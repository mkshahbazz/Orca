import type { Metadata } from "next";
import OceanWatchView from "@/components/seamonk/views/OceanWatchView";

export const metadata: Metadata = {
  title: "Ocean Watch — THE SEAMONK",
  description:
    "Live marine conditions across the West Bengal coast: sea surface temperature, chlorophyll, wind, wave height, visibility and sea state, with a live field map and point inspection.",
};

export default function OceanWatchPage() {
  return <OceanWatchView />;
}
