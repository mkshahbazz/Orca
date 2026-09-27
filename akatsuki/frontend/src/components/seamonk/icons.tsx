/**
 * THE SEAMONK — nautical icon family.
 *
 * One family, drawn on the same rules so the set reads as a single hand:
 *   · 24 × 24 grid, 20–22 px live area
 *   · stroke 1.7 (never 1 or 2), rounded caps and joins, no fills
 *   · geometry from charts, buoys, sounders and routes — not from a UI kit
 *
 * Every glyph is authored here rather than imported from a generic icon
 * library, because a stock set is the fastest way for a product like this to
 * start looking like every other dashboard.
 */

import type { ReactNode } from "react";

export type SeamonkIconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
  title?: string;
  style?: React.CSSProperties;
};

function Svg({
  size = 20,
  className,
  strokeWidth = 1.7,
  title,
  style,
  children,
}: SeamonkIconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* --------------------------------------------------------------- signature mark */

/** The beacon — used for the brand and for every Monk's Reading block. */
export const Beacon = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M9.6 20.4 10.8 9.6h2.4l1.2 10.8" />
    <path d="M8.4 20.4h7.2" />
    <path d="M9.8 9.6 9 6.8h6l-.8 2.8" />
    <path d="M12 6.8V4.2" />
    <path d="M5.6 3.8 7.8 5.2M18.4 3.8 16.2 5.2" />
    <path d="M4.8 9.4 7.4 8.6M19.2 9.4 16.6 8.6" />
  </Svg>
);

/* ------------------------------------------------------------------- navigation */

export const OceanWatch = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="6.6" r="1.6" />
    <path d="M8.6 4.5a5.2 5.2 0 0 1 6.8 0" />
    <path d="M6.6 2.6a9 9 0 0 1 10.8 0" />
    <path d="M2.5 14q2.35-2.5 4.75 0t4.75 0t4.75 0t4.75 0" />
    <path d="M4.6 19.3q2.2-2.2 4.4 0t4.4 0t4.4 0" />
  </Svg>
);

export const FishingZones = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.4 11.4c2.4-3.1 5.9-4.2 9-2.6 1.4.7 2.4 1.6 3.1 2.6-.7 1-1.7 1.9-3.1 2.6-3.1 1.6-6.6.5-9-2.6Z" />
    <path d="M15.5 11.4 19.4 8.6v5.6l-3.9-2.8Z" />
    <path d="M6.1 11.4h.01" />
    <path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6" />
  </Svg>
);

export const VoyageSafety = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 2.6 19 5.6v6.1c0 4.3-2.9 7.5-7 9-4.1-1.5-7-4.7-7-9V5.6l7-3Z" />
    <path d="M14.9 9.1 13.3 13.7 8.7 15.3 10.3 10.7 14.9 9.1Z" />
    <path d="M12 11.9h.01" />
  </Svg>
);

export const MarineAnalytics = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M4.2 20.4v-5.6" />
    <path d="M9.4 20.4v-9" />
    <path d="M14.6 20.4v-3.6" />
    <path d="M19.8 20.4v-10" />
    <path d="M2.6 8.4q2.35-2.4 4.7 0t4.7 0t4.7 0t4.7 0" />
  </Svg>
);

export const MapLayers = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 2.8 21.2 7.2 12 11.6 2.8 7.2 12 2.8Z" />
    <path d="M8.6 8.1q1.7-1.3 3.4-.2t3.4-.2" />
    <path d="M3.2 12 12 16.2l8.8-4.2" />
    <path d="M3.2 16.6 12 20.8l8.8-4.2" />
  </Svg>
);

export const Reports = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M6.2 2.8h7.2l5.4 5.4v13H6.2V2.8Z" />
    <path d="M13.2 2.8v5.6h5.6" />
    <path d="M9 16.6l2.5-2.5 1.9 1.7 2.5-3.3" />
    <path d="M8.8 19.4h7.4" />
  </Svg>
);

export const Settings = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.3" />
    <circle cx="12" cy="12" r="6.9" />
    <path d="M12 2.6v2.5M12 18.9v2.5M2.6 12h2.5M18.9 12h2.5M5.4 5.4l1.8 1.8M16.8 16.8l1.8 1.8M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8" />
  </Svg>
);

/* ----------------------------------------------------------------- marine domain */

export const Waves = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M2.4 9.4q2.35-2.6 4.8 0t4.8 0t4.8 0t4.8 0" />
    <path d="M2.4 15.6q2.35-2.6 4.8 0t4.8 0t4.8 0t4.8 0" />
  </Svg>
);

export const Wind = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3 8.6h9.6a2.6 2.6 0 1 0-2.6-2.7" />
    <path d="M3 12.6h14.6" />
    <path d="M15.2 10.4 17.6 12.6 15.2 14.8" />
    <path d="M3 16.6h6.4" />
  </Svg>
);

export const Thermometer = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 3.4a2 2 0 0 1 2 2v7.2a3.9 3.9 0 1 1-4 0V5.4a2 2 0 0 1 2-2Z" />
    <path d="M16.2 6.2h2.4M16.2 9.4h1.8M16.2 12.6h2.4" />
  </Svg>
);

export const Chlorophyll = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 3.2c3 3.5 5.2 6.3 5.2 9.1A5.2 5.2 0 0 1 12 17.5a5.2 5.2 0 0 1-5.2-5.2c0-2.8 2.2-5.6 5.2-9.1Z" />
    <path d="M12 13.4c0-2 1.2-3.3 2.9-3.7" />
    <path d="M12 10.3c-1.5.3-2.4 1.2-2.6 2.5" />
    <path d="M8.4 20.4h7.2" />
  </Svg>
);

export const Visibility = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M2.4 12S6 6.6 12 6.6 21.6 12 21.6 12 18 17.4 12 17.4 2.4 12 2.4 12Z" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M12 2.6v2M5.6 4.6l1.4 1.6M18.4 4.6 17 6.2" />
  </Svg>
);

export const Depth = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M9.4 3.2h5.2v2.4H9.4z" />
    <path d="M12 5.6v6.2" />
    <path d="M12 11.8 6.6 19.2M12 11.8l5.4 7.4" />
    <path d="M2.8 19.2h18.4" />
    <path d="M5 21.4h3M10 21.4h4M16 21.4h3" />
  </Svg>
);

export const Compass = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.2 8.8 13.4 13.8 8.4 15.6 10.2 10.6 15.2 8.8Z" />
  </Svg>
);

export const Anchor = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="4.8" r="2.2" />
    <path d="M12 7v13.2" />
    <path d="M8.2 9.8h7.6" />
    <path d="M4.6 13.4a7.4 7.4 0 0 0 14.8 0" />
    <path d="M4.6 13.4h2.5M19.4 13.4h-2.5" />
  </Svg>
);

export const Buoy = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M8.6 13.6h6.8l-1 6.2H9.6l-1-6.2Z" />
    <path d="M12 13.6V7" />
    <path d="M12 7h5.4v2.6H12" />
    <path d="M6 21.4h12" />
    <path d="M10.4 11.2h3.2" />
  </Svg>
);

export const Ship = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.6 13.8h16.8l-2.4 5H6l-2.4-5Z" />
    <path d="M6.8 13.8V7.6h7v6.2" />
    <path d="M13.8 9.2h3.6l2.4 4.6" />
    <path d="M2.6 21q2-1.4 4 0t4 0 4 0 4 0" />
  </Svg>
);

export const Route = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="5.4" cy="18.6" r="2.1" />
    <circle cx="18.6" cy="5.4" r="2.1" />
    <path d="M7.5 18.6h4.1a2.6 2.6 0 0 0 2.6-2.6V8a2.6 2.6 0 0 1 2.6-2.6h.4" />
  </Svg>
);

export const Satellite = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M9.4 9.4h5.2v5.2H9.4z" />
    <path d="M3.2 10.8h4.6v2.4H3.2zM16.2 10.8h4.6v2.4h-4.6z" />
    <path d="M12 14.6v3" />
    <path d="M9.6 17.6h4.8" />
    <path d="M8.6 20.4h6.8" />
  </Svg>
);

export const Radar = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 3.4A8.6 8.6 0 0 1 20.6 12" />
    <path d="M12 7.2a4.8 4.8 0 0 1 4.8 4.8" />
    <path d="M12 10.9a1.1 1.1 0 0 1 1.1 1.1" />
    <path d="M12 12 4.4 19.6" />
    <circle cx="15.6" cy="6.8" r="1.1" />
  </Svg>
);

export const Squall = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M7.2 13.2A3.6 3.6 0 0 1 7.6 6a4.8 4.8 0 0 1 9.2 1.2 3 3 0 0 1-.6 6h-9Z" />
    <path d="M9.6 16.4l-1.2 3.2M13 16.4l-1.2 3.2M16.4 16.4l-1.2 3.2" />
  </Svg>
);

export const Current = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.6 7.2c4.8-2.6 11.6-2.6 16.4 0" />
    <path d="M17.6 5.4l2.4 1.8-2.6 1.2" />
    <path d="M3.6 12c4.8-2.6 11.6-2.6 16.4 0" />
    <path d="M3.6 16.8c4.8-2.6 11.6-2.6 16.4 0" />
  </Svg>
);

export const Tide = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M2.6 12c1.9-4.4 3.7 4.4 5.6 0s3.7 4.4 5.6 0 3.7 4.4 5.6 0" />
    <path d="M17.6 5.4v-.01" />
    <path d="M17.4 9.9 19 6.4l1.6 3.5" />
  </Svg>
);

export const Gauge = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.6 17.4a8.4 8.4 0 0 1 16.8 0" />
    <path d="M12 17.4 16.2 11.8" />
    <circle cx="12" cy="17.4" r="1.1" />
    <path d="M12 6.2v1.7M5.4 9.2 6.6 10.4M18.6 9.2 17.4 10.4" />
  </Svg>
);

/* ------------------------------------------------------------------------- UI */

export const TrendUp = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.6 16.8l5.4-5.4 3.6 3.6 7.6-7.6" />
    <path d="M20.2 11.6V7.4h-4.2" />
  </Svg>
);

export const TrendDown = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.6 7.4l5.4 5.4 3.6-3.6 7.6 7.6" />
    <path d="M20.2 12.8v4.2h-4.2" />
  </Svg>
);

export const ArrowRight = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M4.4 12h15" />
    <path d="M14 6.6 19.4 12 14 17.4" />
  </Svg>
);

export const ChevronDown = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M6.6 9.6 12 15l5.4-5.4" />
  </Svg>
);

export const ChevronRight = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M9.6 6.6 15 12l-5.4 5.4" />
  </Svg>
);

export const Check = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M5 12.8l4.4 4.4L19.2 7.4" />
  </Svg>
);

export const Close = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M6.6 6.6 17.4 17.4M17.4 6.6 6.6 17.4" />
  </Svg>
);

export const Search = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="10.6" cy="10.6" r="6.6" />
    <path d="M15.4 15.4 20.4 20.4" />
  </Svg>
);

export const Filter = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.8 5.4h16.4l-6.4 7.6v5.4l-3.6-1.8v-3.6L3.8 5.4Z" />
  </Svg>
);

export const Download = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 3.6v11" />
    <path d="M7.6 10.2 12 14.6l4.4-4.4" />
    <path d="M4.2 19.6h15.6" />
  </Svg>
);

export const Share = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="17.6" cy="6" r="2.4" />
    <circle cx="6.4" cy="12" r="2.4" />
    <circle cx="17.6" cy="18" r="2.4" />
    <path d="M8.6 10.9 15.4 7.2M8.6 13.1l6.8 3.7" />
  </Svg>
);

export const Plus = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 5.2v13.6M5.2 12h13.6" />
  </Svg>
);

export const Refresh = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M19.8 11.6a7.8 7.8 0 1 0-2.3 6.2" />
    <path d="M19.8 6.6v5h-5" />
  </Svg>
);

export const Bell = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 3.2a5.6 5.6 0 0 0-5.6 5.6c0 5.2-1.6 6.6-1.6 6.6h14.4s-1.6-1.4-1.6-6.6A5.6 5.6 0 0 0 12 3.2Z" />
    <path d="M10.2 18.6a2 2 0 0 0 3.6 0" />
  </Svg>
);

export const Crosshair = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="7.4" />
    <path d="M12 1.8v4M12 18.2v4M1.8 12h4M18.2 12h4" />
  </Svg>
);

export const Ruler = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3 15.4 15.4 3l5.6 5.6L8.6 21 3 15.4Z" />
    <path d="M6.6 12.4l1.8 1.8M9.6 9.4l1.8 1.8M12.6 6.4l1.8 1.8" />
  </Svg>
);

export const Grid = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M3.6 3.6h16.8v16.8H3.6z" />
    <path d="M3.6 9.6h16.8M3.6 15.6h16.8M9.6 3.6v16.8M15.6 3.6v16.8" />
  </Svg>
);

export const Info = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11.2v5.2" />
    <path d="M12 7.6h.01" />
  </Svg>
);

export const Warning = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 3.4 21.4 20H2.6L12 3.4Z" />
    <path d="M12 9.6v4.2" />
    <path d="M12 16.8h.01" />
  </Svg>
);

export const ShieldCheck = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 2.6 19 5.6v6.1c0 4.3-2.9 7.5-7 9-4.1-1.5-7-4.7-7-9V5.6l7-3Z" />
    <path d="M8.9 11.7l2.2 2.2 4-4.1" />
  </Svg>
);

export const Pin = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 21.2s6.2-6 6.2-10.8a6.2 6.2 0 1 0-12.4 0C5.8 15.2 12 21.2 12 21.2Z" />
    <circle cx="12" cy="10.2" r="2.3" />
  </Svg>
);

export const Clock = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.2V12l3.4 2.1" />
  </Svg>
);

export const Sliders = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M6 3.6v5.6M6 14.4v6M18 3.6v9M18 18.4v2M12 3.6v2.6M12 11.4v9" />
    <circle cx="6" cy="11.4" r="2.2" />
    <circle cx="18" cy="15.2" r="2.2" />
    <circle cx="12" cy="8.4" r="2.2" />
  </Svg>
);

export const Menu = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M4 7.4h16M4 12h16M4 16.6h16" />
  </Svg>
);

export const Globe = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M3.4 12h17.2" />
    <path d="M12 3.4c2.6 2.6 3.9 5.4 3.9 8.6S14.6 18 12 20.6C9.4 18 8.1 15.2 8.1 12S9.4 6 12 3.4Z" />
  </Svg>
);

export const Send = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M20.4 3.6 3.6 10.2l6.8 2.6 2.6 6.8 7.4-16Z" />
    <path d="M10.4 12.8 20.4 3.6" />
  </Svg>
);

export const FileCheck = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M6.2 2.8h7.2l5.4 5.4v13H6.2V2.8Z" />
    <path d="M13.2 2.8v5.6h5.6" />
    <path d="M9.2 15.4l2 2 3.6-3.8" />
  </Svg>
);

export const Database = (p: SeamonkIconProps) => (
  <Svg {...p}>
    <path d="M12 3.2c4.4 0 7.6 1.1 7.6 2.6S16.4 8.4 12 8.4 4.4 7.3 4.4 5.8 7.6 3.2 12 3.2Z" />
    <path d="M4.4 5.8v12.4c0 1.5 3.2 2.6 7.6 2.6s7.6-1.1 7.6-2.6V5.8" />
    <path d="M4.4 12c0 1.5 3.2 2.6 7.6 2.6s7.6-1.1 7.6-2.6" />
  </Svg>
);
