/**
 * THE SEAMONK — shared derivations.
 *
 * Views stay readable because the mapping from data to display lives here:
 * one definition of "what colour is a caution zone", one definition of how a
 * station's numbers become a status word, and so on.
 */

import type { MarkerSpec, ZoneSpec, FieldSpec, RouteSpec, Cell } from "@/components/seamonk/mapConfig";
import type { ReadoutItem, TimelineEntry } from "@/components/seamonk/primitives";
import {
  LAYERS,
  rampColor,
  seaState,
  visibilityAssessment,
  waveAssessment,
  windAssessment,
  sstAssessment,
  chlorophyllAssessment,
  type Assessment,
  type LayerKey,
  type Tone,
} from "./design";
import {
  isSea,
  type Conditions,
  type CommunityReport,
  type Hazard,
  type Observation,
  type PfzZone,
  type Place,
} from "./demo";
import { nm, num } from "./format";

/* ------------------------------------------------------------------- colours */

export const HAZARD_COLOR: Record<Hazard["severity"], string> = {
  hazard: "#f05c5c",
  caution: "#e8a33d",
  advisory: "#7ccbf5",
};

export const STATION_COLOR: Record<Observation["kind"], string> = {
  buoy: "#33b9f2",
  "coastal-station": "#2ec4c4",
  "satellite-pass": "#d8b45c",
  vessel: "#57e3a3",
};

export type RouteCode = "A" | "B" | "C";

export const ROUTE_COLOR: Record<RouteCode, string> = {
  A: "#f0c25c",
  B: "#57e3a3",
  C: "#ff9a9a",
};

/* ------------------------------------------------------------------ readouts */

/** Assessment for a full station row, worst-of the contributing parameters. */
export function stationStatus(o: Observation): Assessment {
  const factors = [waveAssessment(o.waveM), windAssessment(o.windKt)];
  const worst = factors.sort((a, b) => rank(b.tone) - rank(a.tone))[0];
  return worst;
}

function rank(tone: Tone): number {
  return { danger: 4, warn: 3, info: 2, neutral: 1, ok: 0 }[tone];
}

export function conditionsReadout(c: Conditions, stations: Observation[]): ReadoutItem[] {
  const sea = seaState(c.wave_height_m);
  return [
    {
      key: "sst",
      label: "Sea Surface Temp",
      value: num(c.sst_c, 1),
      unit: "°C",
      status: sstAssessment(c.sst_c),
      delta: undefined,
      source: "MOSDAC · INSAT-3DR · 4 km",
    },
    {
      key: "chl",
      label: "Chlorophyll-a",
      value: num(c.chlorophyll_mgm3, 2),
      unit: "mg/m³",
      status: chlorophyllAssessment(c.chlorophyll_mgm3),
      source: "Copernicus · Sentinel-3 OLCI",
    },
    {
      key: "wind",
      label: "Wind",
      value: num(c.wind_kt, 0),
      unit: "kt",
      status: windAssessment(c.wind_kt),
      source: `IMD · GFS blend · ${c.wind_dir}`,
    },
    {
      key: "wave",
      label: "Wave Height",
      value: num(c.wave_height_m, 1),
      unit: "m",
      status: waveAssessment(c.wave_height_m),
      source: `INCOIS wave model · period ${num(c.swell_period_s, 0)} s`,
    },
    {
      key: "vis",
      label: "Visibility",
      value: num(c.visibility_km, 1),
      unit: "km",
      status: visibilityAssessment(c.visibility_km),
      source: `${stations.filter((s) => s.kind === "coastal-station").length} coastal stations`,
    },
    {
      key: "sea",
      label: "Sea State",
      value: sea.code,
      unit: "Douglas",
      status: { tone: sea.tone, label: sea.label },
      source: "derived from significant wave height",
    },
  ];
}

/* --------------------------------------------------------------------- fields */

export function fieldSpec(
  layer: LayerKey,
  cells: Cell[] | undefined,
  visible: boolean,
  opacity: number
): FieldSpec {
  const def = LAYERS.find((l) => l.key === layer)!;
  return {
    key: layer,
    label: def.label,
    ramp: (t) => rampColor(def.ramp, t),
    // Land mask: a marine field is only defined over water.
    cells: (cells ?? []).filter((c) => isSea(c.lat, c.lon)),
    min: def.min,
    max: def.max,
    opacity,
    visible,
    unit: def.unit,
  };
}

/* ---------------------------------------------------------------------- zones */

export function hazardZones(hazards: Hazard[], selectedId?: string | null): ZoneSpec[] {
  return hazards.map((h) => ({
    id: h.id,
    kind:
      h.kind === "restricted"
        ? "restricted"
        : h.kind === "shallow"
          ? "shallow"
          : h.kind === "weather"
            ? "squall"
            : "hazard",
    label: h.label,
    detail: h.detail,
    color: HAZARD_COLOR[h.severity],
    tone: h.severity === "hazard" ? "danger" : h.severity === "caution" ? "warn" : "info",
    lat: h.lat,
    lon: h.lon,
    radiusKm: h.radiusKm,
    selected: selectedId === h.id,
  }));
}

export function pfzZones(zones: PfzZone[], selectedId?: string | null): ZoneSpec[] {
  return zones.map((z) => ({
    id: z.id,
    kind: "pfz" as const,
    label: `${z.name} · ${z.probability}%`,
    detail: `${nm(z.distanceNm)} from ${z.name.split(" ")[0]} · depth ${z.depthM} m`,
    color: "#22c55e",
    tone: (z.probability >= 65 ? "ok" : "info") as Tone,
    lat: z.lat,
    lon: z.lon,
    radiusKm: 12,
    ring: z.polygons,
    selected: selectedId === z.id,
  }));
}

export function communityMarkers(reports: CommunityReport[]): MarkerSpec[] {
  return reports.map((r) => ({
    id: r.id,
    lat: r.lat,
    lon: r.lon,
    label: r.category.replace(/_/g, " "),
    sub: r.reporterRole,
    detail: r.verified ? "verified against sensors" : "unverified",
    color: r.verified ? "#22d3ee" : "#f59e0b",
    shape: "circle" as const,
    size: r.verified ? 7 : 6,
  }));
}

export function stationMarkers(stations: Observation[], withLabels = false): MarkerSpec[] {
  return stations.map((s) => ({
    id: s.id,
    lat: s.lat,
    lon: s.lon,
    label: s.label,
    detail: `${num(s.sst, 1)} °C`,
    color: STATION_COLOR[s.kind],
    shape: s.kind === "vessel" ? ("diamond" as const) : ("circle" as const),
    size: 7,
    permanent: withLabels && s.kind !== "vessel",
  }));
}

export function pfzMarkers(zones: PfzZone[], selectedId?: string | null): MarkerSpec[] {
  return zones.map((z) => ({
    id: z.id,
    lat: z.lat,
    lon: z.lon,
    label: `${z.probability}%`,
    detail: z.name,
    color: selectedId === z.id ? "#ffffff" : "#22c55e",
    shape: "square" as const,
    size: selectedId === z.id ? 10 : 8,
  }));
}

export function placeMarkers(places: Place[]): MarkerSpec[] {
  return places.map((p) => ({
    id: p.id,
    lat: p.lat,
    lon: p.lon,
    label: p.name,
    detail: p.state,
    color: p.kind === "port" ? "#d8b45c" : "#2ec4c4",
    shape: p.kind === "port" ? ("square" as const) : ("circle" as const),
    size: 8,
    permanent: true,
  }));
}

/** A planned track drawn on the chart: selected tracks are solid and wider. */
export function routeSpec(
  id: string,
  code: RouteCode,
  points: [number, number][],
  active: boolean
): RouteSpec {
  return {
    id,
    points,
    color: active ? ROUTE_COLOR[code] : "rgba(140,170,200,.55)",
    width: active ? 2.8 : 1.8,
    dashed: !active,
  };
}

/* ------------------------------------------------------------------ timelines */

/** Next-hours marine timeline built from the 3-hourly forecast. */
export function forecastTimeline(
  forecast: Array<{ time: string; wind_kt: number; sea: string; temp_c: number }>
): TimelineEntry[] {
  const rows = forecast.slice(0, 6);
  return rows.map((f, i) => {
    const prev = rows[i - 1];
    const wind = windAssessment(f.wind_kt);
    let detail = `Sea state ${f.sea} · air ${num(f.temp_c, 1)} °C.`;
    if (prev) {
      const dWind = f.wind_kt - prev.wind_kt;
      if (Math.abs(dWind) >= 2) {
        detail += dWind > 0 ? ` Wind freshening by ${Math.abs(dWind)} kt.` : ` Wind easing by ${Math.abs(dWind)} kt.`;
      } else {
        detail += " Wind holding steady.";
      }
    } else {
      detail += " Baseline for the window.";
    }
    return {
      time: f.time,
      label: `Wind ${f.wind_kt} kt — ${wind.label}`,
      detail,
      tone: wind.tone,
    };
  });
}

/* --------------------------------------------------------------- misc helpers */

export function probeRows(
  values: Array<{ layer: LayerKey; value: number; unit: string; label: string }>,
  zone?: PfzZone
): Array<{ label: string; value: string; note?: string }> {
  const rows = values.map((v) => ({
    label: v.label,
    value: `${num(v.value, v.layer === "bathy" ? 0 : 2)} ${v.unit}`,
    note: LAYERS.find((l) => l.key === v.layer)?.observed,
  }));
  if (zone) rows.push({ label: "PFZ probability", value: `${zone.probability}%`, note: "MODEL PREDICTION" });
  return rows;
}
