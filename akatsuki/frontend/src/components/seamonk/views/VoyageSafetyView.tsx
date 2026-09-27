"use client";

import { useMemo, useState } from "react";
import type { BasemapKey } from "@/components/seamonk/mapConfig";
import { ConsoleMap } from "@/components/seamonk/ConsoleMapClient";
import {
  Anchor,
  Clock,
  Compass,
  Depth,
  MapLayers,
  Route as RouteIcon,
  ShieldCheck,
  Ship,
  Squall,
  Waves,
  Wind,
} from "@/components/seamonk/icons";
import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  Eyebrow,
  Field,
  Note,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Reading,
  SourceTag,
  Status,
  Timeline,
  type Column,
} from "@/components/seamonk/primitives";
import { useSea } from "@/lib/seamonk/DataProvider";
import { LAYER_BY_KEY, type LayerKey } from "@/lib/seamonk/design";
import { fieldSpec, hazardZones, placeMarkers, routeSpec } from "@/lib/seamonk/derive";
import { PLACES, sampleField, type Hazard } from "@/lib/seamonk/demo";
import { coordLabel, duration, nm, num } from "@/lib/seamonk/format";
import { planRoutes, type PlannedRoute } from "@/lib/seamonk/voyage";

const CRAFT = [
  { id: "dinghy", label: "Wooden dinghy", lengthM: 6, safeWaveM: 1.2 },
  { id: "fishing", label: "Fishing boat", lengthM: 12, safeWaveM: 1.8 },
  { id: "trawler", label: "Trawler", lengthM: 18, safeWaveM: 2.4 },
  { id: "patrol", label: "Patrol craft", lengthM: 14, safeWaveM: 2.0 },
  { id: "research", label: "Research vessel", lengthM: 30, safeWaveM: 3.5 },
];

const RISK_TONE: Record<string, "ok" | "info" | "warn" | "danger"> = {
  ok: "ok",
  info: "info",
  warn: "warn",
  danger: "danger",
};

export default function VoyageSafetyView() {
  const sea = useSea();
  const [fromId, setFromId] = useState("digha");
  const [toId, setToId] = useState("sagar");
  const [departure, setDeparture] = useState("08:40");
  const [craftId, setCraftId] = useState("fishing");
  const [speed, setSpeed] = useState(10);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<PlannedRoute[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>("dark");
  const [fieldLayer, setFieldLayer] = useState<LayerKey>("bathy");
  const [touched, setTouched] = useState(false);

  const from = PLACES.find((p) => p.id === fromId)!;
  const to = PLACES.find((p) => p.id === toId)!;
  const craft = CRAFT.find((c) => c.id === craftId)!;
  const samePoint = fromId === toId;
  const speedInvalid = !Number.isFinite(speed) || speed < 1 || speed > 30;

  const field = useMemo(() => fieldSpec(fieldLayer, sea.gridFor(fieldLayer), true, 0.4), [fieldLayer, sea.gridFor]);
  const fieldDef = LAYER_BY_KEY[fieldLayer];

  const active = plan?.find((r) => r.id === activeId) ?? plan?.find((r) => r.recommended) ?? null;

  const run = () => {
    setTouched(true);
    if (samePoint || speedInvalid) return;
    setBusy(true);
    // The computation is synchronous; the delay only makes the pending state
    // perceivable. No network call is implied or claimed.
    window.setTimeout(() => {
      const result = planRoutes({
        from,
        to,
        speedKt: speed,
        departure,
        conditions: sea.conditions,
        hazards: sea.hazards,
        sample: sampleField,
        craft,
      });
      setPlan(result);
      setActiveId(result.find((r) => r.recommended)?.id ?? result[0].id);
      setBusy(false);
    }, 420);
  };

  const reading = useMemo(() => {
    if (!active || !plan) return null;
    const others = plan.filter((r) => r.id !== active.id);
    const shortest = [...others].sort((a, b) => a.distanceNm - b.distanceNm)[0];
    const extra = active.distanceNm - shortest.distanceNm;
    const parts: string[] = [];
    parts.push(
      `${active.label} is the track to take: ${active.distanceNm.toFixed(1)} NM, about ${duration(active.hours)} at ${speed} kt.`
    );
    if (active.minDepthM >= 10) parts.push(`It keeps ${active.minDepthM} m under the keel the whole way.`);
    else parts.push(`Watch the ${active.minDepthM} m shoal crossing — keep a lookout and reduce speed there.`);
    if (extra > 0.4)
      parts.push(
        `Route ${shortest.code} saves ${extra.toFixed(1)} NM but ${shortest.hazardsOnTrack.length >= active.hazardsOnTrack.length ? "passes closer to" : "is a tighter track against"} the registered hazards.`
      );
    if (active.maxWaveM > craft.safeWaveM) parts.push(`At ${num(active.maxWaveM, 1)} m the wave height is above this craft's working limit — consider delaying.`);
    return {
      text: parts.slice(0, 3).join(" "),
      basis: [
        "IMD wind forecast",
        "Wave model run 00Z",
        `Tide tables, ${from.name}`,
        `${sea.hazards.length} registered hazards`,
      ],
    };
  }, [active, plan, speed, craft, from.name, sea.hazards.length]);

  const hazardColumns: Array<Column<Hazard>> = [
    {
      key: "label",
      header: "Hazard",
      sortValue: (h) => h.label,
      render: (h) => (
        <span>
          <span className="sk-td-strong">{h.label}</span>
          <br />
          <span className="sk-td-dim">{h.detail}</span>
        </span>
      ),
    },
    { key: "kind", header: "Class", sortValue: (h) => h.kind, render: (h) => <span className="sk-td-dim">{h.kind}</span> },
    {
      key: "pos",
      header: "Position",
      sortValue: (h) => h.lat,
      render: (h) => <span className="sk-val">{coordLabel(h.lat, h.lon)}</span>,
    },
    { key: "radius", header: "Radius", align: "right", sortValue: (h) => h.radiusKm, render: (h) => `${h.radiusKm} km` },
    {
      key: "sev",
      header: "Severity",
      render: (h) => (
        <Status tone={h.severity === "hazard" ? "danger" : h.severity === "caution" ? "warn" : "info"}>
          {h.severity === "hazard" ? "Hazard" : h.severity === "caution" ? "Caution" : "Advisory"}
        </Status>
      ),
    },
    { key: "source", header: "Source", render: (h) => <span className="sk-td-dim">{h.source}</span> },
  ];

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Voyage Safety</h1>
          <p>
            Whether a planned passage is workable, what it will cost in distance, and where the risk sits along the
            track. Route options are computed from the live fields and the hazard register — not looked up.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          <span className="sk-chip">
            <RouteIcon size={13} /> {from.name} → {to.name}
          </span>
          <span className="sk-chip">
            <Ship size={13} /> {craft.label} · {speed} kt
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------- route planner */}
      <Panel>
        <PanelHead
          icon={<RouteIcon size={16} />}
          title="Route planner"
          hint="Departure, destination, craft and speed"
          actions={
            <Status tone="info">
              <Waves size={12} /> wave {num(sea.conditions.wave_height_m, 1)} m · wind {sea.conditions.wind_kt} kt
            </Status>
          }
        />
        <PanelBody>
          <div className="sk-cols sk-cols--4">
            <Field label="Departure" htmlFor="vs-from">
              <select id="vs-from" className="sk-select" value={fromId} onChange={(e) => setFromId(e.target.value)}>
                {PLACES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.state}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Destination"
              htmlFor="vs-to"
              error={touched && samePoint ? "Departure and destination must differ." : undefined}
            >
              <select
                id="vs-to"
                className="sk-select"
                value={toId}
                aria-invalid={touched && samePoint}
                onChange={(e) => setToId(e.target.value)}
              >
                {PLACES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.state}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Departure time (IST)" htmlFor="vs-time">
              <input
                id="vs-time"
                className="sk-input sk-mono"
                type="time"
                value={departure}
                onChange={(e) => setDeparture(e.target.value)}
              />
            </Field>
            <Field label="Craft" htmlFor="vs-craft" hint={`Safe working limit ${craft.safeWaveM} m significant wave height`}>
              <select id="vs-craft" className="sk-select" value={craftId} onChange={(e) => setCraftId(e.target.value)}>
                {CRAFT.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.lengthM} m)
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="sk-row" style={{ marginTop: 14, gap: 14 }}>
            <div style={{ width: 168 }}>
              <Field
                label="Cruising speed"
                htmlFor="vs-speed"
                error={touched && speedInvalid ? "Enter 1–30 knots." : undefined}
                hint={speedInvalid ? undefined : `${nm(speed / 60, 2)} per minute`}
              >
                <div className="sk-row sk-row--nowrap sk-gap-sm">
                  <input
                    id="vs-speed"
                    className="sk-input sk-mono"
                    type="number"
                    min={1}
                    max={30}
                    step={0.5}
                    value={speed}
                    aria-invalid={touched && speedInvalid}
                    onChange={(e) => setSpeed(+e.target.value)}
                  />
                  <span className="sk-dim-sm">kt</span>
                </div>
              </Field>
            </div>
            <div className="sk-spread sk-row" style={{ alignItems: "flex-end", gap: 10 }}>
              <span className="sk-dim-sm" style={{ maxWidth: 340, lineHeight: 1.5 }}>
                Analysis intersects the track with every registered hazard and evaluates wave, wind, visibility and
                least depth along each leg.
              </span>
              <Button variant="primary" onClick={run} busy={busy} disabled={samePoint || speedInvalid}>
                {busy ? "Computing exposure" : "Analyze route"}
              </Button>
            </div>
          </div>
        </PanelBody>
        <PanelFoot>
          <span className="sk-dim-sm">
            Craft limits are working guidance for small vessels, not a seaworthiness certificate. The master keeps the
            decision.
          </span>
        </PanelFoot>
      </Panel>

      {/* ------------------------------------------------------- map + result */}
      <div className="sk-cols sk-cols--map">
        <Panel>
          <PanelHead
            icon={<RouteIcon size={16} />}
            title="Route map"
            hint={plan ? "All evaluated tracks — dashed routes were not selected" : "Preview track"}
            actions={
              <div className="sk-row sk-gap-sm">
                <Segmented_mini value={fieldLayer} onChange={setFieldLayer} />
              </div>
            }
          />
          <PanelBody flush>
            <ConsoleMap
              ariaLabel={`Route map from ${from.name} to ${to.name}`}
              fields={[field]}
              zones={hazardZones(sea.hazards)}
              markers={placeMarkers(PLACES)}
              routes={
                plan
                  ? plan.map((r) => routeSpec(r.id, r.code, r.waypoints, r.id === active?.id))
                  : [
                      {
                        id: "preview",
                        points: [
                          [from.lat, from.lon],
                          [to.lat, to.lon],
                        ],
                        color: "rgba(140,170,200,.6)",
                        width: 2,
                        dashed: true,
                      },
                    ]
              }
              center={[sea.region.lat, sea.region.lon]}
              zoom={sea.region.zoom}
              height="min(68vh, 600px)"
              basemap={basemap}
              onBasemapChange={setBasemap}
              fitPoints={[
                [Math.min(from.lat, to.lat) - 0.35, Math.min(from.lon, to.lon) - 0.45],
                [Math.max(from.lat, to.lat) + 0.35, Math.max(from.lon, to.lon) + 0.45],
              ]}
              fitKey={fromId === toId ? 1 : 2}
              fitMaxZoom={10}
              topRight={
                <div className="sk-mapcard-panel" style={{ width: 208 }}>
                  <div className="sk-mapcard-head">
                    <MapLayers size={13} /> Depth field
                  </div>
                  <div className="sk-mapcard-body">
                    <p className="sk-dim-sm" style={{ margin: "0 0 8px", lineHeight: 1.5 }}>
                      Bathymetry is the decisive layer for a coastal passage — the 10 m and 20 m lines are where sea
                      state changes character.
                    </p>
                    <div className="sk-row sk-gap-sm">
                      <SourceTag kind="MODEL PREDICTION" />
                      <span className="sk-dim-sm">{fieldDef.source}</span>
                    </div>
                  </div>
                </div>
              }
            />
          </PanelBody>
          <PanelFoot>
            <span className="sk-dim-sm">
              Base layer: {fieldDef.label} · {fieldDef.resolution} · shaded from {fieldDef.min} m to {fieldDef.max} m
            </span>
            <span className="sk-spread sk-dim-sm">
              {plan ? `${plan.length} tracks evaluated` : "Run the analysis to evaluate track options"}
            </span>
          </PanelFoot>
        </Panel>

        <div className="sk-stack">
          <Panel>
            <PanelHead
              icon={<ShieldCheck size={16} />}
              title="Route condition"
              hint={active ? `Route ${active.code} · ${active.label}` : undefined}
            />
            {active ? (
              <>
                <PanelBody>
                  <div className="sk-row" style={{ gap: 12, alignItems: "center" }}>
                    <Status tone={RISK_TONE[active.risk] ?? "neutral"}>{active.riskLabel}</Status>
                    {active.recommended ? <Status tone="ok">Recommended</Status> : null}
                  </div>
                  <p className="sk-body-text" style={{ marginTop: 10 }}>
                    {active.summary}
                  </p>
                  <div style={{ marginTop: 6 }}>
                    {active.exposure.map((e) => (
                      <div className="sk-pair" key={e.label}>
                        <span>
                          {e.label}
                          <span className="sk-tag" data-kind={e.kind} style={{ marginLeft: 8 }}>
                            {e.kind === "MODEL PREDICTION" ? "MODEL" : e.kind}
                          </span>
                        </span>
                        <span>
                          {e.value}
                          <small>
                            <Status tone={e.tone} plain>
                              {e.note}
                            </Status>
                          </small>
                        </span>
                      </div>
                    ))}
                  </div>
                </PanelBody>
                <PanelFoot>
                  <Alert tone={active.hazardsOnTrack.length ? "warn" : "ok"}>
                    {active.hazardsOnTrack.length
                      ? `${active.hazardsOnTrack.length} registered hazard${active.hazardsOnTrack.length > 1 ? "s" : ""} on or near this track.`
                      : "No registered hazard intersects this track."}
                  </Alert>
                </PanelFoot>
              </>
            ) : (
              <PanelBody>
                <EmptyState
                  title={busy ? "Computing route exposure" : "No analysis yet"}
                  body={
                    busy
                      ? "Intersecting the track with the hazard register and sampling wave, wind, visibility and depth along each leg."
                      : "Set the departure, destination and craft above, then run the analysis. Three track options are evaluated against the live fields."
                  }
                />
              </PanelBody>
            )}
          </Panel>

          <Panel>
            <PanelHead icon={<Compass size={16} />} title="Route comparison" hint="Select a track to inspect it" />
            <PanelBody tight>
              <div className="sk-stack" style={{ gap: 8 }}>
                {plan ? (
                  plan.map((r) => {
                    const isActive = r.id === active?.id;
                    return (
                      <div key={r.id}>
                        <button
                          type="button"
                          className="sk-route-opt"
                          data-active={isActive}
                          data-recommended={r.recommended}
                          onClick={() => setActiveId(r.id)}
                        >
                          <span className="sk-zone-rank">{r.code}</span>
                          <span style={{ minWidth: 0 }}>
                            <span className="sk-zone-name">
                              {r.label}
                              {r.recommended ? <Status tone="ok">safe pick</Status> : null}
                            </span>
                            <span className="sk-zone-meta">
                              <span>
                                <b>{r.distanceNm.toFixed(1)}</b> NM
                              </span>
                              <span>
                                <b>{duration(r.hours)}</b>
                              </span>
                              <span>
                                least depth <b>{r.minDepthM} m</b>
                              </span>
                            </span>
                            <span className="sk-row" style={{ gap: 8, marginTop: 7 }}>
                              <Status tone={RISK_TONE[r.risk] ?? "neutral"}>{r.riskLabel}</Status>
                              <span className="sk-dim-sm">
                                {r.hazardsOnTrack.length
                                  ? `${r.hazardsOnTrack.length} hazard${r.hazardsOnTrack.length > 1 ? "s" : ""}`
                                  : "clear of hazards"}
                              </span>
                            </span>
                          </span>
                        </button>
                        {isActive ? (
                          <div className="sk-route-detail">
                            <Eyebrow>Why this track</Eyebrow>
                            <p className="sk-body-text" style={{ marginTop: 5 }}>
                              {r.strategy}
                            </p>
                            <div className="sk-kv-grid" style={{ marginTop: 10 }}>
                              <div>
                                <span className="sk-kv-label">Max wave</span>
                                <span className="sk-kv-value">{num(r.maxWaveM, 1)} m</span>
                                <span className="sk-kv-note">
                                  craft limit {craft.safeWaveM} m
                                </span>
                              </div>
                              <div>
                                <span className="sk-kv-label">Max wind</span>
                                <span className="sk-kv-value">{r.maxWindKt} kt</span>
                                <span className="sk-kv-note">{sea.conditions.wind_dir} forecast</span>
                              </div>
                              <div>
                                <span className="sk-kv-label">Arrival</span>
                                <span className="sk-kv-value">{r.timeline[r.timeline.length - 1]?.time}</span>
                                <span className="sk-kv-note">departing {departure} IST</span>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <EmptyState
                    title="Track options appear here"
                    body="Three variants are evaluated: the direct rhumb line, a seaward swing into deeper water, and an inshore shortcut."
                  />
                )}
              </div>
            </PanelBody>
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------------ lower detail */}
      <div className="sk-cols sk-cols--3">
        <Panel>
          <PanelHead
            icon={<Clock size={16} />}
            title="Exposure along the track"
            hint={active ? `Departure ${departure} IST` : undefined}
          />
          <PanelBody>
            {active ? (
              <Timeline items={active.timeline} ariaLabel={`Exposure timeline for route ${active.code}`} />
            ) : (
              <EmptyState
                title="No track selected"
                body="Once a route is evaluated, every leg is listed in order with the time it is expected to be reached."
              />
            )}
          </PanelBody>
          {active ? (
            <PanelFoot>
              <span className="sk-dim-sm">
                Times are forecasts, not observations. Re-run the analysis within an hour of departure.
              </span>
            </PanelFoot>
          ) : null}
        </Panel>

        <Panel>
          <PanelHead
            icon={<Squall size={16} />}
            title="Hazard register"
            hint={`${sea.hazards.length} active in region`}
          />
          <PanelBody flush>
            <DataTable
              columns={hazardColumns}
              rows={sea.hazards}
              rowKey={(h) => h.id}
              initialSortKey="sev"
              initialSortDir="asc"
              caption="Notices, charted restrictions and logged reports for this region"
            />
          </PanelBody>
        </Panel>

        <div className="sk-stack">
          {reading && active ? (
            <Reading
              text={reading.text}
              window={`Departure ${departure} IST`}
              basedOn={reading.basis}
              confidence={active.recommended ? 82 : 74}
            />
          ) : (
            <Reading
              text={sea.readings.safety.text}
              window={sea.readings.safety.window}
              basedOn={sea.readings.safety.basedOn}
              confidence={sea.readings.safety.confidence}
            />
          )}

          <Panel>
            <PanelHead icon={<Anchor size={16} />} title="Reference conditions" hint="What the analysis ran against" />
            <PanelBody tight>
              <div className="sk-pair">
                <span>
                  <Wind size={14} /> Wind
                </span>
                <span>
                  {sea.conditions.wind_kt} kt {sea.conditions.wind_dir}
                  <small>
                    <SourceTag kind="FORECAST" />
                  </small>
                </span>
              </div>
              <div className="sk-pair">
                <span>
                  <Waves size={14} /> Significant wave
                </span>
                <span>
                  {num(sea.conditions.wave_height_m, 1)} m
                  <small>
                    <SourceTag kind="MODEL PREDICTION" />
                  </small>
                </span>
              </div>
              <div className="sk-pair">
                <span>
                  <Depth size={14} /> Shelf depth at midpoint
                </span>
                <span>
                  {Math.round(sampleField("bathy", (from.lat + to.lat) / 2, (from.lon + to.lon) / 2))} m
                  <small>
                    <SourceTag kind="MODEL PREDICTION" />
                  </small>
                </span>
              </div>
              <div className="sk-pair">
                <span>
                  <Compass size={14} /> Great-circle distance
                </span>
                <span>{nm(Math.hypot(to.lat - from.lat, to.lon - from.lon) * 60)}</span>
              </div>
            </PanelBody>
            <PanelFoot>
              <Note>
                Wave and depth are model fields. Wind is an IMD forecast. Tide streams are interpolated from published
                tables at {from.name} and {to.name}.
              </Note>
            </PanelFoot>
          </Panel>
        </div>
      </div>
    </>
  );
}

/** Compact field selector for the map header. */
function Segmented_mini({ value, onChange }: { value: LayerKey; onChange: (v: LayerKey) => void }) {
  const options: Array<{ key: LayerKey; label: string }> = [
    { key: "bathy", label: "Depth" },
    { key: "wind", label: "Wind" },
    { key: "sst", label: "SST" },
  ];
  return (
    <div className="sk-seg" role="group" aria-label="Map field">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className="sk-seg-item"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
