// Tumbling metal debris (instanced) and a small pool of flash point lights.
import * as THREE from 'three';
import { rand } from '../core/math';

interface Chunk {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  s: number;
  life: number;
  max: number;
}

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private chunks: Chunk[] = [];
  private head = 0;

  constructor(material: THREE.Material, capacity = 180) {
    const g = new THREE.DodecahedronGeometry(0.5, 0);
    // Squash into irregular shards.
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * 1.4, pos.getY(i) * 0.35, pos.getZ(i) * 0.9);
    g.computeVertexNormals();
    this.mesh = new THREE.InstancedMesh(g, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    for (let i = 0; i < capacity; i++) {
      this.chunks.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: 1, life: 0, max: 1 });
      this.mesh.setMatrixAt(i, HIDDEN);
    }
  }

  burst(x: number, y: number, z: number, n: number, speed: number, size: number, color?: THREE.Color) {
    for (let k = 0; k < n; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.chunks.length;
      const c = this.chunks[i];
      c.alive = true;
      c.p.set(x + rand(-0.3, 0.3), y + rand(-0.3, 0.3), z + rand(-0.3, 0.3));
      const a = rand(0, Math.PI * 2);
      const e = rand(-0.6, 0.9);
      const sp = speed * rand(0.4, 1.1);
      c.v.set(Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + speed * 0.3, Math.sin(a) * Math.cos(e) * sp);
      c.q.setFromEuler(tmpE.set(rand(0, 6), rand(0, 6), rand(0, 6)));
      c.w.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
      c.s = size * rand(0.5, 1.2);
      c.life = 0;
      c.max = rand(1.6, 2.8);
      if (color) this.mesh.setColorAt(i, color);
    }
    if (color && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number, drift: number) {
    let any = false;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (!c.alive) continue;
      any = true;
      c.life += dt;
      if (c.life >= c.max) {
        c.alive = false;
        this.mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      const drag = Math.exp(-1.6 * dt);
      c.v.multiplyScalar(drag);
      c.v.y -= 5.5 * dt;
      c.v.x += drift * dt * 0.8;
      c.p.addScaledVector(c.v, dt);
      tmpQ.setFromEuler(tmpE.set(c.w.x * dt, c.w.y * dt, c.w.z * dt));
      c.q.multiply(tmpQ);
      const k = c.s * Math.min(1, (c.max - c.life) * 2);
      tmpM.compose(c.p, c.q, tmpS.set(k, k, k));
      this.mesh.setMatrixAt(i, tmpM);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.chunks.length; i++) {
      this.chunks[i].alive = false;
      this.mesh.setMatrixAt(i, HIDDEN);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Fixed pool of point lights for explosion flashes (constant light count = no shader recompiles). */
export class FlashLights {
  private lights: { l: THREE.PointLight; t: number; max: number; peak: number }[] = [];
  private head = 0;

  constructor(parent: THREE.Object3D, n = 4) {
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffa050, 0, 22, 1.6);
      l.position.set(0, 0, -1000);
      parent.add(l);
      this.lights.push({ l, t: 0, max: 0, peak: 0 });
    }
  }

  flash(x: number, y: number, z: number, color: number, intensity: number, dur: number) {
    const s = this.lights[this.head];
    this.head = (this.head + 1) % this.lights.length;
    s.l.color.setHex(color);
    s.l.position.set(x, y, z + 1.5);
    s.t = 0;
    s.max = dur;
    s.peak = intensity;
    s.l.intensity = intensity;
  }

  clear() {
    for (const s of this.lights) {
      s.max = 0;
      s.l.intensity = 0;
    }
  }

  update(dt: number) {
    for (const s of this.lights) {
      if (s.max <= 0) continue;
      s.t += dt;
      const k = Math.max(0, 1 - s.t / s.max);
      s.l.intensity = s.peak * k * k;
      if (k <= 0) s.max = 0;
    }
  }
}
