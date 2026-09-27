/**
 * THE SEAMONK — demonstration dataset (West Bengal coast / northern Bay of Bengal).
 *
 * The console has to be usable before every upstream feed is wired, and it
 * must never pretend. Everything here is *illustrative*: the shell labels it
 * "DEMONSTRATION DATA" whenever the live API cannot be reached, and every
 * page keeps its OBSERVED / FORECAST / MODEL labels intact either way.
 *
 * Values are generated deterministically (seeded PRNG + analytic fields) so
 * that the prerendered static export and the hydrated client agree.
 */

import { clamp } from "./format";
import type { LayerKey } from "./design";

/* ------------------------------------------------------------------- geometry */

/**
 * Signed distance in degrees seaward of the coast: negative is inland.
 *
 * This is the only geometric input to the scalar fields. An earlier revision
 * used a straight diagonal as a stand-in for the coastline, which put the
 * West Bengal coast 5° into the Bay and produced 2600 m of water off Digha.
 */
export function offshoreDeg(lat: number, lon: number): number {
  return lon - coastLon(lat);
}

/**
 * Generalised coastline, Andhra Pradesh to the Sundarbans, as [lat, lon].
 *
 * Satellite products only exist over water, so scalar fields are masked
 * against this line before they are drawn — a thermal raster painted across
 * Odisha is the single fastest way for a marine display to look fake. The
 * line is deliberately coarse (about 10 km); it is a display mask, not a
 * navigational boundary.
 */
export const COASTLINE: Array<[number, number]> = [
  [15.5, 80.2],
  [16.2, 80.9],
  [17.2, 82.4],
  [18.2, 83.5],
  [19.0, 84.4],
  [19.3, 84.9],
  [20.0, 85.9],
  [20.35, 86.6],
  [20.9, 86.6],
  [21.3, 87.0],
  [21.55, 87.5],
  [21.7, 88.0],
  [21.85, 88.4],
  [22.2, 88.9],
];

/** Longitude of the coast at a given latitude. */
export function coastLon(lat: number): number {
  if (lat <= COASTLINE[0][0]) return COASTLINE[0][1];
  for (let i = 1; i < COASTLINE.length; i++) {
    const [l0, lon0] = COASTLINE[i - 1];
    const [l1, lon1] = COASTLINE[i];
    if (lat <= l1) {
      const f = (lat - l0) / (l1 - l0 || 1);
      return lon0 + f * (lon1 - lon0);
    }
  }
  return COASTLINE[COASTLINE.length - 1][1];
}

/** True when a coordinate falls in open water (east of the coast). */
export function isSea(lat: number, lon: number): boolean {
  return lon > coastLon(lat) + 0.03;
}

/**
 * Analytic scalar field for a layer — the same shape the API returns.
 *
 * Bathymetry follows the real shape of this margin: a wide shelf that reaches
 * about 200 m at the shelf break, then a steep continental slope into the
 * abyssal plain. Everything else is anchored to the distance seaward of the
 * coast, which is the parameter that actually drives this coast.
 */
export function sampleField(layer: LayerKey, lat: number, lon: number): number {
  const d = Math.max(0, offshoreDeg(lat, lon));
  // The Odisha–Bengal shelf is widest in the north, narrowing to the south.
  const shelfWidth = 1.1 + 0.25 * ((lat - 19) / 3);
  const shelfFrac = clamp(d / shelfWidth, 0, 1);
  const shelf = Math.exp(-((d / 1.15) ** 2));
  switch (layer) {
    case "sst":
      return clamp(
        26.4 + 2.8 * Math.exp(-((d / 1.15) ** 2)) + 2.0 * (1 - (lat - 16) / 6) + 0.3 * Math.sin(lon * 3 + lat * 2),
        24,
        32
      );
    case "chl":
      // Productivity is highest over the shelf and falls off past the break.
      return Math.max(0.12, 0.26 + 1.5 * shelf + 0.16 * Math.sin(lat * 4));
    case "wind":
      // knots: lighter nearshore, rising across the shelf break
      return Math.max(
        2,
        3.2 + 5.4 * (1 - shelf) + 2.4 * Math.sin(lat * 2.2 + lon * 1.7) + 1.4 * Math.cos(lon * 2.9)
      );
    case "bathy": {
      const shelfDepth = 200 * Math.pow(shelfFrac, 1.2);
      const beyond = Math.max(0, d - shelfWidth);
      const slope = 2800 * (1 - Math.exp(-beyond / 0.6));
      return clamp(4 + shelfDepth + slope, 4, 3000);
    }
  }
}

/** Sampled grid cells over the operations box, `nlat × nlon`. */
export function buildGrid(
  layer: LayerKey,
  nlat = 20,
  nlon = 26,
  bounds = { south: 16, north: 22, west: 82, east: 90 }
): { lat: number; lon: number; v: number }[] {
  const cells: { lat: number; lon: number; v: number }[] = [];
  for (let i = 0; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) {
      const lat = +(bounds.south + (i * (bounds.north - bounds.south)) / (nlat - 1)).toFixed(3);
      const lon = +(bounds.west + (j * (bounds.east - bounds.west)) / (nlon - 1)).toFixed(3);
      if (!isSea(lat, lon)) continue;
      cells.push({ lat, lon, v: +sampleField(layer, lat, lon).toFixed(2) });
    }
  }
  return cells;
}

/* ----------------------------------------------------------------- deterministic rng */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------- places */

export type Place = {
  id: string;
  name: string;
  kind: "port" | "landing" | "anchor" | "station";
  lat: number;
  lon: number;
  state: string;
};

export const PLACES: Place[] = [
  { id: "digha", name: "Digha", kind: "landing", lat: 21.627, lon: 87.51, state: "West Bengal" },
  { id: "sagar", name: "Sagar Island", kind: "port", lat: 21.646, lon: 88.09, state: "West Bengal" },
  { id: "bakkhali", name: "Bakkhali", kind: "landing", lat: 21.56, lon: 88.26, state: "West Bengal" },
  { id: "haldia", name: "Haldia", kind: "port", lat: 22.056, lon: 88.093, state: "West Bengal" },
  { id: "kolkata", name: "Kolkata (Outram Ghat)", kind: "port", lat: 22.585, lon: 88.34, state: "West Bengal" },
  { id: "chandipur", name: "Chandipur", kind: "landing", lat: 21.466, lon: 87.019, state: "Odisha" },
  { id: "paradip", name: "Paradip", kind: "port", lat: 20.316, lon: 86.611, state: "Odisha" },
  { id: "gopalpur", name: "Gopalpur", kind: "port", lat: 19.265, lon: 84.9, state: "Odisha" },
];

export const PLACE_BY_ID: Record<string, Place> = PLACES.reduce(
  (acc, p) => ({ ...acc, [p.id]: p }),
  {} as Record<string, Place>
);

/* ---------------------------------------------------------- observation stations */

export type Observation = {
  id: string;
  label: string;
  kind: "buoy" | "coastal-station" | "satellite-pass" | "vessel";
  lat: number;
  lon: number;
  sst: number;
  chl: number;
  windKt: number;
  windDir: string;
  waveM: number;
  visibilityKm: number;
  /** minutes since the last transmission, used for freshness badges */
  ageMin: number;
  source: string;
};

const STATION_SEED: Array<Omit<Observation, "sst" | "chl" | "windKt" | "waveM" | "visibilityKm">> = [
  { id: "bd08", label: "BD08 — Sagar Roads", kind: "buoy", lat: 21.63, lon: 88.05, windDir: "NE", ageMin: 7, source: "INCOIS OMNI" },
  { id: "dgh", label: "Digha Coastal Station", kind: "coastal-station", lat: 21.62, lon: 87.52, windDir: "NNE", ageMin: 12, source: "IMD AWS" },
  { id: "sl03", label: "Sentinel-3B pass 1841", kind: "satellite-pass", lat: 21.2, lon: 87.6, windDir: "NE", ageMin: 46, source: "Copernicus OLCI" },
  { id: "vb02", label: "FB Sagar-02 (reported)", kind: "vessel", lat: 21.48, lon: 87.95, windDir: "ENE", ageMin: 23, source: "Vessel report" },
  { id: "bk01", label: "Bakkhali Jetty", kind: "coastal-station", lat: 21.56, lon: 88.26, windDir: "NE", ageMin: 18, source: "IMD AWS" },
  { id: "pr04", label: "Paradip Port Sensor", kind: "coastal-station", lat: 20.31, lon: 86.62, windDir: "SW", ageMin: 9, source: "INCOIS OMNI" },
];

export const OBSERVATIONS: Observation[] = STATION_SEED.map((s, i) => {
  const rnd = mulberry32(9137 + i * 71);
  const jitter = (scale: number) => (rnd() - 0.5) * scale;
  return {
    ...s,
    sst: +(sampleField("sst", s.lat, s.lon) + jitter(0.4)).toFixed(1),
    chl: +Math.max(0.12, sampleField("chl", s.lat, s.lon) + jitter(0.12)).toFixed(2),
    windKt: Math.round(clamp(sampleField("wind", s.lat, s.lon) + jitter(2.4), 3, 34)),
    waveM: +clamp(0.9 + (sampleField("wind", s.lat, s.lon) / 22) * 1.9 + jitter(0.2), 0.5, 3.4).toFixed(1),
    visibilityKm: +clamp(9.2 - jitter(5.5) - sampleField("chl", s.lat, s.lon) * 0.7, 1.2, 12).toFixed(1),
  };
});

/* ------------------------------------------------------------- conditions snapshot */

export type Conditions = {
  sst_c: number;
  sst_delta_c: number;
  chlorophyll_mgm3: number;
  chlorophyll_delta: number;
  wind_kt: number;
  wind_dir: string;
  gust_kt: number;
  wave_height_m: number;
  wave_delta_m: number;
  swell_period_s: number;
  visibility_km: number;
  current_kt: number;
  current_dir: string;
  salinity_psu: number;
  sea_state: string;
  /** Upstream feed that produced the observation, shown next to the value. */
  source?: string;
};

export const DEMO_CONDITIONS: Conditions = {
  sst_c: 29.2,
  sst_delta_c: 0.6,
  chlorophyll_mgm3: 0.84,
  chlorophyll_delta: 0.12,
  wind_kt: 15,
  wind_dir: "NE",
  gust_kt: 19,
  wave_height_m: 1.8,
  wave_delta_m: 0.2,
  swell_period_s: 8.5,
  visibility_km: 8.5,
  current_kt: 0.8,
  current_dir: "E",
  salinity_psu: 31.6,
  sea_state: "2-3",
};

/* ------------------------------------------------------------------ time series */

export type Point = { t: number; v: number };

/**
 * A believable marine curve: diurnal temperature swing, wind that freshens in
 * the afternoon sea-breeze, swell that trails the wind by ~3 h.
 */
export function series(
  param: "sst" | "wave" | "wind" | "chl" | "visibility" | "current",
  fromMs: number,
  toMs: number,
  stepMs = 3600_000,
  seed = 11
): Point[] {
  const rnd = mulberry32(seed);
  const out: Point[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const d = new Date(t);
    const hour = d.getHours() + d.getMinutes() / 60;
    const diurnal = Math.sin(((hour - 6) / 24) * 2 * Math.PI);
    const dayIndex = (t - fromMs) / 86_400_000;
    let v: number;
    switch (param) {
      case "sst":
        v = 29.2 - 0.55 * diurnal + 0.32 * Math.sin(dayIndex * 0.9) + (rnd() - 0.5) * 0.08;
        break;
      case "wave":
        v = 1.72 + 0.34 * Math.sin(((hour - 9) / 12) * Math.PI) + 0.22 * Math.sin(dayIndex * 0.7) + (rnd() - 0.5) * 0.06;
        break;
      case "wind":
        v = 13.4 + 4.1 * Math.sin(((hour - 13) / 24) * 2 * Math.PI) + 2.2 * Math.sin(dayIndex * 1.1) + (rnd() - 0.5) * 1.1;
        break;
      case "chl":
        v = 0.82 + 0.19 * Math.sin(dayIndex * 0.55) + 0.05 * Math.sin(dayIndex * 2.3) + (rnd() - 0.5) * 0.03;
        break;
      case "visibility":
        v = 8.6 - 0.9 * Math.sin(((hour - 4) / 24) * 2 * Math.PI) + 0.4 * Math.sin(dayIndex * 0.8) + (rnd() - 0.5) * 0.35;
        break;
      case "current":
        v = 0.78 + 0.24 * Math.sin(((hour - 2) / 12.4) * Math.PI) + (rnd() - 0.5) * 0.05;
        break;
    }
    out.push({ t, v: +Math.max(0.05, v).toFixed(2) });
  }
  return out;
}

/** Long-range monthly aggregates for the analytics workstation (12 months). */
export function monthlyAggregate(
  param: "sst" | "chl" | "wind" | "wave",
  months = 12,
  endMs = Date.now()
): Array<{ t: number; v: number; min: number; max: number; coverage: number }> {
  const rnd = mulberry32(4242);
  const end = new Date(endMs);
  const out: Array<{ t: number; v: number; min: number; max: number; coverage: number }> = [];
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - k, 1));
    const m = d.getUTCMonth();
    // monsoon (Jun–Sep) drives chlorophyll up and wind up; winter cools the sea
    const monsoon = m >= 5 && m <= 8 ? 1 : 0;
    const winter = m === 11 || m <= 1 ? 1 : 0;
    let mean: number;
    switch (param) {
      case "sst":
        mean = 29.4 + 1.1 * monsoon - 2.7 * winter + (rnd() - 0.5) * 0.4;
        break;
      case "chl":
        mean = 0.62 + 0.85 * monsoon + 0.12 * winter + (rnd() - 0.5) * 0.06;
        break;
      case "wind":
        mean = 12.5 + 6.4 * monsoon + (rnd() - 0.5) * 0.9;
        break;
      case "wave":
        mean = 1.5 + 1.15 * monsoon + (rnd() - 0.5) * 0.12;
        break;
    }
    const spread = param === "chl" ? 0.5 : param === "sst" ? 0.9 : param === "wave" ? 0.7 : 4.2;
    out.push({
      t: d.getTime(),
      v: +mean.toFixed(2),
      min: +(mean - spread * (0.5 + rnd() * 0.3)).toFixed(2),
      max: +(mean + spread * (0.5 + rnd() * 0.35)).toFixed(2),
      coverage: +clamp(99 - rnd() * 9 - monsoon * 4, 82, 99.5).toFixed(1),
    });
  }
  return out;
}

/* ------------------------------------------------------------- potential fishing zones */

export type PfzZone = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  probability: number;
  distanceNm: number;
  depthM: number;
  sst: number;
  chl: number;
  bestTime: string;
  bestWindow: string;
  confidence: number;
  bearing: string;
  source: string;
  reasons: string[];
  polygons: [number, number][][];
};

/** Pentagon ring roughly 18 km across, matching the API's PFZ polygons. */
function ring(lat: number, lon: number, r = 0.28): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; k < 5; k++) {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / 5;
    pts.push([+(lon + r * 1.25 * Math.cos(a)).toFixed(3), +(lat + r * Math.sin(a)).toFixed(3)]);
  }
  pts.push(pts[0]);
  return pts;
}

function zone(
  id: string,
  name: string,
  lat: number,
  lon: number,
  probability: number,
  distanceNm: number,
  bestTime: string,
  bestWindow: string,
  confidence: number,
  bearing: string,
  reasons: string[]
): PfzZone {
  return {
    id,
    name,
    lat,
    lon,
    probability,
    distanceNm,
    depthM: Math.round(clamp(sampleField("bathy", lat, lon), 8, 4000) / 5) * 5,
    sst: +sampleField("sst", lat, lon).toFixed(1),
    chl: +sampleField("chl", lat, lon).toFixed(2),
    bestTime,
    bestWindow,
    confidence,
    bearing,
    source: "INCOIS PFZ bulletin · satellite-derived",
    reasons,
    polygons: [ring(lat, lon)],
  };
}

export const PFZ_ZONES: PfzZone[] = [
  zone("pfz-01", "Off Digha", 21.4, 87.9, 88, 18.4, "Today · 04:10–09:30", "next 24 h", 86, "132° SE", [
    "Elevated chlorophyll against the 30-day median for this cell",
    "SST front roughly 0.7 °C above the surrounding water",
    "Sits on the shelf-slope transition where the north-setting current slows",
  ]),
  zone("pfz-02", "South of Sagar Island", 21.28, 88.02, 74, 24.7, "Today · 05:20–10:00", "next 24 h", 71, "156° SSE", [
    "Turbidity plume from the Hooghly carrying nutrients offshore",
    "Consistent with historic landings for hilsa in the same fortnight",
  ]),
  zone("pfz-03", "SW of Paradip", 19.2, 86.8, 81, 96.2, "Tomorrow · 04:40–09:10", "next 48 h", 78, "214° SW", [
    "Upwelling signature: chlorophyll 1.24 mg/m³",
    "SST 1.1 °C cooler than the 18 °C-isotherm band offshore",
  ]),
  zone("pfz-04", "Near 19.5°N 87.2°E", 19.5, 87.2, 66, 118.5, "Tomorrow · 06:00–10:30", "next 48 h", 62, "188° S", [
    "Moderate chlorophyll (0.79 mg/m³) with a fragmented front",
    "Purse-seine reports from this box in the last 5 days",
  ]),
  zone("pfz-05", "Near Gopalpur", 18.9, 84.9, 58, 152.8, "Fri · 05:00–09:20", "3-day outlook", 54, "222° SW", [
    "Weak signal — SST gradient below the PFZ detection threshold",
    "Shown for completeness; not recommended for a dedicated trip",
  ]),
  zone("pfz-06", "Off Chandipur", 21.26, 87.42, 71, 41.6, "Today · 04:30–09:40", "next 24 h", 69, "108° ESE", [
    "Narrow coastal band of elevated chlorophyll across the inner shelf",
    "Tidal front strengthens on the ebb, about 2 h after high water",
  ]),
];

/* --------------------------------------------------------------------- hazards */

export type Hazard = {
  id: string;
  kind: "shallow" | "restricted" | "current" | "debris" | "weather" | "shoal";
  label: string;
  detail: string;
  severity: "advisory" | "caution" | "hazard";
  lat: number;
  lon: number;
  radiusKm: number;
  validUntil: string;
  source: string;
};

export const HAZARDS: Hazard[] = [
  {
    id: "hz-1",
    kind: "shallow",
    label: "Sagar shelf — depth under 5 m",
    detail: "Sandbanks shift after the monsoon. Charted soundings may be 1–2 m optimistic.",
    severity: "caution",
    lat: 21.7,
    lon: 88.02,
    radiusKm: 14,
    validUntil: "31 Oct 2026",
    source: "INCOIS · NHO chart 3020",
  },
  {
    id: "hz-2",
    kind: "restricted",
    label: "Sandheads pilotage — restricted area",
    detail: "Entry requires port authority clearance. Vessels must hold outside 5 NM.",
    severity: "hazard",
    lat: 21.52,
    lon: 88.22,
    radiusKm: 11,
    validUntil: "Notices to Mariners 14/2026",
    source: "Kolkata Port Trust",
  },
  {
    id: "hz-3",
    kind: "current",
    label: "Hooghly ebb race",
    detail: "Ebb stream reaches 2.4 kt across the Sagar Roads; directional control is difficult for slow craft.",
    severity: "caution",
    lat: 21.64,
    lon: 88.06,
    radiusKm: 9,
    validUntil: "Tidal — peak 10:20 & 22:40 IST",
    source: "Tide tables, Sagar",
  },
  {
    id: "hz-4",
    kind: "weather",
    label: "Squall corridor",
    detail: "Convective squalls develop over the Sundarbans in the afternoon and track east-southeast.",
    severity: "advisory",
    lat: 21.35,
    lon: 88.15,
    radiusKm: 26,
    validUntil: "29 Sep 2026 18:00 IST",
    source: "IMD · Nowcast",
  },
  {
    id: "hz-5",
    kind: "debris",
    label: "Floating debris — logged timber",
    detail: "Three reports of drifting timber in the last 48 h after upstream discharge.",
    severity: "advisory",
    lat: 21.5,
    lon: 87.86,
    radiusKm: 12,
    validUntil: "30 Sep 2026",
    source: "Community reports (3 · 2 verified)",
  },
];

/* ---------------------------------------------------------------- voyage routes */

/**
 * Tracks are *generated* at request time by `lib/seamonk/voyage.ts` from the
 * departure point, the destination, the craft and the live conditions, so no
 * canned route table is stored here.
 */

/* -------------------------------------------------------------- community reports */

export type CommunityReport = {
  id: string;
  category: string;
  description: string;
  reporterRole: string;
  lat: number;
  lon: number;
  observedAt: string;
  verified: boolean;
  verificationNote: string;
};

export const COMMUNITY: CommunityReport[] = [
  {
    id: "cr-1",
    category: "heavy_swell",
    description: "Swell picking up outside the 20 m line; two vessels turned back.",
    reporterRole: "Fisher, Sagar Island",
    lat: 21.62,
    lon: 88.04,
    observedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    verified: true,
    verificationNote: "Wave height 2.4 m at BD08 buoy — supports the report.",
  },
  {
    id: "cr-2",
    category: "debris",
    description: "Drifting timber around 6–10 logs, spread over about half a mile.",
    reporterRole: "Vessel crew, MV Kalinga",
    lat: 21.5,
    lon: 87.86,
    observedAt: new Date(Date.now() - 9 * 3600_000).toISOString(),
    verified: false,
    verificationNote: "No sensor can confirm floating debris — flagged unverified.",
  },
  {
    id: "cr-3",
    category: "fish_sighting",
    description: "Bait ball with birds working the surface; good sign for a set tonight.",
    reporterRole: "Fisher, Digha",
    lat: 21.42,
    lon: 87.88,
    observedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
    verified: false,
    verificationNote: "Observation only — advisory weight applied, no evidence bump.",
  },
  {
    id: "cr-4",
    category: "strong_current",
    description: "Strong easterly set across Sagar Roads, roughly 2 kt on the ebb.",
    reporterRole: "Harbour pilot",
    lat: 21.65,
    lon: 88.07,
    observedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    verified: false,
    verificationNote: "Currents are not instrumented here; treated as unverified.",
  },
];

/* ------------------------------------------------------------------ data sources */

export type SourceHealth = {
  key: string;
  label: string;
  provider: string;
  status: "active" | "degraded" | "offline";
  lastSyncMin: number;
  coverage: number;
  cadence: string;
  note: string;
};

export const SOURCES: SourceHealth[] = [
  {
    key: "satellite",
    label: "Satellite Data",
    provider: "MOSDAC · Copernicus",
    status: "active",
    lastSyncMin: 46,
    coverage: 94,
    cadence: "3-hourly · 1 km",
    note: "INSAT-3DR and Sentinel-3 OLCI passes over the operations box.",
  },
  {
    key: "ocean",
    label: "Oceanographic Data",
    provider: "INCOIS · VEDAS",
    status: "active",
    lastSyncMin: 9,
    coverage: 88,
    cadence: "hourly",
    note: "OMNI buoy BD08 plus 3 coastal stations transmitting normally.",
  },
  {
    key: "weather",
    label: "Weather API",
    provider: "IMD · Open-Meteo",
    status: "active",
    lastSyncMin: 12,
    coverage: 97,
    cadence: "hourly",
    note: "Marine forecast grids for the northern Bay of Bengal.",
  },
  {
    key: "gis",
    label: "GIS & Bathymetry",
    provider: "PostGIS · GEBCO",
    status: "degraded",
    lastSyncMin: 184,
    coverage: 76,
    cadence: "daily",
    note: "Spatial store reachable; the last full bathymetry refresh is overdue.",
  },
];

/* ------------------------------------------------------------------- analytics */

export type Stat = { label: string; value: string; note: string };

export const ANALYTICS_STATS: Stat[] = [
  { label: "Mean", value: "29.1 °C", note: "over the selected window" },
  { label: "Minimum", value: "27.8 °C", note: "05:20 IST, 26 Sep" },
  { label: "Maximum", value: "30.4 °C", note: "14:40 IST, 27 Sep" },
  { label: "Current", value: "29.2 °C", note: "latest observation" },
  { label: "Change", value: "+1.4 %", note: "vs. previous window" },
  { label: "Coverage", value: "94 %", note: "126 of 134 expected samples" },
];

/* --------------------------------------------------------------------- reports */

export type ReportRow = {
  id: string;
  title: string;
  type: "Daily" | "PFZ" | "Voyage" | "Conditions" | "Custom";
  region: string;
  generatedAt: string;
  status: "ready" | "queued" | "failed";
  author: string;
  pages: number;
  sizeKb: number;
};

export const REPORTS: ReportRow[] = [
  {
    id: "rp-2418",
    title: "Daily Marine Conditions",
    type: "Daily",
    region: "West Bengal Coast",
    generatedAt: new Date(Date.now() - 26 * 60_000).toISOString(),
    status: "ready",
    author: "SEAMONK scheduler",
    pages: 6,
    sizeKb: 412,
  },
  {
    id: "rp-2417",
    title: "PFZ Analysis — Off Digha",
    type: "PFZ",
    region: "Off Digha · 21.4°N 87.9°E",
    generatedAt: new Date(Date.now() - 53 * 60_000).toISOString(),
    status: "ready",
    author: "A. Mondal (Marine Explorer)",
    pages: 4,
    sizeKb: 288,
  },
  {
    id: "rp-2416",
    title: "Voyage Safety — Digha → Sagar Island",
    type: "Voyage",
    region: "Digha → Sagar Island",
    generatedAt: new Date(Date.now() - 3.4 * 3600_000).toISOString(),
    status: "ready",
    author: "A. Mondal (Marine Explorer)",
    pages: 3,
    sizeKb: 196,
  },
  {
    id: "rp-2415",
    title: "Ocean Conditions — Haldia approaches",
    type: "Conditions",
    region: "Haldia · Sagar Roads",
    generatedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
    status: "ready",
    author: "SEAMONK scheduler",
    pages: 5,
    sizeKb: 344,
  },
  {
    id: "rp-2414",
    title: "Custom — chlorophyll anomaly, Feb–Mar",
    type: "Custom",
    region: "Northern Bay of Bengal",
    generatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    status: "ready",
    author: "Dr. R. Bose (Research)",
    pages: 12,
    sizeKb: 918,
  },
  {
    id: "rp-2413",
    title: "Daily Marine Conditions",
    type: "Daily",
    region: "West Bengal Coast",
    generatedAt: new Date(Date.now() - 2 * 86_400_000 - 24 * 60_000).toISOString(),
    status: "failed",
    author: "SEAMONK scheduler",
    pages: 0,
    sizeKb: 0,
  },
];

/* ------------------------------------------------------------------- monk's reading */

export type Reading = {
  /** The interpretation itself — always short, never a chat transcript. */
  text: string;
  window: string;
  basedOn: string[];
  confidence: number;
};

export const READINGS: Record<string, Reading> = {
  ocean: {
    text:
      "Conditions remain favourable for nearshore activity. Wind is expected to strengthen slightly after 15:00, and the swell period stays under 9 s, so seas will stay short rather than building.",
    window: "Next 12 hours",
    basedOn: ["SST buoy BD08", "IMD marine forecast", "Copernicus chlorophyll", "2 verified community reports"],
    confidence: 86,
  },
  fishing: {
    text:
      "Off Digha holds the strongest signal today — the chlorophyll front sits over the 40 m shelf edge and the tidal ebb should concentrate bait there through the morning. Work it on the last two hours of the ebb.",
    window: "Next 24 hours",
    basedOn: ["INCOIS PFZ bulletin", "Sentinel-3 chlorophyll", "SST front analysis", "Historic landings, Sep"],
    confidence: 86,
  },
  safety: {
    text:
      "The direct track is workable but crosses the shoal shoulder as the ebb runs hardest. Take the offshore variant: 2.7 NM longer, and it enters Sagar Roads from seaward where the stream is running at 0.9 kt instead of 2.1 kt.",
    window: "Departure 08:40 IST",
    basedOn: ["IMD wind forecast", "Wave model run 00Z", "Tide tables, Sagar", "Notices to Mariners 14/2026"],
    confidence: 78,
  },
  analytics: {
    text:
      "Chlorophyll across the northern Bay of Bengal is tracking about 18 % above the five-year mean for late September. The relationship with reported PFZ probability is consistent but loose — treat it as supporting evidence, not a forecast.",
    window: "1 Sep – 28 Sep 2026",
    basedOn: ["Sentinel-3 OLCI monthly composite", "INCOIS PFZ bulletins", "24 PFZ advisories"],
    confidence: 71,
  },
  layers: {
    text:
      "Four fields are loaded. Read the wind field against the bathymetry: the 20 m isobath is where the sea state changes character, and it is the line to judge any nearshore plan against.",
    window: "Current composite",
    basedOn: ["MOSDAC INSAT-3DR", "Copernicus OLCI", "IMD GFS blend", "GEBCO 2023"],
    confidence: 82,
  },
};

/* --------------------------------------------------------------- system / context */

export const TIDE_STATIONS = [
  { name: "Sagar", high: "10:20", low: "16:35", range: "3.1 m" },
  { name: "Digha", high: "10:52", low: "17:04", range: "2.7 m" },
  { name: "Haldia", high: "11:40", low: "17:58", range: "3.6 m" },
];

export const COASTAL_REGIONS = [
  { id: "wb", name: "West Bengal Coast", short: "West Bengal", lat: 21.55, lon: 87.9, zoom: 9, stations: 6 },
  { id: "sundarbans", name: "Sundarbans Delta", short: "Sundarbans", lat: 21.7, lon: 88.15, zoom: 10, stations: 4 },
  { id: "odisha", name: "Odisha Coast", short: "Odisha", lat: 19.9, lon: 86.2, zoom: 9, stations: 5 },
  { id: "bob", name: "Northern Bay of Bengal", short: "Bay of Bengal", lat: 19.5, lon: 86.8, zoom: 7, stations: 11 },
];

export type RegionId = (typeof COASTAL_REGIONS)[number]["id"];
