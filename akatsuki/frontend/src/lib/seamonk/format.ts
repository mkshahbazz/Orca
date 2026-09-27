/**
 * THE SEAMONK — value formatting.
 *
 * Marine operators read numbers in a fixed way: unit always attached, one
 * decimal on sea-state values, coordinates to two decimals with hemisphere
 * suffixes, times always in IST. Every formatter here returns a string so the
 * same value reads identically in a table, a tooltip and a printed report.
 */

export const IST_TZ = "Asia/Kolkata";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Sep 2026 23:08 IST" */
export function istStamp(value: Date | string | number = new Date(), withSeconds = false): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("day")} ${get("month")} ${get("year")}`;
  const time = withSeconds ? `${get("hour")}:${get("minute")}:${get("second")}` : `${get("hour")}:${get("minute")}`;
  return `${date} ${time} IST`;
}

/** "23:08 IST" — the compact variant used in chart cursor readouts. */
export function istClock(value: Date | string | number = new Date(), withSeconds = false): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}${withSeconds ? `:${get("second")}` : ""} IST`;
}

/** "27 Sep" — axis ticks and table cells where the year is implied. */
export function istDay(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TZ,
    day: "2-digit",
    month: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")}`;
}

export function monthName(index: number): string {
  return MONTHS[((index % 12) + 12) % 12];
}

/** Relative age in the register operators actually use: "18 min ago", "3 h ago". */
export function sinceLabel(value: Date | string | number, now: Date = new Date()): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const mins = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Fixed-decimal number, em-dash when the feed has nothing. */
export function num(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

/** Same as `num` but with the unit glued on, so labels never drift apart. */
export function withUnit(value: number | null | undefined, unit: string, digits = 1): string {
  const n = num(value, digits);
  return n === "—" ? n : `${n}${unit.startsWith("°") ? "" : " "}${unit}`;
}

/** "21.42°N 87.91°E" */
export function coordLabel(lat: number | null | undefined, lon: number | null | undefined): string {
  if (lat === null || lon === null || lat === undefined || lon === undefined) return "—";
  return `${coordPair(lat, "N", "S")} ${coordPair(lon, "E", "W")}`;
}

/** "21.42°N" */
export function coordPair(value: number, pos: string, neg: string): string {
  return `${Math.abs(value).toFixed(2)}°${value >= 0 ? pos : neg}`;
}

/** Decimal degrees → degrees / minutes, the form used on a chart table. */
export function coordDms(value: number, pos: string, neg: string): string {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${deg}° ${min.toFixed(1)}′ ${value >= 0 ? pos : neg}`;
}

/** Greater-circle distance in nautical miles (haversine). */
export function distanceNm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return (2 * R * Math.asin(Math.min(1, Math.sqrt(h)))) / 1.852;
}

export function nm(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)} NM`;
}

/** km/h → knots, the unit the marine bulletins quote. */
export function kmhToKt(kmh: number | null | undefined): number | null {
  if (kmh === null || kmh === undefined || Number.isNaN(kmh)) return null;
  return kmh * 0.539957;
}

/** Duration from decimal hours → "1 h 45 min". */
export function duration(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${m.toString().padStart(2, "0")} min` : `${m} min`;
}

/** Signed change with an explicit sign, e.g. "+0.6", "−0.2". */
export function signed(value: number, digits = 1): string {
  const s = value.toFixed(digits);
  return value > 0 ? `+${s}` : s.replace("-", "−");
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function pct(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}
