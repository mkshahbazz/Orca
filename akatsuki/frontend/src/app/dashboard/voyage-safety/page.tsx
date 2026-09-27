import type { Metadata } from "next";
import VoyageSafetyView from "@/components/seamonk/views/VoyageSafetyView";

export const metadata: Metadata = {
  title: "Voyage Safety — THE SEAMONK",
  description:
    "Plan a coastal passage along the West Bengal and Odisha coast: three track options evaluated against wave, wind, visibility, least depth and every registered hazard.",
};

export default function VoyageSafetyPage() {
  return <VoyageSafetyView />;
}
