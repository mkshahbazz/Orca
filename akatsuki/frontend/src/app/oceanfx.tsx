"use client";

import { useEffect, useMemo, useRef } from "react";

/**
 * Living-ocean FX for the cinematic landing.
 *
 * All layers are absolutely-positioned children of the transformed `.gw-bg`
 * element, so they inherit the scroll/cursor zoom + parallax exactly like the
 * hero photo — the FX stay pixel-registered with the water at every scale.
 *
 * Perf: compositor-only animation (canvas rAF + CSS transform keyframes),
 * DPR-capped, paused on hidden tabs, static single frame under
 * prefers-reduced-motion. Zero React renders per frame.
 */

/** Moon position + waterline in .gw-bg local space (fractions of the frame).
 *  Measured from the master photo: moon blob centroid ≈ (0.65, 0.195). */
const MOON = { x: 0.65, y: 0.195 };
const HORIZON = 0.545;

/* ------------------------------------------------------------------ */
/*  OceanFX — moonlight shimmer column, wave glints, drifting mist     */
/* ------------------------------------------------------------------ */
export function OceanFX() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const DPR = Math.min(2, window.devicePixelRatio || 1);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = !document.hidden;
    let t = 3.2;
    let last = 0;

    type Glint = { x: number; y: number; len: number; sp: number; ph: number; a: number };
    type Blob = { x: number; y: number; r: number; sp: number; ph: number };
    let glints: Glint[] = [];
    let blobs: Blob[] = [];

    // Pre-rendered soft glow sprite (mist) — avoids per-frame gradient churn.
    const sprite = document.createElement("canvas");
    sprite.width = 256;
    sprite.height = 256;
    const sctx = sprite.getContext("2d");
    if (sctx) {
      const g = sctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, "rgba(150,195,245,.55)");
      g.addColorStop(0.5, "rgba(150,195,245,.16)");
      g.addColorStop(1, "rgba(150,195,245,0)");
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, 256, 256);
    }

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * DPR));
      canvas.height = Math.max(1, Math.floor(h * DPR));
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

      const waterY = h * HORIZON;
      const depth = Math.max(1, h - waterY);
      glints = Array.from({ length: Math.min(110, Math.floor(w / 11)) }, () => {
        const y = waterY + Math.pow(Math.random(), 0.85) * depth;
        const f = (y - waterY) / depth;
        return {
          x: Math.random() * w,
          y,
          len: 7 + f * 40 * (0.5 + Math.random()) + Math.random() * 8,
          sp: 0.15 + Math.random() * 0.55,
          ph: Math.random() * Math.PI * 2,
          a: 0.05 + Math.random() * 0.15,
        };
      });
      blobs = Array.from({ length: 6 }, (_, i) => ({
        x: (i / 6) * w + Math.random() * w * 0.18,
        y: waterY + (Math.random() - 0.55) * h * 0.08,
        r: 130 + Math.random() * 190,
        sp: 0.05 + Math.random() * 0.08,
        ph: Math.random() * Math.PI * 2,
      }));
    };

    const paint = () => {
      ctx.clearRect(0, 0, w, h);
      const waterY = h * HORIZON;
      const mx = w * MOON.x;

      ctx.globalCompositeOperation = "lighter";

      // Drifting sea mist along the horizon.
      for (const b of blobs) {
        const bx = (((b.x + t * b.sp * 42) % (w + b.r * 2)) + w + b.r * 2) % (w + b.r * 2) - b.r;
        const a = 0.05 + 0.03 * Math.sin(t * 0.5 + b.ph);
        ctx.globalAlpha = Math.max(0, a);
        ctx.drawImage(sprite, bx - b.r, b.y - b.r * 0.62, b.r * 2, b.r * 1.24);
      }
      ctx.globalAlpha = 1;

      // Moonlight shimmer column — dashes widen + wander with distance.
      const N = 26;
      for (let i = 0; i < N; i++) {
        const f = i / N;
        const y = waterY + 6 + Math.pow(f, 1.35) * (h - waterY - 14);
        const spread = 6 + f * f * 74;
        const flick = 0.5 + 0.5 * Math.sin(t * (1.1 + f) + i * 1.93);
        const bw = (10 + f * 78) * (0.7 + 0.3 * Math.sin(t * 1.7 + i * 2.4));
        const a = 0.16 * (1 - f * 0.55) * (0.35 + 0.65 * flick);
        ctx.fillStyle = `rgba(200,230,255,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(
          mx + Math.sin(t * 0.5 + i * 1.31) * spread,
          y,
          Math.max(2, bw / 2),
          1.2 + f * 1.9,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }

      // Bright kiss where the reflection meets the horizon swell.
      const spark = 0.5 + 0.5 * Math.sin(t * 2.3);
      ctx.fillStyle = `rgba(235,248,255,${(0.22 + 0.2 * spark).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(mx + Math.sin(t * 0.9) * 6, waterY + 9, 26, 2.3, 0, 0, Math.PI * 2);
      ctx.fill();

      // Rolling wave glints across the whole water body.
      ctx.lineWidth = 1;
      for (const g of glints) {
        g.x += g.sp * 7 * dtSafe;
        if (g.x - g.len > w) g.x = -g.len;
        const a = g.a * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * g.sp * 2 + g.ph)));
        ctx.strokeStyle = `rgba(170,215,250,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.lineTo(g.x + g.len, g.y);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "source-over";
    };

    // dt for glint drift, refreshed per frame (0 when painting a static frame).
    let dtSafe = 0;

    const frame = (now: number) => {
      if (!visible) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      dtSafe = dt;
      t += dt;
      paint();
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (!visible || reduce) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) start();
      else cancelAnimationFrame(raf);
    };

    resize();
    if (reduce) {
      dtSafe = 0;
      paint(); // one beautiful static frame
    } else {
      start();
    }

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="gw-oceanfx" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/*  WaveField — pre-displaced water texture, GPU-drifted (no seams)    */
/* ------------------------------------------------------------------ */

function WaveLayer({ seed }: { seed: number }) {
  const rows = useMemo(() => {
    return Array.from({ length: 15 }, (_, i) => {
      const j = (n: number) => ((i * seed + n * 7 + seed) % 10) / 10; // deterministic scatter
      return {
        y: 14 + i * 40 + j(1) * 16,
        h: 8 + j(2) * 12,
        o: 0.05 + j(3) * 0.09,
        x: -40 + j(4) * 30,
        wd: 1280 + j(5) * 60,
      };
    });
  }, [seed]);

  const id = `wd${seed}`;
  return (
    <svg className="gw-wave-svg" viewBox="0 0 1200 600" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <filter id={id} x="-25%" y="-25%" width="150%" height="150%">
          <feTurbulence type="fractalNoise" baseFrequency="0.009 0.05" numOctaves="2" seed={seed} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="52" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <g filter={`url(#${id})`}>
        {rows.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.wd} height={r.h} fill="#cfe4ff" opacity={r.o} rx={r.h / 2} />
        ))}
      </g>
    </svg>
  );
}

export function WaveField() {
  return (
    <div className="gw-waves" aria-hidden="true">
      <div className="gw-wave gw-wave-a">
        <WaveLayer seed={7} />
      </div>
      <div className="gw-wave gw-wave-b">
        <WaveLayer seed={23} />
      </div>
    </div>
  );
}
