/**
 * THE SEAMONK — community contribution client.
 *
 * Thin wrapper over the backend's `/api/community/*` routes. Everything a
 * contributor sees is checked by the server: the verification matrix, the PFZ
 * cross-check and the trust maths all live in the backend, and this module only
 * carries the results. Nothing here invents a verdict, a badge or a score.
 *
 * Reused by:
 *   · components/seamonk/views/ContributeView.tsx  (the Contribute page)
 *   · lib/seamonk/DataProvider.tsx                 (live pins on the map)
 */

import { API_URL } from "./api";

/* ------------------------------------------------------------------- types */

export type ReportCategoryId =
  | "catch"
  | "hazard"
  | "sea_condition"
  | "fishing_zone"
  | "weather_observation"
  | "other";

export type CategorySpec = {
  id: string;
  label: string;
  verifiable: boolean;
  /** What the verification matrix will try to confirm it with. */
  evidence: string;
};

export type CommunityReport = {
  id: string;
  created_at?: string | null;
  observed_at?: string | null;
  category: string;
  description: string;
  reporter_name?: string | null;
  reporter_role?: string | null;
  lat: number;
  lon: number;
  verified: boolean;
  verification_note?: string | null;
  verification_source?: string | null;
  media_url?: string | null;
  media_type?: "image" | "video" | null;
};

export type ContributorCard = {
  name: string;
  contributions: number;
  verified: number;
  unverified: number;
  trust_score: number;
  badge: string;
  badge_key: "new" | "trusted" | "observer" | "expert";
  badge_tone: "ok" | "info" | "warn" | "danger" | "neutral";
  last_report_at?: string | null;
};

export type CommunityStats = {
  total: number;
  verified: number;
  unverified: number;
  contributors: number;
  with_media: number;
  verified_share: number;
  window_hours: number;
};

export type SubmitResult = {
  report: CommunityReport;
  contributor: ContributorCard | null;
  message: string;
};

/**
 * The six choices, used to render the form before `/categories` answers and as
 * the label table everywhere else. This is UI vocabulary mirroring the backend
 * constant — never report data.
 */
export const CATEGORY_ICONS: Record<string, string> = {
  catch: "🎣",
  hazard: "⚠️",
  sea_condition: "🌊",
  fishing_zone: "📡",
  weather_observation: "🌤️",
  other: "📝",
};

export const FALLBACK_CATEGORIES: CategorySpec[] = [
  { id: "catch", label: "Catch", verifiable: true, evidence: "Active INCOIS PFZ zone at the reported position" },
  { id: "hazard", label: "Hazard", verifiable: true, evidence: "Live wave, wind or storm signal for that point" },
  { id: "sea_condition", label: "Sea / ocean condition", verifiable: true, evidence: "Live wave height / swell period for that point" },
  { id: "fishing_zone", label: "Fishing zone condition", verifiable: true, evidence: "Active INCOIS PFZ zone at the reported position" },
  { id: "weather_observation", label: "Weather observation", verifiable: true, evidence: "Live wind gusts or an active storm cell" },
  { id: "other", label: "Other", verifiable: false, evidence: "No independent feed can confirm it — shown as unverified" },
];

export function categoryLabel(id: string): string {
  const spec = FALLBACK_CATEGORIES.find((c) => c.id === id);
  if (spec) return spec.label;
  // Legacy categories written before the Contribute page existed.
  return id.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/* -------------------------------------------------------------- storage key */

export const REPORTER_KEY = "seamonk.reporter";

export function loadReporterName(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(REPORTER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveReporterName(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REPORTER_KEY, name);
  } catch {
    /* private mode / storage blocked — the name simply is not remembered */
  }
}

/* ----------------------------------------------------------------- requests */

async function jsonOrThrow(res: Response): Promise<any> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.detail ?? body?.message;
    throw new Error(
      typeof detail === "string"
        ? detail
        : `The contribution service replied ${res.status}${detail ? `: ${JSON.stringify(detail).slice(0, 200)}` : ""}`
    );
  }
  return body;
}

export async function fetchCategories(): Promise<{
  categories: CategorySpec[];
  badges: { key: string; label: string; rule: string }[];
  trust_formula?: string;
}> {
  const res = await fetch(`${API_URL}/api/community/categories`, { cache: "no-store" });
  return jsonOrThrow(res);
}

export async function fetchReportFeed(opts: {
  lat?: number;
  lon?: number;
  limit?: number;
  verifiedOnly?: boolean;
  reverify?: boolean;
  radiusKm?: number;
} = {}): Promise<{ count: number; verified_count: number; reports: CommunityReport[]; geojson: any }> {
  const params = new URLSearchParams();
  if (opts.lat !== undefined && opts.lon !== undefined) {
    params.set("lat", String(opts.lat));
    params.set("lon", String(opts.lon));
  }
  params.set("limit", String(opts.limit ?? 40));
  if (opts.verifiedOnly) params.set("verified_only", "true");
  if (opts.reverify) params.set("reverify", "true");
  if (opts.radiusKm) params.set("radius_km", String(opts.radiusKm));
  const res = await fetch(`${API_URL}/api/community/reports?${params.toString()}`, { cache: "no-store" });
  return jsonOrThrow(res);
}

export async function submitReport(body: {
  category: string;
  description: string;
  lat: number;
  lon: number;
  reporter_name?: string;
  reporter_role?: string;
  media_url?: string | null;
  media_type?: string | null;
}): Promise<SubmitResult> {
  const res = await fetch(`${API_URL}/api/community/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export async function uploadMedia(
  file: File,
  reporterName: string,
  onProgress?: (fraction: number) => void
): Promise<{ media_url: string; media_type: "image" | "video"; bytes: number }> {
  // XHR rather than fetch: upload progress is what makes a large phone video
  // feel like it is working rather than frozen.
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    if (reporterName) form.append("reporter_name", reporterName);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/community/media`);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.media_url) {
        onProgress?.(1);
        resolve(body);
      } else {
        reject(new Error(body?.detail || `The media upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("The media upload could not reach the server."));
    xhr.send(form);
  });
}

export async function reverifyReport(id: string): Promise<CommunityReport> {
  const res = await fetch(`${API_URL}/api/community/reports/${id}/verify`, { method: "POST" });
  const body = await jsonOrThrow(res);
  return body.report as CommunityReport;
}

export async function fetchContributors(limit = 25): Promise<ContributorCard[]> {
  const res = await fetch(`${API_URL}/api/community/contributors?limit=${limit}`, { cache: "no-store" });
  const body = await jsonOrThrow(res);
  return (body.contributors ?? []) as ContributorCard[];
}

export async function fetchContributor(name: string): Promise<ContributorCard> {
  const res = await fetch(`${API_URL}/api/community/contributors/${encodeURIComponent(name)}`, {
    cache: "no-store",
  });
  const body = await jsonOrThrow(res);
  return body.contributor as ContributorCard;
}

export async function fetchStats(): Promise<CommunityStats> {
  const res = await fetch(`${API_URL}/api/community/stats`, { cache: "no-store" });
  return jsonOrThrow(res);
}
