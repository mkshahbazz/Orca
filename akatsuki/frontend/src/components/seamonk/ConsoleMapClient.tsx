"use client";

/**
 * Client-only loader for ConsoleMap.
 *
 * Leaflet touches `window` at module scope, so the map must never be evaluated
 * during prerendering — every console view imports the map through this wrapper
 * (next/dynamic, ssr:false) instead of importing ConsoleMap directly. Basemap
 * config and map spec types come from ./mapConfig, which is Leaflet-free.
 */

import dynamic from "next/dynamic";

export const ConsoleMap = dynamic(() => import("./ConsoleMap").then((m) => m.ConsoleMap), { ssr: false });
