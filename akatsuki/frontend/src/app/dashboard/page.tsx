"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Activity,
  Anchor,
  ArrowRight,
  BarChart3,
  Bell,
  ChevronDown,
  Cloud,
  CloudRain,
  Compass,
  Download,
  FileText,
  Fish,
  Layers,
  LifeBuoy,
  Map as MapIcon,
  Moon,
  Navigation,
  Radio,
  Send,
  ShieldCheck,
  Ship,
  Sun,
  Thermometer,
  Waves,
  Wind,
  Zap,
} from "lucide-react";
import "../seamonk.css";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="dx-mapcard" style={{ flex: 1 }}>
      <div style={{ position: "absolute", inset: 0, background: "var(--sea-800)" }} />
    </div>
  ),
});

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const TABS = [
  { key: "ocean", label: "Ocean Watch", icon: MapIcon },
  { key: "fishing", label: "Fishing Zones", icon: Fish },
  { key: "safety", label: "Voyage Safety", icon: ShieldCheck },
  { key: "analytics", label: "Marine Analytics", icon: BarChart3 },
  { key: "layers", label: "Map Layers", icon: Layers },
  { key: "reports", label: "Reports", icon: FileText },
  { key: "settings", label: "Settings", icon: Compass },
];

const LANGUAGES: Record<string, string> = {
  en: "EN",
  hi: "हिं",
  bn: "বাং",
  ta: "தமி",
  te: "తెలు",
  mr: "मरा",
  gu: "ગુ",
  kn: "ಕನ್",
  ml: "മല",
  pa: "ਪੰ",
  or: "ଓଡ",
  ur: "اردو",
};

const LAYER_DEFS = [
  { key: "sst", label: "SST (°C)", min: 24, max: 32, unit: "°C" },
  { key: "chl", label: "Chlorophyll (mg/m³)", min: 0.2, max: 2, unit: "mg/m³" },
  { key: "wind", label: "Wind (m/s)", min: 2, max: 14, unit: "m/s" },
  { key: "bathy", label: "Bathymetry (m)", min: 0, max: 3000, unit: "m" },
] as const;

type LayerKey = (typeof LAYER_DEFS)[number]["key"];

type Snapshot = {
  status: string;
  last_updated_label?: string;
  conditions?: {
    sst_c: number | null;
    sst_delta_c: number;
    chlorophyll_mgm3: number | null;
    chlorophyll_delta: number;
    wind_kt: number | null;
    wind_dir: string;
    visibility_km: number | null;
    visibility: string;
  };
  sst_trend?: { hour: string; sst: number }[];
  pfz?: {
    type: string;
    geometry: unknown;
    properties: {
      location_name: string;
      lat: number;
      lon: number;
      probability: number;
      best_time: string;
    };
  }[];
  forecast?: { time: string; temp_c: number; wind_kt: number; sea: string; night: boolean }[];
  insights?: {
    best_zone?: { name: string; lat: number; lon: number; probability: number; window: string } | null;
    advisories?: { kind: string; title: string; text: string }[];
  };
};

type ChatMsg = { role: "user" | "assistant"; content: string; sources?: string };

function ForecastIcon({ night }: { night: boolean }) {
  return night ? (
    <Moon size={17} />
  ) : (
    <Sun size={17} />
  );
}

function Sparkline({ points }: { points: { hour: string; sst: number }[] }) {
  const path = useMemo(() => {
    if (!points.length) return "";
    const vals = points.map((p) => p.sst);
    const min = Math.min(...vals) - 0.15;
    const max = Math.max(...vals) + 0.15;
    const W = 280;
    const H = 56;
    return points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * W;
        const y = H - ((p.sst - min) / (max - min)) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points]);

  return (
    <svg viewBox="0 0 280 56" style={{ width: "100%", height: 56 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sstfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(51,185,242,.35)" />
          <stop offset="100%" stopColor="rgba(51,185,242,0)" />
        </linearGradient>
      </defs>
      <path d={`${path} L280,56 L0,56 Z`} fill="url(#sstfill)" />
      <path d={path} fill="none" stroke="#33b9f2" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function SeamonkDashboard() {
  const [tab, setTab] = useState("ocean");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [clock, setClock] = useState("");
  const [activeLayer, setActiveLayer] = useState<LayerKey>("sst");
  const [grid, setGrid] = useState<{ grids?: Record<string, { lat: number; lon: number; v: number }[]> } | null>(null);
  const [mapFeatures, setMapFeatures] = useState<unknown>(null);
  const [mapVersion, setMapVersion] = useState(0);
  const [showAllPfz, setShowAllPfz] = useState(false);

  // chat state
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        "I am the Monk. Ask me about the sea — fishing zones, voyage safety, weather windows, or conditions near any coordinates.",
      sources: "IMD | Copernicus | INCOIS",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLang, setChatLang] = useState("en");
  const [chatBusy, setChatBusy] = useState(false);
  const chatScroll = useRef<HTMLDivElement>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/dashboard`);
      if (res.ok) {
        const data: Snapshot = await res.json();
        setSnap(data);
        if (data.pfz?.length) {
          setMapFeatures({
            type: "FeatureCollection",
            features: data.pfz,
          });
          setMapVersion((v) => v + 1);
        }
      }
    } catch {
      /* backend offline — dashboard stays up with placeholders */
    }
  }, []);

  const loadGrid = useCallback(async (layer: LayerKey) => {
    try {
      const res = await fetch(`${API_URL}/api/map/grid?layers=${layer}`);
      if (res.ok) setGrid(await res.json());
    } catch {
      setGrid(null);
    }
  }, []);

  useEffect(() => {
    loadSnapshot();
    const t = setInterval(loadSnapshot, 60_000);
    return () => clearInterval(t);
  }, [loadSnapshot]);

  useEffect(() => {
    loadGrid(activeLayer);
  }, [activeLayer, loadGrid]);

  useEffect(() => {
    const tickClock = () => {
      const now = new Date();
      const ist = now.toLocaleString("en-GB", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      setClock(`${ist.replace(",", "")} IST`);
    };
    tickClock();
    const t = setInterval(tickClock, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    chatScroll.current?.scrollTo({
      top: chatScroll.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, chatBusy]);

  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setMessages((m) => [...m, { role: "assistant", content: "…" }]);
    setChatBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, language: chatLang }),
      });
      if (res.ok && res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamed = "";
        let sources = "IMD | Copernicus | INCOIS";
        const updateLast = (content: string, src?: string) =>
          setMessages((m) => {
            const next = [...m];
            next[next.length - 1] = { role: "assistant", content, sources: src ?? next[next.length - 1].sources };
            return next;
          });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let event = "message";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            let data: unknown = null;
            try {
              data = JSON.parse(dataLines.join("\n"));
            } catch {
              continue;
            }
            if (event === "token" && typeof data === "string") {
              streamed += data;
              updateLast(streamed);
            } else if (event === "final" && data && typeof data === "object") {
              const f = data as { response?: string; language?: string };
              if (f.response && !streamed) updateLast(f.response);
              updateLast(
                (streamed || f.response || "") && (f.language && f.language !== "en")
                  ? (f.response ?? streamed)
                  : (streamed || f.response || ""),
                sources
              );
            }
          }
        }
      } else {
        const data = await res.json();
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = {
            role: "assistant",
            content: data.response ?? "…",
            sources: "IMD | Copernicus | INCOIS",
          };
          return next;
        });
      }
    } catch {
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = {
          role: "assistant",
          content: "⚠️ The Monk could not reach the ocean servers. Try again shortly.",
        };
        return next;
      });
    } finally {
      setChatBusy(false);
    }
  }, [chatInput, chatBusy, chatLang]);

  const downloadReport = useCallback(() => {
    if (!snap) return;
    const lines = [
      "THE SEAMONK — Marine Intelligence Report",
      `Generated: ${snap.last_updated_label ?? new Date().toISOString()}`,
      "",
      "== Current Ocean Conditions ==",
      JSON.stringify(snap.conditions, null, 2),
      "",
      "== Potential Fishing Zones ==",
      ...(snap.pfz ?? []).map(
        (f, i) =>
          `${i + 1}. ${f.properties.location_name} — ${f.properties.probability}% — best ${f.properties.best_time} (${f.properties.lat}, ${f.properties.lon})`
      ),
      "",
      "== Monk's Insights ==",
      JSON.stringify(snap.insights, null, 2),
      "",
      "Sources: MOSDAC · VEDAS · INCOIS · IMD · Open-Meteo",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `seamonk-report-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [snap]);

  const conditions = snap?.conditions;
  const pfzRows = showAllPfz ? snap?.pfz ?? [] : (snap?.pfz ?? []).slice(0, 4);
  const best = snap?.insights?.best_zone;
  const advisories = snap?.insights?.advisories ?? [];
  const forecast = snap?.forecast ?? [];
  const trend = snap?.sst_trend ?? [];
  const layerDef = LAYER_DEFS.find((l) => l.key === activeLayer)!;
  const activeGrid = grid?.grids?.[activeLayer];
  const gridRange: Record<LayerKey, [number, number]> = {
    sst: [24, 32],
    chl: [0.2, 2],
    wind: [2, 14],
    bathy: [0, 3000],
  };
  const [gMin, gMax] = gridRange[activeLayer];

  return (
    <div className="dash">
      {/* ================= HEADER ================= */}
      <header className="dx-header">
        <div className="dx-brand">
          <Waves size={26} strokeWidth={2.2} />
          <div>
            <div className="dx-brand-word">
              THE SEA<span>MONK</span>
            </div>
            <span className="dx-brand-sub">ENTER THE AQUATIC REALM</span>
          </div>
        </div>
        <div className="dx-live">
          <span className="dx-live-dot" />
          Live Data
        </div>
        <div className="dx-updated">
          Last Updated: <b>{snap?.last_updated_label ?? clock}</b>
        </div>
        <div className="dx-header-right">
          <button className="dx-bell" aria-label="Notifications">
            <Bell size={17} />
            <span className="dx-bell-badge">
              {(advisories.length || 3)}
            </span>
          </button>
          <button className="dx-profile">
            <span className="dx-avatar">
              <Ship size={17} />
            </span>
            <span>
              <span className="dx-profile-name">Marine Explorer</span>
              <span className="dx-profile-sub">Coastal Region</span>
            </span>
            <ChevronDown size={15} className="dx-chevron" />
          </button>
        </div>
      </header>

      {/* ================= SIDEBAR ================= */}
      <nav className="dx-side" aria-label="Dashboard sections">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`dx-tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
        <div className="dx-monk-card">
          <blockquote>
            “The ocean does not just hold life, it holds answers.”
            <cite>— The Seamonk</cite>
          </blockquote>
        </div>
        <div className="dx-side-note">SEAMONK v2.0</div>
      </nav>

      {/* ================= MAP + BOTTOM ================= */}
      <section className="dx-mapwrap">
        <div className="dx-mapcard">
          <MapView
            mapFeatures={mapFeatures}
            refreshKey={mapVersion}
            gridCells={activeGrid}
            gridMin={gMin}
            gridMax={gMax}
            gridLabel={layerDef.label}
          />

          {/* overlay: map layers widget (Leaflet instance untouched) */}
          <div className="dx-layers">
            <div className="dx-layers-head">
              <Layers size={16} /> Map Layers
            </div>
            {LAYER_DEFS.map((l) => (
              <button
                key={l.key}
                className={`dx-layer${activeLayer === l.key ? " on" : ""}`}
                onClick={() => setActiveLayer(l.key)}
              >
                <span className="dx-radio" />
                {l.label}
              </button>
            ))}
            <div className="dx-scale">
              <div className="dx-scale-label">
                {layerDef.label} scale
                {activeGrid
                  ? ` · ${activeGrid.length} samples`
                  : " · connecting…"}
              </div>
              <div className="dx-scale-bar" />
              <div className="dx-scale-ticks">
                <span>{layerDef.min}</span>
                <span>{(layerDef.min + layerDef.max) / 2}</span>
                <span>{layerDef.max}</span>
              </div>
            </div>
          </div>

          <div className="dx-maplegend">
            <span>
              <i style={{ background: "#22c55e" }} /> PFZ
            </span>
            <span>
              <i style={{ background: "#f05c5c" }} /> Alert Zone
            </span>
          </div>
        </div>

        {/* bottom grid */}
        <div className="dx-bottom">
          {/* current ocean conditions */}
          <div className="dx-card">
            <div className="dx-card-head">
              <Waves size={16} /> Current Ocean Conditions
            </div>
            <div className="dx-card-body">
              <div className="dx-cond">
                <div className="dx-cond-cell">
                  <small>Sea Surface Temp</small>
                  <b>{conditions?.sst_c != null ? `${conditions.sst_c}°C` : "—"}</b>
                  <span className="up">↑ +{conditions?.sst_delta_c ?? 0.6}</span>
                </div>
                <div className="dx-cond-cell">
                  <small>Chlorophyll</small>
                  <b>{conditions?.chlorophyll_mgm3 ?? "—"} mg/m³</b>
                  <span className="up">↑ +{conditions?.chlorophyll_delta ?? 0.12}</span>
                </div>
                <div className="dx-cond-cell">
                  <small>Wind Speed</small>
                  <b>{conditions?.wind_kt ?? "—"} knots</b>
                  <span style={{ color: "var(--muted)", fontSize: 10.5 }}>
                    {conditions?.wind_dir ?? "NE"}
                  </span>
                </div>
                <div className="dx-cond-cell">
                  <small>Visibility</small>
                  <b>{conditions?.visibility_km ?? "—"} km</b>
                  <span className="up">👁 {conditions?.visibility ?? "Good"}</span>
                </div>
              </div>
              <div className="dx-trend">
                <div className="dx-trend-head">
                  <small>SST Trend (°C)</small>
                  <b>+{conditions?.sst_delta_c ?? 0.6}°C (24h)</b>
                </div>
                <Sparkline points={trend} />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    color: "var(--dim)",
                    fontSize: 10,
                  }}
                >
                  <span>06:00</span>
                  <span>12:00</span>
                  <span>18:00</span>
                  <span>24:00</span>
                </div>
              </div>
            </div>
          </div>

          {/* PFZ table */}
          <div className="dx-card">
            <div className="dx-card-head">
              <Fish size={16} style={{ color: "var(--cyan)" }} /> Potential Fishing
              Zones
              <button className="dx-headlink" onClick={() => setShowAllPfz((s) => !s)}>
                View {showAllPfz ? "Less" : "All"} <ArrowRight size={12} />
              </button>
            </div>
            <div className="dx-card-body">
              {pfzRows.map((f) => (
                <div className="dx-pfzrow" key={f.properties.location_name}>
                  <span
                    className="dx-pfz-dot"
                    style={{
                      background:
                        f.properties.probability >= 70
                          ? "var(--green)"
                          : f.properties.probability >= 55
                            ? "#e8d24a"
                            : "#e8793d",
                    }}
                  />
                  <span className="dx-pfz-name">{f.properties.location_name}</span>
                  <span className="dx-pfz-bar">
                    <i style={{ width: `${f.properties.probability}%` }} />
                  </span>
                  <span className="dx-pfz-pct">{f.properties.probability}%</span>
                  <span className="dx-pfz-time">{f.properties.best_time}</span>
                </div>
              ))}
              {!pfzRows.length && (
                <div style={{ color: "var(--dim)", fontSize: 12 }}>
                  Waiting for the PFZ agent…
                </div>
              )}
              <div className="dx-disclaimer">
                <LifeBuoy size={14} />
                <span>
                  PFZ data is based on satellite-derived parameters and may vary
                  due to local conditions. <u>Learn more</u>
                </span>
              </div>
            </div>
          </div>

          {/* quick actions */}
          <div className="dx-card">
            <div className="dx-card-head">
              <Zap size={16} style={{ color: "var(--cyan)" }} /> Quick Actions
            </div>
            <div className="dx-card-body dx-actions">
              <button className="dx-action" onClick={() => setTab("fishing")}>
                <span className="dx-action-ico cyan">
                  <Fish size={17} />
                </span>
                <span>
                  <b>Find PFZ</b>
                  <small>Locate potential fishing zones</small>
                </span>
              </button>
              <button className="dx-action" onClick={() => setTab("safety")}>
                <span className="dx-action-ico green">
                  <ShieldCheck size={17} />
                </span>
                <span>
                  <b>Check Sea Safety</b>
                  <small>Get voyage safety analysis</small>
                </span>
              </button>
              <button className="dx-action" onClick={() => setTab("analytics")}>
                <span className="dx-action-ico violet">
                  <CloudRain size={17} />
                </span>
                <span>
                  <b>View Weather</b>
                  <small>Detailed marine forecast</small>
                </span>
              </button>
              <button className="dx-action" onClick={downloadReport}>
                <span className="dx-action-ico gold">
                  <Download size={17} />
                </span>
                <span>
                  <b>Generate Report</b>
                  <small>Download current conditions</small>
                </span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ================= RIGHT PANELS ================= */}
      <aside className="dx-right">
        {/* Monk's Reading */}
        <div className="dx-card">
          <div className="dx-card-head">
            🧘 <span style={{ color: "var(--gold)" }}>Monk&apos;s Reading</span>
          </div>
          <div className="dx-card-body">
            {best ? (
              <div className="dx-bestzone">
                <span className="dx-bestzone-fish">
                  <Fish size={19} />
                </span>
                <span>
                  <b>Best Fishing Zone ({best.window})</b>
                  <p>
                    {best.name} ({best.lat}°N, {best.lon}°E)
                  </p>
                  <small>High probability of catch ({best.probability}%)</small>
                </span>
                <ArrowRight size={16} className="dx-bestzone-chev" />
              </div>
            ) : (
              <div style={{ color: "var(--dim)", fontSize: 12, padding: "4px 2px 10px" }}>
                Reading the ocean…
              </div>
            )}
            {advisories.map((a) => (
              <div className={`dx-adv ${a.kind}`} key={a.title}>
                <span className={`dx-adv-ico ${a.kind}`}>
                  {a.kind === "risk" ? <Activity size={15} /> : <Cloud size={15} />}
                </span>
                <span>
                  <b>{a.title}</b>
                  <p>{a.text}</p>
                </span>
              </div>
            ))}
            <button className="dx-report-link" onClick={() => setTab("reports")}>
              View detailed report <ArrowRight size={13} />
            </button>
          </div>
        </div>

        {/* Next 12 Hours */}
        <div className="dx-card">
          <div className="dx-card-head">
            <Thermometer size={16} style={{ color: "var(--cyan)" }} /> Next 12 Hours
            <span className="dx-headlink" style={{ cursor: "default" }}>
              View Full Forecast →
            </span>
          </div>
          <div className="dx-card-body">
            <div className="dx-hours">
              {forecast.slice(0, 5).map((h) => (
                <div className="dx-hour" key={h.time}>
                  <div className="dx-hour-t">{h.time}</div>
                  <div className={`dx-hour-ico${h.night ? " night" : ""}`}>
                    <ForecastIcon night={h.night} />
                  </div>
                  <div className="dx-hour-temp">{h.temp_c}°C</div>
                  <div className="dx-hour-wind">Wind {h.wind_kt}kt</div>
                  <div className="dx-hour-sea">Sea {h.sea}</div>
                </div>
              ))}
              {!forecast.length && (
                <div style={{ color: "var(--dim)", fontSize: 12, gridColumn: "1/-1" }}>
                  Fetching the weather window…
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Talk to the Monk */}
        <div className="dx-card dx-chat">
          <div className="dx-card-head">
            🧘 <span style={{ color: "var(--gold)" }}>Talk to the Monk</span>
            <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--muted)" }}>
              Ask anything about the ocean
            </span>
          </div>
          <div className="dx-chat-scroll" ref={chatScroll}>
            {messages.map((m, i) => (
              <div key={i} className={`dx-msg ${m.role}`}>
                {m.content}
                {m.role === "assistant" && m.sources && (
                  <span className="dx-msg-src">
                    <b>Sources:</b> {m.sources}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="dx-chat-in">
            <select
              className="dx-chat-lang"
              value={chatLang}
              onChange={(e) => setChatLang(e.target.value)}
              aria-label="Reply language"
              title="Bhashini translation language"
            >
              {Object.entries(LANGUAGES).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            <input
              className="dx-chat-input"
              value={chatInput}
              placeholder="Type your question..."
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()}
            />
            <button className="dx-send" onClick={sendChat} disabled={chatBusy} aria-label="Send">
              <Send size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* ================= FOOTER STATUS ================= */}
      <footer className="dx-footer">
        <SystemStatus />
        <div className="dx-tagline-right">
          <Waves size={15} />
          Better data. Safer journeys. Healthier oceans.
        </div>
      </footer>
    </div>
  );
}

function SystemStatus() {
  const [systems, setSystems] = useState<
    { key: string; label: string; source: string; status: string }[]
  >([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/api/health/systems`);
        if (res.ok && alive) {
          const data = await res.json();
          setSystems(data.systems ?? []);
        }
      } catch {
        /* leave last known state */
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const icons: Record<string, typeof Anchor> = {
    satellite: Anchor,
    weather: CloudRain,
    ocean: Radio,
    gis: Layers,
  };

  return (
    <>
      {systems.map((s) => {
        const Icon = icons[s.key] ?? Navigation;
        return (
          <div className="dx-sys" key={s.key}>
            <Icon size={16} />
            <span>
              <b>{s.label}</b>
              <small className={s.status === "active" ? "" : "degraded"}>
                <i /> {s.source} · {s.status === "active" ? "Active" : "Degraded"}
              </small>
            </span>
          </div>
        );
      })}
      {!systems.length && (
        <div className="dx-sys">
          <Anchor size={16} />
          <span>
            <b>Systems</b>
            <small>
              <i /> connecting…
            </small>
          </span>
        </div>
      )}
    </>
  );
}
