"use client";

import { useMemo, useState } from "react";
import type { BasemapKey } from "@/components/seamonk/mapConfig";
import { ConsoleMap } from "@/components/seamonk/ConsoleMapClient";
import { CoverageBar, Gauge } from "@/components/seamonk/charts";
import {
  ArrowRight,
  Chlorophyll,
  Compass,
  Depth,
  FishingZones,
  Filter,
  MapLayers,
  Pin,
  Route as RouteIcon,
  Satellite,
  Thermometer,
  Waves,
} from "@/components/seamonk/icons";
import {
  Drawer,
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
  Delta,
} from "@/components/seamonk/primitives";
import { useSea } from "@/lib/seamonk/DataProvider";
import { LAYER_BY_KEY, pfzAssessment, type LayerKey } from "@/lib/seamonk/design";
import { communityMarkers, fieldSpec, hazardZones, pfzMarkers, pfzZones, placeMarkers } from "@/lib/seamonk/derive";
import { PLACES } from "@/lib/seamonk/demo";
import { coordLabel, distanceNm, nm, num } from "@/lib/seamonk/format";

type SortKey = "probability" | "distance" | "depth";

export default function FishingZonesView() {
  const sea = useSea();
  const [selectedId, setSelectedId] = useState<string | null>(sea.pfz[0]?.id ?? null);
  const [selectionToken, setSelectionToken] = useState(0);
  const [basemap, setBasemap] = useState<BasemapKey>("dark");
  const [context, setContext] = useState<LayerKey>("chl");
  const [sortKey, setSortKey] = useState<SortKey>("probability");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [minProbability, setMinProbability] = useState(45);
  const [maxDistance, setMaxDistance] = useState(200);
  const [maxDepth, setMaxDepth] = useState(400);
  const [showHazards, setShowHazards] = useState(true);
  const [showReports, setShowReports] = useState(true);

  const sorted = useMemo(() => {
    const rows = sea.pfz.filter(
      (z) => z.probability >= minProbability && z.distanceNm <= maxDistance && z.depthM <= maxDepth
    );
    return [...rows].sort((a, b) =>
      sortKey === "probability" ? b.probability - a.probability : sortKey === "distance" ? a.distanceNm - b.distanceNm : a.depthM - b.depthM
    );
  }, [sea.pfz, minProbability, maxDistance, maxDepth, sortKey]);

  const selected = useMemo(
    () => sea.pfz.find((z) => z.id === selectedId) ?? sorted[0] ?? null,
    [sea.pfz, selectedId, sorted]
  );

  const nearestPort = useMemo(() => {
    if (!selected) return PLACES[0];
    return [...PLACES].sort(
      (a, b) =>
        distanceNm([a.lat, a.lon], [selected.lat, selected.lon]) -
        distanceNm([b.lat, b.lon], [selected.lat, selected.lon])
    )[0];
  }, [selected]);

  const approach = useMemo(() => {
    if (!selected) return [];
    const mid: [number, number] = [
      (nearestPort.lat + selected.lat) / 2,
      (nearestPort.lon + selected.lon) / 2,
    ];
    return [
      [nearestPort.lat, nearestPort.lon] as [number, number],
      mid,
      [selected.lat, selected.lon] as [number, number],
    ];
  }, [nearestPort, selected]);

  const field = useMemo(() => fieldSpec(context, sea.gridFor(context), true, 0.46), [context, sea.gridFor]);
  const contextDef = LAYER_BY_KEY[context];

  const zones = useMemo(
    () => [
      ...pfzZones(sorted, selected?.id ?? null),
      ...(showHazards ? hazardZones(sea.hazards) : []),
    ],
    [sorted, selected, sea.hazards, showHazards]
  );

  const markers = useMemo(
    () => [
      ...pfzMarkers(sorted, selected?.id ?? null),
      ...placeMarkers(PLACES.filter((p) => ["digha", "sagar", "chandipur", "paradip", "bakkhali"].includes(p.id))),
      ...(showReports ? communityMarkers(sea.community) : []),
    ],
    [sorted, selected, sea.community, showReports]
  );

  const filterControls = (
    <>
      <div className="sk-field">
        <label htmlFor="fz-prob">Minimum probability — {minProbability}%</label>
        <input
          id="fz-prob"
          className="sk-range"
          type="range"
          min={30}
          max={90}
          step={5}
          value={minProbability}
          onChange={(e) => setMinProbability(+e.target.value)}
          style={{ "--fill": `${((minProbability - 30) / 60) * 100}%` } as React.CSSProperties}
        />
        <span className="sk-field-help">{sea.pfz.filter((z) => z.probability >= minProbability).length} zones at or above this threshold</span>
      </div>
      <div className="sk-field">
        <label htmlFor="fz-dist">Maximum range from {sea.region.short} — {maxDistance} NM</label>
        <input
          id="fz-dist"
          className="sk-range"
          type="range"
          min={20}
          max={200}
          step={10}
          value={maxDistance}
          onChange={(e) => setMaxDistance(+e.target.value)}
          style={{ "--fill": `${((maxDistance - 20) / 180) * 100}%` } as React.CSSProperties}
        />
        <span className="sk-field-help">Fuel and daylight are the practical limits, not the model.</span>
      </div>
      <div className="sk-field">
        <label htmlFor="fz-depth">Maximum depth — {maxDepth} m</label>        <input
          id="fz-depth"
          className="sk-range"
          type="range"
          min={20}
          max={800}
          step={20}
          value={maxDepth}
          onChange={(e) => setMaxDepth(+e.target.value)}
          style={{ "--fill": `${((maxDepth - 20) / 780) * 100}%` } as React.CSSProperties}
        />
        <span className="sk-field-help">Gear and craft length usually set this, not the fish.</span>
      </div>
      <div className="sk-field">
        <label>Time window</label>
        <select className="sk-select" defaultValue="24">
          <option value="24">Next 24 hours</option>
          <option value="48">Next 48 hours</option>
          <option value="72">3-day outlook</option>
        </select>
      </div>
    </>
  );

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Fishing Zones</h1>
          <p>
            Potential fishing zones derived from satellite chlorophyll fronts, sea surface temperature gradients and
            bathymetry — the same three parameters the INCOIS advisory bulletins use.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          <Status tone={sorted.length ? "ok" : "warn"}>
            {sorted.length} zone{sorted.length === 1 ? "" : "s"} pass the filters
          </Status>
          <button type="button" className="sk-btn sk-btn--primary" onClick={() => setFiltersOpen(true)}>
            <Filter size={15} /> Zone filters
          </button>
        </div>
      </div>

      {/* ----------------------------------------------------- inline filters */}
      <div className="sk-toolbar">
        <span className="sk-eyebrow">Refine</span>
        <div className="sk-row sk-gap-sm">
          <span className="sk-dim-sm">Sort by</span>
          <Segmented
            label="Sort zones"
            value={sortKey}
            onChange={(v) => setSortKey(v as SortKey)}
            options={[
              { value: "probability" as SortKey, label: "Probability" },
              { value: "distance" as SortKey, label: "Range" },
              { value: "depth" as SortKey, label: "Depth" },
            ]}
          />
        </div>
        <div className="sk-row sk-gap-sm">
          <span className="sk-dim-sm">Context field</span>
          <Segmented
            label="Map context field"
            value={context}
            onChange={(v) => setContext(v as LayerKey)}
            options={[
              { value: "chl" as LayerKey, label: "Chlorophyll" },
              { value: "sst" as LayerKey, label: "SST" },
              { value: "bathy" as LayerKey, label: "Bathymetry" },
            ]}
          />
        </div>
        <div className="sk-row sk-gap-sm sk-spread">
          <button type="button" className="sk-chip" aria-pressed={showHazards} onClick={() => setShowHazards((v) => !v)}>
            <span className="sk-swatch" style={{ background: "#f05c5c" }} /> Hazards
          </button>
          <button type="button" className="sk-chip" aria-pressed={showReports} onClick={() => setShowReports((v) => !v)}>
            <span className="sk-swatch" style={{ background: "#22d3ee", borderRadius: "50%" }} /> Community
          </button>
        </div>
      </div>

      <div className="sk-cols sk-cols--map">
        <div className="sk-stack">
          <Panel>
            <PanelHead
              icon={<FishingZones size={16} />}
              title="Zone map"
              hint={`${contextDef.label} field · ${contextDef.source}`}
              actions={<span className="sk-tag" data-kind={contextDef.observed}>{contextDef.observed}</span>}
            />
            <PanelBody flush>
              <ConsoleMap
                ariaLabel="Potential fishing zones over the satellite chlorophyll field"
                fields={[field]}
                zones={zones}
                markers={markers}
                routes={approach.length ? [{ id: "approach", points: approach, color: "#f0c25c", width: 2, dashed: true }] : []}
                center={[sea.region.lat, sea.region.lon]}
                zoom={sea.region.zoom}
                height="min(70vh, 620px)"
                basemap={basemap}
                onBasemapChange={setBasemap}
                selectedId={selected?.id ?? null}
                selectionToken={selectionToken}
                onSelectMarker={(id) => {
                  setSelectedId(id);
                  setSelectionToken((t) => t + 1);
                }}
                onInspect={() => undefined}
                cursorReadout={(lat, lon) => {
                  const probe = sea.inspect(lat, lon);
                  const chl = probe.find((p) => p.layer === "chl")?.value ?? 0;
                  return `${coordLabel(lat, lon)} · chl ${chl.toFixed(2)} mg/m³`;
                }}
                fitPoints={
                  sorted.length
                    ? [
                        [Math.min(...sorted.map((z) => z.lat)) - 0.35, Math.min(...sorted.map((z) => z.lon)) - 0.5],
                        [Math.max(...sorted.map((z) => z.lat)) + 0.35, Math.max(...sorted.map((z) => z.lon)) + 0.5],
                      ]
                    : [
                        [16.5, 84.5],
                        [22.1, 89.5],
                      ]
                }
                fitKey={sorted.length}
                fitMaxZoom={7}
                topRight={
                  <div className="sk-mapcard-panel" style={{ width: 214 }}>
                    <div className="sk-mapcard-head">
                      <MapLayers size={13} /> Reading the map
                    </div>
                    <div className="sk-mapcard-body">
                      <div className="sk-legend">
                        <div className="sk-row sk-gap-sm">
                          <span
                            className="sk-swatch"
                            style={{ width: 12, height: 12, background: "rgba(34,197,94,.28)", border: "1.5px solid #22c55e" }}
                          />
                          <span style={{ fontSize: 11.5 }}>PFZ polygon · model</span>
                        </div>
                        <div className="sk-row sk-gap-sm">
                          <span className="sk-swatch" style={{ width: 12, height: 12, background: "rgba(240,92,92,.2)", border: "1.5px dashed #f05c5c" }} />
                          <span style={{ fontSize: 11.5 }}>Hazard · advisory</span>
                        </div>
                        <div className="sk-row sk-gap-sm">
                          <span className="sk-swatch" style={{ marginLeft: 3, background: "#22d3ee", borderRadius: "50%" }} />
                          <span style={{ fontSize: 11.5 }}>Community report</span>
                        </div>
                      </div>
                      <div className="sk-hair" />
                      <p className="sk-dim-sm" style={{ margin: 0, lineHeight: 1.5 }}>
                        Contours are the {contextDef.short.toLowerCase()} field at {contextDef.resolution}. Polygons mark
                        where the three parameters coincide, not where fish certainly are.
                      </p>
                    </div>
                  </div>
                }
              />
            </PanelBody>
            <PanelFoot>
              <span>
                Approach line drawn from {nearestPort.name} — {nm(distanceNm([nearestPort.lat, nearestPort.lon], selected ? [selected.lat, selected.lon] : [0, 0]))} great-circle
              </span>
              <span className="sk-spread sk-dim-sm">Click a polygon or symbol to centre the map on it</span>
            </PanelFoot>
          </Panel>

          {/* --------------------------------------------------- zone detail */}
          {selected ? (
            <Panel>
              <PanelHead
                icon={<Pin size={16} />}
                title={`PFZ #${(sorted.findIndex((z) => z.id === selected.id) + 1).toString().padStart(2, "0")} — ${selected.name}`}
                hint={coordLabel(selected.lat, selected.lon)}
                actions={
                  <>
                    <Status tone={pfzAssessment(selected.probability).tone}>
                      {pfzAssessment(selected.probability).label}
                    </Status>
                    <SourceTag kind="MODEL PREDICTION" />
                  </>
                }
              />
              <PanelBody>
                <div className="sk-cols sk-cols--3">
                  {/* observed conditions */}
                  <div>
                    <Eyebrow>Environmental conditions</Eyebrow>
                    <div style={{ marginTop: 8 }}>
                      <div className="sk-pair">
                        <span>Sea surface temperature</span>
                        <span>
                          {num(selected.sst, 1)} °C
                          <small>observed · INSAT-3DR</small>
                        </span>
                      </div>
                      <div className="sk-pair">
                        <span>Chlorophyll-a</span>
                        <span>
                          {num(selected.chl, 2)} mg/m³
                          <small>observed · Sentinel-3 OLCI</small>
                        </span>
                      </div>
                      <div className="sk-pair">
                        <span>Depth</span>
                        <span>
                          {selected.depthM} m
                          <small>model · GEBCO 2023</small>
                        </span>
                      </div>
                      <div className="sk-pair">
                        <span>Range and bearing</span>
                        <span>
                          {nm(selected.distanceNm)} · {selected.bearing}
                          <small>from {sea.region.short}</small>
                        </span>
                      </div>
                      <div className="sk-pair">
                        <span>Best window</span>
                        <span>{selected.bestWindow}</span>
                      </div>
                    </div>
                  </div>

                  {/* why this zone */}
                  <div>
                    <Eyebrow>Why this zone?</Eyebrow>
                    <div className="sk-reason" style={{ marginTop: 8 }}>
                      {selected.reasons.map((r, i) => (
                        <div className="sk-reason-row" key={r}>
                          <span className="sk-reason-op">{i === 0 ? "" : "+"}</span>
                          <span>{r}</span>
                          <SourceTag kind={i === 2 ? "MODEL PREDICTION" : "OBSERVED"} />
                        </div>
                      ))}
                      <div className="sk-reason-row sk-reason-total">
                        <span className="sk-reason-op">=</span>
                        <span>
                          <b>Predicted aggregation of pelagic fish</b>
                          <br />
                          <span className="sk-dim-sm" style={{ fontSize: 11 }}>
                            Coincidence of front, temperature band and shelf edge
                          </span>
                        </span>
                        <span className="sk-val" style={{ fontSize: 16 }}>
                          {selected.probability}%
                        </span>
                      </div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <Note>
                        Chlorophyll and temperature are measurements. The probability is a model output from the PFZ
                        bulletin — it describes coincidence of conditions, not a catch forecast.
                      </Note>
                    </div>
                  </div>

                  {/* confidence + route */}
                  <div>
                    <Eyebrow>Data confidence</Eyebrow>
                    <div style={{ marginTop: 10 }}>
                      <Gauge
                        value={selected.confidence}
                        label="Zone confidence"
                        sublabel={`${selected.source}`}
                        tone="var(--teal)"
                      />
                    </div>
                    <div className="sk-hair" />
                    <Eyebrow>Recommended approach</Eyebrow>
                    <div style={{ marginTop: 8 }}>
                      <div className="sk-pair">
                        <span>Departure</span>
                        <span>{nearestPort.name}</span>
                      </div>
                      <div className="sk-pair">
                        <span>Track distance</span>
                        <span>{nm(distanceNm([nearestPort.lat, nearestPort.lon], [selected.lat, selected.lon]))}</span>
                      </div>
                      <div className="sk-pair">
                        <span>Est. transit · 10 kt</span>
                        <span>{((distanceNm([nearestPort.lat, nearestPort.lon], [selected.lat, selected.lon])) / 10).toFixed(1)} h</span>
                      </div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <CoverageBar
                        label="Sample coverage in zone"
                        value={selected.confidence}
                        tone="var(--teal)"
                        note="cloud-free satellite samples over the last 72 h"
                      />
                    </div>
                  </div>
                </div>
              </PanelBody>
              <PanelFoot>
                <span className="sk-dim-sm">
                  Environmental readings carry a 3-hourly satellite cadence; the probability refreshes with the daily
                  PFZ bulletin.
                </span>
              </PanelFoot>
            </Panel>
          ) : null}
        </div>

        {/* ------------------------------------------------------- zone list */}
        <div className="sk-stack">
          <Panel>
            <PanelHead
              icon={<Compass size={16} />}
              title={selected ? "Selected zone" : "Top zone"}
              hint={selected?.bestTime}
            />
            {selected ? (
              <PanelBody>
                <div className="sk-row" style={{ gap: 12, alignItems: "baseline" }}>
                  <span className="sk-val" style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>
                    {selected.probability}
                  </span>
                  <span className="sk-muted" style={{ fontSize: 12 }}>
                    % probability
                  </span>
                  <span className="sk-spread" />
                  <Status tone={pfzAssessment(selected.probability).tone}>
                    {pfzAssessment(selected.probability).label}
                  </Status>
                </div>
                <h3 className="sk-h2" style={{ marginTop: 8 }}>
                  {selected.name}
                </h3>
                <p className="sk-val sk-muted" style={{ fontSize: 12, margin: "4px 0 12px" }}>
                  {coordLabel(selected.lat, selected.lon)}
                </p>
                <div className="sk-kv-grid">
                  <div>
                    <span className="sk-kv-label">Range</span>
                    <span className="sk-kv-value">{nm(selected.distanceNm)}</span>
                    <span className="sk-kv-note">great-circle from {sea.region.short}</span>
                  </div>
                  <div>
                    <span className="sk-kv-label">Depth</span>
                    <span className="sk-kv-value">{selected.depthM} m</span>
                    <span className="sk-kv-note">shelf position</span>
                  </div>
                  <div>
                    <span className="sk-kv-label">Sea temp</span>
                    <span className="sk-kv-value">{num(selected.sst, 1)} °C</span>
                    <span className="sk-kv-note">
                      <Delta value={sea.conditions.sst_delta_c} unit="°C" neutral /> since yesterday
                    </span>
                  </div>
                  <div>
                    <span className="sk-kv-label">Chlorophyll</span>
                    <span className="sk-kv-value">{num(selected.chl, 2)}</span>
                    <span className="sk-kv-note">mg/m³ surface</span>
                  </div>
                </div>
              </PanelBody>
            ) : (
              <PanelBody>
                <EmptyState
                  title="No zone selected"
                  body="Pick a zone from the list or click a polygon on the map to inspect the conditions behind it."
                />
              </PanelBody>
            )}
            <PanelFoot>
              <span className="sk-dim-sm">{selected?.source ?? ""}</span>
            </PanelFoot>
          </Panel>

          <Panel>
            <PanelHead
              icon={<Satellite size={16} />}
              title="Zone list"
              hint={`${sorted.length} of ${sea.pfz.length}`}
            />
            <PanelBody flush>
              <div className="sk-zone-list">
                {sorted.map((z, i) => (
                  <button
                    key={z.id}
                    type="button"
                    className="sk-zone"
                    data-selected={z.id === selected?.id}
                    onClick={() => {
                      setSelectedId(z.id);
                      setSelectionToken((t) => t + 1);
                    }}
                  >
                    <span className="sk-zone-rank">{i + 1}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="sk-zone-name">
                        {z.name}
                        {i === 0 ? <Status tone="ok">best</Status> : null}
                      </span>
                      <span className="sk-zone-meta">
                        <span>
                          range <b>{nm(z.distanceNm, 0)}</b>
                        </span>
                        <span>
                          depth <b>{z.depthM} m</b>
                        </span>
                        <span>
                          confidence <b>{z.confidence}%</b>
                        </span>
                      </span>
                      <span className="sk-dim-sm" style={{ display: "block", marginTop: 4 }}>
                        {z.bestTime}
                      </span>
                    </span>
                    <span className="sk-zone-right">
                      <span className="sk-zone-pct">{z.probability}%</span>
                      <span className="sk-zone-bar">
                        <i
                          style={{
                            width: `${z.probability}%`,
                            background: z.probability >= 80 ? "#2bd68a" : z.probability >= 65 ? "#7fd67f" : "#e8d24a",
                          }}
                        />
                      </span>
                    </span>
                  </button>
                ))}
                {!sorted.length ? (
                  <EmptyState
                    title="No zones pass these filters"
                    body="Widen the probability threshold or the range. The bulletin's weakest zones sit around 55 %."
                    action={
                      <button
                        type="button"
                        className="sk-btn sk-btn--sm"
                        onClick={() => {
                          setMinProbability(30);
                          setMaxDistance(200);
                          setMaxDepth(800);
                        }}
                      >
                        Reset filters
                      </button>
                    }
                  />
                ) : null}
              </div>
            </PanelBody>
          </Panel>

          <Reading
            text={sea.readings.fishing.text}
            window={sea.readings.fishing.window}
            basedOn={sea.readings.fishing.basedOn}
            confidence={sea.readings.fishing.confidence}
          />
        </div>
      </div>

      {/* --------------------------------------------------------- filters */}
      <Drawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Zone filters"
        footer={
          <>
            <button
              type="button"
              className="sk-btn sk-btn--sm"
              onClick={() => {
                setMinProbability(45);
                setMaxDistance(200);
                setMaxDepth(400);
              }}
            >
              Reset
            </button>
            <button type="button" className="sk-btn sk-btn--sm sk-btn--primary sk-spread" onClick={() => setFiltersOpen(false)}>
              Apply to {sorted.length} zones
            </button>
          </>
        }
      >
        {filterControls}
        <div className="sk-hair" />
        <Eyebrow>How the filter is applied</Eyebrow>
        <p className="sk-body-text" style={{ marginTop: 6 }}>
          Filters act on the published zone table, not on the underlying satellite grid, so a zone that fails one
          threshold disappears entirely rather than being shaded out. That keeps the map and the list in agreement.
        </p>
      </Drawer>
    </>
  );
}
