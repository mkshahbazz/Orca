"use client";

/**
 * THE SEAMONK — analytical charts.
 *
 * Written as SVG rather than pulled from a chart library: the grid is a
 * graticule, the lines are 1.5 px instrument traces, and the cursor readout
 * shows a timestamp plus the value of every series at that moment. Keyboard
 * users get the same cursor as pointer users.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { istClock, istDay, istStamp } from "@/lib/seamonk/format";

export type ChartPoint = { t: number; v: number; lo?: number; hi?: number };

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  points: ChartPoint[];
  unit?: string;
  dashed?: boolean;
  area?: boolean;
  width?: number;
};

/** Measures the live width so the plot is drawn at 1 CSS px per unit. */
function useElementWidth<T extends HTMLElement>(fallback = 720) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => {
      if (w > 0) setWidth(Math.round(w));
    };
    apply(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(+v.toFixed(6));
  return out;
}

function nearestIndex(points: ChartPoint[], t: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].t - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/* --------------------------------------------------------------- sparkline */

export function Sparkline({
  points,
  color = "var(--cyan)",
  height = 34,
  width = 120,
  area = true,
  label,
}: {
  points: ChartPoint[];
  color?: string;
  height?: number;
  width?: number;
  area?: boolean;
  label?: string;
}) {
  const id = useId().replace(/[:]/g, "");
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const vals = points.map((p) => p.v);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const step = width / (points.length - 1);
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 3 - ((p.v - min) / span) * (height - 6)).toFixed(1)}`)
      .join(" ");
    return { d, last: points[points.length - 1].v };
  }, [points, width, height]);

  if (!geometry) {
    return <div className="sk-skel" style={{ height, width: "100%" }} />;
  }
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? "Trend sparkline"}
      style={{ display: "block", maxWidth: "100%" }}
    >
      {area ? (
        <>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${geometry.d} L${width},${height} L0,${height} Z`} fill={`url(#spark-${id})`} />
        </>
      ) : null}
      <path d={geometry.d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------------------------------------- time series */

export function TimeSeries({
  series,
  height = 210,
  unit = "",
  yLabel,
  valueDigits = 1,
  showLegend = true,
  cursorLabel,
}: {
  series: ChartSeries[];
  height?: number;
  unit?: string;
  yLabel?: string;
  valueDigits?: number;
  showLegend?: boolean;
  /** Label for the x-axis readout, e.g. "IST" or "date". */
  cursorLabel?: string;
}) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const id = useId().replace(/[:]/g, "");
  const [cursor, setCursor] = useState<number | null>(null);

  const active = series.filter((s) => s.points.length > 1);
  const domain = useMemo(() => {
    if (!active.length) return null;
    let t0 = Infinity;
    let t1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const s of active) {
      for (const p of s.points) {
        if (p.t < t0) t0 = p.t;
        if (p.t > t1) t1 = p.t;
        const lo = p.lo ?? p.v;
        const hi = p.hi ?? p.v;
        if (lo < v0) v0 = lo;
        if (hi > v1) v1 = hi;
      }
    }
    const pad = (v1 - v0) * 0.12 || 0.5;
    return { t0, t1, v0: v0 - pad, v1: v1 + pad };
  }, [active]);

  const pad = { l: 48, r: 16, t: 14, b: 24 };
  const w = Math.max(width, 260);
  const innerW = w - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const x = useCallback(
    (t: number) => pad.l + ((t - (domain?.t0 ?? 0)) / ((domain?.t1 ?? 1) - (domain?.t0 ?? 0) || 1)) * innerW,
    [domain, innerW, pad.l]
  );
  const y = useCallback(
    (v: number) => pad.t + (1 - (v - (domain?.v0 ?? 0)) / ((domain?.v1 ?? 1) - (domain?.v0 ?? 0) || 1)) * innerH,
    [domain, innerH, pad.t]
  );

  const yTicks = domain ? niceTicks(domain.v0, domain.v1, 4) : [];
  const xTicks = domain ? niceTicks(domain.t0, domain.t1, 4) : [];

  const cursorT = useMemo(() => {
    if (cursor === null || !domain) return null;
    return domain.t0 + (cursor / 100) * (domain.t1 - domain.t0);
  }, [cursor, domain]);

  const readout = useMemo(() => {
    if (cursorT === null) return null;
    return active.map((s) => {
      const i = nearestIndex(s.points, cursorT);
      return { key: s.key, label: s.label, color: s.color, value: s.points[i].v, t: s.points[i].t, unit: s.unit ?? unit };
    });
  }, [cursorT, active, unit]);

  if (!active.length || !domain) {
    return <div className="sk-chart-empty">{series.length ? "No samples in this window yet." : "Select a parameter to plot."}</div>;
  }

  const summary = active
    .map((s) => {
      const vs = s.points.map((p) => p.v);
      const last = vs[vs.length - 1];
      return `${s.label}: last ${last.toFixed(valueDigits)}${unit}, low ${Math.min(...vs).toFixed(valueDigits)}, high ${Math.max(...vs).toFixed(valueDigits)}`;
    })
    .join("; ");

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - rect.left - pad.l) / innerW) * 100;
    setCursor(Math.max(0, Math.min(100, rel)));
  };

  return (
    <div className="sk-chart">
      <div className="sk-chart-readout" aria-live="polite">
        {readout ? (
          <>
            <span className="sk-readout-time">{istStamp(readout[0].t, false)}</span>
            {readout.map((r) => (
              <span className="sk-chart-key" key={r.key}>
                <i style={{ background: r.color }} />
                {r.label} <b>{(+r.value).toFixed(valueDigits)}{r.unit}</b>
              </span>
            ))}
          </>
        ) : (
          <span className="sk-dim-sm">
            Hover the plot, or focus it and use ← →, to read exact values.{cursorLabel ? ` Times shown in ${cursorLabel}.` : ""}
          </span>
        )}
      </div>

      <div
        ref={wrapRef}
        style={{ position: "relative", marginTop: 6 }}
        onMouseMove={handleMove}
        onMouseLeave={() => setCursor(null)}
      >
        <svg
          className="sk-chart-svg"
          viewBox={`0 0 ${w} ${height}`}
          width={w}
          height={height}
          role="img"
          aria-label={`${yLabel ?? "Time series"}. ${summary}`}
          tabIndex={0}
          style={{ outlineOffset: 4 }}
          onFocus={() => setCursor((c) => (c === null ? 98 : c))}
          onBlur={() => setCursor(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              setCursor((c) => Math.min(100, (c ?? 0) + 3));
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              setCursor((c) => Math.max(0, (c ?? 100) - 3));
            } else if (e.key === "Home") {
              setCursor(0);
            } else if (e.key === "End") {
              setCursor(100);
            } else if (e.key === "Escape") {
              setCursor(null);
            }
          }}
        >
          {/* graticule */}
          <g className="sk-chart-grid">
            {yTicks.map((t) => (
              <line key={`gy-${t}`} x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} />
            ))}
            {xTicks.map((t) => (
              <line key={`gx-${t}`} x1={x(t)} x2={x(t)} y1={pad.t} y2={height - pad.b} strokeDasharray="2 5" />
            ))}
          </g>
          <line x1={pad.l} x2={pad.l} y1={pad.t} y2={height - pad.b} stroke="rgba(70,130,195,.35)" strokeWidth="1" />
          <line x1={pad.l} x2={w - pad.r} y1={height - pad.b} y2={height - pad.b} stroke="rgba(70,130,195,.35)" strokeWidth="1" />

          {/* y labels */}
          {yTicks.map((t) => (
            <text key={`ty-${t}`} className="sk-chart-axis" x={pad.l - 8} y={y(t) + 3} textAnchor="end">
              {t.toFixed(Math.abs(t) >= 100 ? 0 : valueDigits)}
            </text>
          ))}
          {/* x labels */}
          {xTicks.map((t) => (
            <text key={`tx-${t}`} className="sk-chart-axis" x={x(t)} y={height - 8} textAnchor="middle">
              {istDay(t)}
            </text>
          ))}
          {yLabel ? (
            <text className="sk-chart-axis-label" x={pad.l - 8} y={pad.t - 4} textAnchor="end">
              {yLabel}
            </text>
          ) : null}

          {/* series */}
          {active.map((s) => {
            const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
            return (
              <g key={s.key}>
                {s.area ? (
                  <>
                    <defs>
                      <linearGradient id={`area-${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={s.color} stopOpacity="0.26" />
                        <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
                      </linearGradient>
                    </defs>
                    <path
                      d={`${d} L${x(s.points[s.points.length - 1].t).toFixed(1)},${height - pad.b} L${x(s.points[0].t).toFixed(1)},${height - pad.b} Z`}
                      fill={`url(#area-${id}-${s.key})`}
                    />
                  </>
                ) : null}
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.width ?? 1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={s.dashed ? "3 3" : undefined}
                />
              </g>
            );
          })}

          {/* cursor */}
          {cursorT !== null ? (
            <g>
              <line
                className="sk-chart-cursor"
                x1={x(cursorT)}
                x2={x(cursorT)}
                y1={pad.t}
                y2={height - pad.b}
              />
              {active.map((s) => {
                const i = nearestIndex(s.points, cursorT);
                const p = s.points[i];
                return (
                  <circle
                    key={`cur-${s.key}`}
                    cx={x(p.t)}
                    cy={y(p.v)}
                    r="3"
                    fill="#04121f"
                    stroke={s.color}
                    strokeWidth="1.8"
                  />
                );
              })}
            </g>
          ) : null}
        </svg>
      </div>

      {showLegend ? (
        <div className="sk-row sk-gap-sm" style={{ marginTop: 8 }}>
          {active.map((s) => (
            <span className="sk-chart-key" key={`lg-${s.key}`} style={{ fontSize: 11.5, color: "var(--muted)" }}>
              <i style={{ background: s.color, height: s.dashed ? 2 : 3 }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ bars */

export function BarSeries({
  points,
  height = 176,
  color = "var(--cyan)",
  unit = "",
  digits = 1,
  label,
}: {
  points: ChartPoint[];
  height?: number;
  color?: string;
  unit?: string;
  digits?: number;
  label: string;
}) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 14, t: 16, b: 26 };
  const w = Math.max(width, 260);
  const innerW = w - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  if (!points.length) return <div className="sk-chart-empty">No monthly aggregates available.</div>;

  const v0 = Math.min(...points.map((p) => p.lo ?? p.v), ...points.map((p) => p.v)) * 0.9;
  const v1 = Math.max(...points.map((p) => p.hi ?? p.v), ...points.map((p) => p.v)) * 1.06;
  const step = innerW / points.length;
  const barW = Math.max(6, step * 0.54);
  const y = (v: number) => pad.t + (1 - (v - v0) / ((v1 - v0) || 1)) * innerH;
  const ticks = niceTicks(v0, v1, 4);

  return (
    <div className="sk-chart">
      <div className="sk-chart-readout">
        {hover !== null ? (
          <>
            <span className="sk-readout-time">{new Date(points[hover].t).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}</span>
            <span className="sk-chart-key">
              <i style={{ background: color }} />
              mean <b>{points[hover].v.toFixed(digits)}{unit}</b>
            </span>
            {points[hover].lo !== undefined ? (
              <span className="sk-chart-key sk-dim-sm">
                range {points[hover].lo!.toFixed(digits)} – {points[hover].hi!.toFixed(digits)}{unit}
              </span>
            ) : null}
          </>
        ) : (
          <span className="sk-dim-sm">Monthly mean with observed range. Hover a column for the figures.</span>
        )}
      </div>
      <div ref={wrapRef} style={{ marginTop: 6 }}>
        <svg className="sk-chart-svg" viewBox={`0 0 ${w} ${height}`} width={w} height={height} role="img" aria-label={label}>
          <g className="sk-chart-grid">
            {ticks.map((t) => (
              <line key={`bg-${t}`} x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} />
            ))}
          </g>
          <line x1={pad.l} x2={pad.l} y1={pad.t} y2={height - pad.b} stroke="rgba(70,130,195,.35)" strokeWidth="1" />
          <line x1={pad.l} x2={w - pad.r} y1={height - pad.b} y2={height - pad.b} stroke="rgba(70,130,195,.35)" strokeWidth="1" />
          {ticks.map((t) => (
            <text key={`bt-${t}`} className="sk-chart-axis" x={pad.l - 8} y={y(t) + 3} textAnchor="end">
              {t.toFixed(0)}
            </text>
          ))}
          {points.map((p, i) => {
            const cx = pad.l + step * i + step / 2;
            const isHover = hover === i;
            return (
              <g key={p.t}>
                {p.lo !== undefined ? (
                  <line
                    x1={cx}
                    x2={cx}
                    y1={y(p.lo)}
                    y2={y(p.hi ?? p.v)}
                    stroke={color}
                    strokeWidth="1"
                    opacity="0.55"
                  />
                ) : null}
                <rect
                  x={cx - barW / 2}
                  y={y(Math.max(p.v, p.lo ?? p.v))}
                  width={barW}
                  height={Math.max(2, height - pad.b - y(Math.max(p.v, p.lo ?? p.v)))}
                  fill={color}
                  opacity={isHover ? 0.85 : 0.5}
                  rx="1.5"
                />
                <rect
                  x={pad.l + step * i}
                  y={pad.t}
                  width={step}
                  height={height - pad.t - pad.b}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
                <text className="sk-chart-axis" x={cx} y={height - 8} textAnchor="middle">
                  {new Date(p.t).toLocaleDateString("en-GB", { month: "short", timeZone: "Asia/Kolkata" })}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- scatter */

export function Scatter({
  points,
  xLabel,
  yLabel,
  xUnit = "",
  yUnit = "",
  fit = true,
  digits = 2,
  height = 200,
  note,
}: {
  points: Array<{ x: number; y: number; label?: string }>;
  xLabel: string;
  yLabel: string;
  xUnit?: string;
  yUnit?: string;
  fit?: boolean;
  digits?: number;
  height?: number;
  note?: string;
}) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 48, r: 16, t: 16, b: 30 };
  const w = Math.max(width, 260);
  const innerW = w - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const fitStats = useMemo(() => {
    if (points.length < 3) return null;
    const n = points.length;
    const mx = points.reduce((s, p) => s + p.x, 0) / n;
    const my = points.reduce((s, p) => s + p.y, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const p of points) {
      sxy += (p.x - mx) * (p.y - my);
      sxx += (p.x - mx) ** 2;
      syy += (p.y - my) ** 2;
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = my - slope * mx;
    const r = sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
    return { slope, intercept, r, r2: r * r };
  }, [points]);

  if (points.length < 2) return <div className="sk-chart-empty">Not enough paired samples in this window.</div>;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const xPad = (x1 - x0) * 0.08 || 0.1;
  const yPad = (y1 - y0) * 0.1 || 0.1;
  const X = (v: number) => pad.l + ((v - (x0 - xPad)) / ((x1 + xPad) - (x0 - xPad) || 1)) * innerW;
  const Y = (v: number) => pad.t + (1 - (v - (y0 - yPad)) / ((y1 + yPad) - (y0 - yPad) || 1)) * innerH;

  return (
    <div className="sk-chart">
      <div ref={wrapRef}>
        <svg
          className="sk-chart-svg"
          viewBox={`0 0 ${w} ${height}`}
          width={w}
          height={height}
          role="img"
          aria-label={`${yLabel} against ${xLabel}. ${fitStats ? `Correlation coefficient ${fitStats.r.toFixed(2)}` : ""}`}
        >
          <g className="sk-chart-grid">
            {niceTicks(y0 - yPad, y1 + yPad, 4).map((t) => (
              <line key={`sg-${t}`} x1={pad.l} x2={w - pad.r} y1={Y(t)} y2={Y(t)} />
            ))}
          </g>
          <line x1={pad.l} x2={pad.l} y1={pad.t} y2={height - pad.b} stroke="rgba(70,130,195,.35)" strokeWidth="1" />
          <line x1={pad.l} x2={w - pad.r} y1={height - pad.b} y2={height - pad.b} stroke="rgba(70,130,195,.35)" strokeWidth="1" />
          {niceTicks(y0 - yPad, y1 + yPad, 4).map((t) => (
            <text key={`st-${t}`} className="sk-chart-axis" x={pad.l - 8} y={Y(t) + 3} textAnchor="end">
              {t.toFixed(digits)}
            </text>
          ))}
          <text className="sk-chart-axis" x={pad.l} y={height - 10} textAnchor="start">
            {xLabel} {xUnit ? `(${xUnit})` : ""}
          </text>
          <text className="sk-chart-axis-label" x={pad.l - 8} y={pad.t - 4} textAnchor="end">
            {yLabel}
          </text>

          {fit && fitStats ? (
            <line
              x1={X(x0 - xPad)}
              y1={Y(fitStats.intercept + fitStats.slope * (x0 - xPad))}
              x2={X(x1 + xPad)}
              y2={Y(fitStats.intercept + fitStats.slope * (x1 + xPad))}
              stroke="rgba(216,180,92,.8)"
              strokeWidth="1.4"
              strokeDasharray="4 3"
            />
          ) : null}

          {points.map((p, i) => (
            <circle
              key={i}
              cx={X(p.x)}
              cy={Y(p.y)}
              r={hover === i ? 4.5 : 3}
              fill={hover === i ? "var(--cyan)" : "rgba(51,185,242,.55)"}
              stroke="#04121f"
              strokeWidth="1"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <title>{p.label ?? `${p.x.toFixed(digits)} ${xUnit} → ${p.y.toFixed(digits)} ${yUnit}`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="sk-chart-readout" style={{ marginTop: 6 }}>
        {fitStats ? (
          <>
            <span className="sk-chart-key">
              Pearson r <b>{fitStats.r.toFixed(2)}</b>
            </span>
            <span className="sk-chart-key">
              r² <b>{fitStats.r2.toFixed(2)}</b>
            </span>
            <span className="sk-chart-key sk-dim-sm">
              slope <b style={{ color: "var(--gold)" }}>{fitStats.slope.toFixed(3)}</b> {yUnit}/{xUnit}
            </span>
            <span className="sk-dim-sm">{points.length} paired samples</span>
          </>
        ) : null}
      </div>
      {note ? <p className="sk-dim-sm" style={{ margin: "6px 0 0" }}>{note}</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- gauge */

export function Gauge({
  value,
  label,
  sublabel,
  tone = "var(--cyan)",
  size = 108,
}: {
  value: number;
  label: string;
  sublabel?: string;
  tone?: string;
  size?: number;
}) {
  const r = size / 2 - 9;
  const circumference = Math.PI * r; // half ring
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <svg width={size} height={size / 2 + 12} viewBox={`0 0 ${size} ${size / 2 + 12}`} role="img" aria-label={`${label}: ${clamped}%`}>
        <path
          d={`M9 ${size / 2 + 4} A ${r} ${r} 0 0 1 ${size - 9} ${size / 2 + 4}`}
          fill="none"
          stroke="rgba(70,130,195,.22)"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d={`M9 ${size / 2 + 4} A ${r} ${r} 0 0 1 ${size - 9} ${size / 2 + 4}`}
          fill="none"
          stroke={tone}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
        />
        <text x={size / 2} y={size / 2 - 3} textAnchor="middle" className="sk-chart-axis" style={{ fontSize: 15, fontWeight: 600, fill: "#eaf3fd" }}>
          {clamped}%
        </text>
      </svg>
      <span>
        <span className="sk-eyebrow" style={{ display: "block" }}>{label}</span>
        {sublabel ? <span className="sk-dim-sm">{sublabel}</span> : null}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- coverage bar */

export function CoverageBar({
  label,
  value,
  tone = "var(--cyan)",
  note,
}: {
  label: string;
  value: number;
  tone?: string;
  note?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div className="sk-row" style={{ justifyContent: "space-between" }}>
        <span className="sk-dim-sm">{label}</span>
        <span className="sk-val" style={{ fontSize: 12 }}>
          {value}%
        </span>
      </div>
      <span className="sk-progress">
        <i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: tone }} />
      </span>
      {note ? <span className="sk-dim-sm" style={{ fontSize: 10.5 }}>{note}</span> : null}
    </div>
  );
}

export { istClock };
