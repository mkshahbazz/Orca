"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, Menu, Send, Waves } from "lucide-react";
import "./landing.css";

/**
 * ORCA landing — matches the reference video:
 *   1. Wide shot: a tiny meditating monk in a vast moonlit ocean (no UI).
 *   2. Scroll / cursor-slide smoothly zooms the scene; the monk scales up.
 *   3. At full zoom the UI "locks in": nav bar, ORCA branding (left),
 *      ORCA Assistant widget (right), concentric energy rings — like the
 *      video's final frame.
 *
 * Performance: progress is smoothed in a single rAF loop and applied as
 * compositor-only properties (transform / opacity / CSS vars) directly on
 * refs — zero React re-renders per frame, 60fps-friendly.
 */

const PROMPTS = [
  "Where are the best fishing zones today?",
  "What's the weather near my location?",
  "Show me the marine map",
  "Give me a quick ocean overview",
];

export default function LandingPage() {
  const router = useRouter();

  const stageRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLDivElement | null>(null);
  const ringsRef = useRef<HTMLDivElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);

const target = useRef(0); // raw progress target (scroll or cursor)
const current = useRef(0); // smoothed progress actually applied
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

    const apply = (p: number) => {
      const px = pointer.x;
      const py = pointer.y;

      // Scene zoom: scale 1 -> 1.42, slight upward drift keeps the monk framed
      // like the video's final composition. Parallax fades out as we lock in.
      const eased = p * p * (3 - 2 * p); // smoothstep
      const scale = 1 + 0.42 * eased;
      const parallax = 1 - eased;
      const mx = (px - 0.5) * 16 * parallax;
      const my = (py - 0.5) * 12 * parallax - eased * window.innerHeight * 0.03;
      bg.style.transform = `translate3d(${mx.toFixed(2)}px, ${my.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;

      // Rings fade/scale in while zooming (video shows them from ~50% zoom).
      const ringP = Math.max(0, Math.min(1, (p - 0.3) / 0.45));
      rings.style.opacity = ringP.toFixed(3);
      rings.style.transform = `translate(-50%, -50%) scale(${(0.82 + 0.18 * ringP).toFixed(4)})`;

      // UI chrome locks in during the final stretch.
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

    const pointer = { x: 0.5, y: 0.5 };
    let scrollP = 0;
    let cursorP = 0;

    const onScroll = () => {
      scrollP = Math.min(1, window.scrollY / scrollMax.current);
      target.current = Math.max(scrollP, cursorP);
    };

    // Cursor-slide: moving the cursor down the viewport drives the same zoom
    // (per the reference video). It acts as a latch so an upward mouse drift
    // never un-zooms; scrolling still reverses the zoom naturally.
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
      // Poll scrollY directly (cheap read) instead of relying only on scroll
      // events — immune to event coalescing/missed events on mobile toolbars.
      const y = window.scrollY;
      if (y !== lastY) {
        lastY = y;
        scrollP = Math.min(1, y / scrollMax.current);
        target.current = Math.max(scrollP, cursorP);
      }
      const next = current.current + (target.current - current.current) * 0.09;
      current.current = Math.abs(target.current - next) < 0.0004
        ? target.current
        : next;
      apply(current.current);
      raf = requestAnimationFrame(tick);
    };

    measure();
    onScroll();
    apply(current.current);
    raf = requestAnimationFrame(tick);

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  const enterApp = () => router.push("/app");

  return (
    <div className="scroll-track">
      <div className="sticky-stage" ref={stageRef}>
        {/* moonlit ocean + monk (wide shot from the reference video) */}
        <div className="hero-bg" ref={bgRef} aria-hidden="true" />
        <div className="hero-shade" aria-hidden="true" />

        {/* concentric energy rings around the monk */}
        <div className="rings" ref={ringsRef} aria-hidden="true">
          <div className="ring ring-outer" />
          <div className="ring ring-mid" />
          <div className="ring ring-inner" />
          <div className="ring-halo" />
        </div>

        {/* top navigation — appears when the zoom locks in */}
        <nav className="top-nav" aria-label="Main">
          <button className="nav-brand" onClick={enterApp}>
            <span className="nav-logo">
              <Waves size={20} strokeWidth={2.4} />
            </span>
            ORCA
          </button>
          <div className="nav-links">
            <button onClick={enterApp}>Home</button>
            <button onClick={enterApp}>Assistance</button>
            <button onClick={enterApp}>Services</button>
          </div>
          <div className="nav-actions">
            <button className="nav-login" onClick={enterApp}>
              Log in
            </button>
            <button className="nav-cta" onClick={enterApp}>
              Learn More
            </button>
            <button className="nav-burger" aria-label="Menu">
              <Menu size={20} />
            </button>
          </div>
        </nav>

        {/* left: ORCA branding */}
        <section className="hero-copy">
          <p className="eyebrow">MARINE INTELLIGENCE. SAFER OCEANS.</p>
          <h1>
            ORC<span>A</span>
            <Waves className="title-wave" size={30} strokeWidth={2.6} />
          </h1>
          <p className="hero-description">
            AI-powered marine intelligence that connects ocean data, weather,
            satellite observations and geospatial information to help people
            make smarter marine decisions.
          </p>
          <button className="primary-cta" onClick={enterApp}>
            <span>
              <ArrowRight size={18} />
            </span>
            Explore ORCA
          </button>
        </section>

        {/* right: ORCA Assistant widget */}
        <aside className="hero-assistant" aria-label="ORCA Assistant preview">
          <div className="preview-head">
            <div className="preview-avatar">
              <Waves size={18} strokeWidth={2.4} />
            </div>
            <div>
              <b>ORCA Assistant</b>
              <span>
                <i /> Online
              </span>
            </div>
            <Menu size={16} className="preview-menu" />
          </div>
          <div className="preview-message">
            Hi! I&apos;m ORCA — your marine intelligence assistant. Ask me
            about fishing zones, weather, ocean conditions, or explore the
            map.
          </div>
          {PROMPTS.map((question) => (
            <button
              key={question}
              className="preview-prompt"
              onClick={enterApp}
            >
              {question}
              <ArrowRight size={14} />
            </button>
          ))}
          <div className="preview-input">
            Ask a question...
            <span className="preview-send">
              <Send size={13} />
            </span>
          </div>
        </aside>

        {/* scroll hint */}
        <div className="scroll-hint" ref={hintRef} aria-hidden="true">
          <ChevronDown size={16} />
          <span>Scroll or move your cursor to dive in</span>
        </div>
      </div>
    </div>
  );
}
