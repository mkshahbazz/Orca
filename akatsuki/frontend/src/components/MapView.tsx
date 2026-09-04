"use client";

import "leaflet/dist/leaflet.css";          // must live in the client component
import L from "leaflet";
import { useEffect } from "react";
import { GeoJSON, MapContainer, TileLayer, useMap } from "react-leaflet";

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

export default function MapView({
  mapFeatures,
  refreshKey = 0,
}: {
  mapFeatures: any;
  refreshKey?: number;
}) {
  return (
    <div className="absolute inset-0 z-0">
      <MapContainer center={[16.5, 84.5]} zoom={5} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
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

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-[1000] rounded-lg bg-white/90 p-3 text-xs shadow-md backdrop-blur">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span className="inline-block h-3 w-3 rounded-sm bg-red-500" /> Hazard zone
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-green-500" /> PFZ (potential fishing zone)
        </div>
      </div>
    </div>
  );
}
