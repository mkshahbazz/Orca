"use client";

import { useMemo, useState } from "react";
import { BASEMAPS, type BasemapKey, type MarkerSpec, type ZoneSpec } from "@/components/seamonk/mapConfig";
import { ConsoleMap } from "@/components/seamonk/ConsoleMapClient";
import {
  Check,
  Crosshair,
  Depth,
  Download,
  FishingZones,
  Grid,
  MapLayers,
  Pin,
  Radar,
  Waves,
  Wind,
} from "@/components/seamonk/icons";
import {
  CheckRow,
  Drawer,
  Eyebrow,
  LegendRamp,
  Note,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  SourceTag,
  Status,
  Tabs,
} from "@/components/seamonk/primitives";
import { useSea } from "@/lib/seamonk/DataProvider";
import { LAYERS, LAYER_BY_KEY, rampGradient, type LayerKey } from "@/lib/seamonk/design";
import { communityMarkers, fieldSpec, hazardZones, placeMarkers, stationMarkers } from "@/lib/seamonk/derive";
import { PLACES, isSea } from "@/lib/seamonk/demo";
import { coordLabel, distanceNm, nm, num } from "@/lib/seamonk/format";

type FieldState = { visible: boolean; opacity: number };

/** Non-field overlays. Each entry is a real layer the map can draw. */
const VECTOR_GROUPS: Array<{
  group: string;
  items: Array<{ key: VectorKey; label: string; detail: string; color: string; available: boolean }>;
}> = [
  {
    group: "Weather",
    items: [
      { key: "squall", label: "Storm & squall cells", detail: "IMD nowcast convection corridors", color: "#7ccbf5", available: true },
      { key: "rain", label: "Rainfall rate", detail: "not connected in this build", color: "#7ccbf5", available: false },
      { key: "visibility", label: "Visibility field", detail: "station point values only — see Ocean Watch", color: "#7ccbf5", available: false },
    ],
  },
  {
    group: "Fishing",
    items: [
      { key: "pfz", label: "Potential fishing zones", detail: "current INCOIS bulletin polygons", color: "#22c55e", available: true },
      { key: "shading", label: "Probability shading", detail: "shade each zone by its advisory probability", color: "#2bd68a", available: true },
      { key: "historic", label: "Historical zones", detail: "no PFZ archive loaded in this build", color: "#2bd68a", available: false },
    ],
  },
  {
    group: "Safety",
    items: [
      { key: "hazards", label: "Hazard zones", detail: "registered notices and logged reports", color: "#f05c5c", available: true },
      { key: "restricted", label: "Restricted areas", detail: "port and pilotage boundaries", color: "#e8a33d", available: true },
      { key: "shallow", label: "Shallow water", detail: "shelf and sandbank warnings", color: "#e8a33d", available: true },
      { key: "community", label: "Community reports", detail: "crowdsourced, sensor-verified where possible", color: "#22d3ee", available: true },
    ],
  },
  {
    group: "Reference",
    items: [
      { key: "stations", label: "Observation stations", detail: "buoys, coastal stations, satellite passes", color: "#33b9f2", available: true },
      { key: "places", label: "Ports & landings", detail: "named chart symbols", color: "#d8b45c", available: true },
    ],
  },
];

type VectorKey = "squall" | "rain" | "visibility" | "pfz" | "shading" | "historic" | "hazards" | "restricted" | "shallow" | "community" | "stations" | "places";

const DEFAULT_VECTORS: Record<VectorKey, boolean> = {
  squall: false,
  rain: false,
  visibility: false,
  pfz: true,
  shading: true,
  historic: false,
  hazards: true,
  restricted: true,
  shallow: true,
  community: true,
  stations: true,
  places: true,
};

export default function MapLayersView() {
  const sea = useSea();
  const [tab, setTab] = useState<"layers" | "inspector" | "legend">("layers");
  const [panelOpen, setPanelOpen] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKey>("dark");
  const [fields, setFields] = useState<Record<LayerKey, FieldState>>({
    sst: { visible: false, opacity: 0.5 },
    chl: { visible: true, opacity: 0.5 },
    wind: { visible: false, opacity: 0.45 },
    bathy: { visible: true, opacity: 0.4 },
  });
  const [vectors, setVectors] = useState<Record<VectorKey, boolean>>(DEFAULT_VECTORS);
  const [probe, setProbe] = useState<{ lat: number; lon: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const visibleFields = useMemo(
    () =>
      LAYERS.filter((l) => fields[l.key].visible).map((l) =>
        fieldSpec(l.key, sea.gridFor(l.key), true, fields[l.key].opacity)
      ),
    [fields, sea.gridFor]
  );

  const probabilityColor = (p: number) => (p >= 80 ? "#2bd68a" : p >= 65 ? "#7fd67f" : "#e8d24a");

  const zones = useMemo(() => {
    const out: ZoneSpec[] = [];
    if (vectors.pfz) {
      out.push(
        ...sea.pfz.map((z) => ({
          id: z.id,
          kind: "pfz" as const,
          label: `${z.name} · ${z.probability}%`,
          detail: `${nm(z.distanceNm)} · depth ${z.depthM} m`,
          color: vectors.shading ? probabilityColor(z.probability) : "#22c55e",
          tone: (z.probability >= 65 ? "ok" : "info") as "ok" | "info",
          lat: z.lat,
          lon: z.lon,
          radiusKm: 12,
          ring: z.polygons,
        }))
      );
    }
    hazardZones(sea.hazards).forEach((z) => {
      const kindMatch =
        (vectors.hazards && z.kind !== "restricted" && z.kind !== "shallow" && z.kind !== "squall") ||
        (vectors.restricted && z.kind === "restricted") ||
        (vectors.shallow && z.kind === "shallow") ||
        (vectors.squall && z.kind === "squall");
      if (kindMatch) out.push(z);
    });
    return out;
  }, [sea.pfz, sea.hazards, vectors]);

  const markers = useMemo(() => {
    const out: MarkerSpec[] = [];
    if (vectors.places) out.push(...placeMarkers(PLACES));
    if (vectors.stations) out.push(...stationMarkers(sea.observations));
    if (vectors.community) out.push(...communityMarkers(sea.community));
    return out;
  }, [sea.observations, sea.community, vectors]);

  const probeValues = useMemo(() => (probe ? sea.inspect(probe.lat, probe.lon) : []), [probe, sea.inspect]);

  const nearestZone = useMemo(() => {
    if (!probe) return null;
    return [...sea.pfz]
      .map((z) => ({ z, d: distanceNm([probe.lat, probe.lon], [z.lat, z.lon]) }))
      .sort((a, b) => a.d - b.d)[0];
  }, [probe, sea.pfz]);

  const copyCoords = async () => {
    if (!probe) return;
    const text = `${probe.lat.toFixed(4)}, ${probe.lon.toFixed(4)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const exportLayers = () => {
    const payload = {
      region: sea.region.name,
      generated: new Date().toISOString(),
      dataMode: sea.mode,
      scalarFields: LAYERS.filter((l) => fields[l.key].visible).map((l) => ({
        layer: l.key,
        label: l.label,
        unit: l.unit,
        source: l.source,
        resolution: l.resolution,
        observationType: l.observed,
        opacity: fields[l.key].opacity,
        samples: sea.gridFor(l.key)?.length ?? 0,
      })),
      overlays: (Object.keys(vectors) as VectorKey[]).filter((k) => vectors[k]),
      zoneCount: zones.length,
      markerCount: markers.length,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `seamonk-layer-state.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const layerManager = (
    <>
      <div className="sk-group-head">
        <Eyebrow>Ocean</Eyebrow>
        <span className="sk-spread" />
        <button
          type="button"
          className="sk-link"
          onClick={() =>
            setFields({ sst: { visible: true, opacity: 0.5 }, chl: { visible: true, opacity: 0.5 }, wind: { visible: true, opacity: 0.45 }, bathy: { visible: true, opacity: 0.4 } })
          }
        >
          Show all four
        </button>
      </div>
      <div style={{ padding: "4px 10px 10px" }}>
        {LAYERS.filter((l) => l.group === "ocean").map((l) => (
          <FieldRow
            key={l.key}
            layerKey={l.key}
            state={fields[l.key]}
            onChange={(s) => setFields((f) => ({ ...f, [l.key]: s }))}
          />
        ))}
        <div className="sk-check" style={{ opacity: 0.5 }}>
          <input type="checkbox" disabled aria-label="Wave height field (unavailable)" />
          <span>
            Wave height field
            <small>Not carried as a grid in this build — read it from the trace on Ocean Watch.</small>
          </span>
        </div>
      </div>

      {VECTOR_GROUPS.map((group) => (
        <div key={group.group}>
          <div className="sk-group-head">
            <Eyebrow>{group.group}</Eyebrow>
          </div>
          <div style={{ padding: "4px 10px 10px" }}>
            {group.items.map((item) => (
              <label className="sk-check" key={item.key} style={item.available ? undefined : { opacity: 0.45 }}>
                <input
                  type="checkbox"
                  checked={vectors[item.key]}
                  disabled={!item.available}
                  onChange={(e) => setVectors((v) => ({ ...v, [item.key]: e.target.checked }))}
                />
                <span>
                  <span className="sk-row sk-gap-sm">
                    <span className="sk-swatch" style={{ background: item.color }} />
                    {item.label}
                  </span>
                  <small>{item.detail}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div style={{ padding: "10px 14px 16px" }}>
        <Note>
          Opacity applies to scalar fields only. Vector overlays keep a hairline stroke so the field underneath stays
          readable — that is deliberate, not a limitation.
        </Note>
      </div>
    </>
  );

  const legendPanel = (
    <div style={{ padding: 14 }}>
      <Eyebrow>Active legend</Eyebrow>
      <div className="sk-legend" style={{ marginTop: 12 }}>
        {visibleFields.map((f) => {
          const def = LAYER_BY_KEY[f.key as LayerKey];
          return (
            <LegendRamp
              key={f.key}
              label={`${def.short} (${def.unit})`}
              gradient={rampGradient(def.ramp)}
              ticks={[def.min, (def.min + def.max) / 2, def.max]}
              unit=""
            />
          );
        })}
        {!visibleFields.length ? (
          <p className="sk-dim-sm" style={{ margin: 0 }}>
            No scalar field is active. Turn one on in the Layers tab and its scale will appear here.
          </p>
        ) : null}
      </div>
      <div className="sk-hair" />
      <Eyebrow>Overlays</Eyebrow>
      <div className="sk-stack" style={{ gap: 7, marginTop: 10 }}>
        {vectors.pfz ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ width: 12, height: 12, background: "rgba(34,197,94,.25)", border: "1.5px solid #22c55e" }} />
            PFZ polygon{vectors.shading ? " — shaded by probability" : ""}
          </span>
        ) : null}
        {vectors.hazards ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ width: 12, height: 12, background: "rgba(240,92,92,.2)", border: "1.5px dashed #f05c5c" }} />
            Hazard zone
          </span>
        ) : null}
        {vectors.restricted ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ width: 12, height: 12, background: "rgba(232,163,61,.2)", border: "1.5px dashed #e8a33d" }} />
            Restricted area
          </span>
        ) : null}
        {vectors.shallow ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ width: 12, height: 12, background: "rgba(232,163,61,.2)", border: "1.5px dashed #e8a33d" }} />
            Shallow water
          </span>
        ) : null}
        {vectors.squall ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ width: 12, height: 12, background: "rgba(124,203,245,.2)", border: "1.5px dashed #7ccbf5" }} />
            Storm &amp; squall cell
          </span>
        ) : null}
        {vectors.community ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ borderRadius: "50%", background: "#22d3ee" }} />
            Community report · verified
          </span>
        ) : null}
        {vectors.stations ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ borderRadius: "50%", background: "#33b9f2" }} />
            Observation station
          </span>
        ) : null}
        {vectors.places ? (
          <span className="sk-legend-key">
            <span className="sk-swatch" style={{ background: "#d8b45c" }} />
            Port or landing
          </span>
        ) : null}
      </div>
      <div className="sk-hair" />
      <Eyebrow>Basemap</Eyebrow>
      <div className="sk-stack" style={{ gap: 4, marginTop: 8 }}>
        {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
          <label className="sk-radio" key={k}>
            <input type="radio" name="basemap-legend" checked={basemap === k} onChange={() => setBasemap(k)} />
            <span>{BASEMAPS[k].label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const inspectorPanel = (
    <div style={{ padding: 14 }}>
      <div className="sk-row" style={{ gap: 10 }}>
        <Eyebrow>Coordinate inspector</Eyebrow>
        <span className="sk-spread" />
        {probe ? (
          <button type="button" className="sk-link" onClick={copyCoords}>
            {copied ? <Check size={12} /> : <Pin size={12} />} {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </div>
      {probe ? (
        <>
          <p className="sk-val" style={{ fontSize: 15, margin: "8px 0 2px" }}>
            {coordLabel(probe.lat, probe.lon)}
          </p>
          <p className="sk-dim-sm" style={{ margin: 0 }}>
            {isSea(probe.lat, probe.lon) ? "Open water" : "Over land — marine fields are masked here"} ·{" "}
            {nm(sea.distanceFromRegion(probe.lat, probe.lon))} from region centre
          </p>
          <div className="sk-hair" />
          {probeValues.map((v) => (
            <div className="sk-inspect-row" key={v.layer}>
              <span>{LAYER_BY_KEY[v.layer].label}</span>
              <b>
                {v.value.toFixed(v.layer === "bathy" ? 0 : 2)} {v.unit}
              </b>
            </div>
          ))}
          {nearestZone && isSea(probe.lat, probe.lon) ? (
            <div className="sk-inspect-row">
              <span>Nearest PFZ — {nearestZone.z.name}</span>
              <b>{nearestZone.z.probability}%</b>
            </div>
          ) : null}
          {nearestZone ? (
            <p className="sk-dim-sm" style={{ marginTop: 10 }}>
              {nearestZone.z.name} lies {nm(nearestZone.d)} away, at {coordLabel(nearestZone.z.lat, nearestZone.z.lon)}.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="sk-empty" style={{ padding: "22px 8px" }}>
            <Crosshair size={22} strokeWidth={1.4} />
            <b>No position chosen</b>
            <p>Click anywhere on the water to read every active parameter at that point.</p>
          </div>
        </>
      )}
      <div className="sk-hair" />
      <Eyebrow>Sampling</Eyebrow>
      <p className="sk-body-text" style={{ marginTop: 6 }}>
        Values come from the same fields drawn on the map at {LAYER_BY_KEY.bathy.resolution} to {LAYER_BY_KEY.sst.resolution}{" "}
        resolution. A single sample is not a sounding — soundings come from the chart, not from this console.
      </p>
    </div>
  );

  const sidePanel = (
    <Panel>
      <Tabs
        label="Layer panel"
        value={tab}
        onChange={(v) => setTab(v)}
        tabs={[
          { value: "layers" as const, label: "Layers", count: visibleFields.length + Object.values(vectors).filter(Boolean).length },
          { value: "inspector" as const, label: "Inspector" },
          { value: "legend" as const, label: "Legend" },
        ]}
      />
      <PanelBody flush>
        {tab === "layers" ? layerManager : tab === "inspector" ? inspectorPanel : legendPanel}
      </PanelBody>
      <PanelFoot>
        <span className="sk-dim-sm">
          {visibleFields.length} field{visibleFields.length === 1 ? "" : "s"} · {zones.length} zones · {markers.length} symbols
        </span>
      </PanelFoot>
    </Panel>
  );

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Map Layers</h1>
          <p>
            A geospatial workspace over the northern Bay of Bengal. Composite any combination of satellite, model and
            advisory layers, then read the exact value under the cursor.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          <span className="sk-chip">
            <Grid size={13} /> {sea.region.name}
          </span>
          <button type="button" className="sk-btn" onClick={exportLayers}>
            <Download size={14} /> Export layer state
          </button>
        </div>
      </div>

      <div className="sk-cols sk-cols--map">
        <Panel>
          <PanelHead
            icon={<MapLayers size={16} />}
            title="Composite map"
            hint={`${visibleFields.length} scalar field${visibleFields.length === 1 ? "" : "s"} · ${BASEMAPS[basemap].label} basemap`}
            actions={
              <button type="button" className="sk-btn sk-btn--sm sk-side-mobile" onClick={() => setPanelOpen(true)}>
                Layers
              </button>
            }
          />
          <PanelBody flush>
            <ConsoleMap
              ariaLabel="Composite geospatial workspace"
              fields={visibleFields}
              zones={zones}
              markers={markers}
              center={[sea.region.lat, sea.region.lon]}
              zoom={7}
              height="min(78vh, 720px)"
              basemap={basemap}
              onBasemapChange={setBasemap}
              onInspect={(lat, lon) => {
                setProbe({ lat, lon });
                setTab("inspector");
              }}
              geolocate
              cursorReadout={(lat, lon) =>
                `${coordLabel(lat, lon)} · depth ${num(
                  sea.inspect(lat, lon).find((v) => v.layer === "bathy")?.value ?? 0,
                  0
                )} m`
              }
              fitPoints={[
                [16.1, 82.0],
                [22.1, 90.0],
              ]}
              fitKey={1}
              fitMaxZoom={6}
              topRight={
                <div className="sk-mapcard-panel" style={{ width: 200 }}>
                  <div className="sk-mapcard-head">
                    <Radar size={13} /> Active readout
                  </div>
                  <div className="sk-mapcard-body">
                    <div className="sk-row sk-gap-sm" style={{ marginBottom: 8 }}>
                      <Status tone={sea.mode === "demo" ? "warn" : "ok"}>
                        {sea.mode === "demo" ? "Demonstration" : "Live composite"}
                      </Status>
                    </div>
                    {visibleFields.map((f) => (
                      <div className="sk-inspect-row" key={f.key}>
                        <span>{LAYER_BY_KEY[f.key as LayerKey].short}</span>
                        <b>{Math.round(f.opacity * 100)}%</b>
                      </div>
                    ))}
                    {!visibleFields.length ? (
                      <p className="sk-dim-sm" style={{ margin: 0 }}>
                        Turn on a scalar field to shade the water.
                      </p>
                    ) : null}
                  </div>
                </div>
              }
            />
          </PanelBody>
          <PanelFoot>
            <span className="sk-dim-sm">
              Wheel zoom activates after a click so the page keeps scrolling normally. Drag to pan, double-click to zoom
              in.
            </span>
            <span className="sk-spread sk-dim-sm">Measure tools and the position fix sit at the top-left of the map</span>
          </PanelFoot>
        </Panel>

        <div className="sk-side-desktop">{sidePanel}</div>
      </div>

      {/* On narrow screens the layer manager becomes a drawer. */}
      <div className="sk-side-mobile" style={{ marginTop: -6 }}>
        <button type="button" className="sk-btn sk-btn--primary sk-btn--block" onClick={() => setPanelOpen(true)}>
          <MapLayers size={15} /> Layer manager, inspector &amp; legend
        </button>
      </div>

      <Drawer
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title="Layers, inspector & legend"
        footer={
          <button type="button" className="sk-btn sk-btn--sm sk-btn--primary sk-btn--block" onClick={() => setPanelOpen(false)}>
            Done
          </button>
        }
      >
        <Tabs
          label="Layer panel"
          value={tab}
          onChange={(v) => setTab(v)}
          tabs={[
            { value: "layers" as const, label: "Layers" },
            { value: "inspector" as const, label: "Inspector" },
            { value: "legend" as const, label: "Legend" },
          ]}
        />
        {tab === "layers" ? layerManager : tab === "inspector" ? inspectorPanel : legendPanel}
      </Drawer>

      <p className="sk-dim-sm" style={{ margin: 0 }}>
        Layer state is held for this session only. <SourceTag kind="DEMO" /> marks sources that are illustrative in the
        demonstration dataset — the labels on each layer say where it really comes from when feeds are live.
      </p>
    </>
  );
}

/* --------------------------------------------------------------- layer row */

function FieldRow({
  layerKey,
  state,
  onChange,
}: {
  layerKey: LayerKey;
  state: FieldState;
  onChange: (s: FieldState) => void;
}) {
  const def = LAYER_BY_KEY[layerKey];
  const icon =
    layerKey === "sst" ? <Waves size={14} /> : layerKey === "chl" ? <FishingZones size={14} /> : layerKey === "wind" ? <Wind size={14} /> : <Depth size={14} />;

  return (
    <div className="sk-layerrow" data-active={state.visible}>
      <CheckRow
        checked={state.visible}
        onChange={(v) => onChange({ ...state, visible: v })}
        label={
          <span className="sk-row sk-gap-sm">
            <span style={{ color: "var(--cyan)", display: "grid" }}>{icon}</span>
            {def.label}
          </span>
        }
        detail={
          <span className="sk-row sk-gap-sm" style={{ gap: 6 }}>
            <SourceTag kind={def.observed} />
            <span>
              {def.source} · {def.resolution}
            </span>
          </span>
        }
      />
      {state.visible ? (
        <div className="sk-layerrow-controls">
          <label className="sk-dim-sm" htmlFor={`op-${layerKey}`}>
            Opacity {Math.round(state.opacity * 100)}%
          </label>
          <input
            id={`op-${layerKey}`}
            className="sk-range"
            type="range"
            min={10}
            max={90}
            step={5}
            value={Math.round(state.opacity * 100)}
            onChange={(e) => onChange({ ...state, opacity: +e.target.value / 100 })}
            style={{ "--fill": `${((state.opacity * 100 - 10) / 80) * 100}%` } as React.CSSProperties}
          />
          <span className="sk-legend-ramp" style={{ background: rampGradient(def.ramp), height: 7, marginTop: 4 }} />
        </div>
      ) : null}
    </div>
  );
}
