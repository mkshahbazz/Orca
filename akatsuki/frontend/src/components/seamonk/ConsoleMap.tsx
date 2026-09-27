"use client";

/**
 * THE SEAMONK — console map.
 *
 * One map component shared by every geography-first page. Design intent:
 *   · satellite/forecast fields render as a *raster*, not glowing blobs, so
 *     they read the way an oceanographer expects a scalar field to read
 *   · zone geometry keeps a hairline stroke so it never obscures the field
 *   · every reading on the map is available a second time as text in the
 *     coordinate inspector — the map is never the only way to get at data
 *   · measure tools behave like chart tools (continuous readout, no snapping)
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Circle,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  ImageOverlay,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
  ZoomControl,
} from "react-leaflet";
import { coordLabel, distanceNm } from "@/lib/seamonk/format";
import { Crosshair, Ruler, Grid, Close, Pin } from "./icons";
import { Status } from "./primitives";

// Spec types + basemap config live in mapConfig.ts (Leaflet-free) so view code
// can import them without evaluating Leaflet during prerendering. This module
// itself is only ever loaded client-side (next/dynamic, ssr:false).
import { BASEMAPS } from "./mapConfig";
import type { BasemapKey, Cell, FieldSpec, MarkerSpec, RouteSpec, ZoneSpec } from "./mapConfig";
export type { Cell, FieldSpec, ZoneSpec, MarkerSpec, RouteSpec, BasemapKey } from "./mapConfig";
export { BASEMAPS };

/**
 * Thins a sampled field so four simultaneous layers stay interactive.
 *
 * Subsampling happens on a regular lattice rather than by skipping flat
 * indices — a flat stride leaves every other column missing, which draws as
 * stripes. FieldLayer then sizes each rectangle from the *thinned* spacing, so
 * the raster stays gapless at any reduction factor.
 */
function thin(cells: Cell[], max = 360): Cell[] {
  if (cells.length <= max) return cells;
  const lats = Array.from(new Set(cells.map((c) => c.lat))).sort((a, b) => a - b);
  const lons = Array.from(new Set(cells.map((c) => c.lon))).sort((a, b) => a - b);
  const k = Math.ceil(Math.sqrt((lats.length * lons.length) / max));
  if (k <= 1) return cells;
  const keepLat = new Set(lats.filter((_, i) => i % k === 0));
  const keepLon = new Set(lons.filter((_, i) => i % k === 0));
  return cells.filter((c) => keepLat.has(c.lat) && keepLon.has(c.lon));
}

/** Median spacing between distinct coordinates — used to tile the raster. */
function spacings(cells: Cell[]): { dLat: number; dLon: number } {
  const lats = Array.from(new Set(cells.map((c) => c.lat))).sort((a, b) => a - b);
  const lons = Array.from(new Set(cells.map((c) => c.lon))).sort((a, b) => a - b);
  const gap = (arr: number[], fallback: number) => {
    if (arr.length < 2) return fallback;
    const gaps: number[] = [];
    for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i - 1]);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] || fallback;
  };
  return { dLat: gap(lats, 0.3), dLon: gap(lons, 0.3) };
}

/* ------------------------------------------------------------------ helpers */

function MapEvents({
  onPick,
  measure,
  onMeasurePoint,
}: {
  onPick?: (lat: number, lon: number) => void;
  measure: MeasureMode;
  onMeasurePoint: (p: [number, number]) => void;
}) {
  useMapEvents({
    click(e) {
      const p: [number, number] = [e.latlng.lat, e.latlng.lng];
      if (measure !== "off") onMeasurePoint(p);
      onPick?.(p[0], p[1]);
    },
  });
  return null;
}

/** Writes the cursor position straight to the DOM — no re-render per mousemove. */
function CursorBar({ format }: { format: (lat: number, lon: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  useMapEvents({
    mousemove(e) {
      const now = performance.now();
      if (now - last.current < 70) return;
      last.current = now;
      if (ref.current) ref.current.textContent = format(e.latlng.lat, e.latlng.lng);
    },
    mouseout() {
      if (ref.current) ref.current.textContent = "—";
    },
  });
  return (
    <div className="sk-map-overlay sk-map-overlay--bl">
      <div className="sk-coordbar">
        <Crosshair size={13} />
        <span>Cursor</span>
        <b>
          <span ref={ref}>—</span>
        </b>
      </div>
    </div>
  );
}

/**
 * Wheel zoom is opt-in: it is enabled on click and dropped again on mouse-out,
 * so a scroll gesture over the map never steals the page scroll. This is the
 * behaviour operators expect from an embedded chart.
 */
function WheelZoomGuard() {
  const map = useMap();
  useEffect(() => {
    map.scrollWheelZoom.disable();
    const enable = () => map.scrollWheelZoom.enable();
    const disable = () => map.scrollWheelZoom.disable();
    map.on("click", enable);
    map.on("focus", enable);
    map.on("mouseout", disable);
    map.on("blur", disable);
    return () => {
      map.off("click", enable);
      map.off("focus", enable);
      map.off("mouseout", disable);
      map.off("blur", disable);
    };
  }, [map]);
  return null;
}

/**
 * Position fix from the device, requested only when the operator asks for it.
 * A refusal or an unavailable device is reported in place — never silently
 * substituted with a default position.
 */
function GeoLocate({ token }: { token: number }) {
  const map = useMap();
  const [fix, setFix] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNote({ tone: "warn", text: "This browser does not expose a position sensor." });
      return;
    }
    setNote({ tone: "warn", text: "Requesting a position fix…" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setFix(p);
        setNote({
          tone: "ok",
          text: `Fix acquired ±${Math.round(p.accuracy)} m. This is a device position, not a surveyed chart datum.`,
        });
        map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 11), { duration: 1 });
      },
      (err) => {
        setFix(null);
        setNote({
          tone: err.code === err.PERMISSION_DENIED ? "danger" : "warn",
          text:
            err.code === err.PERMISSION_DENIED
              ? "Location permission was refused by the browser."
              : "No position fix available right now.",
        });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
    );
  }, [token, map]);

  if (!token && !note) return null;

  return (
    <>
      {fix ? (
        <Circle
          center={[fix.lat, fix.lon]}
          radius={Math.min(fix.accuracy, 400)}
          pathOptions={{ color: "#2ec4c4", weight: 1.5, fillColor: "#2ec4c4", fillOpacity: 0.2 }}
        >
          <Tooltip className="sk-maptip" direction="top" permanent>
            Your position (±{Math.round(fix.accuracy)} m)
          </Tooltip>
        </Circle>
      ) : null}
      {note ? (
        <div className="sk-map-overlay sk-map-overlay--tl" style={{ top: 130 }}>
          <div className="sk-mapcard-panel" style={{ width: 226 }}>
            <div className="sk-mapcard-head">
              <Crosshair size={13} /> Position fix
            </div>
            <div className="sk-mapcard-body">
              <div className="sk-row" style={{ gap: 8 }}>
                <Status tone={note.tone} plain>
                  {note.tone === "ok" ? "Fixed" : note.tone === "danger" ? "Refused" : "Pending"}
                </Status>
              </div>
              <p className="sk-dim-sm" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
                {note.text}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function FitTo({ points, fitKey, maxZoom = 11 }: { points: [number, number][]; fitKey: number; maxZoom?: number }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], Math.min(maxZoom, 10));
      return;
    }
    const b = L.latLngBounds(points);
    if (b.isValid()) map.fitBounds(b, { padding: [48, 48], maxZoom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  return null;
}

function FlyToSelection({ marker, token }: { marker?: MarkerSpec; token: number }) {
  const map = useMap();
  useEffect(() => {
    if (!marker) return;
    map.flyTo([marker.lat, marker.lon], Math.max(map.getZoom(), 10), { duration: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return null;
}

export type MeasureMode = "off" | "distance" | "area" | "point";

/* -------------------------------------------------------------------- map */

export function ConsoleMap({
  fields = [],
  zones = [],
  markers = [],
  routes = [],
  center = [21.55, 87.9],
  zoom = 9,
  height = 420,
  basemap = "dark",
  onBasemapChange,
  onInspect,
  onSelectMarker,
  selectedId,
  selectionToken = 0,
  fitPoints,
  fitKey = 0,
  fitMaxZoom,
  showTools = true,
  cursorReadout,
  ariaLabel,
  dimFields = 0.9,
  topRight,
  geolocate = false,
}: {
  fields?: FieldSpec[];
  zones?: ZoneSpec[];
  markers?: MarkerSpec[];
  routes?: RouteSpec[];
  center?: [number, number];
  zoom?: number;
  height?: number | string;
  basemap?: BasemapKey;
  onBasemapChange?: (b: BasemapKey) => void;
  onInspect?: (lat: number, lon: number) => void;
  /** Fires when a chart symbol is clicked — pages use this to sync a list. */
  onSelectMarker?: (id: string) => void;
  selectedId?: string | null;
  selectionToken?: number;
  fitPoints?: [number, number][];
  fitKey?: number;
  fitMaxZoom?: number;
  showTools?: boolean;
  cursorReadout?: (lat: number, lon: number) => string;
  ariaLabel: string;
  dimFields?: number;
  /** Overlay pinned to the top-right corner — layer switches, legends. */
  topRight?: ReactNode;
  /** Show the device position-fix tool. Requests permission only on click. */
  geolocate?: boolean;
}) {
  const [measure, setMeasure] = useState<MeasureMode>("off");
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  const [locateToken, setLocateToken] = useState(0);
  const tile = BASEMAPS[basemap];

  // Rasterise once: every layer is reduced to the same display lattice, and the
  // rectangle size comes from that lattice so cells meet edge to edge.
  const prepared = useMemo(() => fields.filter((f) => f.cells.length), [fields]);

  const measureResult = useMemo(() => {
    if (measure === "distance" && measurePoints.length >= 2) {
      let total = 0;
      for (let i = 1; i < measurePoints.length; i++) total += distanceNm(measurePoints[i - 1], measurePoints[i]);
      return `${total.toFixed(2)} NM`;
    }
    if (measure === "area" && measurePoints.length >= 3) {
      const km2 = polygonAreaKm2(measurePoints);
      return `${km2.toFixed(1)} km² · ${(km2 / 3.4299).toFixed(1)} NM²`;
    }
    return null;
  }, [measure, measurePoints]);

  const selectedMarker = markers.find((m) => m.id === selectedId);

  return (
    <div className="sk-mapwrap" style={{ height }} data-basemap={basemap}>
      <div className="sk-map">
        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom={false}
          attributionControl
          zoomControl={false}
          style={{ position: "absolute", inset: 0 }}
          aria-label={ariaLabel}
        >
          <TileLayer key={basemap} url={tile.url} attribution={tile.attribution} maxZoom={18} />

          {prepared
            .filter((f) => f.visible)
            .map((f) => (
              <FieldImage key={f.key} field={f} dim={dimFields} />
            ))}

          {zones.map((z) => (
            <ZoneLayer key={z.id} zone={z} />
          ))}

          {routes.map((r) => (
            <Polyline
              key={r.id}
              positions={r.points}
              pathOptions={{
                color: r.color,
                weight: r.width ?? 2.4,
                opacity: 0.95,
                dashArray: r.dashed ? "5 5" : undefined,
                lineCap: "round",
              }}
            />
          ))}

          {/* measure geometry */}
          {measurePoints.length > 1 ? (
            <Polyline
              positions={measurePoints}
              pathOptions={{ color: "#f0c25c", weight: 2, dashArray: "4 4", opacity: 0.95 }}
            />
          ) : null}
          {measure === "area" && measurePoints.length > 2 ? (
            <Polygon
              positions={measurePoints}
              pathOptions={{ color: "#f0c25c", weight: 1.4, fillOpacity: 0.12, dashArray: "4 4" }}
            />
          ) : null}
          {measurePoints.map((p, i) => (
            <Circle
              key={`mp-${i}`}
              center={p}
              radius={120}
              pathOptions={{ color: "#f0c25c", weight: 2, fillColor: "#f0c25c", fillOpacity: 0.6 }}
            />
          ))}

          {markers.map((m) => (
            <MarkerGlyph key={m.id} marker={m} selected={m.id === selectedId} onSelect={onSelectMarker} />
          ))}

          <WheelZoomGuard />
          <ZoomControl position="topleft" />
          {geolocate ? <GeoLocate token={locateToken} /> : null}
          <MapEvents
            onPick={onInspect}
            measure={measure}
            onMeasurePoint={(p) => setMeasurePoints((prev) => [...prev, p])}
          />
          <CursorBar format={cursorReadout ?? ((lat, lon) => coordLabel(lat, lon))} />
          {fitPoints?.length ? <FitTo points={fitPoints} fitKey={fitKey} maxZoom={fitMaxZoom} /> : null}
          <FlyToSelection marker={selectedMarker} token={selectionToken} />
        </MapContainer>
      </div>

      {/* ---------------------------------------------------------- overlays */}
      {topRight ? <div className="sk-map-overlay sk-map-overlay--tr">{topRight}</div> : null}

      {showTools ? (
        <div className="sk-map-overlay sk-map-overlay--tl" style={{ top: 78 }}>
          <div className="sk-maptools">
            <button
              type="button"
              className="sk-maptool"
              aria-pressed={measure === "off"}
              aria-label="Browse the map"
              title="Browse"
              onClick={() => {
                setMeasure("off");
                setMeasurePoints([]);
              }}
            >
              <Pin size={16} />
            </button>
            <button
              type="button"
              className="sk-maptool"
              aria-pressed={measure === "distance"}
              aria-label="Measure distance"
              title="Measure distance"
              onClick={() => {
                setMeasure((m) => (m === "distance" ? "off" : "distance"));
                setMeasurePoints([]);
              }}
            >
              <Ruler size={16} />
            </button>
            <button
              type="button"
              className="sk-maptool"
              aria-pressed={measure === "area"}
              aria-label="Measure area"
              title="Measure area"
              onClick={() => {
                setMeasure((m) => (m === "area" ? "off" : "area"));
                setMeasurePoints([]);
              }}
            >
              <Grid size={16} />
            </button>
            {geolocate ? (
              <button
                type="button"
                className="sk-maptool"
                aria-pressed={locateToken > 0}
                aria-label="Use my current position"
                title="Use my current position"
                onClick={() => setLocateToken((t) => t + 1)}
              >
                <Crosshair size={16} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {measure !== "off" ? (
        <div className="sk-map-overlay sk-map-overlay--tl" style={{ top: showTools ? 202 : 12 }}>
          <div className="sk-mapcard-panel" style={{ width: 210 }}>
            <div className="sk-mapcard-head">
              {measure === "area" ? <Grid size={13} /> : <Ruler size={13} />}
              {measure === "area" ? "Area measure" : "Distance measure"}
            </div>
            <div className="sk-mapcard-body">
              <div className="sk-row" style={{ justifyContent: "space-between" }}>
                <span className="sk-val" style={{ fontSize: 13 }}>
                  {measureResult ?? "Click two or more points"}
                </span>
                <button
                  type="button"
                  className="sk-link"
                  onClick={() => setMeasurePoints([])}
                  aria-label="Clear measurement"
                >
                  <Close size={13} /> Clear
                </button>
              </div>
              <div className="sk-dim-sm" style={{ marginTop: 6 }}>
                {measurePoints.length} point{measurePoints.length === 1 ? "" : "s"} placed · great-circle
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {onBasemapChange ? (
        <div className="sk-map-overlay sk-map-overlay--br">
          <div className="sk-row sk-gap-sm" style={{ background: "rgba(4,17,32,.9)", border: "1px solid var(--line-hair)", borderRadius: "var(--r-sm)", padding: 3 }}>
            {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className="sk-seg-item"
                aria-pressed={basemap === k}
                onClick={() => onBasemapChange(k)}
                style={{ fontSize: 10.5, padding: "4px 8px" }}
              >
                {BASEMAPS[k].label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ layers */

/**
 * Scalar field rendered as a raster image rather than a grid of rectangles.
 *
 * A DOM node per sample is both slow and visibly blocky once the operator
 * zooms in. Painting the samples once into a canvas and handing the result to
 * an image overlay gives a continuous field at any zoom — the way a satellite
 * composite is actually presented — with a single layer in the DOM.
 *
 * Missing cells are left transparent, which is what produces the soft coastal
 * edge where the land mask cuts the field.
 */
function FieldImage({ field, dim }: { field: FieldSpec; dim: number }) {
  const raster = useMemo(() => {
    if (!field.cells.length) return null;
    const lats = Array.from(new Set(field.cells.map((c) => c.lat))).sort((a, b) => a - b);
    const lons = Array.from(new Set(field.cells.map((c) => c.lon))).sort((a, b) => a - b);
    const rows = lats.length;
    const cols = lons.length;
    if (rows < 2 || cols < 2) return null;

    const latIndex = new Map(lats.map((v, i) => [v, i]));
    const lonIndex = new Map(lons.map((v, i) => [v, i]));
    const span = field.max - field.min || 1;

    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(cols, rows);

    field.cells.forEach((c) => {
      const row = rows - 1 - (latIndex.get(c.lat) ?? 0); // canvas origin is top-left
      const col = lonIndex.get(c.lon) ?? 0;
      const t = Math.max(0, Math.min(1, (c.v - field.min) / span));
      const rgb = parseRgb(field.ramp(t));
      if (!rgb) return;
      const i = (row * cols + col) * 4;
      image.data[i] = rgb[0];
      image.data[i + 1] = rgb[1];
      image.data[i + 2] = rgb[2];
      image.data[i + 3] = 255;
    });
    ctx.putImageData(image, 0, 0);

    const dLat = (lats[rows - 1] - lats[0]) / (rows - 1);
    const dLon = (lons[cols - 1] - lons[0]) / (cols - 1);
    return {
      url: canvas.toDataURL("image/png"),
      bounds: [
        [lats[0] - dLat / 2, lons[0] - dLon / 2],
        [lats[rows - 1] + dLat / 2, lons[cols - 1] + dLon / 2],
      ] as [[number, number], [number, number]],
    };
  }, [field]);

  if (!raster) return null;
  return (
    <ImageOverlay
      url={raster.url}
      bounds={raster.bounds}
      opacity={Math.max(0.05, Math.min(0.95, field.opacity * dim))}
      zIndex={250}
    />
  );
}

function parseRgb(color: string): [number, number, number] | null {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const hex = color.replace("#", "");
  if (hex.length === 6) {
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

function ZoneLayer({ zone }: { zone: ZoneSpec }) {
  if (zone.ring?.length) {
    return (
      <Polygon
        positions={zone.ring.map((r) => r.map(([lon, lat]) => [lat, lon] as [number, number]))}
        pathOptions={{
          color: zone.color,
          weight: zone.selected ? 2.6 : 1.8,
          opacity: 0.95,
          fillColor: zone.color,
          fillOpacity: zone.selected ? 0.34 : 0.18,
          dashArray: zone.kind === "hazard" || zone.kind === "restricted" ? "5 4" : undefined,
        }}
      >
        <Tooltip className="sk-maptip" direction="top" sticky>
          {zone.label}
        </Tooltip>
      </Polygon>
    );
  }
  return (
    <Circle
      center={[zone.lat, zone.lon]}
      radius={zone.radiusKm * 1000}
      pathOptions={{
        color: zone.color,
        weight: zone.selected ? 2.4 : 1.6,
        opacity: 0.9,
        fillColor: zone.color,
        fillOpacity: zone.selected ? 0.28 : 0.14,
        dashArray: "5 4",
      }}
    >
      <Tooltip className="sk-maptip" direction="top" sticky>
        {zone.label}
      </Tooltip>
    </Circle>
  );
}

function MarkerGlyph({
  marker,
  selected,
  onSelect,
}: {
  marker: MarkerSpec;
  selected: boolean;
  onSelect?: (id: string) => void;
}) {
  const size = marker.size ?? (selected ? 10 : 8);
  const shape = marker.shape ?? "circle";
  const icon = useMemo(
    () =>
      L.divIcon({
        html: `<span class="sk-sym" style="--c:${marker.color};--s:${size}px;--r:${
          shape === "circle" ? "50%" : shape === "diamond" ? "1px" : "2px"
        };--t:${shape === "diamond" ? "rotate(45deg)" : "none"}${selected ? ";--ring:1" : ""}"></span>`,
        className: "sk-sym-wrap",
        iconSize: [size + 10, size + 10],
        iconAnchor: [(size + 10) / 2, (size + 10) / 2],
      }),
    [marker.color, size, shape, selected]
  );
  return (
    <Marker
      position={[marker.lat, marker.lon]}
      icon={icon}
      keyboard={false}
      eventHandlers={{ click: () => onSelect?.(marker.id) }}
    >
      <Tooltip className="sk-maptip" direction="top" offset={[0, -6]} permanent={marker.permanent}>
        <span style={{ color: marker.color, fontWeight: 600 }}>{marker.label}</span>
        {marker.detail ? <span> · {marker.detail}</span> : null}
      </Tooltip>
    </Marker>
  );
}

/* ------------------------------------------------------------------- maths */

function polygonAreaKm2(points: [number, number][]): number {
  // Equirectangular approximation, adequate for the distances involved here.
  const R = 6371;
  const lat0 = (points.reduce((s, p) => s + p[0], 0) / points.length) * (Math.PI / 180);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[(i + 1) % points.length];
    const x1 = (lon1 * Math.PI) / 180 * Math.cos(lat0) * R;
    const y1 = (lat1 * Math.PI) / 180 * R;
    const x2 = (lon2 * Math.PI) / 180 * Math.cos(lat0) * R;
    const y2 = (lat2 * Math.PI) / 180 * R;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}
