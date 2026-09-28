// WebGL renderer + post-processing chain + camera fitting + adaptive resolution.
import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  ChromaticAberrationEffect,
  NoiseEffect,
  ShockWaveEffect,
  SMAAEffect,
  BlendFunction,
} from 'postprocessing';
import { FIELD } from '../config';
import type { Quality } from './Settings';

interface QualityProfile {
  maxPixelRatio: number;
  shadow: number;
  msaa: number;
  bloomLevels: number;
}

const PROFILES: Record<Quality, QualityProfile> = {
  low: { maxPixelRatio: 0.85, shadow: 0, msaa: 0, bloomLevels: 5 },
  medium: { maxPixelRatio: 1, shadow: 1024, msaa: 0, bloomLevels: 6 },
  high: { maxPixelRatio: 1.5, shadow: 2048, msaa: 4, bloomLevels: 8 },
  ultra: { maxPixelRatio: 2, shadow: 4096, msaa: 4, bloomLevels: 8 },
};

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  private composer!: EffectComposer;
  private bloom!: BloomEffect;
  private ca!: ChromaticAberrationEffect;
  private vignette!: VignetteEffect;
  readonly shock: ShockWaveEffect;
  private caPass?: EffectPass;
  private quality: Quality = 'high';
  private profile: QualityProfile = PROFILES.high;
  private scale = 1; // adaptive resolution multiplier
  private frameTimes: number[] = [];
  private adaptTimer = 0;
  /** Distance that fits the play field; the camera rig builds on it. */
  fitDistance = 30;
  private caBoost = 0;
  onQualityApplied?: (shadow: number, detailHigh: boolean) => void;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      powerPreference: 'high-performance',
      antialias: false,
      stencil: false,
      depth: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x03101a, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.5, 900);
    this.shock = new ShockWaveEffect(this.camera, new THREE.Vector3(), { speed: 1.6, maxRadius: 0.6, waveSize: 0.25, amplitude: 0.06 });
    this.buildComposer();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private buildComposer() {
    this.composer?.dispose();
    const p = this.profile;
    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: p.msaa });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.78,
      luminanceSmoothing: 0.25,
      intensity: 1.15,
      radius: 0.78,
      levels: p.bloomLevels,
    });
    this.vignette = new VignetteEffect({ offset: 0.28, darkness: 0.62 });
    const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    noise.blendMode.opacity.value = 0.07;
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.composer.addPass(new EffectPass(this.camera, this.bloom, tone, this.vignette, noise));
    this.composer.addPass(new EffectPass(this.camera, this.shock));
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0006, 0.0006), radialModulation: true, modulationOffset: 0.25 });
    this.caPass = new EffectPass(this.camera, this.ca);
    this.composer.addPass(this.caPass);
    if (p.msaa === 0 && this.quality !== 'low') this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.profile = PROFILES[q];
    this.scale = 1;
    this.renderer.shadowMap.enabled = this.profile.shadow > 0;
    this.buildComposer();
    this.resize();
    this.onQualityApplied?.(this.profile.shadow, q !== 'low');
  }

  get pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, this.profile.maxPixelRatio) * this.scale;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Fit the 16:9 field plus a margin for HUD bars at any aspect ratio.
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const needH = FIELD.halfH + 1.4;
    const needW = FIELD.halfW + 1.0;
    this.fitDistance = Math.max(needH / t, needW / (t * this.camera.aspect));
  }

  /** Brief chromatic-aberration kick (hits, bombs). */
  kickAberration(k: number) {
    this.caBoost = Math.max(this.caBoost, k);
  }

  bloomIntensity(v: number) {
    this.bloom.intensity = v;
  }

  render(dt: number) {
    this.caBoost = Math.max(0, this.caBoost - dt * 3);
    const o = 0.0006 + this.caBoost * 0.006;
    this.ca.offset.set(o, o);
    this.composer.render(dt);
    this.trackPerformance(dt);
  }

  /** Lower the internal resolution if frames run long; raise it again when there is headroom. */
  private trackPerformance(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.adaptTimer += dt;
    if (this.adaptTimer < 2) return;
    this.adaptTimer = 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const prev = this.scale;
    if (avg > 1 / 45 && this.scale > 0.6) this.scale = Math.max(0.6, this.scale - 0.1);
    else if (avg < 1 / 58 && this.scale < 1) this.scale = Math.min(1, this.scale + 0.05);
    if (prev !== this.scale) this.resize();
  }

  get fps() {
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
    return avg > 0 ? 1 / avg : 0;
  }

  get resolutionScale() {
    return this.scale;
  }
}
