import type { Metadata } from "next";
import ReportsView from "@/components/seamonk/views/ReportsView";

export const metadata: Metadata = {
  title: "Reports — THE SEAMONK",
  description:
    "Generate, review, print and export marine intelligence reports for the West Bengal coast, with a document-style preview and honest data provenance.",
};

export default function ReportsPage() {
  return <ReportsView />;
}
