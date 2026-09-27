"use client";

import "../seamonk.css";
import "../seamonk-console.css";
import { SeamonkDataProvider } from "@/lib/seamonk/DataProvider";
import { Shell } from "@/components/seamonk/Shell";

/**
 * The console layout owns the shell. Because it never re-mounts between
 * routes, the region selection, the polling loop and the alert popovers stay
 * put while the workspace below changes.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <SeamonkDataProvider>
      <Shell>{children}</Shell>
    </SeamonkDataProvider>
  );
}
