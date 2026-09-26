"use client";

import "leaflet/dist/leaflet.css";          // must live in the client component
import L from "leaflet";
import { useEffect } from "react";
import { CircleMarker, GeoJSON, MapContainer, TileLayer, Tooltip, useMap } from "react-leaflet";

/** Flies/fits the map whenever a new GeoJSON payload arrives. */
function FlyController({ features, refreshKey }: { features: any; refreshKey: number }) {
  const map = useMap();
  useEffect(() => {
    if (!features?.features?.length) return;
    const bounds = L.geoJSON(features).getBounds();   // GeoJSON is [lng,lat]; Leaflet handles it
    if (bounds.isValid()) {
      map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 9, duration: 1.4 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, refreshKey, map]);
  return null;
}

const zoneStyle = (feature: any) => ({
  color: feature?.properties?.color ?? "#f97316",
  weight: 2,
  opacity: 0.9,
  fillColor: feature?.properties?.color ?? "#f97316",
  fillOpacity: 0.25,
});

const onEachZone = (feature: any, layer: any) => {
  const p = feature?.properties ?? {};
  const title = p.name ?? p.location_name ?? "Zone";
  const extras = p.advisory
    ? p.advisory
    : p.sst
      ? `SST ${p.sst} °C · Chlorophyll ${p.chlorophyll} mg/m³`
      : "";
  const sev = p.severity ? `<br/><em>Severity: ${p.severity}</em>` : "";
  layer.bindPopup(`<strong>${title}</strong><br/>${extras}${sev}`);
};

/** Sampled scalar field overlay (SST / chlorophyll / wind / bathymetry). */
export type GridCell = { lat: number; lon: number; v: number };

function heatColor(t: number): string {
  // blue -> cyan -> green -> yellow -> orange -> red
  const stops: [number, [number, number, number]][] = [
    [0.0, [44, 92, 197]],
    [0.2, [43, 169, 232]],
    [0.4, [53, 208, 120]],
    [0.6, [232, 210, 74]],
    [0.8, [232, 121, 61]],
    [1.0, [216, 75, 61]],
  ];
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (clamped <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (clamped - t0) / (t1 - t0);
      const c = c0.map((v, k) => Math.round(v + f * (c1[k] - v)));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return "rgb(216, 75, 61)";
}

export default function MapView({
  mapFeatures,
  refreshKey = 0,
  gridCells,
  gridMin = 0,
  gridMax = 1,
  gridLabel = "",
}: {
  mapFeatures: any;
  refreshKey?: number;
  /** optional sampled scalar layer rendered under the polygons */
  gridCells?: GridCell[];
  gridMin?: number;
  gridMax?: number;
  gridLabel?: string;
}) {
  return (
    <div className="absolute inset-0 z-0">
      <MapContainer center={[16.5, 84.5]} zoom={5} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {gridCells && gridCells.length > 0 && (
          <HeatCells cells={gridCells} min={gridMin} max={gridMax} label={gridLabel} />
        )}
        {mapFeatures?.features?.length > 0 && (
          <GeoJSON
            key={`${refreshKey}-${mapFeatures.features.length}`}   // force remount per payload
            data={mapFeatures}
            style={zoneStyle}
            onEachFeature={onEachZone}
          />
        )}
        <FlyController features={mapFeatures} refreshKey={refreshKey} />
      </MapContainer>

      {/* Legend (overlay div — outside the Leaflet instance) */}
      <div className="absolute bottom-4 left-4 z-[1000] rounded-lg border border-[rgba(70,130,195,.3)] bg-[rgba(4,17,32,.88)] p-3 text-xs text-slate-200 shadow-xl backdrop-blur">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span className="inline-block h-3 w-3 rounded-sm bg-red-400" /> Hazard zone
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-green-400" /> PFZ (potential fishing zone)
        </div>
      </div>
    </div>
  );
}

/** Renders the sampled scalar field as colored cells (additive overlay). */
function HeatCells({
  cells,
  min,
  max,
  label,
}: {
  cells: GridCell[];
  min: number;
  max: number;
  label: string;
}) {
  const span = max - min || 1;
  return (
    <>
      {cells.map((c) => {
        const t = (c.v - min) / span;
        return (
          <CircleMarker
            key={`${c.lat}-${c.lon}`}
            center={[c.lat, c.lon]}
            radius={16}
            pathOptions={{
              stroke: false,
              fillColor: heatColor(t),
              fillOpacity: 0.42,
            }}
          >
            <Tooltip direction="top" opacity={0.9}>
              {label}: {c.v}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}
