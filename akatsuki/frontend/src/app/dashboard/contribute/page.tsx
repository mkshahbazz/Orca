import type { Metadata } from "next";
import ContributeView from "@/components/seamonk/views/ContributeView";

export const metadata: Metadata = {
  title: "Contribute — THE SEAMONK",
  description:
    "File a marine observation from the water: photo, video, description, category and position. Every report is cross-checked against live satellite, buoy and PFZ data, and confirmed reports raise the confidence of the Monk's answers for every fisher in that area.",
};

export default function ContributePage() {
  return <ContributeView />;
}
