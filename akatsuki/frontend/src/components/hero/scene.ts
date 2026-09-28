import * as THREE from "three";
import {
  CLOUD_FRAG,
  DIAMOND_FRAG,
  PLATE_FRAG,
  RING_FRAG,
  STAR_FRAG,
  VERT,
  WATER_FRAG,
} from "./shaders";

/**
 * THE SEAMONK hero, as a real WebGL environment.
 *
 * Depth layers, far to near: stars, clouds, the artwork plate, the living
 * ocean, the rings leaving the monk's head, the diamond above it. Every layer
 * samples the original artwork through the same screen->image mapping, so the
 * composition is untouched; because the layers sit at different depths, looking
 * around with the pointer and diving with the scroll produce genuine parallax
 * instead of sliding a flat image.
 *
 * The monk is deliberately frozen by a stability mask, while the robe skirt
 * breathes with a much smaller, slower displacement — the monk never wobbles.
 */

const IMAGE = { w: 1920, h: 1080, focusY: 0.58 };

/** Positions in the artwork, measured from the original hero frame (0..1). */
const MARK = {
  horizon: 0.478,
  moon: [0.6375, 0.183] as const,
  monkC: [0.487, 0.44] as const,
  monkR: [0.1, 0.115] as const,
  robeC: [0.487, 0.575] as const,
  robeR: [0.115, 0.085] as const,
  head: [0.4875, 0.385] as const,
  diamond: [0.4875, 0.315] as const,
};

const CAM_Z = 6;
const FOV = 42;
const ZOOM_MAX = 0.46; // matches the original CSS dive (scale 1 -> 1.46)

export type HeroTier = "high" | "low";

export type HeroRenderer = (
  time: number,
  delta: number,
  progress: number,
  pointerX: number,
  pointerY: number
) => void;

export interface HeroScene {
  render: HeroRenderer;
  resize: () => void;
  dispose: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function createHeroScene(opts: {
  canvas: HTMLCanvasElement;
  tier: HeroTier;
  reducedMotion: boolean;
  onFirstFrame?: () => void;
}): HeroScene {
  const { canvas, tier, reducedMotion } = opts;
  const detail = tier === "high" ? 1 : 0.55;
  const lowPower = tier === "low";

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
  camera.position.set(0, 0, CAM_Z);

  const texture = new THREE.TextureLoader().load("/assets/orca-hero-base.jpg");
  // Sampled raw (no sRGB decode) because the layers are custom shaders that do
  // not re-encode on output: this keeps the WebGL plate identical to the CSS
  // artwork the fallback path shows.
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // ---------------------------------------------------------------- uniforms
  // shared by every layer
  const shared = {
    uMap: { value: texture },
    uUvA: { value: new THREE.Vector2(1, 1) },
    uUvB: { value: new THREE.Vector2(0, 0) },
    uPan: { value: new THREE.Vector2(0, 0) },
    uTime: { value: 0 },
    uHorizon: { value: MARK.horizon },
    // every layer grades the artwork identically, so the plate and the living
    // water never disagree about colour
    uGrade: { value: new THREE.Vector3(0.95, 1.05, 0.92) },
  };

  type Layer = {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    z: number;
    zoomBase: number; // how strongly this layer answers the dive
  };
  const layers: Layer[] = [];

  /**
   * Artwork coordinates -> screen uv, for a given layer zoom and pan.
   * Used to keep the rings centred on the monk's head and the diamond above it
   * while the composition zooms and pans.
   */
  const toScreen = (
    marker: readonly [number, number],
    zoom: number,
    panY: number,
    out: THREE.Vector2
  ) => {
    const upX = marker[0];
    const upY = 1 - (marker[1] - panY);
    const sx = (upX - shared.uUvB.value.x) / shared.uUvA.value.x;
    const sy = (upY - shared.uUvB.value.y) / shared.uUvA.value.y;
    return out.set((sx - 0.5) * zoom + 0.5, (sy - 0.5) * zoom + 0.5);
  };

  const factory = (
    frag: string,
    z: number,
    zoomBase: number,
    uniforms: Record<string, THREE.IUniform>
  ): Layer => {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms: { ...shared, uZoom: { value: 1 }, ...uniforms },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.frustumCulled = false;
    mesh.position.z = z;
    mesh.renderOrder = Math.round((z + 10) * 100);
    scene.add(mesh);
    const layer: Layer = { mesh, material, z, zoomBase };
    layers.push(layer);
    return layer;
  };

  // ---------------------------------------------------------------- layers
  const plate = factory(PLATE_FRAG, -1.0, 1.0, { uFade: { value: 0 } });
  plate.material.blending = THREE.NormalBlending;

  const water = factory(WATER_FRAG, 0.2, 1.1, {
    uWaveAmp: { value: reducedMotion ? 0.0008 : 0.0026 },
    uDetail: { value: detail },
    uMonkC: { value: new THREE.Vector2(MARK.monkC[0], MARK.monkC[1]) },
    uMonkR: { value: new THREE.Vector2(MARK.monkR[0], MARK.monkR[1]) },
    uRobeC: { value: new THREE.Vector2(MARK.robeC[0], MARK.robeC[1]) },
    uRobeR: { value: new THREE.Vector2(MARK.robeR[0], MARK.robeR[1]) },
    uRobeAmp: { value: reducedMotion ? 0.0004 : 0.0013 },
    uMoon: { value: new THREE.Vector2(MARK.moon[0], MARK.moon[1]) },
  });

  const stars = lowPower
    ? null
    : factory(STAR_FRAG, -3.5, 0.9, {
        uTwinkle: { value: reducedMotion ? 0.15 : 1 },
        uDensity: { value: 150 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      });
  if (stars) stars.material.blending = THREE.AdditiveBlending;

  const clouds = lowPower
    ? null
    : factory(CLOUD_FRAG, -2.2, 0.95, {
        uDetail: { value: detail },
        uMoon: { value: new THREE.Vector2(MARK.moon[0], MARK.moon[1]) },
      });

  const rings = factory(RING_FRAG, 0.5, 1.0, {
    uHead: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uAlpha: { value: 0.26 },
    uPixel: { value: 0.0015 },
    uSpeed: { value: reducedMotion ? 0.045 : 0.085 },
  });
  rings.material.blending = THREE.AdditiveBlending;

  const diamond = factory(DIAMOND_FRAG, 0.8, 1.0, {
    uPos: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uSize: { value: 0.026 },
    uGlow: { value: 0.1 },
    uPixel: { value: 0.0015 },
  });
  diamond.material.blending = THREE.AdditiveBlending;

  // ---------------------------------------------------------------- fitting
  const fit = () => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // CSS `cover` + position, expressed as a screen-uv -> texture-uv transform
    const k = Math.max(w / IMAGE.w, h / IMAGE.h);
    const drawnW = IMAGE.w * k;
    const drawnH = IMAGE.h * k;
    const offX = (w - drawnW) * 0.5;
    shared.uUvA.value.set(w / drawnW, h / drawnH);
    // the artwork is 58% down its own height, so a taller viewport reveals
    // (1 - focusY) of the crop at the bottom and focusY at the top
    shared.uUvB.value.set(
      -offX / drawnW,
      (1 - IMAGE.focusY) * (1 - h / drawnH)
    );

    for (const layer of layers) {
      const dist = CAM_Z - layer.z;
      const ph = 2 * Math.tan((FOV * Math.PI) / 360) * dist;
      layer.mesh.scale.set(ph * camera.aspect, ph, 1);
    }

    rings.material.uniforms.uAspect.value = camera.aspect;
    rings.material.uniforms.uPixel.value = 1 / h;
    diamond.material.uniforms.uAspect.value = camera.aspect;
    diamond.material.uniforms.uPixel.value = 1 / h;

    if (stars) stars.material.uniforms.uResolution.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  };
  fit();

  // ---------------------------------------------------------------- camera
  const rig = { rx: 0, ry: 0, x: 0, y: 0, zoom: 1, pan: 0 };
  let time = 0;
  let fade = 0;
  let firstFrame = false;

  const render: HeroRenderer = (t, delta, progress, px, py) => {
    time += delta;

    // damped camera: subtle rotation (~2 degrees) + a little travel
    const lookX = reducedMotion ? 0 : px;
    const lookY = reducedMotion ? 0 : py;
    rig.ry = lerp(rig.ry, -lookX * 0.042, 0.045);
    rig.rx = lerp(rig.rx, lookY * 0.034, 0.045);
    rig.x = lerp(rig.x, lookX * 0.06, 0.045);
    rig.y = lerp(rig.y, lookY * 0.045, 0.045);
    const eased = progress * progress * (3 - 2 * progress);
    rig.zoom = lerp(rig.zoom, 1 + ZOOM_MAX * eased * (reducedMotion ? 0.35 : 1), 0.08);
    rig.pan = lerp(rig.pan, 0.03 * eased, 0.08);

    camera.rotation.set(rig.rx, rig.ry, 0);
    camera.position.set(rig.x, rig.y, CAM_Z);

    shared.uTime.value = time;
    shared.uPan.value.set(0, rig.pan);
    for (const layer of layers) {
      const z = 1 + (rig.zoom - 1) * layer.zoomBase;
      layer.material.uniforms.uZoom.value = z;
    }

    // keep the rings on the head and the diamond above it as the view moves
    const ringZoom = rings.material.uniforms.uZoom.value;
    toScreen(MARK.head, ringZoom, rig.pan, rings.material.uniforms.uHead.value);
    const diaZoom = diamond.material.uniforms.uZoom.value;
    toScreen(MARK.diamond, diaZoom, rig.pan, diamond.material.uniforms.uPos.value);

    // the diamond wakes as the visitor dives toward the next section
    const glow = 0.1 + 0.9 * clamp(eased / 0.72, 0, 1);
    diamond.material.uniforms.uGlow.value = glow;
    diamond.material.uniforms.uSize.value = 0.026 + 0.006 * clamp(eased, 0, 1);
    rings.material.uniforms.uAlpha.value = 0.24 * (0.85 + 0.15 * clamp(eased, 0, 1));

    // fades in over the CSS plate once the artwork has decoded
    if (texture.image && fade < 1) fade = Math.min(1, fade + delta * 2.2);
    plate.material.uniforms.uFade.value = fade;

    renderer.render(scene, camera);

    if (!firstFrame && fade >= 1) {
      firstFrame = true;
      opts.onFirstFrame?.();
    }
  };

  const resize = () => fit();

  const dispose = () => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const layer of layers) layer.material.dispose();
    texture.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
  };

  return { render, resize, dispose };
}
