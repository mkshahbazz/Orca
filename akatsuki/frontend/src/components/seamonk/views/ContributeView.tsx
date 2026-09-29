"use client";

/**
 * THE SEAMONK — Contribute.
 *
 * The fisher's half of the platform. A person on the water sends a photo, a
 * clip or a short observation with a position; the report lands in the existing
 * `community_reports` store, is cross-checked against live weather/ocean
 * readings and the INCOIS PFZ bulletin by the existing verification matrix, and
 * — only when the sensors can corroborate it — raises the confidence of every
 * later answer about that area.
 *
 * Deliberate product choices:
 *   · one big upload target and six plain-language categories, no jargon;
 *   · the position is chosen three ways (device fix, map tap, typed
 *     coordinates) because a boat's GPS is the least reliable part of the trip;
 *   · a report that could not be corroborated says so in words — "unverified"
 *     is shown, never silently upgraded, and never "expert";
 *   · the recognition card reports only what the sensors confirmed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConsoleMap } from "@/components/seamonk/ConsoleMapClient";
import type { MarkerSpec } from "@/components/seamonk/mapConfig";
import {
  Community,
  Crosshair,
  Info,
  Pin,
  Refresh,
  Send,
  ShieldCheck,
  Upload,
  Warning,
} from "@/components/seamonk/icons";
import {
  Alert,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  Note,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Status,
  relLabel,
} from "@/components/seamonk/primitives";
import { useMounted, useSea } from "@/lib/seamonk/DataProvider";
import { fieldSpec } from "@/lib/seamonk/derive";
import { coordLabel, istStamp } from "@/lib/seamonk/format";
import {
  CATEGORY_ICONS,
  FALLBACK_CATEGORIES,
  categoryLabel,
  fetchCategories,
  fetchContributor,
  fetchContributors,
  fetchReportFeed,
  fetchStats,
  loadReporterName,
  reverifyReport,
  saveReporterName,
  submitReport,
  uploadMedia,
  type CategorySpec,
  type CommunityReport,
  type CommunityStats,
  type ContributorCard,
  type SubmitResult,
} from "@/lib/seamonk/community";

const ROLES = ["Fisherman", "Boat crew", "Harbour staff", "Coastal worker", "Researcher", "Other"];

type UploadState = {
  state: "empty" | "uploading" | "ready" | "error";
  pct: number;
  url?: string;
  kind?: "image" | "video";
  error?: string;
  name?: string;
  size?: number;
};

const EMPTY_UPLOAD: UploadState = { state: "empty", pct: 0 };

function prettyBytes(bytes?: number): string {
  if (!bytes) return "";
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
}

export default function ContributeView() {
  const sea = useSea();
  const mounted = useMounted();

  // form
  const [categories, setCategories] = useState<CategorySpec[]>(FALLBACK_CATEGORIES);
  const [category, setCategory] = useState<string>("sea_condition");
  const [description, setDescription] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [role, setRole] = useState(ROLES[0]);
  const [point, setPoint] = useState<{ lat: number; lon: number; source: string } | null>(null);
  const [upload, setUpload] = useState<UploadState>(EMPTY_UPLOAD);
  const [locating, setLocating] = useState(false);

  // submission
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // community state
  const [feed, setFeed] = useState<CommunityReport[]>([]);
  const [feedNote, setFeedNote] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [stats, setStats] = useState<CommunityStats | null>(null);
  const [people, setPeople] = useState<ContributorCard[]>([]);
  const [me, setMe] = useState<ContributorCard | null>(null);
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const nameRef = useRef(reporterName);
  nameRef.current = reporterName;

  const selected = useMemo(
    () => categories.find((c) => c.id === category) ?? categories[0],
    [categories, category]
  );

  /* ------------------------------------------------------------- loading */

  const loadFeed = useCallback(async (recheck = false) => {
    setFeedLoading(true);
    try {
      // `reverify` costs one live weather lookup per distinct point, so it is
      // requested here (a small, deliberate page) and skipped elsewhere.
      const data = await fetchReportFeed({ limit: 20, reverify: recheck });
      setFeed(data.reports ?? []);
      setFeedNote(null);
    } catch (err: any) {
      setFeed([]);
      setFeedNote(err?.message || "the contribution feed could not be reached");
    } finally {
      setFeedLoading(false);
    }
  }, []);

  const loadCommunity = useCallback(async () => {
    const [cat, stat, top] = await Promise.allSettled([
      fetchCategories(),
      fetchStats(),
      fetchContributors(12),
    ]);
    if (cat.status === "fulfilled" && cat.value.categories?.length) {
      setCategories(cat.value.categories);
    }
    if (stat.status === "fulfilled") setStats(stat.value);
    if (top.status === "fulfilled") setPeople(top.value);
    void loadFeed(false);
  }, [loadFeed]);

  useEffect(() => {
    setReporterName(loadReporterName());
    loadCommunity();
  }, [loadCommunity]);

  // A contributor's own card follows the name they file under.
  useEffect(() => {
    if (!reporterName.trim()) {
      setMe(null);
      return;
    }
    let alive = true;
    fetchContributor(reporterName.trim())
      .then((card) => alive && setMe(card))
      .catch(() => alive && setMe(null));
    return () => {
      alive = false;
    };
  }, [reporterName, stats]);

  /* --------------------------------------------------------------- upload */

  const acceptFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      setError(null);
      const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : null;
      if (!kind) {
        setUpload({
          state: "error",
          pct: 0,
          error: `“${file.type || file.name}” is not a photo or video. Use JPEG, PNG, WebP, MP4, MOV or WebM.`,
          name: file.name,
        });
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        setUpload({
          state: "error",
          pct: 0,
          error: `This file is ${prettyBytes(file.size)}; the limit is 20 MB.`,
          name: file.name,
        });
        return;
      }
      setUpload({ state: "uploading", pct: 0, name: file.name, size: file.size, kind });
      try {
        const stored = await uploadMedia(file, nameRef.current.trim(), (pct) =>
          setUpload((u) => ({ ...u, state: "uploading", pct }))
        );
        setUpload({
          state: "ready",
          pct: 1,
          url: stored.media_url,
          kind: stored.media_type,
          name: file.name,
          size: stored.bytes,
        });
      } catch (err: any) {
        setUpload({ state: "error", pct: 0, error: err?.message || "the upload failed", name: file.name });
      }
    },
    []
  );

  const clearMedia = () => {
    setUpload(EMPTY_UPLOAD);
    if (fileInput.current) fileInput.current.value = "";
  };

  /* ------------------------------------------------------------- location */

  const useDevicePosition = () => {
    if (!navigator.geolocation) {
      setError("This device does not expose a position fix. Pick the position on the map instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPoint({
          lat: +pos.coords.latitude.toFixed(5),
          lon: +pos.coords.longitude.toFixed(5),
          source: `device fix ±${Math.round(pos.coords.accuracy)} m`,
        });
        setLocating(false);
      },
      (err) => {
        setError(
          `The device position could not be read (${err.message}). Pick the position on the map or type the coordinates.`
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  };

  /* --------------------------------------------------------------- submit */

  const submit = async () => {
    setError(null);
    setResult(null);
    if (description.trim().length < 5) {
      setError("Describe what you saw in at least a few words.");
      return;
    }
    if (!point) {
      setError("Attach the position — a device fix, a tap on the map, or typed coordinates.");
      return;
    }
    if (upload.state === "uploading") {
      setError("The media is still uploading. Wait for it to finish, then submit.");
      return;
    }
    saveReporterName(reporterName.trim());
    setBusy(true);
    try {
      const res = await submitReport({
        category,
        description: description.trim(),
        lat: point.lat,
        lon: point.lon,
        reporter_name: reporterName.trim() || "Anonymous",
        reporter_role: role.toLowerCase(),
        media_url: upload.state === "ready" ? upload.url : null,
        media_type: upload.state === "ready" ? upload.kind ?? null : null,
      });
      setResult(res);
      setDescription("");
      clearMedia();
      setStats(null);
      await loadCommunity();
    } catch (err: any) {
      setError(err?.message || "the contribution service could not be reached");
    } finally {
      setBusy(false);
    }
  };

  const recheck = async (id: string) => {
    setRechecking(id);
    try {
      const fresh = await reverifyReport(id);
      setFeed((rows) => rows.map((r) => (r.id === id ? fresh : r)));
    } catch (err: any) {
      setFeedNote(err?.message || "the re-check could not run");
    } finally {
      setRechecking(null);
    }
  };

  /* ------------------------------------------------------------------ map */

  const markers: MarkerSpec[] = useMemo(() => {
    const out: MarkerSpec[] = feed.slice(0, 30).map((r) => ({
      id: `cr-${r.id}`,
      lat: r.lat,
      lon: r.lon,
      label: categoryLabel(r.category),
      sub: r.reporter_name || "Contributor",
      detail: r.verified ? "verified against live data" : "unverified",
      color: r.verified ? "#22d3ee" : "#f59e0b",
      shape: "circle" as const,
      size: r.verified ? 7 : 6,
    }));
    if (point) {
      out.push({
        id: "draft",
        lat: point.lat,
        lon: point.lon,
        label: "This report",
        sub: coordLabel(point.lat, point.lon),
        detail: point.source,
        color: "#f0c25c",
        shape: "diamond" as const,
        size: 10,
        permanent: true,
      });
    }
    return out;
  }, [feed, point]);

  const field = useMemo(
    () => fieldSpec("sst", sea.gridFor("sst"), true, 0.5),
    [sea.gridFor]
  );

  const center: [number, number] = point ? [point.lat, point.lon] : [sea.region.lat, sea.region.lon];

  /* --------------------------------------------------------------- render */

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Contribute</h1>
          <p>
            Send what you see from the water — a catch, a hazard, the sea state, a weather
            observation — with a photo or clip. Every report is checked against live satellite and
            buoy readings, and the confirmed ones raise the confidence of the Monk&apos;s answers for
            everyone fishing that area.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          {stats ? (
            <span className="sk-chip">
              <ShieldCheck size={13} /> {stats.verified} verified · {stats.total} reports ·{" "}
              {stats.contributors} contributors
            </span>
          ) : null}
          <Button icon={<Refresh size={14} />} onClick={() => loadCommunity()} busy={feedLoading}>
            Refresh feed
          </Button>
        </div>
      </div>

      {error ? (
        <Alert tone="danger" title="That did not go through.">
          {error}
        </Alert>
      ) : null}

      {result ? (
        <Alert
          tone={result.report.verified ? "ok" : "info"}
          title={result.report.verified ? "Verified contribution." : "Report recorded."}
        >
          {result.message}
          <span style={{ display: "block", marginTop: 4 }} className="sk-dim-sm">
            {result.report.verification_note}
          </span>
        </Alert>
      ) : null}

      <div className="sk-cols sk-cols--split">
        {/* ------------------------------------------------------ the form */}
        <div className="sk-stack" style={{ gap: 14 }}>
          <Panel>
            <PanelHead
              icon={<Upload size={16} />}
              title="1 · Your photo or video"
              hint="Up to 20 MB · JPEG, PNG, WebP, MP4, MOV, WebM"
            />
            <PanelBody>
              <div
                className={`cn-drop${dragging ? " is-dragging" : ""}${
                  upload.state === "error" ? " is-error" : ""
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  acceptFile(e.dataTransfer.files?.[0]);
                }}
                onClick={() => fileInput.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
                aria-label="Attach a photo or video from this device"
              >
                <Upload size={22} />
                <b>
                  {dragging
                    ? "Drop it here"
                    : upload.state === "empty"
                      ? "Add a photo or clip"
                      : upload.name}
                </b>
                <span>
                  {upload.state === "empty"
                    ? "Tap to open the camera or gallery, or drag a file here. A clear photo of the sea, the catch or the hazard is what makes a report useful."
                    : upload.state === "uploading"
                      ? `Uploading… ${Math.round(upload.pct * 100)}%`
                      : upload.state === "ready"
                        ? `${prettyBytes(upload.size)} uploaded — attached to this report`
                        : upload.error}
                </span>
                {upload.state === "uploading" ? (
                  <span className="sk-progress" style={{ maxWidth: 260, width: "100%" }}>
                    <i style={{ width: `${Math.round(upload.pct * 100)}%` }} />
                  </span>
                ) : null}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/*,video/*"
                className="sk-sr"
                onChange={(e) => acceptFile(e.target.files?.[0])}
                aria-label="Choose a photo or video file"
              />

              {upload.state === "ready" && upload.url ? (
                <div className="cn-preview">
                  {upload.kind === "video" ? (
                    <video src={upload.url} controls preload="metadata" />
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={upload.url} alt="Attached contribution" />
                  )}
                  <div className="sk-row sk-gap-sm">
                    <Status tone="ok">Attached</Status>
                    <span className="sk-dim-sm sk-truncate">{upload.name}</span>
                    <span className="sk-spread" />
                    <Button size="sm" variant="ghost" onClick={clearMedia}>
                      Remove
                    </Button>
                  </div>
                </div>
              ) : null}

              <Note>
                The file is uploaded through the ORCA server to the community store — no storage
                credential is ever placed in this page.
              </Note>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead icon={<Community size={16} />} title="2 · What are you reporting?" />
            <PanelBody>
              <div className="cn-cats" role="radiogroup" aria-label="Report category">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={category === c.id}
                    className={`cn-cat${category === c.id ? " is-active" : ""}`}
                    onClick={() => setCategory(c.id)}
                    title={c.evidence}
                  >
                    <span className="cn-cat-ico" aria-hidden>
                      {CATEGORY_ICONS[c.id] ?? "📝"}
                    </span>
                    <b>{c.label}</b>
                  </button>
                ))}
              </div>
              {selected ? (
                <p className="sk-dim-sm" style={{ margin: "10px 0 0" }}>
                  <b>How this gets checked: </b>
                  {selected.evidence}.
                </p>
              ) : null}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead icon={<Info size={16} />} title="3 · What did you see?" />
            <PanelBody>
              <Field
                label="Description"
                htmlFor="cn-desc"
                hint={`${description.trim().length}/${1200} characters — plain words are best, and give an idea of how far out you were.`}
              >
                <textarea
                  id="cn-desc"
                  className="sk-textarea"
                  rows={5}
                  maxLength={1200}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Heavy rolling swell past the 20 m line, two boats turned back; water discoloured and a lot of weed drifting."
                />
              </Field>
              <div className="sk-field-row">
                <Field label="Your name" htmlFor="cn-name" hint="Used for your contribution record and badges.">
                  <input
                    id="cn-name"
                    className="sk-input"
                    value={reporterName}
                    maxLength={48}
                    onChange={(e) => setReporterName(e.target.value)}
                    placeholder="How you want to be credited"
                  />
                </Field>
                <Field label="You are" htmlFor="cn-role">
                  <select
                    id="cn-role"
                    className="sk-select"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              icon={<Pin size={16} />}
              title="4 · Where was it?"
              hint="Device fix, a tap on the map, or typed coordinates"
            />
            <PanelBody>
              <div className="sk-row sk-gap-sm" style={{ flexWrap: "wrap" }}>
                <Button icon={<Crosshair size={14} />} onClick={useDevicePosition} busy={locating}>
                  {locating ? "Getting fix" : "Use my location"}
                </Button>
                <span className="sk-dim-sm">
                  or tap anywhere on the map below to drop the pin
                </span>
              </div>

              <div className="sk-field-row" style={{ marginTop: 12 }}>
                <Field label="Latitude" htmlFor="cn-lat" hint="decimal degrees, N positive">
                  <input
                    id="cn-lat"
                    className="sk-input"
                    inputMode="decimal"
                    value={point ? String(point.lat) : ""}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setPoint((p) =>
                        Number.isFinite(v)
                          ? { lat: v, lon: p?.lon ?? sea.region.lon, source: "typed by hand" }
                          : null
                      );
                    }}
                    placeholder="21.55"
                  />
                </Field>
                <Field label="Longitude" htmlFor="cn-lon" hint="decimal degrees, E positive">
                  <input
                    id="cn-lon"
                    className="sk-input"
                    inputMode="decimal"
                    value={point ? String(point.lon) : ""}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setPoint((p) =>
                        Number.isFinite(v)
                          ? { lat: p?.lat ?? sea.region.lat, lon: v, source: "typed by hand" }
                          : null
                      );
                    }}
                    placeholder="87.90"
                  />
                </Field>
              </div>

              {point ? (
                <div className="sk-pair">
                  <span>
                    <Pin size={13} /> Position for this report
                  </span>
                  <span>
                    {coordLabel(point.lat, point.lon)} · {point.source}
                  </span>
                </div>
              ) : (
                <Alert tone="warn" title="No position yet.">
                  A report without a position cannot be verified or shown on the map — it is not
                  accepted.
                </Alert>
              )}

              <div className="cn-map">
                <ConsoleMap
                  ariaLabel="Pick the position for your community report"
                  fields={[field]}
                  markers={markers}
                  selectedId={point ? "draft" : null}
                  center={center}
                  zoom={point ? 8 : 6}
                  height={300}
                  basemap="dark"
                  showTools={false}
                  onInspect={(lat, lon) => setPoint({ lat: +lat.toFixed(5), lon: +lon.toFixed(5), source: "dropped on the map" })}
                />
              </div>
              <p className="sk-dim-sm" style={{ marginTop: 8 }}>
                Cyan pins are reports already corroborated by live data, amber ones await
                confirmation. The shaded field is the sea-surface temperature layer the console
                uses.
              </p>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead icon={<Send size={16} />} title="5 · Submit" hint="Verification runs the moment it lands" />
            <PanelBody>
              <Button
                variant="primary"
                block
                busy={busy}
                onClick={submit}
                disabled={busy || upload.state === "uploading"}
                icon={<Send size={16} />}
                style={{ padding: "14px 18px", fontSize: 14.5 }}
              >
                {busy ? "Saving and checking against live data…" : "Submit my report"}
              </Button>
              <div style={{ marginTop: 12 }}>
                <Note>
                  Only sensor-corroborated reports raise the Monk&apos;s confidence. If nothing can
                  confirm your report yet it is still published, clearly marked unverified, and
                  never used to justify a confidence score.
                </Note>
              </div>
            </PanelBody>
            <PanelFoot>
              <span className="sk-dim-sm">
                Reported as {reporterName.trim() || "Anonymous"} · {rolesLabel(role)}
              </span>
              <span className="sk-spread" />
              <span className="sk-dim-sm">
                {point ? coordLabel(point.lat, point.lon) : "no position attached"}
              </span>
            </PanelFoot>
          </Panel>
        </div>

        {/* ------------------------------------------------- your record */}
        <div className="sk-stack" style={{ gap: 14 }}>
          <Panel>
            <PanelHead
              icon={<ShieldCheck size={16} />}
              title="Your contribution record"
              hint="Badges come only from confirmed reports"
            />
            <PanelBody>
              {me ? (
                <>
                  <div className="sk-row" style={{ alignItems: "baseline", gap: 10 }}>
                    <span className="cn-trust">{me.trust_score}</span>
                    <span>
                      <b>{me.badge}</b>
                      <br />
                      <span className="sk-dim-sm">
                        {me.contributions} report{me.contributions === 1 ? "" : "s"} ·{" "}
                        {me.verified} corroborated
                      </span>
                    </span>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <span className="sk-progress">
                      <i style={{ width: `${me.trust_score}%` }} />
                    </span>
                  </div>
                  <p className="sk-dim-sm" style={{ marginTop: 10 }}>
                    Trust score = 70% × (corroborated ÷ total) + 30% × min(corroborated, 10) ÷ 10.
                    It moves only when a live sensor or the PFZ bulletin confirms one of your
                    reports.
                  </p>
                </>
              ) : (
                <EmptyState
                  title={reporterName.trim() ? "No contributions under this name yet" : "Add your name above"}
                  body={
                    reporterName.trim()
                      ? "Submit your first report and it will appear here with the verification result."
                      : "Your reports are recorded under the name you type, so you can build a track record."
                  }
                />
              )}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              icon={<Community size={16} />}
              title="Community contributors"
              hint="Ranked by corroborated observations"
            />
            <PanelBody flush>
              {people.length ? (
                <div className="sk-typelist">
                  {people.map((p) => (
                    <div className="cn-person" key={`${p.name}-${p.badge_key}`}>
                      <span className="cn-person-ico" aria-hidden>
                        {p.badge_key === "expert" ? "🧭" : p.badge_key === "observer" ? "🔭" : p.badge_key === "trusted" ? "⛵" : "🐟"}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <b>{p.name}</b>
                        <span className="sk-dim-sm" style={{ display: "block" }}>
                          {p.verified} verified of {p.contributions} · trust {p.trust_score}
                        </span>
                      </span>
                      <span className="sk-spread" />
                      <Status tone={p.badge_tone}>{p.badge}</Status>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: 14 }}>
                  <EmptyState
                    title="No contributors yet"
                    body="Contribution records appear here once reports start arriving."
                  />
                </div>
              )}
            </PanelBody>
            <PanelFoot>
              <span className="sk-dim-sm">
                A badge is a statement about how many observations the sensors could confirm — never
                about the person.
              </span>
            </PanelFoot>
          </Panel>

          <Panel>
            <PanelHead
              icon={<ShieldCheck size={16} />}
              title="Recent reports"
              hint={`${feed.length} loaded${feedLoading ? " · refreshing" : ""}`}
            />
            <PanelBody flush>
              {feedNote ? (
                <div style={{ padding: 14 }}>
                  <Alert tone="warn" title="The feed is unavailable.">
                    {feedNote}
                  </Alert>
                </div>
              ) : feed.length ? (
                <div className="cn-feed">
                  {feed.slice(0, 12).map((r) => (
                    <article className="cn-item" key={r.id}>
                      <div className="cn-item-head">
                        <Status tone={r.verified ? "ok" : "info"}>
                          {r.verified ? "Verified" : "Unverified"}
                        </Status>
                        <b>{categoryLabel(r.category)}</b>
                        <span className="sk-spread" />
                        <span className="sk-dim-sm">
                          {mounted && r.observed_at ? relLabel(r.observed_at) : ""}
                        </span>
                      </div>
                      <p>{r.description}</p>
                      {r.media_url ? (
                        <div className="cn-thumb">
                          {r.media_type === "video" ? (
                            <video src={r.media_url} controls preload="metadata" />
                          ) : (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={r.media_url} alt={`Contribution: ${r.description.slice(0, 60)}`} loading="lazy" />
                          )}
                        </div>
                      ) : null}
                      <div className="cn-item-foot">
                        <span className="sk-dim-sm">
                          {r.reporter_name || "Anonymous"} · {coordLabel(r.lat, r.lon)}
                          {mounted && r.observed_at ? ` · ${istStamp(r.observed_at)}` : ""}
                        </span>
                        <span className="sk-spread" />
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={rechecking === r.id}
                          onClick={() => recheck(r.id)}
                        >
                          Re-check
                        </Button>
                      </div>
                      <p className="cn-note">{r.verification_note}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div style={{ padding: 14 }}>
                  <EmptyState
                    title="No reports in the window"
                    body="This is the live community store — nothing is shown in its place if the feed is empty."
                  />
                </div>
              )}
            </PanelBody>
            <PanelFoot>
              <span className="sk-dim-sm">
                <Warning size={12} /> Unverified reports are published for context and are never
                allowed to raise a confidence score.
              </span>
            </PanelFoot>
          </Panel>

          <Panel variant="plain">
            <PanelBody>
              <Eyebrow>How a contribution helps</Eyebrow>
              <ol className="cn-flow">
                <li>You send a photo, clip or observation with a position.</li>
                <li>The verification matrix cross-checks it against live wave, wind, storm and PFZ data.</li>
                <li>Confirmed reports raise the confidence of later answers about that area.</li>
                <li>Every other fisher asking the Monk about that water gets the benefit.</li>
              </ol>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </>
  );
}

function rolesLabel(role: string): string {
  return role.charAt(0).toLowerCase() + role.slice(1);
}
