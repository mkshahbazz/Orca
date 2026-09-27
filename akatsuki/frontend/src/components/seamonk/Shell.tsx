"use client";

/**
 * THE SEAMONK — application shell.
 *
 * Persistent by design: the rail and the header never re-mount between pages,
 * so the marine explorer's context (region, data mode, clock) stays put while
 * only the workspace changes. That is what separates an operations console
 * from a set of pages.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMounted, useNow, useSea } from "@/lib/seamonk/DataProvider";
import { istStamp, coordLabel } from "@/lib/seamonk/format";
import {
  Anchor,
  Beacon,
  Bell,
  ChevronDown,
  Close,
  Database,
  FishingZones,
  Globe,
  MapLayers,
  MarineAnalytics,
  Menu,
  OceanWatch,
  Refresh,
  Reports,
  Satellite,
  Settings,
  Ship,
  Sliders,
  Squall,
  VoyageSafety,
  Waves,
  Warning,
} from "./icons";
import { relLabel, SourceTag, Status } from "./primitives";

export type NavItem = {
  href: string;
  label: string;
  icon: (p: { size?: number; strokeWidth?: number }) => ReactNode;
  count?: number;
};

export function navItems(counts: { zones: number; reports: number }): NavItem[] {
  return [
    { href: "/dashboard/", label: "Ocean Watch", icon: OceanWatch },
    { href: "/dashboard/fishing-zones/", label: "Fishing Zones", icon: FishingZones, count: counts.zones },
    { href: "/dashboard/voyage-safety/", label: "Voyage Safety", icon: VoyageSafety },
    { href: "/dashboard/analytics/", label: "Marine Analytics", icon: MarineAnalytics },
    { href: "/dashboard/map-layers/", label: "Map Layers", icon: MapLayers },
    { href: "/dashboard/reports/", label: "Reports", icon: Reports, count: counts.reports },
    { href: "/dashboard/settings/", label: "Settings", icon: Settings },
  ];
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/dashboard/";
  const sea = useSea();
  const mounted = useMounted();
  const now = useNow(20_000);
  const [railOpen, setRailOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);

  const bellRef = useOutside(bellOpen, () => setBellOpen(false));
  const userRef = useOutside(userOpen, () => setUserOpen(false));

  useEffect(() => {
    setRailOpen(false);
    setBellOpen(false);
    setUserOpen(false);
  }, [path]);

  const items = navItems({
    zones: sea.pfz.filter((z) => z.probability >= 65).length,
    reports: sea.reports.filter((r) => r.status === "ready").length,
  });
  const current = items.find((i) => i.href === path) ?? items[0];

  const criticalHazards = sea.hazards.filter((h) => h.severity === "hazard");
  const alerts = [
    ...criticalHazards.map((h) => ({
      id: h.id,
      tone: "danger" as const,
      title: h.label,
      detail: h.detail,
      meta: `Valid ${h.validUntil}`,
    })),
    ...sea.hazards
      .filter((h) => h.severity === "caution")
      .map((h) => ({
        id: h.id,
        tone: "warn" as const,
        title: h.label,
        detail: h.detail,
        meta: `Valid ${h.validUntil}`,
      })),
    ...sea.community
      .filter((c) => c.verified)
      .map((c) => ({
        id: c.id,
        tone: "info" as const,
        title: `Verified community report — ${c.category.replace(/_/g, " ")}`,
        detail: c.verificationNote,
        meta: `${c.reporterRole} · ${relLabel(c.observedAt)}`,
      })),
    ...sea.systems
      .filter((s) => s.status !== "active")
      .map((s) => ({
        id: `sys-${s.key}`,
        tone: "warn" as const,
        title: `${s.label} degraded`,
        detail: `${s.source} is not reporting at full coverage.`,
        meta: "Pipeline status",
      })),
  ].slice(0, 7);

  return (
    <div className="sk-shell">
      <a className="sk-skip" href="#sk-main">
        Skip to workspace
      </a>

      {/* ------------------------------------------------------------ rail */}
      <nav className="sk-rail" aria-label="Console sections">
        <div className="sk-brand">
          <span className="sk-brand-mark">
            <Beacon size={21} />
          </span>
          <span className="sk-brand-txt">
            <span className="sk-brand-word">
              THE SEA<span>MONK</span>
            </span>
            <span className="sk-brand-sub">ENTER THE AQUATIC REALM</span>
          </span>
        </div>

        <div className="sk-nav">
          <div className="sk-nav-group">Operations</div>
          {items.map((it) => {
            const Icon = it.icon;
            const active = path === it.href;
            return (
              <Link
                key={it.href}
                href={it.href}
                className="sk-nav-item"
                aria-current={active ? "page" : undefined}
                aria-label={it.label}
                title={it.label}
              >
                <Icon size={18} strokeWidth={active ? 1.9 : 1.7} />
                <span className="sk-nav-label">{it.label}</span>
                {it.count !== undefined ? <span className="sk-nav-count">{it.count}</span> : null}
              </Link>
            );
          })}
        </div>

        <div className="sk-rail-foot">
          <div className="sk-rail-reading">
            <span className="sk-eyebrow" style={{ color: "var(--gold)" }}>
              Region watch
            </span>
            <p>
              {sea.region.name} — {sea.observations.length} stations reporting,{" "}
              {sea.pfz.filter((z) => z.probability >= 65).length} zones above the advisory threshold.
            </p>
          </div>
          <div className="sk-rail-version">
            <span>SEAMONK CONSOLE v2.0</span>
            <span>{sea.mode === "demo" ? "OFFLINE" : sea.mode.toUpperCase()}</span>
          </div>
        </div>
      </nav>

      {/* mobile rail */}
      {railOpen ? (
        <>
          <div className="sk-scrim" onClick={() => setRailOpen(false)} />
          <nav className="sk-rail-drawer" aria-label="Console sections">
            <div className="sk-brand">
              <span className="sk-brand-mark">
                <Beacon size={21} />
              </span>
              <span className="sk-brand-txt">
                <span className="sk-brand-word">
                  THE SEA<span>MONK</span>
                </span>
                <span className="sk-brand-sub">ENTER THE AQUATIC REALM</span>
              </span>
              <span className="sk-spread" />
              <button type="button" className="sk-iconbtn" aria-label="Close navigation" onClick={() => setRailOpen(false)}>
                <Close size={15} />
              </button>
            </div>
            <div className="sk-nav">
              {items.map((it) => {
                const Icon = it.icon;
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className="sk-nav-item"
                    aria-current={path === it.href ? "page" : undefined}
                  >
                    <Icon size={18} />
                    <span className="sk-nav-label">{it.label}</span>
                  </Link>
                );
              })}
            </div>
          </nav>
        </>
      ) : null}

      {/* ------------------------------------------------------------ body */}
      <div className="sk-body">
        <header className="sk-head">
          <div className="sk-head-lead">
            <button
              type="button"
              className="sk-menu-btn"
              aria-label="Open navigation"
              aria-expanded={railOpen}
              onClick={() => setRailOpen((v) => !v)}
            >
              <Menu size={17} />
            </button>
            <div className="sk-crumb">
              <span>SEAMONK</span>
              <span className="sk-crumb-sep">/</span>
              <b>{current.label}</b>
            </div>
          </div>

          <div className="sk-head-status">
            <span className="sk-live" data-mode={sea.mode}>
              <span className="sk-live-dot" />
              {sea.liveLabel}
            </span>
            <div className="sk-stamp">
              <span>{sea.mode === "demo" ? "Reference time" : "Last Updated"}</span>
              <b>{mounted && now ? (sea.generatedAt && sea.mode !== "demo" ? istStamp(sea.generatedAt) : istStamp(now)) : "—"}</b>
            </div>
            {sea.mode === "demo" ? <SourceTag kind="DEMO" /> : null}
          </div>

          <div className="sk-head-right">
            <button
              type="button"
              className="sk-iconbtn sk-hide-sm"
              aria-label="Refresh all feeds"
              title="Refresh all feeds"
              aria-busy={sea.refreshing}
              onClick={sea.refresh}
            >
              <Refresh size={16} style={sea.refreshing ? { animation: "skSpin .9s linear infinite" } : undefined} />
            </button>

            <div ref={bellRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="sk-iconbtn"
                aria-label={`Alerts and advisories (${alerts.length})`}
                aria-expanded={bellOpen}
                title="Alerts and advisories"
                onClick={() => setBellOpen((v) => !v)}
              >
                <Bell size={16} />
                {alerts.length ? <span className="sk-badge-count">{alerts.length}</span> : null}
              </button>
              {bellOpen ? (
                <div className="sk-popover" role="dialog" aria-label="Alerts and advisories">
                  <div className="sk-popover-head">
                    <Squall size={14} />
                    <span>Alerts &amp; advisories</span>
                    <span className="sk-spread" />
                    <span className="sk-dim-sm">{alerts.length} active</span>
                  </div>
                  <div className="sk-popover-body">
                    {alerts.length ? (
                      alerts.map((a) => (
                        <div className="sk-notice" key={a.id}>
                          <Status tone={a.tone} plain>
                            {a.tone === "danger" ? "Hazard" : a.tone === "warn" ? "Caution" : "Verified"}
                          </Status>
                          <div className="sk-notice-body">
                            <b>{a.title}</b>
                            <p>{a.detail}</p>
                            <small>{a.meta}</small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="sk-dim-sm" style={{ margin: 0 }}>
                        No active advisories for this region.
                      </p>
                    )}
                  </div>
                  <div className="sk-popover-foot">
                    <Link className="sk-link" href="/dashboard/voyage-safety/">
                      Open voyage safety
                    </Link>
                    <span className="sk-spread" />
                    <span className="sk-dim-sm">Advisories come from IMD nowcasts and logged reports.</span>
                  </div>
                </div>
              ) : null}
            </div>

            <label className="sk-select-region sk-hide-sm">
              <Globe size={15} />
              <span className="sk-sr">Coastal region</span>
              <select
                value={sea.region.id}
                onChange={(e) => sea.setRegionId(e.target.value as typeof sea.region.id)}
                aria-label="Coastal region"
              >
                {sea.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>

            <div ref={userRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="sk-user"
                aria-expanded={userOpen}
                aria-haspopup="menu"
                onClick={() => setUserOpen((v) => !v)}
              >
                <span className="sk-avatar">
                  <Ship size={16} />
                </span>
                <span className="sk-user-txt">
                  <b>Marine Explorer</b>
                  <small>Coastal Region Operator</small>
                </span>
                <ChevronDown size={14} className="sk-dim" />
              </button>
              {userOpen ? (
                <div className="sk-popover sk-popover--right" role="menu" aria-label="Account">
                  <div className="sk-popover-head">
                    <Ship size={14} />
                    <span>Session context</span>
                  </div>
                  <div className="sk-popover-body">
                    <div className="sk-pair">
                      <span>Role</span>
                      <span>Coastal Region Operator</span>
                    </div>
                    <div className="sk-pair">
                      <span>Region</span>
                      <span>{sea.region.name}</span>
                    </div>
                    <div className="sk-pair">
                      <span>Map centre</span>
                      <span>{coordLabel(sea.region.lat, sea.region.lon)}</span>
                    </div>
                    <div className="sk-pair">
                      <span>Data mode</span>
                      <span>{sea.mode === "demo" ? "Demonstration" : sea.mode === "degraded" ? "Live, degraded" : "Live"}</span>
                    </div>
                    <p className="sk-dim-sm" style={{ margin: "8px 0 0" }}>
                      {sea.statusNote}
                    </p>
                  </div>
                  <div className="sk-popover-foot">
                    <Link className="sk-link" href="/dashboard/settings/">
                      <Sliders size={13} /> Open settings
                    </Link>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {sea.mode === "demo" ? (
          <div className="sk-modebar">
            <Warning size={14} />
            <span>
              <b>Demonstration dataset.</b> {sea.statusNote}
            </span>
            <span className="sk-spread" />
            <button type="button" className="sk-link" onClick={sea.refresh}>
              <Refresh size={12} /> Retry live feeds
            </button>
          </div>
        ) : null}

        <main className="sk-main" id="sk-main">
          {children}
        </main>

        <footer className="sk-foot">
          {sea.systems.length ? (
            sea.systems.map((s) => (
              <div className="sk-sys" key={s.key}>
                {s.key === "satellite" ? <Satellite size={15} /> : s.key === "weather" ? <Squall size={15} /> : s.key === "gis" ? <MapLayers size={15} /> : <Anchor size={15} />}
                <span>
                  <b>{s.label}</b>
                  <small>
                    <i className="sk-sys-dot" data-status={s.status} />
                    {s.source} · {s.status === "active" ? "Active" : s.status === "degraded" ? "Degraded" : "Offline"}
                  </small>
                </span>
              </div>
            ))
          ) : (
            sea.sources.map((s) => (
              <div className="sk-sys" key={s.key}>
                {s.key === "satellite" ? <Satellite size={15} /> : s.key === "weather" ? <Squall size={15} /> : s.key === "gis" ? <Database size={15} /> : <Anchor size={15} />}
                <span>
                  <b>{s.label}</b>
                  <small>
                    <i className="sk-sys-dot" data-status={s.status} />
                    {s.provider} · {s.status === "active" ? "Active" : s.status === "degraded" ? "Degraded" : "Offline"}
                  </small>
                </span>
              </div>
            ))
          )}
          <div className="sk-foot-tail">
            <Waves size={15} />
            Better data. Safer journeys. Healthier oceans.
          </div>
        </footer>
      </div>
    </div>
  );
}
