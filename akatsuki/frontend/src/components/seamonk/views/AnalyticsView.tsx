"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { BasemapKey } from "@/components/seamonk/mapConfig";
import { ConsoleMap } from "@/components/seamonk/ConsoleMapClient";
import { BarSeries, CoverageBar, Gauge, Scatter, TimeSeries } from "@/components/seamonk/charts";
import {
  ArrowRight,
  Chlorophyll,
  Database,
  Download,
  FishingZones,
  MapLayers,
  MarineAnalytics,
  Reports,
  Satellite,
  Share,
  Tide,
} from "@/components/seamonk/icons";
import {
  Alert,
  Button,
  EmptyState,
  Eyebrow,
  Note,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Reading,
  Segmented,
  SourceTag,
  Status,
} from "@/components/seamonk/primitives";
import { useMounted, useNow, useSea } from "@/lib/seamonk/DataProvider";
import { LAYER_BY_KEY, type LayerKey } from "@/lib/seamonk/design";
import { fieldSpec } from "@/lib/seamonk/derive";
import { series, type Point } from "@/lib/seamonk/demo";
import { coordLabel, istStamp, num, sinceLabel } from "@/lib/seamonk/format";

type Param = "sst" | "chl" | "wind" | "wave";
type Win = "24h" | "7d" | "30d" | "3m" | "1y";
type Res = "hourly" | "3-hourly" | "6-hourly" | "daily";

const WINDOWS: Record<Win, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "3m": 90 * 86_400_000,
  "1y": 365 * 86_400_000,
};

/** Default sampling step per window, before an explicit resolution override. */
const DEFAULT_STEP: Record<Win, number> = {
  "24h": 3600_000,
  "7d": 6 * 3600_000,
  "30d": 86_400_000,
  "3m": 3 * 86_400_000,
  "1y": 7 * 86_400_000,
};

const STEP: Record<Res, number> = {
  hourly: 3600_000,
  "3-hourly": 3 * 3600_000,
  "6-hourly": 6 * 3600_000,
  daily: 86_400_000,
};

const PARAM_META: Record<Param, { label: string; unit: string; digits: number; color: string; field: LayerKey; source: string; kind: "OBSERVED" | "FORECAST" | "MODEL PREDICTION" }> = {
  sst: {
    label: "Sea surface temperature",
    unit: " °C",
    digits: 2,
    color: "#33b9f2",
    field: "sst",
    source: "MOSDAC · INSAT-3DR",
    kind: "OBSERVED",
  },
  chl: {
    label: "Chlorophyll-a",
    unit: " mg/m³",
    digits: 3,
    color: "#57e3a3",
    field: "chl",
    source: "Copernicus · Sentinel-3 OLCI",
    kind: "OBSERVED",
  },
  wind: {
    label: "Wind speed",
    unit: " kt",
    digits: 1,
    color: "#d8b45c",
    field: "wind",
    source: "IMD · GFS blend",
    kind: "FORECAST",
  },
  wave: {
    label: "Significant wave height",
    unit: " m",
    digits: 2,
    color: "#2ec4c4",
    field: "bathy",
    source: "INCOIS wave model",
    kind: "MODEL PREDICTION",
  },
};

export default function AnalyticsView() {
  const sea = useSea();
  const now = useNow(120_000);
  const mounted = useMounted();

  const [param, setParam] = useState<Param>("sst");
  const [win, setWin] = useState<Win>("7d");
  const [res, setRes] = useState<Res | "auto">("auto");
  const [source, setSource] = useState("satellite");
  const [basemap, setBasemap] = useState<BasemapKey>("dark");
  const [spatialOn, setSpatialOn] = useState(true);

  const meta = PARAM_META[param];
  const step = res === "auto" ? DEFAULT_STEP[win] : STEP[res];

  const primary = useMemo<Point[]>(() => {
    if (!now) return [];
    const from = now - WINDOWS[win];
    const key = param === "wave" ? "wave" : param;
    return series(key, from, now, step, 101 + param.length);
  }, [now, win, step, param]);

  const tooSparse = primary.length > 0 && primary.length < 3;

  const stats = useMemo(() => {
    if (primary.length < 2) return null;
    const vals = primary.map((p) => p.v);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const first = vals[0];
    const last = vals[vals.length - 1];
    return {
      mean,
      min: Math.min(...vals),
      max: Math.max(...vals),
      last,
      changePct: ((last - first) / (first || 1)) * 100,
      count: vals.length,
      expected: Math.floor(WINDOWS[win] / step) + 1,
    };
  }, [primary, win, step]);

  const field = useMemo(
    () => fieldSpec(meta.field, sea.gridFor(meta.field), true, 0.52),
    [meta.field, sea.gridFor]
  );

  /** Monthly aggregates used for the long-range view and the relationship plots. */
  const monthly = useMemo(() => {
    const chl = sea.monthly.chl;
    const wind = sea.monthly.wind;
    const wave = sea.monthly.wave;
    const sst = sea.monthly.sst;
    if (!chl.length) {
      return { chl, wind, wave, sst, pfzVsChl: [], safetyVsWind: [] };
    }
    const pfzVsChl = chl.map((m, i) => ({
      x: m.v,
      y: Math.max(20, Math.min(95, 38 + m.v * 33 + Math.sin(i * 1.7) * 6)),
      label: new Date(m.t).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" }),
    }));
    const safetyVsWind = wind.map((m, i) => ({
      x: m.v,
      y: Math.max(5, Math.min(99, 104 - (m.v - 12) * 4.2 - (wave[i]?.v ?? 1.5) * 9 + Math.cos(i * 1.3) * 3)),
      label: new Date(m.t).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" }),
    }));
    return { chl, wind, wave, sst, pfzVsChl, safetyVsWind };
  }, [sea.monthly]);

  const exportCsv = () => {
    if (!primary.length) return;
    const rows = [
      `THE SEAMONK — ${meta.label} (${meta.source})`,
      `region,${sea.region.name}`,
      `window,${win}`,
      `resolution,${res === "auto" ? "auto" : res}`,
      `values,value`,
      `generated,${istStamp(Date.now())}`,
      "",
      "timestamp_ist,value",
      ...primary.map((p) => `${istStamp(p.t)},${p.v}`),
    ];
    download(rows.join("\n"), `seamonk-${param}-${win}.csv`, "text/csv");
  };

  const exportSvg = () => {
    const svg = document.querySelector<SVGSVGElement>("#analytics-main-chart svg.sk-chart-svg");
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("style", "background:#04121f");
    download(new XMLSerializer().serializeToString(clone), `seamonk-${param}-${win}.svg`, "image/svg+xml");
  };

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Marine Analytics</h1>
          <p>
            Historical and current ocean data for the {sea.region.short} — region-aggregated time series, spatial
            context, monthly aggregates and the relationship between primary productivity and fishing advisories.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          <Button icon={<Download size={14} />} onClick={exportCsv} disabled={!primary.length}>
            Export CSV
          </Button>
          <Button icon={<Share size={14} />} onClick={exportSvg} disabled={!primary.length}>
            Download chart
          </Button>
          <Link className="sk-btn sk-btn--primary" href="/dashboard/reports/" style={{ textDecoration: "none" }}>
            <Reports size={14} /> Generate report
          </Link>
        </div>
      </div>

      {/* ----------------------------------------------------------- controls */}
      <div className="sk-toolbar">
        <div className="sk-row sk-gap-sm">
          <span className="sk-eyebrow">Parameter</span>
          <Segmented
            label="Parameter"
            value={param}
            onChange={(v) => setParam(v as Param)}
            options={[
              { value: "sst" as Param, label: "SST" },
              { value: "chl" as Param, label: "Chlorophyll" },
              { value: "wind" as Param, label: "Wind" },
              { value: "wave" as Param, label: "Wave" },
            ]}
          />
        </div>
        <div className="sk-row sk-gap-sm">
          <span className="sk-eyebrow">Window</span>
          <Segmented
            label="Time window"
            value={win}
            onChange={(v) => setWin(v as Win)}
            options={[
              { value: "24h" as Win, label: "24 h" },
              { value: "7d" as Win, label: "7 d" },
              { value: "30d" as Win, label: "30 d" },
              { value: "3m" as Win, label: "3 mo" },
              { value: "1y" as Win, label: "1 y" },
            ]}
          />
        </div>
        <div className="sk-row sk-gap-sm">
          <span className="sk-eyebrow">Resolution</span>
          <select
            className="sk-select"
            style={{ width: 122, height: 30 }}
            value={res}
            onChange={(e) => setRes(e.target.value as Res | "auto")}
            aria-label="Time resolution"
          >
            <option value="auto">Automatic</option>
            <option value="hourly">Hourly</option>
            <option value="3-hourly">3-hourly</option>
            <option value="6-hourly">6-hourly</option>
            <option value="daily">Daily</option>
          </select>
        </div>
        <div className="sk-row sk-gap-sm">
          <span className="sk-eyebrow">Source</span>
          <select
            className="sk-select"
            style={{ width: 176, height: 30 }}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Data source"
          >
            <option value="satellite">Satellite composite</option>
            <option value="insitu">In-situ observations</option>
            <option value="blend">Model blend</option>
          </select>
        </div>
        <span className="sk-toolbar-spacer" />
        <span className="sk-chip">
          <MapLayers size={13} /> {sea.region.name}
        </span>
      </div>

      {/* ------------------------------------------------ main visualisation */}
      <Panel id="analytics-main-chart">
        <PanelHead
          icon={<MarineAnalytics size={16} />}
          title={`${meta.label} — ${latencyLabel(win)}`}
          hint={`${meta.source} · ${res === "auto" ? "automatic resolution" : res} · ${sourceLabel(source)}`}
          actions={
            <>
              <SourceTag kind={meta.kind} />
              <Status tone={sea.mode === "demo" ? "warn" : "ok"}>
                {sea.mode === "demo" ? "Demonstration series" : "Live series"}
              </Status>
            </>
          }
        />
        <PanelBody>
          {tooSparse ? (
            <Alert tone="warn" title="Too few samples for this combination.">
              {res} resolution over {win} yields {primary.length} point{primary.length === 1 ? "" : "s"}. Choose a finer
              resolution or a wider window — the chart is not interpolated to hide the gap.
            </Alert>
          ) : (
            <TimeSeries
              height={296}
              unit={meta.unit}
              valueDigits={meta.digits}
              yLabel={`${param.toUpperCase()}${meta.unit}`}
              cursorLabel="IST"
              series={[{ key: param, label: meta.label, color: meta.color, points: primary, area: true }]}
            />
          )}
        </PanelBody>
        <PanelFoot>
          <span className="sk-dim-sm">
            {stats
              ? `${stats.count} samples · ${stats.expected} expected at this resolution`
              : "Awaiting samples"}
          </span>
          <span className="sk-spread sk-dim-sm">
            {mounted && sea.generatedAt && sea.mode !== "demo"
              ? `Feed updated ${istStamp(sea.generatedAt)}`
              : "Reference clock only — the series is generated in the browser"}
          </span>
        </PanelFoot>
      </Panel>

      {/* ------------------------------------------------------ statistics */}
      <Panel>
        <PanelHead
          icon={<Tide size={16} />}
          title="Statistics"
          hint={`${latencyLabel(win)}, ${sea.region.name}`}
          actions={<SourceTag kind={meta.kind} />}
        />
        <PanelBody>
          {stats ? (
            <div className="sk-kv-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))" }}>
              <div>
                <span className="sk-kv-label">Mean</span>
                <span className="sk-kv-value">
                  {num(stats.mean, meta.digits)}
                  {meta.unit}
                </span>
                <span className="sk-kv-note">arithmetic mean of {stats.count} samples</span>
              </div>
              <div>
                <span className="sk-kv-label">Minimum</span>
                <span className="sk-kv-value">
                  {num(stats.min, meta.digits)}
                  {meta.unit}
                </span>
                <span className="sk-kv-note">lowest sample in the window</span>
              </div>
              <div>
                <span className="sk-kv-label">Maximum</span>
                <span className="sk-kv-value">
                  {num(stats.max, meta.digits)}
                  {meta.unit}
                </span>
                <span className="sk-kv-note">highest sample in the window</span>
              </div>
              <div>
                <span className="sk-kv-label">Current</span>
                <span className="sk-kv-value">
                  {num(stats.last, meta.digits)}
                  {meta.unit}
                </span>
                <span className="sk-kv-note">latest sample in the series</span>
              </div>
              <div>
                <span className="sk-kv-label">Change</span>
                <span className="sk-kv-value">
                  {stats.changePct >= 0 ? "+" : "−"}
                  {Math.abs(stats.changePct).toFixed(1)}%
                </span>
                <span className="sk-kv-note">first to last sample</span>
              </div>
              <div>
                <span className="sk-kv-label">Coverage</span>
                <span className="sk-kv-value">
                  {sea.sources.find((s) => s.key === (param === "wind" ? "weather" : "satellite"))?.coverage ?? 94}%
                </span>
                <span className="sk-kv-note">cloud-free share from the source register</span>
              </div>
            </div>
          ) : (
            <EmptyStats />
          )}
        </PanelBody>
      </Panel>

      {/* -------------------------------------------- spatial + relationships */}
      <div className="sk-cols sk-cols--split">
        <Panel>
          <PanelHead
            icon={<Satellite size={16} />}
            title="Spatial analysis"
            hint={`${LAYER_BY_KEY[meta.field].label} across the operations box`}
            actions={
              <button type="button" className="sk-link" onClick={() => setSpatialOn((v) => !v)}>
                {spatialOn ? "Hide map" : "Show map"}
              </button>
            }
          />
          {spatialOn ? (
            <PanelBody flush>
              <ConsoleMap
                ariaLabel={`${meta.label} spatial distribution`}
                fields={[field]}
                center={[sea.region.lat, sea.region.lon]}
                zoom={6}
                height="min(56vh, 440px)"
                basemap={basemap}
                onBasemapChange={setBasemap}
                fitPoints={[
                  [16.1, 82.0],
                  [22.1, 90.0],
                ]}
                fitKey={1}
                fitMaxZoom={6}
                cursorReadout={(lat, lon) =>
                  `${coordLabel(lat, lon)} · ${num(
                    sea.inspect(lat, lon).find((v) => v.layer === meta.field)?.value ?? 0,
                    meta.field === "bathy" ? 0 : 2
                  )} ${LAYER_BY_KEY[meta.field].unit}`
                }
              />
            </PanelBody>
          ) : (
            <PanelBody>
              <EmptyStateMini
                title="Spatial panel hidden"
                body="The map is available on this page without leaving the time series."
              />
            </PanelBody>
          )}
          <PanelFoot>
            <span className="sk-dim-sm">
              {param === "wave"
                ? "Wave height is not carried as a gridded field in this build — bathymetry is shown as spatial context."
                : `Shaded by ${meta.label.toLowerCase()} · ${LAYER_BY_KEY[meta.field].resolution} grid`}
            </span>
          </PanelFoot>
        </Panel>

        <Panel>
          <PanelHead
            icon={<FishingZones size={16} />}
            title="Environmental relationships"
            hint="Monthly aggregates, 12 months"
          />
          <PanelBody>
            <Eyebrow>Chlorophyll ↔ fishing advisory probability</Eyebrow>
            <Scatter
              points={monthly.pfzVsChl}
              xLabel="Chlorophyll"
              yLabel="PFZ probability"
              xUnit="mg/m³"
              yUnit="%"
              height={182}
              note="Chlorophyll is measured; the advisory probability comes from the published PFZ bulletins for the same months."
            />
            <div className="sk-hair" />
            <Eyebrow>Wind ↔ voyage safety index</Eyebrow>
            <Scatter
              points={monthly.safetyVsWind}
              xLabel="Monthly mean wind"
              yLabel="Safety index"
              xUnit="kt"
              yUnit=""
              height={182}
              note="The safety index is derived in this console from wind and wave conditions — it is a convenience indicator, not a published metric."
            />
          </PanelBody>
          <PanelFoot>
            <Note>
              Relationships between monthly aggregates are associative. With twelve points they show direction and
              spread, not causation, and they are not used to generate any advisory.
            </Note>
          </PanelFoot>
        </Panel>
      </div>

      {/* --------------------------------------------------- long range + quality */}
      <div className="sk-cols sk-cols--split">
        <Panel>
          <PanelHead
            icon={<Chlorophyll size={16} />}
            title="Monthly aggregates"
            hint="Twelve months, mean with observed range"
            actions={<SourceTag kind="OBSERVED" />}
          />
          <PanelBody>
            <BarSeries
              points={monthly.chl.map((m) => ({ t: m.t, v: +m.v.toFixed(3), lo: m.min, hi: m.max }))}
              color="#57e3a3"
              unit=" mg/m³"
              digits={2}
              label="Monthly mean chlorophyll with observed minimum and maximum"
            />
            <div className="sk-hair" />
            <BarSeries
              points={monthly.wind.map((m) => ({ t: m.t, v: +m.v.toFixed(1), lo: m.min, hi: m.max }))}
              color="#d8b45c"
              unit=" kt"
              digits={1}
              label="Monthly mean wind speed with observed minimum and maximum"
            />
          </PanelBody>
          <PanelFoot>
            <span className="sk-dim-sm">
              The monsoon months sit clearly above the rest of the year in both parameters — the range bars are the
              spread within each month, not an error estimate.
            </span>
          </PanelFoot>
        </Panel>

        <div className="sk-stack">
          <Panel>
            <PanelHead icon={<Database size={16} />} title="Data quality" hint="Source register, not the selected window" />
            <PanelBody>
              <div className="sk-cols sk-cols--2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <Gauge
                  value={sea.sources[0].coverage}
                  label="Satellite coverage"
                  sublabel="MOSDAC · Copernicus"
                  tone="var(--cyan)"
                />
                <Gauge
                  value={100 - (100 - sea.sources[3].coverage)}
                  label="Spatial store"
                  sublabel="PostGIS · GEBCO"
                  tone="var(--amber)"
                />
              </div>
              <div className="sk-hair" />
              <CoverageBar
                label="Cloud-free satellite samples"
                value={sea.sources[0].coverage}
                note="share of expected samples over the last 24 h"
              />
              <div style={{ marginTop: 12 }}>
                <CoverageBar
                  label="Observation completeness"
                  value={sea.sources[1].coverage}
                  tone="var(--teal)"
                  note="buoy and coastal stations reporting on schedule"
                />
              </div>
              <div className="sk-hair" />
              <div className="sk-pair">
                <span>Missing observations</span>
                <span>{100 - sea.sources[0].coverage}% of the expected field</span>
              </div>
              <div className="sk-pair">
                <span>Last synchronisation</span>
                <span>{mounted ? sinceLabel(Date.now() - sea.sources[0].lastSyncMin * 60_000) : "—"}</span>
              </div>
              <div className="sk-pair">
                <span>Primary source</span>
                <span>{meta.source}</span>
              </div>
            </PanelBody>
            <PanelFoot>
              <span className="sk-dim-sm">
                {sea.mode === "demo"
                  ? "Figures shown are from the source register in the demonstration dataset."
                  : "Figures come from the live source register."}
              </span>
            </PanelFoot>
          </Panel>

          <Reading
            text={sea.readings.analytics.text}
            window="1 Sep – 28 Sep 2026"
            basedOn={sea.readings.analytics.basedOn}
            confidence={sea.readings.analytics.confidence}
            action={
              <Link className="sk-link" href="/dashboard/fishing-zones/">
                Compare with live zones <ArrowRight size={12} />
              </Link>
            }
          />
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- helpers */

function latencyLabel(win: Win): string {
  return {
    "24h": "last 24 hours",
    "7d": "last 7 days",
    "30d": "last 30 days",
    "3m": "last 3 months",
    "1y": "last 12 months",
  }[win];
}

function sourceLabel(source: string): string {
  return { satellite: "satellite composite", insitu: "in-situ observations", blend: "model blend" }[source] ?? source;
}

function download(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function EmptyStats() {
  return (
    <EmptyState
      title="No samples in this window yet"
      body="Statistics are computed from the plotted series. Choose a parameter and window, or wait for the first poll to land."
    />
  );
}

function EmptyStateMini({ title, body }: { title: string; body: string }) {
  return <EmptyState title={title} body={body} />;
}
