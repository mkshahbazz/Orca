/**
 * A small smooth-scroll controller for the hero's scroll track.
 *
 * Wheel and trackpad input is interpolated into the real page scroll, so the
 * dive has momentum and a consistent easing instead of the browser's raw jumps.
 * Only `wheel` is owned here: touch, keyboard, scrollbars and anchor jumps stay
 * native (and re-sync the controller), and any nested scrollable element keeps
 * its own scrolling untouched.
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function isInsideScroller(node: EventTarget | null): boolean {
  let el = node instanceof HTMLElement ? node : null;
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

export class SmoothScroll {
  private current = 0;
  private target = 0;
  private written = -1;
  private attached = false;
  private readonly enabled: boolean;

  /** `disabled` keeps native scrolling (used for prefers-reduced-motion). */
  constructor(opts: { disabled?: boolean } = {}) {
    this.enabled = !opts.disabled;
  }

  attach(): void {
    if (!this.enabled || this.attached) return;
    this.current = this.target = window.scrollY;
    window.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("scroll", this.onScroll, { passive: true });
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("scroll", this.onScroll);
    this.attached = false;
  }

  /** Called once per animation frame by the hero loop. */
  step(): void {
    if (!this.enabled) return;
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    this.target = clamp(this.target, 0, max);
    const next = this.current + (this.target - this.current) * 0.12;
    this.current = Math.abs(this.target - next) < 0.35 ? this.target : next;
    const y = Math.round(this.current);
    if (Math.abs(Math.round(window.scrollY) - y) > 0) {
      this.written = y;
      window.scrollTo(0, y);
    }
  }

  private onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return; // pinch-zoom / browser zoom
    if (isInsideScroller(event.target)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const delta = event.deltaY * unit;
    if (Math.abs(delta) < 0.5) return;
    event.preventDefault();
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    this.target = clamp(this.target + delta, 0, max);
  };

  /** Anything that scrolls the page by other means wins the handoff. */
  private onScroll = () => {
    const y = Math.round(window.scrollY);
    if (Math.abs(y - this.written) > 2) {
      this.current = this.target = y;
    }
  };
}
