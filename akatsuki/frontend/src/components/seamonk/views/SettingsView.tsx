"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  Check,
  Clock,
  Database,
  Depth,
  Download,
  Globe,
  MapLayers,
  Radar,
  Refresh,
  Satellite,
  ShieldCheck,
  Ship,
  Sliders,
  Squall,
  Warning,
  Waves,
} from "@/components/seamonk/icons";
import {
  Alert,
  Button,
  Eyebrow,
  Field,
  Note,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  RadioRow,
  Segmented,
  SourceRow,
  Status,
  Toggle,
} from "@/components/seamonk/primitives";
import { API_URL, useMounted, useSea } from "@/lib/seamonk/DataProvider";
import type { BasemapKey } from "@/components/seamonk/mapConfig";
import { LAYERS, type LayerKey } from "@/lib/seamonk/design";
import type { RegionId } from "@/lib/seamonk/demo";
import { coordPair, istStamp, num, sinceLabel } from "@/lib/seamonk/format";

type Section = "profile" | "region" | "notifications" | "sources" | "map" | "units" | "privacy" | "system";

const SECTIONS: Array<{ id: Section; label: string; icon: typeof Ship }> = [
  { id: "profile", label: "Profile", icon: Ship },
  { id: "region", label: "Region & Location", icon: Globe },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "sources", label: "Data Sources", icon: Database },
  { id: "map", label: "Map Preferences", icon: MapLayers },
  { id: "units", label: "Units", icon: Sliders },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "system", label: "System", icon: Radar },
];

type Prefs = {
  name: string;
  email: string;
  organisation: string;
  coordFormat: "dd" | "dm";
  defaultRegion: RegionId;
  centreLat: number;
  centreLon: number;
  monitoringRadiusNm: number;
  notify: Record<"severe" | "waves" | "zones" | "route" | "sources", boolean>;
  quietStart: string;
  quietEnd: string;
  channel: "inapp" | "email" | "sms";
  units: { distance: "nm" | "km"; wind: "kt" | "kmh" | "ms"; temp: "c" | "f"; depth: "m" | "ft" };
  map: {
    defaultLayer: LayerKey;
    basemap: BasemapKey;
    showCoords: boolean;
    showPfz: boolean;
    showHazards: boolean;
    opacity: number;
  };
  privacy: { retention: "30" | "90" | "365" | "indefinite"; shareAnon: boolean; attribution: "name" | "role" | "anonymous" };
};

const DEFAULTS: Prefs = {
  name: "Marine Explorer",
  email: "",
  organisation: "Coastal Region Operator",
  coordFormat: "dd",
  defaultRegion: "wb",
  centreLat: 21.55,
  centreLon: 87.9,
  monitoringRadiusNm: 60,
  notify: { severe: true, waves: true, zones: false, route: true, sources: true },
  quietStart: "22:00",
  quietEnd: "05:30",
  channel: "inapp",
  units: { distance: "nm", wind: "kt", temp: "c", depth: "m" },
  map: { defaultLayer: "sst", basemap: "dark", showCoords: true, showPfz: true, showHazards: true, opacity: 0.5 },
  privacy: { retention: "90", shareAnon: true, attribution: "role" },
};

const STORE_KEY = "seamonk.prefs.v1";

export default function SettingsView() {
  const sea = useSea();
  const mounted = useMounted();
  const [section, setSection] = useState<Section>("profile");
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const [sourceTest, setSourceTest] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Array<{ label: string; value: string; tone: "ok" | "warn" | "danger" }>>([]);
  const [runningDiag, setRunningDiag] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  // Preferences live in this browser only — there is no account service wired
  // up, so nothing is claimed to be stored on a server.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) setPrefs({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) });
    } catch {
      /* unreadable or blocked storage — fall back to defaults */
    }
    setLoaded(true);
  }, []);

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
        setSavedAt(Date.now());
      } catch {
        /* storage full or blocked */
      }
      return next;
    });
  }, []);

  const emailInvalid = touched && prefs.email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prefs.email);
  const nameInvalid = touched && prefs.name.trim().length < 2;

  const testSources = async () => {
    setTesting(true);
    const started = performance.now();
    try {
      const res = await fetch(`${API_URL}/api/health/systems`, { cache: "no-store" });
      const ms = Math.round(performance.now() - started);
      if (res.ok) {
        const data = await res.json();
        const rows = (data.systems ?? []) as Array<{ status: string; label: string }>;
        const degraded = rows.filter((r) => r.status !== "active");
        setSourceTest({
          tone: degraded.length ? "warn" : "ok",
          text: `${rows.length} systems answered in ${ms} ms${degraded.length ? `, ${degraded.length} degraded: ${degraded.map((d) => d.label).join(", ")}` : ", all active"}.`,
        });
      } else {
        setSourceTest({ tone: "danger", text: `The endpoint replied ${res.status} in ${ms} ms.` });
      }
    } catch {
      setSourceTest({
        tone: "danger",
        text: `No answer from ${API_URL} within the browser timeout. The console is running on the demonstration dataset.`,
      });
    }
    setTesting(false);
  };

  const runDiagnostics = async () => {
    setRunningDiag(true);
    const out: Array<{ label: string; value: string; tone: "ok" | "warn" | "danger" }> = [];
    out.push({
      label: "Data mode",
      value: sea.mode === "demo" ? "Demonstration dataset (API unreachable)" : sea.mode === "degraded" ? "Live with a degraded pipeline" : "Live",
      tone: sea.mode === "live" ? "ok" : sea.mode === "degraded" ? "warn" : "warn",
    });
    const t0 = performance.now();
    try {
      const res = await fetch(`${API_URL}/api/dashboard`, { cache: "no-store" });
      out.push({
        label: "Aggregation endpoint",
        value: `HTTP ${res.status} in ${Math.round(performance.now() - t0)} ms`,
        tone: res.ok ? "ok" : "warn",
      });
    } catch {
      out.push({
        label: "Aggregation endpoint",
        value: `no response from ${API_URL} (${Math.round(performance.now() - t0)} ms)`,
        tone: "danger",
      });
    }
    out.push({
      label: "Local storage",
      value: (() => {
        try {
          window.localStorage.setItem("seamonk.probe", "1");
          window.localStorage.removeItem("seamonk.probe");
          return "readable and writable";
        } catch {
          return "blocked by the browser";
        }
      })(),
      tone: "ok",
    });
    out.push({
      label: "Clock",
      value: `browser reports ${istStamp(Date.now())}`,
      tone: "ok",
    });
    setDiagnostics(out);
    setRunningDiag(false);
  };

  const exportPrefs = () => {
    const blob = new Blob(
      [JSON.stringify({ app: "THE SEAMONK", exportedAt: new Date().toISOString(), preferences: prefs }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "seamonk-preferences.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearLocal = () => {
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      /* nothing to clear */
    }
    setPrefs(DEFAULTS);
    setSavedAt(null);
    setClearConfirm(false);
  };

  const unitPreview = useMemo(() => {
    const d = sea.conditions;
    const nm = 22.4;
    return {
      distance: prefs.units.distance === "nm" ? `${nm.toFixed(1)} NM` : `${(nm * 1.852).toFixed(1)} km`,
      wind:
        prefs.units.wind === "kt"
          ? `${num(d.wind_kt, 0)} kt`
          : prefs.units.wind === "kmh"
            ? `${num(d.wind_kt * 1.852, 1)} km/h`
            : `${num(d.wind_kt * 0.514444, 1)} m/s`,
      temp: prefs.units.temp === "c" ? `${num(d.sst_c, 1)} °C` : `${num((d.sst_c * 9) / 5 + 32, 1)} °F`,
      depth: prefs.units.depth === "m" ? "42 m" : `${(42 * 3.28084).toFixed(1)} ft`,
    };
  }, [prefs.units, sea.conditions]);

  const coordPreview = prefs.coordFormat === "dd" ? "21.55°N 87.90°E" : "21° 33.0′ N  87° 54.0′ E";

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Settings</h1>
          <p>
            Configure the console for your role and region. Preferences are stored in this browser — no account service
            is connected in this build.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          <span className="sk-chip">
            <Check size={13} />
            {savedAt ? `Saved ${mounted ? istStamp(savedAt) : ""}` : loaded ? "No changes yet" : "Loading"}
          </span>
          <Button
            variant="ghost"
            icon={<Refresh size={14} />}
            onClick={() => {
              setPrefs(DEFAULTS);
              try {
                window.localStorage.setItem(STORE_KEY, JSON.stringify(DEFAULTS));
              } catch {
                /* ignore */
              }
              setSavedAt(Date.now());
            }}
          >
            Restore defaults
          </Button>
        </div>
      </div>

      <div className="sk-settings">
        {/* ------------------------------------------------------- sections nav */}
        <nav className="sk-settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                className="sk-settings-item"
                aria-current={section === s.id}
                onClick={() => setSection(s.id)}
              >
                <Icon size={16} />
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="sk-stack">
          {section === "profile" ? (
            <Panel>
              <PanelHead icon={<Ship size={16} />} title="Profile" hint="How you appear on reports and community reports" />
              <PanelBody>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Display name</div>
                    <p className="sk-setting-desc">Printed as the author on every report you generate.</p>
                  </div>
                  <Field
                    label="Display name"
                    hideLabel
                    htmlFor="st-name"
                    error={nameInvalid ? "Enter at least two characters." : undefined}
                  >
                    <input
                      id="st-name"
                      className="sk-input"
                      value={prefs.name}
                      aria-invalid={nameInvalid}
                      onBlur={() => setTouched(true)}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Email</div>
                    <p className="sk-setting-desc">
                      Used only for report delivery if a delivery channel is ever configured. Left empty by default.
                    </p>
                  </div>
                  <Field
                    label="Email address"
                    hideLabel
                    htmlFor="st-email"
                    error={emailInvalid ? "That does not look like an email address." : undefined}
                    hint={emailInvalid ? undefined : "Optional"}
                  >
                    <input
                      id="st-email"
                      className="sk-input"
                      type="email"
                      placeholder="name@example.org"
                      value={prefs.email}
                      aria-invalid={emailInvalid}
                      onBlur={() => setTouched(true)}
                      onChange={(e) => update({ email: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Role</div>
                    <p className="sk-setting-desc">
                      Determines which advisories are pushed to you and how your community reports are weighted.
                    </p>
                  </div>
                  <select
                    className="sk-select"
                    value={prefs.organisation}
                    onChange={(e) => update({ organisation: e.target.value })}
                    aria-label="Role"
                  >
                    <option>Coastal Region Operator</option>
                    <option>Fisher</option>
                    <option>Vessel master</option>
                    <option>Marine researcher</option>
                    <option>Port authority</option>
                  </select>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Session context</div>
                    <p className="sk-setting-desc">Read-only values resolved at runtime.</p>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="sk-pair">
                      <span>Region</span>
                      <span>{sea.region.name}</span>
                    </div>
                    <div className="sk-pair">
                      <span>Data mode</span>
                      <span>{sea.mode === "demo" ? "Demonstration" : sea.mode === "degraded" ? "Live, degraded" : "Live"}</span>
                    </div>
                  </div>
                </div>
              </PanelBody>
            </Panel>
          ) : null}

          {section === "region" ? (
            <Panel>
              <PanelHead icon={<Globe size={16} />} title="Region & Location" hint="What the console opens on" />
              <PanelBody>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Default region</div>
                    <p className="sk-setting-desc">
                      Applied on load. The header switcher changes it for the session without altering this preference.
                    </p>
                  </div>
                  <select
                    className="sk-select"
                    value={prefs.defaultRegion}
                    onChange={(e) => {
                      const id = e.target.value as RegionId;
                      const r = sea.regions.find((x) => x.id === id);
                      update({ defaultRegion: id, ...(r ? { centreLat: r.lat, centreLon: r.lon } : {}) });
                      sea.setRegionId(id);
                    }}
                    aria-label="Default region"
                  >
                    {sea.regions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Coordinate format</div>
                    <p className="sk-setting-desc">Preview: {coordPreview}</p>
                  </div>
                  <div>
                    <RadioRow
                      checked={prefs.coordFormat === "dd"}
                      onChange={() => update({ coordFormat: "dd" })}
                      name="coord"
                      value="dd"
                      label="Decimal degrees"
                      detail="21.55°N 87.90°E"
                    />
                    <RadioRow
                      checked={prefs.coordFormat === "dm"}
                      onChange={() => update({ coordFormat: "dm" })}
                      name="coord"
                      value="dm"
                      label="Degrees and decimal minutes"
                      detail="21° 33.0′ N 87° 54.0′ E — the form used on chart tables"
                    />
                  </div>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Default map centre</div>
                    <p className="sk-setting-desc">Where a new map opens. Use the current region centre if unsure.</p>
                  </div>
                  <div>
                    <div className="sk-field-row">
                      <Field label="Latitude" htmlFor="st-lat">
                        <input
                          id="st-lat"
                          className="sk-input sk-mono"
                          type="number"
                          step={0.01}
                          min={-90}
                          max={90}
                          value={prefs.centreLat}
                          onChange={(e) => update({ centreLat: +e.target.value })}
                        />
                      </Field>
                      <Field label="Longitude" htmlFor="st-lon">
                        <input
                          id="st-lon"
                          className="sk-input sk-mono"
                          type="number"
                          step={0.01}
                          min={-180}
                          max={180}
                          value={prefs.centreLon}
                          onChange={(e) => update({ centreLon: +e.target.value })}
                        />
                      </Field>
                    </div>
                    <div className="sk-row" style={{ marginTop: 8 }}>
                      <Button
                        size="sm"
                        onClick={() => update({ centreLat: sea.region.lat, centreLon: sea.region.lon })}
                      >
                        Use {sea.region.short} centre
                      </Button>
                      <span className="sk-dim-sm">
                        {coordPair(prefs.centreLat, "N", "S")} {coordPair(prefs.centreLon, "E", "W")}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Monitoring radius — {prefs.monitoringRadiusNm} NM</div>
                    <p className="sk-setting-desc">
                      Advisories and community reports outside this radius are held back rather than shown greyed out.
                    </p>
                  </div>
                  <div>
                    <input
                      className="sk-range"
                      type="range"
                      min={10}
                      max={200}
                      step={5}
                      value={prefs.monitoringRadiusNm}
                      onChange={(e) => update({ monitoringRadiusNm: +e.target.value })}
                      aria-label="Monitoring radius in nautical miles"
                      style={{ "--fill": `${((prefs.monitoringRadiusNm - 10) / 190) * 100}%` } as React.CSSProperties}
                    />
                    <span className="sk-field-help">
                      {sea.pfz.filter((z) => z.distanceNm <= prefs.monitoringRadiusNm).length} of {sea.pfz.length} fishing
                      zones fall inside this radius.
                    </span>
                  </div>
                </div>
              </PanelBody>
            </Panel>
          ) : null}

          {section === "notifications" ? (
            <Panel>
              <PanelHead icon={<Bell size={16} />} title="Notifications" hint="What is worth interrupting you for" />
              <PanelBody>
                {(
                  [
                    { key: "severe", label: "Severe weather", desc: "Gale or squall warnings for the monitored radius." },
                    { key: "waves", label: "High wave conditions", desc: "Significant wave height above 2.0 m on the forecast." },
                    { key: "zones", label: "Fishing zone updates", desc: "A new PFZ bulletin with zones above your threshold." },
                    { key: "route", label: "Route hazards", desc: "A hazard registered on or within 3 km of a planned track." },
                    { key: "sources", label: "Data source failures", desc: "A pipeline stops reporting for more than two cycles." },
                  ] as const
                ).map((row) => (
                  <div className="sk-setting-row" key={row.key}>
                    <div>
                      <div className="sk-setting-label">{row.label}</div>
                      <p className="sk-setting-desc">{row.desc}</p>
                    </div>
                    <div className="sk-setting-inline">
                      <Status tone={prefs.notify[row.key] ? "ok" : "neutral"}>
                        {prefs.notify[row.key] ? "On" : "Off"}
                      </Status>
                      <Toggle
                        checked={prefs.notify[row.key]}
                        onChange={(v) => update({ notify: { ...prefs.notify, [row.key]: v } })}
                        label={row.label}
                      />
                    </div>
                  </div>
                ))}
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Quiet hours</div>
                    <p className="sk-setting-desc">
                      Nothing is delivered between these times except storm warnings, which always break through.
                    </p>
                  </div>
                  <div className="sk-field-row">
                    <Field label="From" htmlFor="st-quiet-a">
                      <input
                        id="st-quiet-a"
                        className="sk-input sk-mono"
                        type="time"
                        value={prefs.quietStart}
                        onChange={(e) => update({ quietStart: e.target.value })}
                      />
                    </Field>
                    <Field label="To" htmlFor="st-quiet-b">
                      <input
                        id="st-quiet-b"
                        className="sk-input sk-mono"
                        type="time"
                        value={prefs.quietEnd}
                        onChange={(e) => update({ quietEnd: e.target.value })}
                      />
                    </Field>
                  </div>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Delivery channel</div>
                    <p className="sk-setting-desc">
                      In-app delivery works today. Email and SMS need provider credentials that are not configured in
                      this deployment.
                    </p>
                  </div>
                  <div>
                    <RadioRow
                      checked={prefs.channel === "inapp"}
                      onChange={() => update({ channel: "inapp" })}
                      name="channel"
                      value="inapp"
                      label="In-app only"
                      detail="Badge on the header bell"
                    />
                    <label className="sk-radio" style={{ opacity: 0.45 }}>
                      <input type="radio" disabled name="channel" value="email" />
                      <span>
                        Email digest
                        <small style={{ display: "block", fontSize: 10.5, color: "var(--dim)" }}>
                          No mail provider configured
                        </small>
                      </span>
                    </label>
                    <label className="sk-radio" style={{ opacity: 0.45 }}>
                      <input type="radio" disabled name="channel" value="sms" />
                      <span>
                        SMS alert
                        <small style={{ display: "block", fontSize: 10.5, color: "var(--dim)" }}>
                          No SMS gateway configured
                        </small>
                      </span>
                    </label>
                  </div>
                </div>
              </PanelBody>
              <PanelFoot>
                <Note>
                  Notification rules are evaluated in the browser while the console is open. Nothing is delivered while
                  the tab is closed.
                </Note>
              </PanelFoot>
            </Panel>
          ) : null}

          {section === "sources" ? (
            <Panel>
              <PanelHead
                icon={<Database size={16} />}
                title="Data Sources"
                hint={`Console endpoint ${API_URL}`}
                actions={
                  <Button size="sm" icon={<Refresh size={13} />} busy={testing} onClick={testSources}>
                    Test connection
                  </Button>
                }
              />
              <PanelBody tight>
                {sea.sources.map((s) => (
                  <SourceRow
                    key={s.key}
                    icon={
                      s.key === "satellite" ? (
                        <Satellite size={14} />
                      ) : s.key === "weather" ? (
                        <Squall size={14} />
                      ) : s.key === "gis" ? (
                        <Depth size={14} />
                      ) : (
                        <Waves size={14} />
                      )
                    }
                    name={`${s.label} — ${s.provider}`}
                    status={{
                      tone: s.status === "active" ? "ok" : s.status === "degraded" ? "warn" : "danger",
                      label: s.status === "active" ? "Receiving" : s.status === "degraded" ? "Degraded" : "Offline",
                    }}
                    note={s.note}
                    metrics={[
                      { label: "Coverage", value: `${s.coverage}%` },
                      { label: "Last sync", value: mounted ? sinceLabel(Date.now() - s.lastSyncMin * 60_000) : "—" },
                      { label: "Cadence", value: s.cadence },
                    ]}
                  />
                ))}
              </PanelBody>
              <PanelBody tight>
                {sourceTest ? (
                  <Alert tone={sourceTest.tone} title={sourceTest.tone === "ok" ? "Connection healthy." : "Connection check"}>
                    {sourceTest.text}
                  </Alert>
                ) : (
                  <Note>
                    The test calls <code className="sk-mono">{API_URL}/api/health/systems</code> from this browser. A
                    failure here means the console is showing the demonstration dataset, not a broken interface.
                  </Note>
                )}
              </PanelBody>
              <PanelFoot>
                <span className="sk-dim-sm">
                  Source register refreshed {mounted ? sinceLabel(Date.now() - sea.sources[0].lastSyncMin * 60_000) : "—"}
                </span>
              </PanelFoot>
            </Panel>
          ) : null}

          {section === "map" ? (
            <Panel>
              <PanelHead icon={<MapLayers size={16} />} title="Map Preferences" hint="Applies to every map in the console" />
              <PanelBody>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Default scalar layer</div>
                    <p className="sk-setting-desc">Which field is shaded when a map opens.</p>
                  </div>
                  <select
                    className="sk-select"
                    value={prefs.map.defaultLayer}
                    onChange={(e) => update({ map: { ...prefs.map, defaultLayer: e.target.value as LayerKey } })}
                    aria-label="Default layer"
                  >
                    {LAYERS.map((l) => (
                      <option key={l.key} value={l.key}>
                        {l.label} ({l.unit})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Map style</div>
                    <p className="sk-setting-desc">
                      The dark chart is the working style; coastal detail is for verifying place names.
                    </p>
                  </div>
                  <div>
                    <RadioRow
                      checked={prefs.map.basemap === "dark"}
                      onChange={() => update({ map: { ...prefs.map, basemap: "dark" } })}
                      name="basemap"
                      value="dark"
                      label="Chart dark"
                    />
                    <RadioRow
                      checked={prefs.map.basemap === "coastal"}
                      onChange={() => update({ map: { ...prefs.map, basemap: "coastal" } })}
                      name="basemap"
                      value="coastal"
                      label="Coastal detail"
                    />
                    <RadioRow
                      checked={prefs.map.basemap === "satellite"}
                      onChange={() => update({ map: { ...prefs.map, basemap: "satellite" } })}
                      name="basemap"
                      value="satellite"
                      label="Imagery"
                    />
                  </div>
                </div>
                {(
                  [
                    { key: "showCoords" as const, label: "Show coordinate readout", desc: "Live cursor position in the bottom-left corner of every map." },
                    { key: "showPfz" as const, label: "Show fishing zones", desc: "PFZ polygons and probability symbols draw by default." },
                    { key: "showHazards" as const, label: "Show hazard zones", desc: "Registered hazards, restricted areas and shoal warnings." },
                  ] as const
                ).map((row) => (
                  <div className="sk-setting-row" key={row.key}>
                    <div>
                      <div className="sk-setting-label">{row.label}</div>
                      <p className="sk-setting-desc">{row.desc}</p>
                    </div>
                    <div className="sk-setting-inline">
                      <Status tone={prefs.map[row.key] ? "ok" : "neutral"}>{prefs.map[row.key] ? "Shown" : "Hidden"}</Status>
                      <Toggle
                        checked={prefs.map[row.key]}
                        onChange={(v) => update({ map: { ...prefs.map, [row.key]: v } })}
                        label={row.label}
                      />
                    </div>
                  </div>
                ))}
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Default field opacity — {Math.round(prefs.map.opacity * 100)}%</div>
                    <p className="sk-setting-desc">
                      Aim for the point where the coastline is still legible under the field.
                    </p>
                  </div>
                  <div>
                    <input
                      className="sk-range"
                      type="range"
                      min={10}
                      max={90}
                      step={5}
                      value={Math.round(prefs.map.opacity * 100)}
                      onChange={(e) => update({ map: { ...prefs.map, opacity: +e.target.value / 100 } })}
                      aria-label="Default field opacity"
                      style={{ "--fill": `${((prefs.map.opacity * 100 - 10) / 80) * 100}%` } as React.CSSProperties}
                    />
                  </div>
                </div>
              </PanelBody>
            </Panel>
          ) : null}

          {section === "units" ? (
            <Panel>
              <PanelHead icon={<Sliders size={16} />} title="Units" hint="Preview and export preferences" />
              <PanelBody>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Distance</div>
                    <p className="sk-setting-desc">Example: {unitPreview.distance}</p>
                  </div>
                  <Segmented
                    label="Distance unit"
                    value={prefs.units.distance}
                    onChange={(v) => update({ units: { ...prefs.units, distance: v as "nm" | "km" } })}
                    options={[
                      { value: "nm" as const, label: "Nautical miles" },
                      { value: "km" as const, label: "Kilometres" },
                    ]}
                  />
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Wind speed</div>
                    <p className="sk-setting-desc">Example: {unitPreview.wind}</p>
                  </div>
                  <Segmented
                    label="Wind unit"
                    value={prefs.units.wind}
                    onChange={(v) => update({ units: { ...prefs.units, wind: v as "kt" | "kmh" | "ms" } })}
                    options={[
                      { value: "kt" as const, label: "Knots" },
                      { value: "kmh" as const, label: "km/h" },
                      { value: "ms" as const, label: "m/s" },
                    ]}
                  />
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Temperature</div>
                    <p className="sk-setting-desc">Example: {unitPreview.temp}</p>
                  </div>
                  <Segmented
                    label="Temperature unit"
                    value={prefs.units.temp}
                    onChange={(v) => update({ units: { ...prefs.units, temp: v as "c" | "f" } })}
                    options={[
                      { value: "c" as const, label: "Celsius" },
                      { value: "f" as const, label: "Fahrenheit" },
                    ]}
                  />
                </div>
                <div className="sk-setting-row">
                  <div>
                    <div className="sk-setting-label">Depth</div>
                    <p className="sk-setting-desc">Example: {unitPreview.depth}</p>
                  </div>
                  <Segmented
                    label="Depth unit"
                    value={prefs.units.depth}
                    onChange={(v) => update({ units: { ...prefs.units, depth: v as "m" | "ft" } })}
                    options={[
                      { value: "m" as const, label: "Metres" },
                      { value: "ft" as const, label: "Feet" },
                    ]}
                  />
                </div>
              </PanelBody>
              <PanelFoot>
                <Note>
                  Conversions are previewed here and stored with your preferences. Panels print the units straight from
                  the source feed, because presenting a converted value beside a source-described one is how
                  transcription errors start. Exports always carry the unit in the column header.
                </Note>
              </PanelFoot>
            </Panel>
          ) : null}

          {section === "privacy" ? (
            <>
              <Panel>
                <PanelHead icon={<ShieldCheck size={16} />} title="Privacy" hint="What is kept, and for how long" />
                <PanelBody>
                  <div className="sk-setting-row">
                    <div>
                      <div className="sk-setting-label">Query retention</div>
                      <p className="sk-setting-desc">
                        Questions asked of the Monk are stored with the answer for audit and improvement. Choose how long
                        they are kept.
                      </p>
                    </div>
                    <select
                      className="sk-select"
                      value={prefs.privacy.retention}
                      onChange={(e) => update({ privacy: { ...prefs.privacy, retention: e.target.value as Prefs["privacy"]["retention"] } })}
                      aria-label="Query retention"
                    >
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="365">1 year</option>
                      <option value="indefinite">Keep indefinitely</option>
                    </select>
                  </div>
                  <div className="sk-setting-row">
                    <div>
                      <div className="sk-setting-label">Community report attribution</div>
                      <p className="sk-setting-desc">
                        How your position reports are credited. Anonymous reports still count towards verification, they
                        just carry no name.
                      </p>
                    </div>
                    <div>
                      <RadioRow
                        checked={prefs.privacy.attribution === "name"}
                        onChange={() => update({ privacy: { ...prefs.privacy, attribution: "name" } })}
                        name="attrib"
                        value="name"
                        label="Full name and role"
                      />
                      <RadioRow
                        checked={prefs.privacy.attribution === "role"}
                        onChange={() => update({ privacy: { ...prefs.privacy, attribution: "role" } })}
                        name="attrib"
                        value="role"
                        label="Role only"
                        detail="e.g. “Fisher, Digha”"
                      />
                      <RadioRow
                        checked={prefs.privacy.attribution === "anonymous"}
                        onChange={() => update({ privacy: { ...prefs.privacy, attribution: "anonymous" } })}
                        name="attrib"
                        value="anonymous"
                        label="Anonymous"
                      />
                    </div>
                  </div>
                  <div className="sk-setting-row">
                    <div>
                      <div className="sk-setting-label">Share anonymised reports</div>
                      <p className="sk-setting-desc">
                        Contribute de-identified condition reports to the research aggregate. Off by default, and never
                        includes coordinates.
                      </p>
                    </div>
                    <div className="sk-setting-inline">
                      <Status tone={prefs.privacy.shareAnon ? "ok" : "neutral"}>{prefs.privacy.shareAnon ? "Sharing" : "Not sharing"}</Status>
                      <Toggle
                        checked={prefs.privacy.shareAnon}
                        onChange={(v) => update({ privacy: { ...prefs.privacy, shareAnon: v } })}
                        label="Share anonymised reports"
                      />
                    </div>
                  </div>
                </PanelBody>
                <PanelFoot>
                  <span className="sk-row" style={{ gap: 10 }}>
                    <Button size="sm" icon={<Download size={13} />} onClick={exportPrefs}>
                      Export my preferences
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setClearConfirm(true)} disabled={clearConfirm}>
                      Clear local data
                    </Button>
                  </span>
                </PanelFoot>
              </Panel>

              {clearConfirm ? (
                <Alert
                  tone="danger"
                  title="Clear everything stored in this browser?"
                  action={
                    <span className="sk-row" style={{ gap: 8 }}>
                      <Button size="sm" onClick={() => setClearConfirm(false)}>
                        Keep
                      </Button>
                      <Button size="sm" variant="danger" onClick={clearLocal}>
                        Clear now
                      </Button>
                    </span>
                  }
                >
                  Preferences, map state and the last session context are removed and the console returns to defaults.
                  Nothing leaves this browser either way.
                </Alert>
              ) : null}
            </>
          ) : null}

          {section === "system" ? (
            <>
              <Panel>
                <PanelHead
                  icon={<Radar size={16} />}
                  title="System"
                  hint="Runtime facts, not marketing copy"
                  actions={
                    <Button size="sm" icon={<Refresh size={13} />} busy={runningDiag} onClick={runDiagnostics}>
                      Run diagnostics
                    </Button>
                  }
                />
                <PanelBody>
                  <div className="sk-kv-grid">
                    <div>
                      <span className="sk-kv-label">Console build</span>
                      <span className="sk-kv-value">v2.0</span>
                      <span className="sk-kv-note">static export, client-rendered workspaces</span>
                    </div>
                    <div>
                      <span className="sk-kv-label">API endpoint</span>
                      <span className="sk-kv-value" style={{ fontSize: 12.5 }}>
                        {API_URL.replace(/^https?:\/\//, "")}
                      </span>
                      <span className="sk-kv-note">from NEXT_PUBLIC_API_URL</span>
                    </div>
                    <div>
                      <span className="sk-kv-label">Data mode</span>
                      <span className="sk-kv-value">{sea.mode === "demo" ? "Demonstration" : sea.mode === "degraded" ? "Live, degraded" : "Live"}</span>
                      <span className="sk-kv-note">{sea.statusNote}</span>
                    </div>
                    <div>
                      <span className="sk-kv-label">Last poll</span>
                      <span className="sk-kv-value" style={{ fontSize: 12.5 }}>
                        {mounted && sea.generatedAt ? istStamp(sea.generatedAt) : "—"}
                      </span>
                      <span className="sk-kv-note">console polls every 60 seconds</span>
                    </div>
                    <div>
                      <span className="sk-kv-label">Timezone</span>
                      <span className="sk-kv-value" style={{ fontSize: 12.5 }}>
                        {Intl.DateTimeFormat().resolvedOptions().timeZone}
                      </span>
                      <span className="sk-kv-note">all marine times displayed in IST</span>
                    </div>
                    <div>
                      <span className="sk-kv-label">Locale</span>
                      <span className="sk-kv-value" style={{ fontSize: 12.5 }}>
                        {typeof navigator !== "undefined" ? navigator.language : "—"}
                      </span>
                      <span className="sk-kv-note">numbers and dates</span>
                    </div>
                  </div>

                  {diagnostics.length ? (
                    <>
                      <div className="sk-hair" />
                      <Eyebrow>Diagnostic results</Eyebrow>
                      <div style={{ marginTop: 8 }}>
                        {diagnostics.map((d) => (
                          <div className="sk-pair" key={d.label}>
                            <span>
                              <Status tone={d.tone} plain>
                                {d.tone === "ok" ? "Pass" : d.tone === "warn" ? "Attention" : "Fail"}
                              </Status>
                              {d.label}
                            </span>
                            <span>{d.value}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </PanelBody>
                <PanelFoot>
                  <span className="sk-dim-sm">{sea.statusNote}</span>
                </PanelFoot>
              </Panel>

              <Panel>
                <PanelHead icon={<Clock size={16} />} title="Keyboard and shortcuts" hint="What the console actually binds" />
                <PanelBody>
                  {(
                    [
                      ["Esc", "Close a drawer, dialog or popover."],
                      ["← →", "Move the cursor along a focused chart."],
                      ["Home / End", "Jump to the start or end of a chart series."],
                      ["Enter / Space", "Activate the focused table row."],
                      ["Tab / Shift+Tab", "Move focus; every control shows a visible focus ring."],
                    ] as const
                  ).map(([key, desc]) => (
                    <div className="sk-pair" key={key}>
                      <span>
                        <kbd className="sk-kbd">{key}</kbd>
                      </span>
                      <span style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--muted)", maxWidth: "62%" }}>
                        {desc}
                      </span>
                    </div>
                  ))}
                </PanelBody>
                <PanelFoot>
                  <Note>
                    Only shortcuts that are genuinely implemented are listed. Nothing here is aspirational.
                  </Note>
                </PanelFoot>
              </Panel>

              <Panel>
                <PanelHead icon={<Warning size={16} />} title="Account and data" hint="Actions that need a service this build does not have" />
                <PanelBody>
                  <div className="sk-setting-row">
                    <div>
                      <div className="sk-setting-label">Sign out</div>
                      <p className="sk-setting-desc">
                        There is no session to end: the console runs without authentication in this deployment.
                      </p>
                    </div>
                    <div className="sk-setting-inline">
                      <Status tone="neutral">Not applicable</Status>
                    </div>
                  </div>
                  <div className="sk-setting-row">
                    <div>
                      <div className="sk-setting-label">Delete account and data</div>
                      <p className="sk-setting-desc">
                        Requires server-side identity to be configured. Until then this control stays disabled rather
                        than pretending to work.
                      </p>
                    </div>
                    <div className="sk-setting-inline">
                      <Button variant="danger" disabled title="No identity service configured">
                        Delete account
                      </Button>
                    </div>
                  </div>
                </PanelBody>
              </Panel>
            </>
          ) : null}

          {!loaded ? (
            <div className="sk-row">
              <span className="sk-skel" style={{ height: 12, width: 180 }} />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
