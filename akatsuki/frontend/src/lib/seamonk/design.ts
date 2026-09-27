/**
 * THE SEAMONK — design decisions expressed as data.
 *
 * Every environmental reading passes through here so that a wind of 17 kt is
 * described the same way on a map tooltip, in the voyage safety result and in
 * a generated report. Each assessment carries a *word* as well as a tone,
 * because status must never be communicated by colour alone.
 */

import { clamp } from "./format";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

export type Assessment = { tone: Tone; label: string; note?: string };

/** Confidence bands, shared with the backend scoring engine. */
export const CONFIDENCE_HIGH = 85;
export const CONFIDENCE_MODERATE = 60;

const TONE_ORDER: Tone[] = ["ok", "info", "warn", "danger", "neutral"];

export function toneVar(tone: Tone, part: "fg" | "bg" | "line" = "fg"): string {
  const t = TONE_ORDER.includes(tone) ? tone : "neutral";
  return `var(--${t}-${part})`;
}

/* ------------------------------------------------------------------ sea state */

/** Douglas sea scale, banded on significant wave height (metres). */
export function seaState(waveM: number | null | undefined): { code: string } & Assessment {
  if (waveM === null || waveM === undefined) return { code: "—", tone: "neutral", label: "Unavailable" };
  if (waveM < 0.1) return { code: "0", tone: "ok", label: "Calm (glassy)" };
  if (waveM < 0.5) return { code: "1", tone: "ok", label: "Calm (rippled)" };
  if (waveM < 1.25) return { code: "2", tone: "ok", label: "Smooth" };
  if (waveM < 2.5) return { code: "3", tone: "info", label: "Slight" };
  if (waveM < 4.0) return { code: "4", tone: "warn", label: "Moderate" };
  if (waveM < 6.0) return { code: "5", tone: "warn", label: "Rough" };
  if (waveM < 9.0) return { code: "6", tone: "danger", label: "Very rough" };
  return { code: "7", tone: "danger", label: "High" };
}

/** Wave height against the limit for a small fishing craft (≈ 2.0 m). */
export function waveAssessment(waveM: number | null | undefined): Assessment {
  if (waveM === null || waveM === undefined) return { tone: "neutral", label: "No reading" };
  if (waveM < 1.0) return { tone: "ok", label: "Good", note: "well within limits for small craft" };
  if (waveM < 1.8) return { tone: "ok", label: "Acceptable", note: "workable for most craft" };
  if (waveM < 2.6) return { tone: "warn", label: "Moderate", note: "small craft should stay nearshore" };
  if (waveM < 3.5) return { tone: "danger", label: "Hazardous", note: "do not launch" };
  return { tone: "danger", label: "Severe", note: "suspend all operations" };
}

export function windAssessment(kt: number | null | undefined): Assessment {
  if (kt === null || kt === undefined) return { tone: "neutral", label: "No reading" };
  if (kt < 8) return { tone: "ok", label: "Light" };
  if (kt < 17) return { tone: "ok", label: "Moderate" };
  if (kt < 22) return { tone: "warn", label: "Fresh" };
  if (kt < 34) return { tone: "danger", label: "Strong" };
  return { tone: "danger", label: "Gale" };
}

export function visibilityAssessment(km: number | null | undefined): Assessment {
  if (km === null || km === undefined) return { tone: "neutral", label: "No reading" };
  if (km >= 10) return { tone: "ok", label: "Excellent" };
  if (km >= 5) return { tone: "ok", label: "Good" };
  if (km >= 2) return { tone: "warn", label: "Moderate" };
  if (km >= 1) return { tone: "warn", label: "Poor" };
  return { tone: "danger", label: "Fog" };
}

/** SST against the 24-month envelope for the northern Bay of Bengal. */
export function sstAssessment(c: number | null | undefined): Assessment {
  if (c === null || c === undefined) return { tone: "neutral", label: "No reading" };
  if (c >= 31.5) return { tone: "danger", label: "Above normal", note: "+2.3 °C vs. seasonal mean" };
  if (c >= 29.5) return { tone: "info", label: "Warm" };
  if (c >= 26) return { tone: "ok", label: "Normal" };
  if (c >= 23) return { tone: "info", label: "Cool" };
  return { tone: "warn", label: "Below normal" };
}

/** Chlorophyll is the crude proxy for biological productivity. */
export function chlorophyllAssessment(mgm3: number | null | undefined): Assessment {
  if (mgm3 === null || mgm3 === undefined) return { tone: "neutral", label: "No reading" };
  if (mgm3 >= 1.6) return { tone: "ok", label: "Bloom" };
  if (mgm3 >= 0.8) return { tone: "ok", label: "Productive" };
  if (mgm3 >= 0.35) return { tone: "info", label: "Moderate" };
  return { tone: "neutral", label: "Oligotrophic" };
}

export function pfzAssessment(p: number): Assessment {
  if (p >= 80) return { tone: "ok", label: "Very likely" };
  if (p >= 65) return { tone: "ok", label: "Likely" };
  if (p >= 50) return { tone: "info", label: "Possible" };
  return { tone: "neutral", label: "Marginal" };
}

export function confidenceBand(score: number): { tone: Tone; label: string } {
  if (score >= CONFIDENCE_HIGH) return { tone: "ok", label: "High confidence" };
  if (score >= CONFIDENCE_MODERATE) return { tone: "info", label: "Moderate confidence" };
  return { tone: "warn", label: "Low confidence" };
}

/** Overall voyage risk, from the worst contributing factor. */
export function riskAssessment(factors: Assessment[]): Assessment {
  const rank: Record<Tone, number> = { danger: 4, warn: 3, info: 2, neutral: 1, ok: 0 };
  const worst = factors.reduce<Assessment>(
    (acc, f) => (rank[f.tone] > rank[acc.tone] ? f : acc),
    { tone: "ok", label: "Low" }
  );
  const map: Record<Tone, Assessment> = {
    ok: { tone: "ok", label: "Low risk" },
    info: { tone: "info", label: "Minor risk" },
    warn: { tone: "warn", label: "Moderate risk" },
    danger: { tone: "danger", label: "High risk" },
    neutral: { tone: "neutral", label: "Undetermined" },
  };
  return { ...map[worst.tone], note: `driver: ${worst.label.toLowerCase()}` };
}

/* ---------------------------------------------------------------- colour ramps */

export type RampStop = [number, string];

/**
 * Scientific ramps, deliberately *not* the default rainbow. Each one is the
 * palette this kind of product actually ships: thermal for temperature,
 * blue→green→brown for benthic depth, a cool ramp for wind.
 */
export const RAMPS = {
  sst: [
    [0.0, "#1f4fa8"],
    [0.25, "#2f8ed6"],
    [0.45, "#3fc7d4"],
    [0.6, "#43d08a"],
    [0.75, "#e9d162"],
    [0.88, "#e8893d"],
    [1.0, "#d8443d"],
  ],
  chl: [
    [0.0, "#12294d"],
    [0.2, "#1c4f7a"],
    [0.4, "#1f8b8b"],
    [0.6, "#42c07b"],
    [0.8, "#c3d95a"],
    [1.0, "#f3e79b"],
  ],
  wind: [
    [0.0, "#0d2136"],
    [0.3, "#1c5f8f"],
    [0.55, "#31a8c4"],
    [0.78, "#7fd6c6"],
    [1.0, "#f0e6a8"],
  ],
  bathy: [
    [0.0, "#c9e7f2"],
    [0.18, "#7cc0dd"],
    [0.4, "#3d84b8"],
    [0.62, "#24557f"],
    [0.85, "#142f4d"],
    [1.0, "#08182c"],
  ],
} satisfies Record<string, RampStop[]>;

export type RampKey = keyof typeof RAMPS;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Interpolated colour for a normalised value in a named ramp. */
export function rampColor(key: RampKey, t: number): string {
  const stops: RampStop[] = RAMPS[key];
  const v = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (v - t0) / (t1 - t0 || 1);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      const mix = a.map((x, k) => Math.round(x + f * (b[k] - x)));
      return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
    }
  }
  return stops[stops.length - 1][1];
}

/** CSS `linear-gradient` string for a legend swatch. */
export function rampGradient(key: RampKey): string {
  const stops = RAMPS[key]
    .map(([pos, hex]) => `${hex} ${(pos * 100).toFixed(0)}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

/* -------------------------------------------------------------- layer registry */

export type LayerKey = "sst" | "chl" | "wind" | "bathy";

export type LayerDef = {
  key: LayerKey;
  label: string;
  short: string;
  unit: string;
  min: number;
  max: number;
  ramp: RampKey;
  group: "ocean" | "weather" | "fishing" | "safety";
  /** Rendering family: continuous scalar field vs. discrete zone geometry. */
  kind: "field" | "zones";
  observed: "OBSERVED" | "FORECAST" | "MODEL PREDICTION";
  source: string;
  resolution: string;
  cadence: string;
};

export const LAYERS: LayerDef[] = [
  {
    key: "sst",
    label: "Sea Surface Temperature",
    short: "SST",
    unit: "°C",
    min: 24,
    max: 32,
    ramp: "sst",
    group: "ocean",
    kind: "field",
    observed: "OBSERVED",
    source: "MOSDAC · INSAT-3DR",
    resolution: "4 km",
    cadence: "3-hourly",
  },
  {
    key: "chl",
    label: "Chlorophyll-a",
    short: "Chlorophyll",
    unit: "mg/m³",
    min: 0.15,
    max: 1.8,
    ramp: "chl",
    group: "ocean",
    kind: "field",
    observed: "OBSERVED",
    source: "Copernicus · Sentinel-3 OLCI",
    resolution: "1 km",
    cadence: "daily",
  },
  {
    key: "wind",
    label: "Wind Speed",
    short: "Wind",
    unit: "kt",
    min: 2,
    max: 22,
    ramp: "wind",
    group: "weather",
    kind: "field",
    observed: "FORECAST",
    source: "IMD · GFS blend",
    resolution: "9 km",
    cadence: "hourly",
  },
  {
    key: "bathy",
    label: "Bathymetry",
    short: "Depth",
    unit: "m",
    min: 0,
    max: 3000,
    ramp: "bathy",
    group: "ocean",
    kind: "field",
    observed: "MODEL PREDICTION",
    source: "GEBCO 2023 · INCOIS",
    resolution: "450 m",
    cadence: "static",
  },
];

export const LAYER_BY_KEY: Record<LayerKey, LayerDef> = LAYERS.reduce(
  (acc, l) => ({ ...acc, [l.key]: l }),
  {} as Record<LayerKey, LayerDef>
);
