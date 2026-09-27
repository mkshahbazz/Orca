"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BASEMAPS, type BasemapKey } from "@/components/seamonk/mapConfig";
import { ConsoleMap } from "@/components/seamonk/ConsoleMapClient";
import { TimeSeries } from "@/components/seamonk/charts";
import {
  ArrowRight,
  Chlorophyll,
  Clock,
  Database,
  Depth,
  MapLayers,
  OceanWatch,
  Pin,
  Refresh,
  Satellite,
  Squall,
  Thermometer,
  Tide,
  Waves,
  Wind,
} from "@/components/seamonk/icons";
import {
  Alert,
  DataTable,
  Drawer,
  Eyebrow,
  Note,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Reading,
  SourceRow,
  SourceTag,
  Status,
  Timeline,
  TimeAgo,
  Delta,
  type Column,
} from "@/components/seamonk/primitives";
import { useMounted, useSea } from "@/lib/seamonk/DataProvider";
import { LAYER_BY_KEY, rampGradient, type LayerKey } from "@/lib/seamonk/design";
import {
  communityMarkers,
  conditionsReadout,
  fieldSpec,
  forecastTimeline,
  hazardZones,
  pfzMarkers,
  pfzZones,
  stationMarkers,
  stationStatus,
} from "@/lib/seamonk/derive";
import { coordLabel, istStamp, num, sinceLabel } from "@/lib/seamonk/format";
import { isSea, type Observation } from "@/lib/seamonk/demo";

const TREND_STYLE: Record<string, string> = {
  sst: "#33b9f2",
  wave: "#2ec4c4",
  wind: "#d8b45c",
  chl: "#57e3a3",
};

/** Layers offered as map fields. Wave height is deliberately absent — see note. */
const FIELD_LAYERS: LayerKey[] = ["sst", "chl", "wind", "bathy"];

export default function OceanWatchView() {
  const sea = useSea();
  const mounted = useMounted();
  const [layer, setLayer] = useState<LayerKey>("sst");
  const [basemap, setBasemap] = useState<BasemapKey>("dark");
  const [showPfz, setShowPfz] = useState(true);
  const [showHazards, setShowHazards] = useState(true);
  const [showCommunity, setShowCommunity] = useState(true);
  const [probe, setProbe] = useState<{ lat: number; lon: number } | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [stationQuery, setStationQuery] = useState<"all" | Observation["kind"]>("all");

  const regionIndex = Math.max(0, sea.regions.findIndex((r) => r.id === sea.region.id));
  const def = LAYER_BY_KEY[layer];

  const readout = useMemo(() => {
    const base = conditionsReadout(sea.conditions, sea.observations);
    return base.map((it) => {
      if (it.key === "sst") return { ...it, delta: <Delta value={sea.conditions.sst_delta_c} unit="°C" neutral /> };
      if (it.key === "chl")
        return { ...it, delta: <Delta value={sea.conditions.chlorophyll_delta} digits={2} neutral /> };
      if (it.key === "wave")
        return { ...it, delta: <Delta value={sea.conditions.wave_delta_m} unit=" m" invertGood /> };
      if (it.key === "wind")
        return { ...it, delta: <span className="sk-dim-sm">gusting {sea.conditions.gust_kt} kt</span> };
      return it;
    });
  }, [sea.conditions, sea.observations]);

  const field = useMemo(
    () => fieldSpec(layer, sea.gridFor(layer), true, layer === "bathy" ? 0.62 : 0.5),
    [layer, sea.gridFor]
  );

  const stations = useMemo(
    () => (stationQuery === "all" ? sea.observations : sea.observations.filter((s) => s.kind === stationQuery)),
    [sea.observations, stationQuery]
  );

  const markers = useMemo(
    () => [
      ...(showPfz ? pfzMarkers(sea.pfz) : []),
      ...(showCommunity ? communityMarkers(sea.community) : []),
      ...stationMarkers(sea.observations),
    ],
    [sea.pfz, sea.community, sea.observations, showPfz, showCommunity]
  );

  const zones = useMemo(
    () => [...(showPfz ? pfzZones(sea.pfz) : []), ...(showHazards ? hazardZones(sea.hazards) : [])],
    [sea.pfz, sea.hazards, showPfz, showHazards]
  );

  const timeline = useMemo(() => forecastTimeline(sea.forecast), [sea.forecast]);
  const probeRows = useMemo(() => (probe ? sea.inspect(probe.lat, probe.lon) : []), [probe, sea.inspect]);

  const stationColumns: Array<Column<Observation>> = [
    {
      key: "label",
      header: "Observation",
      sortValue: (o) => o.label,
      render: (o) => (
        <span>
          <span className="sk-td-strong">{o.label}</span>
          <br />
          <span className="sk-td-dim">{o.source}</span>
        </span>
      ),
    },
    {
      key: "kind",
      header: "Type",
      sortValue: (o) => o.kind,
      render: (o) => <span className="sk-td-dim">{o.kind.replace(/-/g, " ")}</span>,
    },
    {
      key: "sst",
      header: "SST",
      align: "right",
      sortValue: (o) => o.sst,
      render: (o) => `${num(o.sst, 1)} °C`,
    },
    {
      key: "wind",
      header: "Wind",
      align: "right",
      sortValue: (o) => o.windKt,
      render: (o) => (
        <span title={`${o.windKt} knots from ${o.windDir}`}>
          {o.windKt} kt {o.windDir}
        </span>
      ),
    },
    { key: "wave", header: "Wave", align: "right", sortValue: (o) => o.waveM, render: (o) => `${num(o.waveM, 1)} m` },
    {
      key: "age",
      header: "Last fix",
      align: "right",
      sortValue: (o) => o.ageMin,
      render: (o) => <TimeAgo value={Date.now() - o.ageMin * 60_000} />,
    },
    {
      key: "status",
      header: "Read",
      render: (o) => {
        const st = stationStatus(o);
        return <Status tone={st.tone}>{st.label}</Status>;
      },
    },
  ];

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Ocean Watch</h1>
          <p>
            Live marine conditions across the {sea.region.name} and the northern Bay of Bengal. Fields are
            satellite-derived where noted; wind is forecast, not observed.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          <span className="sk-chip">
            <Pin size={13} /> {coordLabel(sea.region.lat, sea.region.lon)}
          </span>
          <span className="sk-chip">
            <Clock size={13} />
            {mounted && sea.generatedAt && sea.mode !== "demo" ? `Updated ${istStamp(sea.generatedAt)}` : "Awaiting live timestamp"}
          </span>
          <button type="button" className="sk-btn sk-btn--primary" onClick={sea.refresh} aria-busy={sea.refreshing}>
            <Refresh size={14} style={sea.refreshing ? { animation: "skSpin .9s linear infinite" } : undefined} />
            {sea.refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------- conditions strip */}
      <div className="sk-readout" role="group" aria-label="Current ocean conditions">
        {readout.map((it) => (
          <div
            className="sk-readout-cell"
            key={it.key}
            style={{ "--tone-accent": `var(--${it.status.tone}-line)` } as React.CSSProperties}
          >
            <div className="sk-readout-label">{it.label}</div>
            <div className="sk-readout-value">
              {it.value}
              {it.unit ? <span>{it.unit}</span> : null}
            </div>
            <div className="sk-readout-meta">
              {it.delta}
              <Status tone={it.status.tone} plain>
                {it.status.label}
              </Status>
            </div>
            <div className="sk-readout-src">{it.source}</div>
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------- map + rail */}
      <div className="sk-cols sk-cols--map">
        <div className="sk-stack">
          <Panel>
            <PanelHead
              icon={<OceanWatch size={16} />}
              title="Live ocean map"
              hint={`${def.label} · ${def.source}`}
              actions={
                <>
                  <span className="sk-tag" data-kind={def.observed}>
                    {def.observed}
                  </span>
                  <Link className="sk-link" href="/dashboard/map-layers/">
                    Layer workspace <ArrowRight size={12} />
                  </Link>
                </>
              }
            />
            <PanelBody flush>
              <ConsoleMap
                ariaLabel={`Live ocean map for the ${sea.region.name}`}
                fields={[field]}
                zones={zones}
                markers={markers}
                center={[sea.region.lat, sea.region.lon]}
                zoom={sea.region.zoom}
                height="min(58vh, 520px)"
                basemap={basemap}
                onBasemapChange={setBasemap}
                onInspect={(lat, lon) => {
                  setProbe({ lat, lon });
                  setInspectorOpen(true);
                }}
                cursorReadout={(lat, lon) => `${coordLabel(lat, lon)} · ${num(sea.inspect(lat, lon).find((v) => v.layer === layer)?.value ?? 0, layer === "bathy" ? 0 : 2)} ${def.unit}`}
                fitPoints={[
                  [sea.region.lat - 1.1, sea.region.lon - 1.6],
                  [sea.region.lat + 1.1, sea.region.lon + 1.6],
                ]}
                fitKey={regionIndex + 1}
                fitMaxZoom={9}
                topRight={
                  <div className="sk-mapcard-panel" style={{ width: 236 }}>
                    <div className="sk-mapcard-head">
                      <MapLayers size={13} /> Field layer
                    </div>
                    <div className="sk-mapcard-body">
                      {FIELD_LAYERS.map((k) => {
                        const l = LAYER_BY_KEY[k];
                        const on = layer === k;
                        return (
                          <button
                            key={k}
                            type="button"
                            className="sk-row sk-gap-sm"
                            onClick={() => setLayer(k)}
                            aria-pressed={on}
                            style={{
                              width: "100%",
                              padding: "6px 4px",
                              borderRadius: 6,
                              background: on ? "rgba(29,111,224,.2)" : "transparent",
                              color: on ? "#fff" : "#b9cfe6",
                              fontSize: 12,
                            }}
                          >
                            <span
                              className="sk-swatch"
                              style={{
                                borderRadius: "50%",
                                background: on ? "radial-gradient(circle, var(--cyan) 40%, transparent 46%)" : "transparent",
                                border: on ? "1.5px solid var(--cyan)" : "1.5px solid #5f87b3",
                              }}
                            />
                            {l.short}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className="sk-row sk-gap-sm"
                        disabled
                        title="Wave height is not carried as a gridded field in this build"
                        style={{ width: "100%", padding: "6px 4px", color: "var(--dim)", fontSize: 12, opacity: 0.55, cursor: "not-allowed" }}
                      >
                        <span className="sk-swatch" style={{ borderRadius: "50%", border: "1.5px dashed #4a6b8c" }} />
                        Wave height
                      </button>
                      <div className="sk-hair" />
                      <div className="sk-legend-row" style={{ gridTemplateColumns: "58px 1fr" }}>
                        <span className="sk-legend-name">{def.short}</span>
                        <span className="sk-legend-ramp" style={{ background: rampGradient(def.ramp) }} />
                      </div>
                      <div className="sk-legend-ticks" style={{ marginTop: 2 }}>
                        <span>
                          {def.min} {def.unit}
                        </span>
                        <span>
                          {def.max} {def.unit}
                        </span>
                      </div>
                      <div className="sk-row sk-gap-sm" style={{ marginTop: 10, gap: 6 }}>
                        <button type="button" className="sk-chip" aria-pressed={showPfz} onClick={() => setShowPfz((v) => !v)}>
                          <span className="sk-swatch" style={{ background: "#22c55e" }} /> PFZ
                        </button>
                        <button type="button" className="sk-chip" aria-pressed={showHazards} onClick={() => setShowHazards((v) => !v)}>
                          <span className="sk-swatch" style={{ background: "#f05c5c" }} /> Hazards
                        </button>
                        <button type="button" className="sk-chip" aria-pressed={showCommunity} onClick={() => setShowCommunity((v) => !v)}>
                          <span className="sk-swatch" style={{ background: "#22d3ee", borderRadius: "50%" }} /> Reports
                        </button>
                      </div>
                    </div>
                  </div>
                }
              />
            </PanelBody>
            <PanelFoot>
              <span>{def.resolution} resolution · {def.cadence} cadence · {def.source}</span>
              <span className="sk-spread sk-dim-sm">
                Basemap: {BASEMAPS[basemap].label} · click the water for a point inspection
              </span>
            </PanelFoot>
          </Panel>

          {/* ------------------------------------------------------ trends */}
          <Panel>
            <PanelHead
              icon={<Waves size={16} />}
              title="Ocean trends"
              hint="Sparse markers are instrument traces, not smoothed model output"
            />
            <PanelBody>
              <div className="sk-cols sk-cols--2">
                <TrendBlock
                  icon={<Thermometer size={14} />}
                  label="Sea surface temperature"
                  window="24 h observed"
                  latest={`${num(sea.conditions.sst_c, 1)} °C`}
                  statusTag={<SourceTag kind="OBSERVED" />}
                >
                  <TimeSeries
                    height={168}
                    unit="°C"
                    valueDigits={1}
                    yLabel="SST °C"
                    series={[
                      {
                        key: "sst",
                        label: "SST (buoy BD08)",
                        color: TREND_STYLE.sst,
                        points: sea.sstTrend,
                        area: true,
                      },
                    ]}
                  />
                </TrendBlock>

                <TrendBlock
                  icon={<Tide size={14} />}
                  label="Wave height"
                  window="12 h significant"
                  latest={`${num(sea.conditions.wave_height_m, 1)} m`}
                  statusTag={<SourceTag kind="MODEL PREDICTION" />}
                >
                  <TimeSeries
                    height={168}
                    unit=" m"
                    valueDigits={2}
                    yLabel="Hs m"
                    series={[
                      { key: "wave", label: "Significant wave height", color: TREND_STYLE.wave, points: sea.waveSeries, area: true },
                    ]}
                  />
                </TrendBlock>

                <TrendBlock
                  icon={<Wind size={14} />}
                  label="Wind speed"
                  window="next 30 h forecast"
                  latest={`${num(sea.conditions.wind_kt, 0)} kt ${sea.conditions.wind_dir}`}
                  statusTag={<SourceTag kind="FORECAST" />}
                >
                  <TimeSeries
                    height={168}
                    unit=" kt"
                    valueDigits={0}
                    yLabel="Wind kt"
                    series={[
                      { key: "wind", label: "Wind speed", color: TREND_STYLE.wind, points: sea.windSeries },
                      {
                        key: "gust",
                        label: "Gust envelope",
                        color: "rgba(216,180,92,.5)",
                        dashed: true,
                        points: sea.windSeries.map((p) => ({ t: p.t, v: +(p.v * 1.28).toFixed(1) })),
                      },
                    ]}
                  />
                </TrendBlock>

                <TrendBlock
                  icon={<Chlorophyll size={14} />}
                  label="Chlorophyll-a"
                  window="7 day composite"
                  latest={`${num(sea.conditions.chlorophyll_mgm3, 2)} mg/m³`}
                  statusTag={<SourceTag kind="OBSERVED" />}
                >
                  <TimeSeries
                    height={168}
                    unit=" mg/m³"
                    valueDigits={2}
                    yLabel="Chl mg/m³"
                    series={[
                      { key: "chl", label: "Chlorophyll-a", color: TREND_STYLE.chl, points: sea.chlorophyllSeries, area: true },
                    ]}
                  />
                </TrendBlock>
              </div>
              <div style={{ marginTop: 12 }}>
                <Note>
                  Wave height is shown as a significant-height trace rather than a map field because the
                  gridded wave product is not connected in this build. Nothing is interpolated to fill the gap.
                </Note>
              </div>
            </PanelBody>
          </Panel>
        </div>

        {/* --------------------------------------------------- right column */}
        <div className="sk-stack">
          <Reading
            text={sea.readings.ocean.text}
            window={sea.readings.ocean.window}
            basedOn={sea.readings.ocean.basedOn}
            confidence={sea.readings.ocean.confidence}
            action={
              <Link className="sk-link" href="/dashboard/reports/">
                Full report <ArrowRight size={12} />
              </Link>
            }
          />

          <Panel>
            <PanelHead
              icon={<Clock size={16} />}
              title="Condition timeline"
              hint="Next 18 h"
            />
            <PanelBody tight>
              {timeline.length ? (
                <Timeline items={timeline} ariaLabel="Marine condition timeline for the next 18 hours" />
              ) : (
                <p className="sk-dim-sm" style={{ padding: 10 }}>
                  Waiting for the forecast window.
                </p>
              )}
            </PanelBody>
            <PanelFoot>
              <span>Tide at {sea.region.name.split(" ")[0]}: high 10:20, low 16:35 IST · range 3.1 m</span>
            </PanelFoot>
          </Panel>

          <Panel>
            <PanelHead icon={<Squall size={16} />} title="Active advisories" hint={`${sea.hazards.length} in region`} />
            <PanelBody tight>
              {sea.hazards.slice(0, 3).map((h) => (
                <div className="sk-notice" key={h.id}>
                  <HazardDot tone={h.severity} />
                  <div className="sk-notice-body">
                    <b>{h.label}</b>
                    <p>{h.detail}</p>
                    <small>
                      Valid {h.validUntil} · {h.source}
                    </small>
                  </div>
                  <Status tone={h.severity === "hazard" ? "danger" : h.severity === "caution" ? "warn" : "info"}>
                    {h.severity === "hazard" ? "Hazard" : h.severity === "caution" ? "Caution" : "Advisory"}
                  </Status>
                </div>
              ))}
            </PanelBody>
            <PanelFoot>
              <Link className="sk-link" href="/dashboard/voyage-safety/">
                Check a voyage against these <ArrowRight size={12} />
              </Link>
            </PanelFoot>
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------------- lower row */}
      <div className="sk-cols sk-cols--3">
        <Panel className="sk-col-span-2">
          <PanelHead
            icon={<Satellite size={16} />}
            title="Observation stations"
            hint="Truth data — satellite passes, buoys and reported fixes"
            actions={
              <select
                className="sk-select"
                style={{ width: 148, height: 28, fontSize: 11.5 }}
                value={stationQuery}
                onChange={(e) => setStationQuery(e.target.value as typeof stationQuery)}
                aria-label="Filter stations by type"
              >
                <option value="all">All sources</option>
                <option value="buoy">Buoys</option>
                <option value="coastal-station">Coastal stations</option>
                <option value="satellite-pass">Satellite passes</option>
                <option value="vessel">Vessel reports</option>
              </select>
            }
          />
          <PanelBody flush>
            <DataTable
              columns={stationColumns}
              rows={stations}
              rowKey={(o) => o.id}
              initialSortKey="age"
              initialSortDir="asc"
              caption={`${stations.length} of ${sea.observations.length} stations shown`}
            />
          </PanelBody>
          <PanelFoot>
            <Status tone="info">{sea.community.filter((c) => c.verified).length} verified community reports</Status>
            <span className="sk-dim-sm">
              Reports that no sensor can confirm stay unverified and carry reduced weight in the confidence score.
            </span>
          </PanelFoot>
        </Panel>

        <div className="sk-stack">
          <Panel>
            <PanelHead icon={<Wind size={16} />} title="Next hours" hint="3-hourly forecast" />
            <PanelBody tight>
              <div className="sk-hours">
                {sea.forecast.slice(0, 8).map((f) => (
                  <div className="sk-hour" key={f.time}>
                    <div className="sk-hour-t">{f.time}</div>
                    <div className="sk-hour-ico" data-night={f.night || undefined}>
                      {f.night ? "\u263E" : "\u2600"}
                    </div>
                    <div className="sk-hour-val">{num(f.temp_c, 1)}°</div>
                    <div className="sk-hour-sm">{f.wind_kt} kt</div>
                    <div className="sk-hour-sm" style={{ color: "#7fb3e0" }}>
                      sea {f.sea}
                    </div>
                  </div>
                ))}
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead icon={<Database size={16} />} title="Data sources" hint="Coverage and freshness" />
            <PanelBody tight>
              {sea.sources.map((s) => (
                <SourceRow
                  key={s.key}
                  icon={
                    s.key === "satellite" ? <Satellite size={14} /> : s.key === "weather" ? <Squall size={14} /> : s.key === "gis" ? <Depth size={14} /> : <Waves size={14} />
                  }
                  name={s.label}
                  status={{
                    tone: s.status === "active" ? "ok" : s.status === "degraded" ? "warn" : "danger",
                    label: s.status === "active" ? "Receiving" : s.status === "degraded" ? "Degraded" : "Offline",
                  }}
                  note={`${s.provider} · ${s.note}`}
                  metrics={[
                    { label: "Coverage", value: `${s.coverage}%` },
                    { label: "Last sync", value: mounted ? sinceLabel(Date.now() - s.lastSyncMin * 60_000) : "—" },
                    { label: "Cadence", value: s.cadence },
                  ]}
                />
              ))}
            </PanelBody>
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------ coordinate drawer */}
      <Drawer
        open={inspectorOpen && !!probe}
        onClose={() => setInspectorOpen(false)}
        title="Point inspection"
        footer={
          <>
            <button type="button" className="sk-btn sk-btn--sm" onClick={() => setInspectorOpen(false)}>
              Close
            </button>
            <Link
              className="sk-btn sk-btn--sm sk-btn--primary"
              href="/dashboard/map-layers/"
              style={{ textDecoration: "none" }}
            >
              Open in map layers
            </Link>
          </>
        }
      >
        {probe ? (
          <>
            <Eyebrow>Coordinates</Eyebrow>
            <p className="sk-val" style={{ fontSize: 15, margin: "6px 0 14px" }}>
              {coordLabel(probe.lat, probe.lon)}
            </p>
            <Eyebrow>Sampled values</Eyebrow>
            {isSea(probe.lat, probe.lon) ? (
              <div style={{ marginTop: 8 }}>
                {probeRows.map((r) => (
                  <div className="sk-pair" key={r.layer}>
                    <span>{LAYER_BY_KEY[r.layer].label}</span>
                    <span>
                      {r.value.toFixed(r.layer === "bathy" ? 0 : 2)} {r.unit}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 8 }}>
                <Alert tone="neutral" title="Selected point is over land.">
                  Marine fields are masked to water. Move the cursor offshore for temperature,
                  chlorophyll, wind or depth at a point.
                </Alert>
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              <Note>
                Values are sampled from the same fields drawn on the map. Satellite fields are 4 km
                interpolated — treat a single point as indicative, not a sounding.
              </Note>
            </div>
          </>
        ) : null}
      </Drawer>
    </>
  );
}

/* -------------------------------------------------------------- sub-blocks */

function TrendBlock({
  icon,
  label,
  window,
  latest,
  statusTag,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  window: string;
  latest: string;
  statusTag: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid var(--line-soft)", borderRadius: "var(--r-md)", padding: "11px 12px 8px", background: "rgba(5,20,36,.5)" }}>
      <div className="sk-row" style={{ gap: 9 }}>
        <span style={{ color: "var(--cyan)", display: "grid" }}>{icon}</span>
        <span className="sk-eyebrow" style={{ color: "var(--muted)" }}>
          {label}
        </span>
        <span className="sk-spread" />
        {statusTag}
      </div>
      <div className="sk-row" style={{ gap: 10, marginTop: 6 }}>
        <span className="sk-val" style={{ fontSize: 17, fontWeight: 600 }}>
          {latest}
        </span>
        <span className="sk-dim-sm">{window}</span>
      </div>
      {children}
    </div>
  );
}

function HazardDot({ tone }: { tone: "advisory" | "caution" | "hazard" }) {
  return (
    <span
      className="sk-hzdot"
      style={{
        background: tone === "hazard" ? "var(--red)" : tone === "caution" ? "var(--amber)" : "var(--cyan)",
      }}
    />
  );
}
