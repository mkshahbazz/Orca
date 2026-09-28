import type { HeroRenderer } from "./scene";

/**
 * The one-line contract between the two halves of the hero.
 *
 * The landing page owns a single animation loop (scroll, pointer, UI reveal)
 * and calls `signal.current.renderer` if a WebGL scene has registered itself.
 * That keeps one rAF driving everything, keeps the UI reveal working even when
 * WebGL is unavailable, and avoids duplicating the animation logic.
 */
export interface HeroSignal {
  renderer: HeroRenderer | null;
}

export function createHeroSignal(): { current: HeroSignal } {
  return { current: { renderer: null } };
}
