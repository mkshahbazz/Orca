"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  ChevronDown,
  Menu,
  Send,
  Waves,
} from "lucide-react";
import "./seamonk.css";
import { SmoothScroll } from "@/components/hero/SmoothScroll";
import { createHeroSignal } from "@/components/hero/signal";

/**
 * THE SEAMONK — cinematic gateway ("Enter the Aquatic Realm").
 *
 * The visual layer is a WebGL ocean environment (see components/hero). The page
 * itself owns the single animation loop: it interpolates the scroll, tracks the
 * pointer, drives the UI reveal (`--uiP`, `is-locked`) and hands the frame to the
 * registered WebGL renderer. That means:
 *
 *   * the composition, typography, navigation, buttons and copy are unchanged —
 *     the artwork, the monk and the moon are the same, only now they live in a
 *     scene with depth, moving water, drifting clouds and drifting stars;
 *   * scrolling dives the camera through the scene and wakes the diamond;
 *   * moving the pointer looks around inside the scene (a few degrees), rather
 *     than sliding the page sideways;
 *   * if WebGL is unavailable the original CSS artwork, rings and starfield take
 *     over and the page behaves exactly as before.
 */

const GATEWAY_QUESTIONS = [
  "Where are the fish biting today?",
  "Is it safe to sail near Paradip?",
  "Show today's marine forecast",
];

const HeroScene = dynamic(() => import("@/components/hero/HeroScene"), {
  ssr: false,
});

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** CSS fallback starfield — only rendered when WebGL is unavailable. */
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
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  const hintRef = useRef<HTMLDivElement | null>(null);
  const signal = useRef(createHeroSignal().current);
  const [webgl, setWebgl] = useState<boolean | null>(null);

  // stable identity: a new callback would remount the WebGL scene
  const handleSceneStatus = useCallback((available: boolean) => {
    setWebgl(available);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const hint = hintRef.current;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const smooth = new SmoothScroll({ disabled: reduceMotion });
    smooth.attach();

    const pointer = { x: 0.5, y: 0.5 };
    let scrollP = 0;
    let cursorP = 0;
    let current = 0;
    let target = 0;
    let maxScroll = 1;
    let raf = 0;
    let last = performance.now();

    // Cursor-slide acts as a latch: moving the cursor down the viewport reveals
    // the gateway UI; scrolling still drives the dive either way.
    const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");

    const apply = (p: number) => {
      const eased = p * p * (3 - 2 * p); // smoothstep
      const uiP = clamp01((p - 0.7) / 0.3);
      const ringP = clamp01((p - 0.3) / 0.45);

      stage.style.setProperty("--uiP", uiP.toFixed(3));
      stage.style.setProperty("--ringP", ringP.toFixed(3));
      stage.classList.toggle("is-locked", uiP >= 0.98);

      // CSS fallback only (the WebGL scene reads the progress directly)
      const parallax = 1 - eased;
      stage.style.setProperty("--zoom", (1 + 0.46 * eased).toFixed(4));
      stage.style.setProperty("--bgx", `${((pointer.x - 0.5) * 18 * parallax).toFixed(2)}px`);
      stage.style.setProperty(
        "--bgy",
        `${(
          (pointer.y - 0.5) * 14 * parallax -
          eased * window.innerHeight * 0.03
        ).toFixed(2)}px`
      );

      if (hint) hint.style.opacity = Math.max(0, 1 - p * 1.6).toFixed(3);
    };

    const measure = () => {
      maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX / window.innerWidth;
      pointer.y = event.clientY / window.innerHeight;
      if (canHover.matches) {
        cursorP = clamp01((pointer.y - 0.15) / 0.6);
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      smooth.step();

      // Poll scrollY directly — immune to missed/coalesced scroll events.
      scrollP = Math.min(1, window.scrollY / maxScroll);
      target = Math.max(scrollP, cursorP);
      const next = current + (target - current) * 0.09;
      current = Math.abs(target - next) < 0.0004 ? target : next;

      apply(current);

      signal.current.renderer?.(
        now / 1000,
        dt,
        current,
        (pointer.x - 0.5) * 2,
        (0.5 - pointer.y) * 2
      );
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };

    measure();
    apply(current);
    raf = requestAnimationFrame(tick);

    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      smooth.detach();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const enterRealm = () => router.push("/dashboard");

  return (
    <div className="landing">
      <div className="gw-track">
        <div className="gw-stage" ref={stageRef}>
          <div className="gw-stars" aria-hidden="true">
            {webgl === false && <Starfield />}
          </div>
          <div className="gw-bg" aria-hidden="true" />
          <div className="gw-ocean-glow" aria-hidden="true" />

          <HeroScene signal={signal} onStatus={handleSceneStatus} />

          <div className="gw-shade" aria-hidden="true" />

          <div className="gw-rings" aria-hidden="true">
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
