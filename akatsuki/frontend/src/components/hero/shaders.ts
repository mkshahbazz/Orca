/**
 * GLSL for the hero scene.
 *
 * One photo (the original hero art) is the source of truth, so every layer
 * samples the *same* texture through the *same* screen->image mapping. That
 * mapping reproduces CSS `background: center 58% / cover` exactly, which is why
 * the monk, the moon and the composition sit precisely where they always did.
 *
 * The artwork itself carries no watermark (the generated-image sparkle was
 * patched out of the asset), so every layer can sample it as-is.
 *
 * Everything else is generated on the GPU: the moving water, the moonlight
 * glimmer, the stars, the drifting cloud veil, the rings radiating from the
 * monk's head and the diamond above it. Nothing is a stretched bitmap.
 */

/** Vertex stage shared by every full-viewport layer. */
export const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Shared uniforms + helpers: image mapping, grading, value noise. */
export const COMMON = /* glsl */ `
uniform sampler2D uMap;
uniform vec2  uUvA;      // screen uv -> image uv (scale)
uniform vec2  uUvB;      // screen uv -> image uv (offset, image y points down)
uniform float uZoom;     // composition zoom about the screen centre
uniform vec2  uPan;      // screen-space pan (y points down)
uniform vec3  uGrade;    // saturation, contrast, brightness

// Screen uv (y up) -> artwork coordinates (y down, 0 = top of the artwork),
// reproducing CSS background-position: center 58% + cover exactly.
vec2 imageUv(vec2 uv) {
  vec2 s = (uv - 0.5) / uZoom + 0.5;
  vec2 up = vec2(s.x, s.y) * uUvA + uUvB;  // GL texture space (y up)
  return vec2(up.x, 1.0 - up.y) + uPan;    // artwork space (y down)
}

// Sample the artwork from artwork-space coordinates. The texture is uploaded
// without an sRGB decode, so the values here are the same ones the CSS hero
// shows — the WebGL plate and the CSS fallback match pixel for pixel.
vec3 raw(vec2 art) {
  return texture2D(uMap, vec2(art.x, 1.0 - art.y)).rgb;
}

vec3 grade(vec3 c) {
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, uGrade.x);
  c = clamp((c - 0.5) * uGrade.y + 0.5, 0.0, 1.0);
  return c * uGrade.z;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

/** Base plate: the original artwork, graded. */
export const PLATE_FRAG = /* glsl */ `
${COMMON}
uniform float uFade;      // 0 until the texture is decoded
varying vec2 vUv;

void main() {
  vec2 uv = imageUv(vUv);
  vec3 col = grade(raw(uv));
  // very light unsharp: keeps the artwork crisp on high-density displays
  vec2 t = vec2(1.5 / 1920.0, 1.5 / 1080.0);
  vec3 blur = (raw(uv + vec2(t.x, 0.0)) + raw(uv - vec2(t.x, 0.0))
             + raw(uv + vec2(0.0, t.y)) + raw(uv - vec2(0.0, t.y))) * 0.25;
  col += (col - grade(blur)) * 0.3;
  gl_FragColor = vec4(max(col, 0.0), uFade);
}
`;

/** The ocean: the artwork's water, displaced by layered waves and re-lit. */
export const WATER_FRAG = /* glsl */ `
${COMMON}
uniform float uTime;
uniform float uWaveAmp;
uniform float uDetail;
uniform vec2  uMonkC;     // stability mask: the monk never moves
uniform vec2  uMonkR;
uniform vec2  uRobeC;     // the robe skirt may breathe, very slightly
uniform vec2  uRobeR;
uniform float uRobeAmp;
uniform float uHorizon;   // image v of the horizon
uniform vec2  uMoon;      // image uv of the moon
uniform float uAspectImg;
varying vec2 vUv;

void main() {
  vec2 uv = imageUv(vUv);
  float t = uTime;

  // ---- how strong the water movement is at this depth -------------------
  float depth = smoothstep(uHorizon, 1.02, uv.y);        // 0 at horizon, 1 near
  float amp = uWaveAmp * (0.18 + 0.82 * depth);

  // ---- layered swell: slow, long, heavy — never ripples ------------------
  float w1 = sin(uv.x * 6.2 + t * 0.19);
  float w2 = sin(uv.x * 13.0 - t * 0.28 + uv.y * 3.2);
  float w3 = sin(uv.y * 8.5 + t * 0.13);
  float n  = fbm(uv * vec2(3.1, 1.5) + vec2(t * 0.022, -t * 0.013));
  vec2 disp = vec2(w1 * 0.40 + (n - 0.5) * 0.85,
                   w2 * 0.20 + w3 * 0.34 + (n - 0.5) * 0.5) * amp;

  // ---- the monk is frozen: no displacement inside his silhouette --------
  float dMonk = length((uv - uMonkC) / uMonkR);
  float stable = 1.0 - smoothstep(0.72, 1.05, dMonk);
  disp *= (1.0 - stable);

  // ---- robe cloth: a whisper of movement in the skirt only --------------
  float dRobe = length((uv - uRobeC) / uRobeR);
  float robe = (1.0 - smoothstep(0.45, 1.0, dRobe)) * (1.0 - stable);
  disp += vec2(sin(t * 0.19 + uv.y * 6.0) * 1.0,
               sin(t * 0.14 + uv.x * 5.0) * 0.35) * uRobeAmp * robe;

  vec3 col = grade(raw(uv + disp));

  // ---- moonlight: a shimmering column under the moon --------------------
  float column = exp(-pow((uv.x - uMoon.x) / 0.16, 2.0));
  float band = smoothstep(uHorizon - 0.02, uHorizon + 0.12, uv.y)
             * smoothstep(1.06, 0.55, uv.y);
  float glint = pow(fbm(uv * vec2(26.0, 60.0) + vec2(0.0, -t * 0.28)), 2.2);
  float crest = pow(fbm(uv * vec2(10.0, 26.0) + vec2(t * 0.05, -t * 0.18)), 3.0);
  col += vec3(0.42, 0.60, 0.86) * column * band * (glint * 0.34 + crest * 0.30) * (0.35 + depth);

  // ---- foam detail: real high-frequency structure, not upscaled pixels ---
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  float foam = smoothstep(0.45, 0.9, luma) * depth;
  float sparkle = fbm(uv * vec2(90.0, 170.0) + vec2(t * 0.35, -t * 0.5));
  col += vec3(0.5, 0.66, 0.9) * foam * smoothstep(0.6, 1.0, sparkle) * uDetail * 0.35;

  float alpha = smoothstep(uHorizon - 0.012, uHorizon + 0.03, uv.y);
  gl_FragColor = vec4(max(col, 0.0), alpha);
}
`;

/** A slow veil of drifting mist over the artwork's own clouds. */
export const CLOUD_FRAG = /* glsl */ `
${COMMON}
uniform float uTime;
uniform float uDetail;
uniform float uHorizon;
uniform vec2  uMoon;
varying vec2 vUv;

void main() {
  vec2 uv = imageUv(vUv);
  float t = uTime;

  // only over the sky, and never close to the horizon line
  float sky = smoothstep(uHorizon + 0.02, uHorizon - 0.22, uv.y);
  float drift = 0.0022 * t;
  float n = fbm(uv * vec2(3.4, 2.1) + vec2(drift, drift * 0.25));
  float wisps = fbm(uv * vec2(8.0, 4.0) - vec2(drift * 1.7, 0.0));
  float veil = smoothstep(0.35, 0.95, n) * (0.55 + 0.45 * wisps);

  // moonlight lifts the clouds around the moon, and only there
  float moonGlow = exp(-length((uv - uMoon) * vec2(1.0, 1.78) * 3.4) * 1.5);

  float alpha = sky * (0.16 + 0.10 * uDetail) * veil;
  vec3 col = vec3(0.46, 0.60, 0.82) * (0.5 + 0.5 * uDetail) + vec3(0.20) * moonGlow;
  gl_FragColor = vec4(col, alpha);
}
`;

/** Stationary stars that twinkle, each on its own phase. No meteors. */
export const STAR_FRAG = /* glsl */ `
${COMMON}
uniform float uTime;
uniform float uTwinkle;
uniform float uHorizon;
uniform float uDensity;
uniform vec2  uResolution;
varying vec2 vUv;

void main() {
  vec2 uv = imageUv(vUv);
  // a star grid in image space, sized in real pixels so density tracks the DPR
  vec2 grid = vec2(uDensity * uResolution.x / uResolution.y, uDensity);
  vec2 g = uv * grid;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;

  float h = hash21(id);
  float h2 = hash21(id + 17.31);
  vec2 jitter = (vec2(h, h2) - 0.5) * 0.62;
  float d = length(f - jitter);

  float star = smoothstep(0.075, 0.0, d);
  float twinkle = 0.65 + 0.35 * sin(uTime * (0.25 + h2 * 1.15) + h * 62.83);
  float bright = smoothstep(0.55, 0.98, h);           // only some stars show
  float alpha = star * bright * mix(1.0, twinkle, uTwinkle);

  // the artwork's own clouds occlude the stars
  vec3 plate = raw(uv);
  float cloud = smoothstep(0.05, 0.22, dot(plate, vec3(0.299, 0.587, 0.114)));
  float sky = smoothstep(uHorizon + 0.03, uHorizon - 0.12, uv.y);

  gl_FragColor = vec4(vec3(0.78, 0.88, 1.0), alpha * sky * (1.0 - cloud) * 0.85);
}
`;

/** Rings that radiate outward from the monk's head and fade as they go. */
export const RING_FRAG = /* glsl */ `
uniform vec2  uHead;      // screen uv of the monk's head (y up)
uniform float uAspect;
uniform float uTime;
uniform float uAlpha;
uniform float uPixel;     // one pixel, in screen-uv units
uniform float uSpeed;
varying vec2 vUv;

float easeOut(float t) { return 1.0 - pow(1.0 - t, 2.2); }

void main() {
  vec2 p = (vUv - uHead) * vec2(uAspect, 1.0);
  float r = length(p);
  float rings = 0.0;
  for (int i = 0; i < 5; i++) {
    float ph = fract(uTime * uSpeed + float(i) / 5.0);
    float radius = mix(0.015, 0.62, easeOut(ph));
    float fade = (1.0 - ph) * smoothstep(0.0, 0.22, ph);
    float width = uPixel * (1.1 + 2.4 * radius);
    rings += fade * (1.0 - smoothstep(0.0, width, abs(r - radius)));
  }
  // a calm pulse right at the head, where the signal comes from
  float core = exp(-r * 26.0) * (0.35 + 0.15 * sin(uTime * 0.9));
  float alpha = (rings * 0.9 + core * 0.5) * uAlpha;
  gl_FragColor = vec4(vec3(0.42, 0.74, 1.0), alpha);
}
`;

/** The diamond above the monk's head — subtle at rest, awake on scroll. */
export const DIAMOND_FRAG = /* glsl */ `
uniform vec2  uPos;       // screen uv (y up)
uniform float uAspect;
uniform float uSize;      // half-diagonal, in screen-height units
uniform float uGlow;      // 0.1 at the top of the page -> 1.0 at the transition
uniform float uTime;
uniform float uPixel;
varying vec2 vUv;

void main() {
  vec2 q = (vUv - uPos) * vec2(uAspect, 1.0);
  float d = abs(q.x) + abs(q.y);

  float outline = 1.0 - smoothstep(0.0, uPixel * 1.6, abs(d - uSize));
  float core = exp(-d / max(uSize, 1e-4) * 3.2) * 0.42;
  float breathe = 0.94 + 0.06 * sin(uTime * 0.8);
  float alpha = (outline * 0.95 + core) * uGlow * breathe;

  vec3 col = mix(vec3(0.55, 0.82, 1.0), vec3(1.0), 0.35 * uGlow);
  gl_FragColor = vec4(col, alpha);
}
`;
