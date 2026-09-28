"use client";

/**
 * THE SEAMONK — one data source for the whole console.
 *
 * Every page reads from this context, so the header clock, the map, a chart
 * and a generated report can never disagree about what the sea is doing.
 *
 * Degradation is explicit and visible. Three modes:
 *   live      — the API answered; values carry their real source labels
 *   degraded  — the API answered but a subsystem is down
 *   demo      — the API is unreachable; the console runs on the labelled
 *               demonstration dataset rather than showing invented "live" data
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  COMMUNITY,
  COASTAL_REGIONS,
  DEMO_CONDITIONS,
  HAZARDS,
  OBSERVATIONS,
  PFZ_ZONES,
  READINGS,
  REPORTS,
  SOURCES,
  buildGrid,
  monthlyAggregate,
  sampleField,
  series,
  type Conditions,
  type Hazard,
  type PfzZone,
  type Point,
  type RegionId,
} from "./demo";
import { LAYERS, type LayerKey } from "./design";
import { distanceNm, kmhToKt } from "./format";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export type DataMode = "live" | "degraded" | "demo";

export type SystemsRow = { key: string; label: string; source: string; status: string };

export type Region = (typeof COASTAL_REGIONS)[number];

type ApiSnapshot = {
  status?: string;
  last_updated_label?: string;
  generated_at?: string;
  error?: string;
  conditions?: Record<string, number | string | null>;
  sst_trend?: { hour: string; sst: number }[];
  pfz?: Array<{ properties: Record<string, string | number> }>;
  forecast?: Array<{ time: string; temp_c: number; wind_kt: number; sea: string; night: boolean }>;
  insights?: {
    best_zone?: { name: string; lat: number; lon: number; probability: number; window: string } | null;
    advisories?: { kind: string; title: string; text: string }[];
  };
};

export type SeaState = {
  mode: DataMode;
  /** Human sentence describing why we are in this mode. */
  statusNote: string;
  liveLabel: string;
  generatedAt: number | null;
  /** bumped on every successful load, used as a key for map re-centring */
  revision: number;
  refreshing: boolean;
  refresh: () => void;
  apiError: string | null;

  region: Region;
  setRegionId: (id: RegionId) => void;
  regions: Region[];

  conditions: Conditions;
  sstTrend: Point[];
  waveSeries: Point[];
  windSeries: Point[];
  chlorophyllSeries: Point[];
  visibilitySeries: Point[];
  currentSeries: Point[];
  monthly: {
    sst: ReturnType<typeof monthlyAggregate>;
    chl: ReturnType<typeof monthlyAggregate>;
    wind: ReturnType<typeof monthlyAggregate>;
    wave: ReturnType<typeof monthlyAggregate>;
  };

  pfz: PfzZone[];
  hazards: Hazard[];
  observations: typeof OBSERVATIONS;
  sources: typeof SOURCES;
  reports: typeof REPORTS;
  community: typeof COMMUNITY;
  readings: typeof READINGS;
  systems: SystemsRow[];
  /** Sampled scalar field; uses the API grid when live, analytic model otherwise. */
  gridFor: (layer: LayerKey) => { lat: number; lon: number; v: number }[] | undefined;
  /** Point inspection — always answers, so the coordinate inspector never lies. */
  inspect: (lat: number, lon: number) => { layer: LayerKey; value: number; unit: string; label: string }[];
  distanceFromRegion: (lat: number, lon: number) => number;
  /** Forecast strip for the next hours, normalised across both modes. */
  forecast: Array<{ time: string; temp_c: number; wind_kt: number; sea: string; night: boolean }>;
};

const Ctx = createContext<SeaState | null>(null);

export function useSea(): SeaState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSea() must be used inside <SeamonkDataProvider>");
  return v;
}

/** Stable "now" for the current render pass — updated once per minute after mount. */
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now ?? 0;
}

/** True only after hydration — gates any clock-derived text. */
export function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

function trendFromApi(rows: { hour: string; sst: number }[] | undefined, day: number): Point[] {
  if (!rows?.length) return [];
  return rows.map((r) => {
    const [h, mi] = r.hour.split(":").map((n) => parseInt(n, 10));
    const d = new Date(day);
    d.setHours(h || 0, mi || 0, 0, 0);
    return { t: d.getTime(), v: r.sst };
  });
}

export function SeamonkDataProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<DataMode>("demo");
  const [statusNote, setStatusNote] = useState("Waiting for the first feed…");
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [regionId, setRegionId] = useState<RegionId>("wb");
  const [systems, setSystems] = useState<SystemsRow[]>([]);
  const [apiSnapshot, setApiSnapshot] = useState<ApiSnapshot | null>(null);
  const [apiGrid, setApiGrid] = useState<Record<string, { lat: number; lon: number; v: number }[]> | null>(null);
  const [windows, setWindows] = useState(() => ({ now: 0, day: 0, week: 0, month: 0, year: 0 }));

  // Time windows are computed after mount so the prerendered HTML and the
  // hydrated client agree on a single value.
  useEffect(() => {
    const n = Date.now();
    setWindows({
      now: n,
      day: n - 24 * 3600_000,
      week: n - 7 * 86_400_000,
      month: n - 30 * 86_400_000,
      year: n - 365 * 86_400_000,
    });
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    let ok = false;
    let error: string | null = null;
    let fetchedSystems: SystemsRow[] = [];
    try {
      const res = await fetch(`${API_URL}/api/dashboard`, { cache: "no-store" });
      if (res.ok) {
        const data: ApiSnapshot = await res.json();
        if (data.status === "degraded") {
          // Upstream errors can carry long request URLs (e.g. a rate-limited
          // weather provider); keep the banner to a short human sentence.
          const raw = String(data.error ?? "");
          error = raw.length > 160 ? "a live feed is rate-limiting the aggregation service" : raw || "the aggregation service reported a degraded run";
          setApiSnapshot(null);
        } else {
          ok = true;
          setApiSnapshot(data);
          setGeneratedAt(data.generated_at ? Date.parse(data.generated_at) : Date.now());
          setApiError(null);
        }
      } else {
        error = `marine intelligence API replied ${res.status}`;
      }
    } catch {
      error = "marine intelligence API unreachable";
    }
    if (!ok) setApiError(error);

    try {
      const res = await fetch(`${API_URL}/api/health/systems`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        fetchedSystems = data.systems ?? [];
        setSystems(fetchedSystems);
      }
    } catch {
      /* keep the last known pipeline state */
    }

    try {
      const res = await fetch(`${API_URL}/api/map/grid?layers=sst,chl,wind,bathy`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setApiGrid(data.grids ?? null);
      }
    } catch {
      setApiGrid(null);
    }

    if (ok) {
      const degraded = fetchedSystems.some((s) => s.status !== "active");
      setMode(degraded ? "degraded" : "live");
      setStatusNote(
        degraded
          ? "Live feeds with one degraded pipeline — see Data Sources."
          : "Live feeds from IMD, Copernicus, INCOIS and the spatial store."
      );
    } else {
      setMode("demo");
      setStatusNote(
        `${error ?? "live feeds unreachable"} — showing the labelled demonstration dataset for the West Bengal coast.`
      );
    }
    setRevision((r) => r + 1);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(true), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const region = useMemo(
    () => COASTAL_REGIONS.find((r) => r.id === regionId) ?? COASTAL_REGIONS[0],
    [regionId]
  );

  const conditions = useMemo<Conditions>(() => {
    const c = apiSnapshot?.conditions;
    if (!c) return DEMO_CONDITIONS;
    const windKt = c.wind_kt !== null && c.wind_kt !== undefined ? Number(c.wind_kt) : DEMO_CONDITIONS.wind_kt;
    return {
      ...DEMO_CONDITIONS,
      sst_c: c.sst_c !== null && c.sst_c !== undefined ? Number(c.sst_c) : DEMO_CONDITIONS.sst_c,
      sst_delta_c: Number(c.sst_delta_c ?? DEMO_CONDITIONS.sst_delta_c),
      chlorophyll_mgm3:
        c.chlorophyll_mgm3 !== null ? Number(c.chlorophyll_mgm3) : DEMO_CONDITIONS.chlorophyll_mgm3,
      chlorophyll_delta: Number(c.chlorophyll_delta ?? DEMO_CONDITIONS.chlorophyll_delta),
      wind_kt: windKt,
      wind_dir: String(c.wind_dir ?? DEMO_CONDITIONS.wind_dir),
      visibility_km: c.visibility_km !== null && c.visibility_km !== undefined ? Number(c.visibility_km) : DEMO_CONDITIONS.visibility_km,
      wave_height_m:
        c.wave_height_m !== null && c.wave_height_m !== undefined
          ? Number(c.wave_height_m)
          : DEMO_CONDITIONS.wave_height_m,
      gust_kt: Math.round(windKt * 1.28),
      source: String(c.source ?? ""),
    };
  }, [apiSnapshot]);

  const seriesBundle = useMemo(() => {
    if (!windows.now) {
      return {
        sst: [] as Point[],
        wave: [] as Point[],
        wind: [] as Point[],
        chl: [] as Point[],
        vis: [] as Point[],
        current: [] as Point[],
      };
    }
    const apiTrend = trendFromApi(apiSnapshot?.sst_trend, windows.now);
    const windFromApi: Point[] = (apiSnapshot?.forecast ?? []).map((f) => {
      const d = new Date(windows.now);
      const [h, mi] = f.time.split(":").map((n) => parseInt(n, 10));
      d.setHours(h || 0, mi || 0, 0, 0);
      return { t: d.getTime(), v: f.wind_kt };
    });
    return {
      sst: apiTrend.length ? apiTrend : series("sst", windows.day, windows.now, 3600_000, 11),
      wave: series("wave", windows.now - 12 * 3600_000, windows.now, 1800_000, 23).map((p) => ({
        ...p,
        v: +(p.v * (conditions.wave_height_m / DEMO_CONDITIONS.wave_height_m)).toFixed(2),
      })),
      wind: windFromApi.length > 4 ? windFromApi : series("wind", windows.day, windows.now, 3600_000, 31),
      chl: series("chl", windows.week, windows.now, 6 * 3600_000, 47),
      vis: series("visibility", windows.day, windows.now, 3600_000, 59),
      current: series("current", windows.day, windows.now, 3600_000, 67),
    };
  }, [apiSnapshot, windows, conditions.wave_height_m]);

  const monthly = useMemo(() => {
    const end = windows.now || 0;
    return {
      sst: monthlyAggregate("sst", 12, end),
      chl: monthlyAggregate("chl", 12, end),
      wind: monthlyAggregate("wind", 12, end),
      wave: monthlyAggregate("wave", 12, end),
    };
  }, [windows.now]);

  /** PFZ: the catalogue gives the zone narrative, the API overrides live values. */
  const pfz = useMemo<PfzZone[]>(() => {
    const live = apiSnapshot?.pfz;
    if (!live?.length) return PFZ_ZONES;
    return PFZ_ZONES.map((z) => {
      const hit = live.find((f) => {
        const lat = Number(f.properties?.lat);
        const lon = Number(f.properties?.lon);
        return Math.abs(lat - z.lat) < 0.4 && Math.abs(lon - z.lon) < 0.4;
      });
      if (!hit) return z;
      const p = hit.properties ?? {};
      const prob = Number(p.probability ?? z.probability);
      return {
        ...z,
        probability: Number.isFinite(prob) ? prob : z.probability,
        sst: Number.isFinite(Number(p.sst)) ? Number(p.sst) : z.sst,
        chl: Number.isFinite(Number(p.chlorophyll)) ? Number(p.chlorophyll) : z.chl,
        bestTime: String(p.best_time ?? z.bestTime),
        source: p.source ? `${p.source} (live)` : z.source,
      };
    });
  }, [apiSnapshot]);

  const gridFor = useCallback(
    (layer: LayerKey) => {
      if (apiGrid?.[layer]?.length) return apiGrid[layer];
      if (!windows.now) return undefined;
      return buildGrid(layer);
    },
    [apiGrid, windows.now]
  );

  const inspect = useCallback(
    (lat: number, lon: number) =>
      LAYERS.map((l) => ({
        layer: l.key,
        label: l.short,
        unit: l.unit === "kt" ? "kt" : l.unit,
        value: +sampleField(l.key, lat, lon).toFixed(l.key === "bathy" ? 0 : 2),
      })),
    []
  );

  const distanceFromRegion = useCallback(
    (lat: number, lon: number) => distanceNm([region.lat, region.lon], [lat, lon]),
    [region]
  );

  const forecast = useMemo(() => {
    const api = apiSnapshot?.forecast;
    if (api?.length) return api.slice(0, 12);
    if (!windows.now) return [];
    const out = [];
    for (let k = 0; k < 12; k++) {
      const d = new Date(windows.now + (k + 1) * 3 * 3600_000);
      const hour = d.getHours();
      const temp = conditions.sst_c - 1.4 * Math.sin(((hour - 6) / 24) * 2 * Math.PI) + 0.2 * ((k % 3) - 1);
      const wind = conditions.wind_kt + 1.7 * Math.sin(k * 1.1);
      const wave = conditions.wave_height_m + 0.25 * Math.sin(k * 0.9);
      out.push({
        time: `${hour.toString().padStart(2, "0")}:00`,
        temp_c: +temp.toFixed(1),
        wind_kt: Math.round(wind),
        sea: wave < 1.5 ? "1-2" : wave < 2.5 ? "2-3" : "3",
        night: hour >= 19 || hour < 5,
      });
    }
    return out;
  }, [apiSnapshot, windows.now, conditions]);

  const value: SeaState = {
    mode,
    statusNote,
    liveLabel: mode === "demo" ? "Demonstration dataset" : mode === "degraded" ? "Live — degraded" : "Live Data",
    generatedAt,
    revision,
    refreshing,
    refresh: () => load(false),
    apiError,

    region,
    setRegionId,
    regions: COASTAL_REGIONS,

    conditions,
    sstTrend: seriesBundle.sst,
    waveSeries: seriesBundle.wave,
    windSeries: seriesBundle.wind,
    chlorophyllSeries: seriesBundle.chl,
    visibilitySeries: seriesBundle.vis,
    currentSeries: seriesBundle.current,
    monthly,

    pfz,
    hazards: HAZARDS,
    observations: OBSERVATIONS,
    sources: SOURCES,
    reports: REPORTS,
    community: COMMUNITY,
    readings: READINGS,
    systems,
    gridFor,
    inspect,
    distanceFromRegion,
    forecast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { kmhToKt };
