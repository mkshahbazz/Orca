/**
 * THE SEAMONK — voyage planning.
 *
 * Route options are *computed* from the departure point, the destination, the
 * craft and the live conditions, then intersected with the hazard register.
 * Nothing here is a stored answer, so the page behaves the same way whether
 * the operator is running Digha → Sagar Island or Paradip → Gopalpur.
 */

import type { TimelineEntry } from "@/components/seamonk/primitives";
import {
  riskAssessment,
  seaState,
  visibilityAssessment,
  waveAssessment,
  windAssessment,
  type Assessment,
  type Tone,
} from "./design";
import type { Conditions, Hazard, Place } from "./demo";
import { distanceNm, num } from "./format";

export type ExposureRow = {
  label: string;
  value: string;
  note: string;
  tone: Tone;
  kind: "OBSERVED" | "FORECAST" | "MODEL PREDICTION";
};

export type PlannedRoute = {
  id: string;
  code: "A" | "B" | "C";
  label: string;
  strategy: string;
  waypoints: [number, number][];
  distanceNm: number;
  hours: number;
  risk: Tone;
  riskLabel: string;
  summary: string;
  exposure: ExposureRow[];
  timeline: TimelineEntry[];
  hazardsOnTrack: Array<{ hazard: Hazard; atWaypoint: number; offsetKm: number }>;
  /** Least depth over the passage legs, excluding the harbour approaches. */
  minDepthM: number;
  /** Depth at the departure and arrival ends — usually shallow, by design. */
  approachDepthM: number;
  maxWaveM: number;
  maxWindKt: number;
  recommended: boolean;
};

export type PlanInput = {
  from: Place;
  to: Place;
  speedKt: number;
  departure: string; // "HH:MM" in IST
  conditions: Conditions;
  hazards: Hazard[];
  /** Analytic field sampler — the same one the map draws. */
  sample: (layer: "sst" | "chl" | "wind" | "bathy", lat: number, lon: number) => number;
  craft: { id: string; label: string; lengthM: number; safeWaveM: number };
};

const LEGS = 5;

function interpolate(a: [number, number], b: [number, number], n = LEGS): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    // A gentle arc rather than a straight line: real tracks follow a heading,
    // and a straight rhumb line looks synthetic on a projected map.
    const bow = Math.sin(f * Math.PI) * 0.035;
    out.push([a[0] + (b[0] - a[0]) * f + bow, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

function offsetLine(
  line: [number, number][],
  perp: [number, number],
  amount: number
): [number, number][] {
  return line.map(([lat, lon], i) => {
    // Taper the offset at both ends so the track leaves and joins the harbour.
    const f = Math.sin((i / (line.length - 1)) * Math.PI);
    return [lat + perp[0] * amount * f, lon + perp[1] * amount * f];
  });
}

function pathLengthNm(line: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distanceNm(line[i - 1], line[i]);
  return total;
}

function clockAdd(base: string, hours: number): string {
  const [h, m] = base.split(":").map((n) => parseInt(n, 10));
  const total = (h || 0) * 60 + (m || 0) + Math.round(hours * 60);
  const hh = Math.floor((total / 60) % 24);
  const mm = total % 60;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

/** Great-circle offset in km from a hazard centre. */
function offsetKm(a: [number, number], b: [number, number]): number {
  return distanceNm(a, b) * 1.852;
}

export function planRoutes(input: PlanInput): PlannedRoute[] {
  const { from, to, speedKt, conditions, hazards, sample, craft, departure } = input;

  const start: [number, number] = [from.lat, from.lon];
  const end: [number, number] = [to.lat, to.lon];
  const base = interpolate(start, end);

  // Which side of the track is deeper? That decides what "offshore" means for
  // this particular pair of ports.
  const mid = base[Math.floor(LEGS / 2)];
  const dLat = end[0] - start[0];
  const dLon = end[1] - start[1];
  const len = Math.hypot(dLat, dLon) || 1;
  const perp: [number, number] = [-dLon / len, dLat / len];
  const probeA = sample("bathy", mid[0] + perp[0] * 0.15, mid[1] + perp[1] * 0.15);
  const probeB = sample("bathy", mid[0] - perp[0] * 0.15, mid[1] - perp[1] * 0.15);
  const seaward: [number, number] = probeA >= probeB ? perp : [-perp[0], -perp[1]];

  const candidates: Array<{
    code: "A" | "B" | "C";
    label: string;
    strategy: string;
    line: [number, number][];
    waveDelta: number;
  }> = [
    {
      code: "A",
      label: "Direct track",
      strategy: "Shortest distance, follows the rhumb line between the two points.",
      line: base,
      waveDelta: 0,
    },
    {
      code: "B",
      label: "Seaward of the shoals",
      strategy: "Swing half a mile into deeper water to avoid the shallow shoulder and the tide race.",
      line: offsetLine(base, seaward, 0.22),
      waveDelta: -0.15,
    },
    {
      code: "C",
      label: "Inshore approach",
      strategy: "Cut the corner inside the 10 m line — shortest over the ground, but no sea room.",
      line: offsetLine(base, seaward, -0.16),
      waveDelta: 0.25,
    },
  ];

  const planned = candidates.map((c) => {
    const distance = pathLengthNm(c.line);
    const hours = distance / Math.max(1, speedKt);

    const depths = c.line.map(([lat, lon]) => sample("bathy", lat, lon));
    // Harbour approaches are shallow by nature; a 4 m reading at the berth is
    // not a shoal crossing, so the passage excludes the two end waypoints.
    const interior = depths.slice(1, -1);
    const minDepthM = Math.round(Math.min(...(interior.length ? interior : depths)));
    const approachDepthM = Math.round(Math.max(depths[0], depths[depths.length - 1]));

    const windKt = Math.round(conditions.wind_kt);
    const waveM = Math.max(0.3, +(conditions.wave_height_m + c.waveDelta).toFixed(1));

    const factors: Assessment[] = [
      waveAssessment(waveM),
      windAssessment(windKt),
      visibilityAssessment(conditions.visibility_km),
    ];
    const risk = riskAssessment(factors);
    const sea = seaState(waveM);

    // Which registered hazards does this track actually pass near?
    const hazardsOnTrack: PlannedRoute["hazardsOnTrack"] = [];
    c.line.forEach(([lat, lon], i) => {
      hazards.forEach((h) => {
        const off = offsetKm([lat, lon], [h.lat, h.lon]);
        if (off <= h.radiusKm) {
          const existing = hazardsOnTrack.find((x) => x.hazard.id === h.id);
          if (existing) existing.offsetKm = Math.min(existing.offsetKm, off);
          else hazardsOnTrack.push({ hazard: h, atWaypoint: i, offsetKm: off });
        }
      });
    });

    // Timeline: exposure along the track, plus any hazard crossings in order.
    const timeline: TimelineEntry[] = c.line.map(([lat, lon], i) => {
      const f = i / (c.line.length - 1);
      const atHours = f * hours;
      const legWave = +(waveM + 0.18 * Math.sin(f * Math.PI * 1.4)).toFixed(1);
      const legWind = Math.round(windKt + 1.6 * Math.sin(f * Math.PI));
      const depth = Math.round(sample("bathy", lat, lon));
      const w = waveAssessment(legWave);
      let detail = `Wave ${num(legWave, 1)} m, wind ${legWind} kt. Depth under keel about ${depth} m.`;
      if (i === 0) detail = `Departure. Wave ${num(legWave, 1)} m, wind ${legWind} kt NE. ` + detail;
      if (i === c.line.length - 1) detail = `Arrival. ${detail}`;
      if (depth < 10) detail += " Shoal water — reduce speed and post a lookout.";
      return {
        time: clockAdd(departure, atHours),
        label: `${w.label === "Good" || w.label === "Acceptable" ? "Holding" : w.label} — wave ${num(legWave, 1)} m`,
        detail,
        tone: depth < 10 ? "warn" : w.tone,
      };
    });

    // Hazard crossings become their own timeline entries, merged by time.
    hazardsOnTrack.forEach((h) => {
      const f = h.atWaypoint / (c.line.length - 1);
      timeline.push({
        time: clockAdd(departure, f * hours),
        label: `${h.hazard.severity === "hazard" ? "Hazard" : "Caution"} — ${h.hazard.label}`,
        detail: chanceDetail(h.hazard, h.offsetKm),
        tone: h.hazard.severity === "hazard" ? "danger" : h.hazard.severity === "caution" ? "warn" : "info",
      });
    });
    timeline.sort((a, b) => a.time.localeCompare(b.time));

    const exposure: ExposureRow[] = [
      {
        label: "Wind",
        value: `${windKt} kt ${conditions.wind_dir}`,
        note: windAssessment(windKt).label ?? "",
        tone: windAssessment(windKt).tone,
        kind: "FORECAST",
      },
      {
        label: "Wave",
        value: `${num(waveM, 1)} m`,
        note:
          waveM <= craft.safeWaveM
            ? `within ${craft.safeWaveM} m limit for a ${craft.lengthM} m ${craft.label.toLowerCase()}`
            : `exceeds the ${craft.safeWaveM} m working limit for this craft`,
        tone: waveM <= craft.safeWaveM ? waveAssessment(waveM).tone : "danger",
        kind: "MODEL PREDICTION",
      },
      {
        label: "Visibility",
        value: `${num(conditions.visibility_km, 1)} km`,
        note: visibilityAssessment(conditions.visibility_km).label ?? "",
        tone: visibilityAssessment(conditions.visibility_km).tone,
        kind: "OBSERVED",
      },
      {
        label: "Sea state",
        value: sea.code,
        note: `${sea.label}, ${num(conditions.swell_period_s, 0)} s period`,
        tone: sea.tone,
        kind: "MODEL PREDICTION",
      },
      {
        label: "Least depth on passage",
        value: `${minDepthM} m`,
        note:
          minDepthM < 10
            ? "shoal crossing — reduce speed, post a lookout"
            : "adequate water across the passage legs",
        tone: minDepthM < 10 ? "warn" : "ok",
        kind: "MODEL PREDICTION",
      },
      {
        label: "Approach depth",
        value: `${approachDepthM} m`,
        note: "at the departure or arrival berth — expect to be shallow there",
        tone: "info",
        kind: "MODEL PREDICTION",
      },
    ];

    return {
      id: `route-${c.code.toLowerCase()}`,
      code: c.code,
      label: c.label,
      strategy: c.strategy,
      waypoints: c.line,
      distanceNm: distance,
      hours,
      risk: risk.tone,
      riskLabel: risk.label,
      summary: buildSummary(c.code, distance, minDepthM, hazardsOnTrack.length, waveM, craft.safeWaveM),
      exposure,
      timeline: timeline.slice(0, 7),
      hazardsOnTrack,
      minDepthM,
      approachDepthM,
      maxWaveM: waveM,
      maxWindKt: windKt,
      recommended: false,
    };
  });

  const order: Record<Tone, number> = { ok: 0, info: 1, neutral: 2, warn: 3, danger: 4 };
  const best = [...planned].sort(
    (a, b) => order[a.risk] - order[b.risk] || a.distanceNm - b.distanceNm
  )[0];
  return planned.map((r) => ({ ...r, recommended: r.id === best.id }));
}

function chanceDetail(h: Hazard, offset: number): string {
  const where = offset <= 1 ? "directly on the track" : `about ${offset.toFixed(1)} km off the track`;
  return `${h.detail} This zone intersects the route ${where}. Valid: ${h.validUntil}.`;
}

function buildSummary(
  code: "A" | "B" | "C",
  distance: number,
  minDepth: number,
  hazardCount: number,
  waveM: number,
  safeWaveM: number
): string {
  const base = `${distance.toFixed(1)} NM with a least depth of ${minDepth} m`;
  const over = waveM > safeWaveM ? " The modelled wave height is above this craft's working limit." : "";
  const hz = hazardCount
    ? ` Enters ${hazardCount} registered hazard zone${hazardCount > 1 ? "s" : ""}.`
    : " Stays clear of every registered hazard zone.";
  if (code === "B") return `${base}; the extra water is what makes this the safer track.${hz}${over}`;
  if (code === "C") return `${base}. Being inshore removes sea room, so any failure has fewer options.${hz}${over}`;
  return `${base}, along the shortest ground between the two points.${hz}${over}`;
}
