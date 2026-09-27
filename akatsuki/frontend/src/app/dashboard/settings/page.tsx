import type { Metadata } from "next";
import SettingsView from "@/components/seamonk/views/SettingsView";

export const metadata: Metadata = {
  title: "Settings — THE SEAMONK",
  description:
    "Configure region, monitoring radius, units, notifications, map preferences and privacy for THE SEAMONK marine console. Preferences are stored in this browser.",
};

export default function SettingsPage() {
  return <SettingsView />;
}
