// Camera behavior: gameplay framing with subtle parallax follow, trauma-based
// shake, a slow orbit for the title screen, and smooth blends between them.
import * as THREE from 'three';
import { clamp, damp, easeInOutCubic, noise1 } from '../core/math';
import { settings } from '../core/Settings';
import type { Renderer } from '../core/Renderer';

export type CamMode = 'title' | 'game';

export class CameraRig {
  private cam: THREE.PerspectiveCamera;
  private trauma = 0;
  private t = 0;
  mode: CamMode = 'title';
  private blend = 1; // 0..1 progress of a mode transition
  private fromPos = new THREE.Vector3();
  private fromLook = new THREE.Vector3();
  private look = new THREE.Vector3();
  private follow = new THREE.Vector2();
  /** Extra offset for cinematic moments (boss entrance, death). */
  cine = new THREE.Vector3();
  cineLook = new THREE.Vector3();
  zoom = 0;
  private titleFocus = new THREE.Vector3(0, 0, 0);

  constructor(private renderer: Renderer) {
    this.cam = renderer.camera;
  }

  setMode(m: CamMode, instant = false) {
    this.fromPos.copy(this.cam.position);
    this.fromLook.copy(this.look);
    this.mode = m;
    this.blend = instant ? 1 : 0;
  }

  setTitleFocus(v: THREE.Vector3) {
    this.titleFocus.copy(v);
  }

  shake(amount: number) {
    if (!settings.data.shake) return;
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  private target(dt: number, px: number, py: number): { pos: THREE.Vector3; look: THREE.Vector3 } {
    if (this.mode === 'title') {
      // Sway in front of the ship (never behind it, where the world ends).
      const a = -0.35 + Math.sin(this.t * 0.11) * 0.75;
      const f = this.titleFocus;
      const r = 9.5;
      return {
        pos: new THREE.Vector3(f.x + Math.sin(a) * r, f.y + 1.4 + Math.sin(this.t * 0.17) * 0.9, f.z + Math.cos(a) * r),
        look: new THREE.Vector3(f.x - 3.2, f.y - 0.3, f.z),
      };
    }
    this.follow.x = damp(this.follow.x, clamp(px, -16, 16), 2.5, dt);
    this.follow.y = damp(this.follow.y, clamp(py, -9, 9), 2.5, dt);
    const d = this.renderer.fitDistance - this.zoom;
    const pos = new THREE.Vector3(this.follow.x * 0.07 + this.cine.x, 1.7 + this.follow.y * 0.06 + this.cine.y, d + this.cine.z);
    const look = new THREE.Vector3(this.follow.x * 0.1 + this.cineLook.x, 0.35 + this.follow.y * 0.08 + this.cineLook.y, this.cineLook.z);
    return { pos, look };
  }

  update(dt: number, px = 0, py = 0) {
    this.t += dt;
    const { pos, look } = this.target(dt, px, py);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 1.6);
      const k = easeInOutCubic(this.blend);
      pos.lerpVectors(this.fromPos, pos, k);
      look.lerpVectors(this.fromLook, look, k);
    }
    this.look.copy(look);
    this.cam.position.copy(pos);

    // Trauma shake: offset + roll, squared for a punchy falloff.
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma;
    if (s > 0) {
      this.cam.position.x += noise1(this.t * 22, 1) * s * 0.9;
      this.cam.position.y += noise1(this.t * 22, 2) * s * 0.7;
    }
    this.cam.lookAt(this.look);
    if (s > 0) this.cam.rotateZ(noise1(this.t * 18, 3) * s * 0.04);
  }
}
