import type { Metadata } from "next";
import MapLayersView from "@/components/seamonk/views/MapLayersView";

export const metadata: Metadata = {
  title: "Map Layers — THE SEAMONK",
  description:
    "Composite satellite, model and advisory layers over the northern Bay of Bengal, with per-layer opacity, a dynamic legend and a coordinate inspector.",
};

export default function MapLayersPage() {
  return <MapLayersView />;
}
