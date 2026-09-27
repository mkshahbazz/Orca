/**
 * Leaflet-free map configuration shared by ConsoleMap and every console view.
 *
 * This module exists so view code can import BASEMAPS and spec types without
 * pulling the Leaflet/React-Leaflet bundle into prerendered pages — Leaflet
 * touches `window` at module scope, so it must only ever load client-side
 * (views load ConsoleMap via next/dynamic, ssr:false).
 */

import type { Tone } from "@/lib/seamonk/design";

export type Cell = { lat: number; lon: number; v: number };

export type FieldSpec = {
  key: string;
  label: string;
  ramp: (t: number) => string;
  cells: Cell[];
  min: number;
  max: number;
  opacity: number;
  visible: boolean;
  unit: string;
};

export type ZoneSpec = {
  id: string;
  kind: "pfz" | "hazard" | "restricted" | "shallow" | "squall";
  label: string;
  detail: string;
  color: string;
  tone: Tone;
  lat: number;
  lon: number;
  radiusKm: number;
  ring?: [number, number][][];
  selected?: boolean;
};

export type MarkerSpec = {
  id: string;
  lat: number;
  lon: number;
  label: string;
  sub?: string;
  color: string;
  shape?: "square" | "circle" | "diamond";
  size?: number;
  permanent?: boolean;
  detail?: string;
};

export type RouteSpec = {
  id: string;
  points: [number, number][];
  color: string;
  width?: number;
  dashed?: boolean;
};

export type BasemapKey = "dark" | "coastal" | "satellite";

export const BASEMAPS: Record<BasemapKey, { label: string; url: string; attribution: string; dark: boolean }> = {
  dark: {
    label: "Chart dark",
    // OpenStreetMap is used rather than a keyed vector service so the console
    // works on any deployment; the tile pane is recoloured in CSS to read as
    // a night chart (see .sk-mapwrap[data-basemap="dark"]) .
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    dark: true,
  },
  coastal: {
    label: "Coastal detail",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    dark: false,
  },
  satellite: {
    label: "Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    dark: true,
  },
};
