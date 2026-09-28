// Visual effect recipes: explosions, impacts, muzzle flashes, bubbles.
import * as THREE from 'three';
import { Particles, PType } from '../gfx/Particles';
import { Debris, FlashLights } from '../gfx/Debris';
import { rand } from '../core/math';
import type { Renderer } from '../core/Renderer';
import type { CameraRig } from './CameraRig';

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

export type Palette = 'fire' | 'plasma' | 'violet' | 'boss';

const PALETTES: Record<Palette, { hot: THREE.Color; mid: THREE.Color; cool: THREE.Color; light: number }> = {
  fire: { hot: C(4, 3.2, 1.8), mid: C(3.2, 1.3, 0.3), cool: C(0.9, 0.18, 0.04), light: 0xffa050 },
  plasma: { hot: C(2.4, 3.8, 4.5), mid: C(0.5, 2.2, 3.5), cool: C(0.1, 0.4, 1.2), light: 0x60d8ff },
  violet: { hot: C(4, 2.6, 4), mid: C(2.6, 0.6, 2.8), cool: C(0.6, 0.1, 0.9), light: 0xff60e0 },
  boss: { hot: C(5, 4, 3), mid: C(4, 1.6, 0.5), cool: C(1.4, 0.2, 0.1), light: 0xff8040 },
};

export class Effects {
  constructor(
    readonly particles: Particles,
    readonly debris: Debris,
    readonly lights: FlashLights,
    private renderer: Renderer,
    private rig: CameraRig,
  ) {}

  explode(x: number, y: number, z: number, size: number, pal: Palette = 'fire', debris = true) {
    const P = PALETTES[pal];
    const p = this.particles;
    // core flash
    p.emit({ x, y, z, life: 0.22, size0: 2.6 * size, size1: 5 * size, c0: P.hot, c1: P.mid, a0: 1, a1: 0, type: PType.Glow });
    // fireballs
    const nf = Math.round(7 + 9 * size);
    for (let i = 0; i < nf; i++) {
      const a = rand(0, Math.PI * 2);
      const e = rand(-1, 1);
      const sp = rand(1.5, 5.5) * Math.sqrt(size);
      p.emit({
        x, y, z,
        vx: Math.cos(a) * sp * Math.sqrt(1 - e * e), vy: Math.sin(a) * sp * Math.sqrt(1 - e * e), vz: e * sp,
        life: rand(0.45, 0.9), size0: rand(0.5, 1.0) * size, size1: rand(1.6, 2.6) * size,
        c0: P.hot, c1: P.cool, a0: 1, a1: 0, type: PType.Glow, drag: 3.2, lift: 1.2, spin: rand(-2, 2),
      });
    }
    // sparks
    const ns = Math.round(12 + 18 * size);
    for (let i = 0; i < ns; i++) {
      const a = rand(0, Math.PI * 2);
      const e = rand(-0.8, 0.8);
      const sp = rand(7, 20) * (0.7 + size * 0.3);
      p.emit({
        x, y, z,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: e * sp,
        life: rand(0.25, 0.7), size0: rand(0.08, 0.16), size1: 0.02,
        c0: P.hot, c1: P.mid, a0: 1, a1: 0.2, type: PType.Spark, drag: 2.6, lift: -3,
      });
    }
    // smoke
    const nk = Math.round(3 + 4 * size);
    for (let i = 0; i < nk; i++) {
      p.emit({
        x: x + rand(-0.4, 0.4) * size, y: y + rand(-0.4, 0.4) * size, z: z + rand(-0.4, 0.4),
        vx: rand(-1, 1), vy: rand(-0.5, 1.2), vz: rand(-1, 1),
        life: rand(1.2, 2.2), size0: 0.8 * size, size1: rand(2.5, 3.8) * size,
        c0: C(0.05, 0.08, 0.1), c1: C(0.03, 0.05, 0.07), a0: 0.55, a1: 0, type: PType.Smoke, drag: 1.5, lift: 0.5, alphaMode: 1, spin: rand(-0.6, 0.6), delay: 0.05,
      });
    }
    // shock ring
    p.emit({ x, y, z, life: 0.45, size0: 0.6 * size, size1: 5.5 * size, c0: C(1.6, 2.4, 2.8), a0: 0.9, a1: 0, type: PType.Ring });
    // bubbles (it's underwater)
    const nb = Math.round(4 + 6 * size);
    for (let i = 0; i < nb; i++) {
      p.emit({
        x: x + rand(-0.6, 0.6) * size, y: y + rand(-0.6, 0.6) * size, z: z + rand(-0.6, 0.6),
        vx: rand(-1.5, 1.5), vy: rand(0, 2), vz: rand(-1.5, 1.5),
        life: rand(1.4, 2.6), size0: rand(0.12, 0.34), size1: rand(0.2, 0.45),
        c0: C(0.7, 1.0, 1.1), a0: 0.85, a1: 0, type: PType.Bubble, drag: 1.2, lift: 3.5, delay: rand(0, 0.25),
      });
    }
    if (debris) this.debris.burst(x, y, z, Math.round(2 + 3 * size), 6 + size * 4, 0.35 * Math.sqrt(size));
    this.lights.flash(x, y, z, P.light, 60 * size, 0.35 + size * 0.15);
    if (size >= 1.2) {
      this.rig.shake(0.25 + size * 0.12);
      this.renderer.kickAberration(0.3 + size * 0.1);
    }
  }

  /** Screen-space shock wave (bombs, boss death). */
  shockwave(x: number, y: number, z: number) {
    this.renderer.shock.epicenter.set(x, y, z);
    this.renderer.shock.explode();
  }

  hitSpark(x: number, y: number, color: THREE.Color = C(3, 2.6, 1.6)) {
    for (let i = 0; i < 4; i++) {
      const a = rand(Math.PI * 0.5, Math.PI * 1.5);
      const sp = rand(5, 12);
      this.particles.emit({
        x, y, z: rand(-0.2, 0.2), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(-3, 3),
        life: rand(0.12, 0.28), size0: 0.1, size1: 0.02, c0: color, a0: 1, a1: 0, type: PType.Spark, drag: 3,
      });
    }
    this.particles.emit({ x, y, z: 0.1, life: 0.1, size0: 0.7, size1: 1.0, c0: color, a0: 0.9, a1: 0, type: PType.Glow });
  }

  muzzle(x: number, y: number, big: boolean) {
    this.particles.emit({ x, y, z: 0.05, life: 0.07, size0: big ? 1.1 : 0.7, size1: big ? 1.4 : 0.9, c0: big ? C(4, 3, 1.2) : C(1.6, 3.2, 4), a0: 0.9, a1: 0, type: PType.Glow });
  }

  engineBubble(x: number, y: number) {
    this.particles.emit({
      x: x + rand(-0.1, 0.1), y: y + rand(-0.15, 0.15), z: rand(-0.3, 0.3), vx: rand(-4, -2), vy: rand(-0.2, 0.4),
      life: rand(0.6, 1.2), size0: rand(0.06, 0.14), size1: rand(0.12, 0.2), c0: C(0.6, 0.9, 1.0), a0: 0.6, a1: 0, type: PType.Bubble, drag: 2, lift: 2.2,
    });
  }

  bubbleColumn(x: number, y: number, z: number) {
    for (let i = 0; i < 14; i++) {
      this.particles.emit({
        x: x + rand(-0.3, 0.3), y, z: z + rand(-0.3, 0.3), vx: rand(-0.3, 0.3), vy: rand(1, 2),
        life: rand(3, 5), size0: rand(0.15, 0.4), size1: rand(0.3, 0.6), c0: C(0.5, 0.8, 0.9), a0: 0.6, a1: 0,
        type: PType.Bubble, lift: 1.2, drag: 0.4, delay: i * rand(0.05, 0.12),
      });
    }
  }

  /** Big radial flash for bombs. */
  nova(x: number, y: number) {
    const p = this.particles;
    p.emit({ x, y, z: 0.5, life: 0.5, size0: 2, size1: 40, c0: C(1.5, 2.6, 3.4), a0: 1, a1: 0, type: PType.Glow });
    p.emit({ x, y, z: 0.5, life: 0.7, size0: 1, size1: 38, c0: C(2, 3, 3.5), a0: 1, a1: 0, type: PType.Ring });
    p.emit({ x, y, z: 0.5, life: 0.9, size0: 1, size1: 26, c0: C(1.2, 2, 3), a0: 0.8, a1: 0, type: PType.Ring, delay: 0.1 });
    for (let i = 0; i < 70; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(14, 32);
      p.emit({ x, y, z: rand(-1, 1), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(-4, 4), life: rand(0.5, 1), size0: 0.2, size1: 0.05, c0: C(2, 3.4, 4), c1: C(0.4, 1.2, 2.4), a0: 1, a1: 0, type: PType.Spark, drag: 1.4 });
    }
    this.lights.flash(x, y, 2, 0x80d8ff, 300, 0.7);
    this.shockwave(x, y, 0);
    this.rig.shake(0.7);
    this.renderer.kickAberration(1);
  }
}
