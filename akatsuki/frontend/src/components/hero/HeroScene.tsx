"use client";

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { createHeroScene, type HeroScene as Scene, type HeroTier } from "./scene";
import type { HeroSignal } from "./signal";

/**
 * Mounts the WebGL hero behind the existing UI.
 *
 * It deliberately owns no animation loop: the page's loop drives it through the
 * shared signal, so scroll, the UI reveal and the 3D scene stay in lockstep and
 * nothing is animated twice. Everything is created once and disposed on
 * unmount — no geometry or material is ever built inside a frame.
 *
 * When WebGL is unavailable the component simply does not mount a canvas: the
 * stage keeps the original CSS artwork, rings and starfield, so the landing page
 * still works exactly as it did.
 */

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    if (!gl) return false;
    (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Mobile, small screens and low core counts get the cheaper scene. */
function pickTier(): HeroTier {
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4;
  const small = Math.min(window.innerWidth, window.innerHeight) < 640;
  return mobile || small || cores <= 4 ? "low" : "high";
}

export default function HeroScene({
  signal,
  onStatus,
}: {
  signal: MutableRefObject<HeroSignal>;
  onStatus?: (available: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const ok = supportsWebGL();
    setAvailable(ok);
    onStatus?.(ok);
    if (!ok) return;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let scene: Scene | null = null;
    try {
      scene = createHeroScene({
        canvas,
        tier: pickTier(),
        reducedMotion,
        onFirstFrame: () => host.parentElement?.classList.add("is-webgl"),
      });
    } catch {
      // No usable context (blocked, out of memory): keep the CSS hero.
      host.removeChild(canvas);
      setAvailable(false);
      onStatus?.(false);
      return;
    }

    signal.current.renderer = scene.render;

    const onResize = () => scene?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (signal.current.renderer === scene?.render) signal.current.renderer = null;
      scene?.dispose();
      canvas.remove();
    };
  }, [signal, onStatus]);

  // `available` is only used to avoid rendering an empty host while probing.
  if (available === false) return null;
  return <div className="gw-canvas" ref={hostRef} aria-hidden="true" />;
}
