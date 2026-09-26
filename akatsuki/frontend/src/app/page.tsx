"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  Menu,
  Send,
  Waves,
} from "lucide-react";
import "./seamonk.css";

/**
 * THE SEAMONK — cinematic gateway ("Enter the Aquatic Realm").
 *
 * 1. Wide shot: a tiny meditating monk in a vast moonlit ocean under a
 *    twinkling starfield (matches the reference video's opening frame).
 * 2. Scroll / cursor-slide smoothly zooms the scene; the monk grows from a
 *    distance into the full-screen cinematic composition.
 * 3. At full zoom the gateway UI locks in (nav, title, assistant preview)
 *    and the CTA dives into the dashboard.
 *
 * Performance: one rAF loop drives everything through compositor-only
 * transforms / CSS variables on refs — zero React renders per frame.
 */

const GATEWAY_QUESTIONS = [
  "Where are the fish biting today?",
  "Is it safe to sail near Paradip?",
  "Show today's marine forecast",
];

function Starfield() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const DPR = Math.min(2, window.devicePixelRatio || 1);

    type Star = { x: number; y: number; r: number; tw: number; ph: number };
    let stars: Star[] = [];

    const seed = () => {
      const count = Math.min(340, Math.floor((w * h) / 5200));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h * 0.72,
        r: Math.random() * 1.25 + 0.3,
        tw: Math.random() * 1.6 + 0.4,
        ph: Math.random() * Math.PI * 2,
      }));
    };

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.floor(w * DPR);
      canvas.height = Math.floor(h * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      seed();
    };

    let t = 0;
    const draw = () => {
      t += 0.016;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph));
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = "#cfe4ff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        if (s.r > 1.05) {
          ctx.globalAlpha = a * 0.25;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    resize();
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" />;
}

export default function SeamonkLanding() {
  const router = useRouter();

  const stageRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLDivElement | null>(null);
  const ringsRef = useRef<HTMLDivElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);

  const target = useRef(0);
  const current = useRef(0);
  const scrollMax = useRef(1);

  useEffect(() => {
    const stage = stageRef.current;
    const bg = bgRef.current;
    const rings = ringsRef.current;
    const hint = hintRef.current;
    if (!stage || !bg || !rings || !hint) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const pointer = { x: 0.5, y: 0.5 };
    let scrollP = 0;
    let cursorP = 0;

    const apply = (p: number) => {
      const eased = p * p * (3 - 2 * p); // smoothstep
      const scale = 1 + 0.46 * eased;
      const parallax = 1 - eased;
      const mx = (pointer.x - 0.5) * 18 * parallax;
      const my =
        (pointer.y - 0.5) * 14 * parallax - eased * window.innerHeight * 0.03;
      bg.style.transform = `translate3d(${mx.toFixed(2)}px, ${my.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;

      const ringP = Math.max(0, Math.min(1, (p - 0.3) / 0.45));
      rings.style.opacity = ringP.toFixed(3);
      rings.style.transform = `translate(-50%, -50%) scale(${(0.8 + 0.2 * ringP).toFixed(4)})`;

      const uiP = Math.max(0, Math.min(1, (p - 0.7) / 0.3));
      stage.style.setProperty("--uiP", uiP.toFixed(3));
      stage.classList.toggle("is-locked", uiP >= 0.98);

      hint.style.opacity = Math.max(0, 1 - p * 1.6).toFixed(3);
    };

    if (reduceMotion) {
      apply(1);
      return;
    }

    const measure = () => {
      scrollMax.current = Math.max(
        1,
        document.documentElement.scrollHeight - window.innerHeight
      );
    };

    // Cursor-slide acts as a latch (moving the cursor down the viewport
    // advances the zoom; scrolling still reverses it naturally).
    const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
    const onPointerMove = (e: PointerEvent) => {
      pointer.x = e.clientX / window.innerWidth;
      pointer.y = e.clientY / window.innerHeight;
      if (canHover.matches) {
        cursorP = Math.max(0, Math.min(1, (pointer.y - 0.15) / 0.6));
      }
    };

    let raf = 0;
    let lastY = -1;
    const tick = () => {
      // Poll scrollY directly — immune to missed/coalesced scroll events.
      const y = window.scrollY;
      if (y !== lastY) {
        lastY = y;
        scrollP = Math.min(1, y / scrollMax.current);
        target.current = Math.max(scrollP, cursorP);
      }
      const next = current.current + (target.current - current.current) * 0.09;
      current.current =
        Math.abs(target.current - next) < 0.0004 ? target.current : next;
      apply(current.current);
      raf = requestAnimationFrame(tick);
    };

    measure();
    apply(current.current);
    raf = requestAnimationFrame(tick);

    window.addEventListener("resize", measure);
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  const enterRealm = () => router.push("/dashboard");

  return (
    <div className="landing">
      <div className="gw-track">
        <div className="gw-stage" ref={stageRef}>
          <div className="gw-stars" aria-hidden="true">
            <Starfield />
          </div>
          <div className="gw-bg" ref={bgRef} aria-hidden="true" />
          <div className="gw-ocean-glow" aria-hidden="true" />
          <div className="gw-shade" aria-hidden="true" />

          <div className="gw-rings" ref={ringsRef} aria-hidden="true">
            <div className="gw-ring gw-ring-outer" />
            <div className="gw-ring gw-ring-mid" />
            <div className="gw-ring gw-ring-inner" />
            <div className="gw-halo" />
          </div>

          <div className="gw-vignette" aria-hidden="true" />

          <nav className="gw-nav" aria-label="Main">
            <div className="gw-logo">
              <Waves size={26} strokeWidth={2.2} />
              <div>
                <span className="gw-logo-word">
                  THE SEA<span style={{ color: "var(--cyan)" }}>MONK</span>
                </span>
                <span className="gw-logo-sub">ENTER THE AQUATIC REALM</span>
              </div>
            </div>
            <div className="gw-nav-links">
              <button onClick={enterRealm}>Ocean Watch</button>
              <button onClick={enterRealm}>Fishing Zones</button>
              <button onClick={enterRealm}>Voyage Safety</button>
              <button onClick={enterRealm}>Analytics</button>
            </div>
            <div className="gw-nav-actions">
              <button className="gw-login" onClick={enterRealm}>
                Log in
              </button>
              <button className="gw-nav-cta" onClick={enterRealm}>
                Enter Dashboard
              </button>
              <button aria-label="Menu" className="gw-burger">
                <Menu size={20} />
              </button>
            </div>
          </nav>

          <section className="gw-branding">
            <p className="gw-eyebrow">MARITIME INTELLIGENCE PLATFORM</p>
            <h1 className="gw-title">
              THE SEA<span>MONK</span>
            </h1>
            <div className="gw-tagline">ENTER THE AQUATIC REALM</div>
            <p className="gw-desc">
              Real-time ocean intelligence fused from satellite imagery,
              weather models, ocean sensors and geospatial data — guiding
              every voyage with the calm wisdom of the deep.
            </p>
            <button className="gw-cta" onClick={enterRealm}>
              <span style={{ display: "grid", placeItems: "center" }}>
                <Waves size={18} strokeWidth={2.4} />
              </span>
              Enter the Aquatic Realm
              <ArrowRight size={17} />
            </button>
            <p className="gw-hint">
              Live PFZ advisories · Voyage safety · Marine analytics
            </p>
          </section>

          <aside className="gw-widget" aria-label="The Monk preview">
            <div className="gw-widget-head">
              <div className="gw-widget-avatar">
                <Waves size={19} strokeWidth={2.3} />
              </div>
              <div>
                <b>Talk to the Monk</b>
                <small>
                  <i /> Online — listening to the ocean
                </small>
              </div>
            </div>
            <div className="gw-widget-msg">
              I am the Seamonk — ask me about fishing zones, voyage safety,
              weather windows, or the state of the sea anywhere along the
              coast.
            </div>
            {GATEWAY_QUESTIONS.map((q) => (
              <button key={q} className="gw-q" onClick={enterRealm}>
                {q}
                <ArrowRight size={14} />
              </button>
            ))}
            <div className="gw-widget-in">
              Ask the ocean...
              <span>
                <Send size={13} />
              </span>
            </div>
          </aside>

          <div className="gw-scrollhint" ref={hintRef} aria-hidden="true">
            <ChevronDown size={16} />
            <span>Scroll or slide your cursor to dive deeper</span>
          </div>
        </div>
      </div>
    </div>
  );
}
