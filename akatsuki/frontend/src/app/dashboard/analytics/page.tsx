import type { Metadata } from "next";
import AnalyticsView from "@/components/seamonk/views/AnalyticsView";

export const metadata: Metadata = {
  title: "Marine Analytics — THE SEAMONK",
  description:
    "Region-aggregated ocean time series with spatial context, monthly aggregates, data-quality reporting and the relationship between chlorophyll and fishing advisories.",
};

export default function AnalyticsPage() {
  return <AnalyticsView />;
}
