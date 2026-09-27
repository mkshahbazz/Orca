import type { Metadata } from "next";
import FishingZonesView from "@/components/seamonk/views/FishingZonesView";

export const metadata: Metadata = {
  title: "Fishing Zones — THE SEAMONK",
  description:
    "Potential fishing zones off the West Bengal and Odisha coast, with the chlorophyll, temperature and bathymetry conditions behind each zone and an approach track from the nearest landing.",
};

export default function FishingZonesPage() {
  return <FishingZonesView />;
}
