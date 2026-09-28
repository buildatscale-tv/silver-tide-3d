// GPU particle system. Particles are written once into a ring buffer and then
// animated entirely in the vertex shader (ballistic motion with drag and
// buoyancy), so thousands of sparks, fireballs, smoke puffs and bubbles cost
// almost no CPU. Premultiplied blending lets additive glows (alpha 0) and
// alpha-blended smoke share a single draw call.
import * as THREE from 'three';

export const PType = {
  Glow: 0,
  Spark: 1,
  Ring: 2,
  Bubble: 3,
  Smoke: 4,
} as const;
export type PType = (typeof PType)[keyof typeof PType];

export interface Emit {
  x: number;
  y: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size0: number;
  size1: number;
  /** start color (linear, can exceed 1 for bloom) */
  c0: THREE.Color;
  c1?: THREE.Color;
  a0?: number;
  a1?: number;
  type: PType;
  drag?: number;
  /** vertical acceleration (+ = rises) */
  lift?: number;
  spin?: number;
  /** 0 = additive, 1 = alpha blended */
  alphaMode?: number;
  delay?: number;
}

const VS = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aTime;   // start, life, drag, lift
attribute vec4 aSize;   // size0, size1, spin, type
attribute vec4 aC0;     // rgb, alpha
attribute vec4 aC1;     // rgb, alpha
attribute float aMode;
uniform float uTime;
uniform vec3 uDrift;
varying vec4 vCol;
varying vec2 vUv;
varying float vType;
varying float vAge;
varying float vMode;
void main() {
  float t = uTime - aTime.x;
  float age = t / aTime.y;
  if (age < 0.0 || age > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float drag = aTime.z;
  vec3 disp = drag > 0.001 ? aVel * (1.0 - exp(-drag * t)) / drag : aVel * t;
  vec3 p = aPos + disp + vec3(0.0, 0.5 * aTime.w * t * t, 0.0) + uDrift * t;
  float type = aSize.w;
  float ease = 1.0 - pow(1.0 - age, 2.0);
  float size = mix(aSize.x, aSize.y, type == 4.0 ? ease : age);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 c = position.xy;
  if (type == 1.0) {
    vec3 vel = aVel * exp(-drag * t) + vec3(0.0, aTime.w * t, 0.0) + uDrift;
    vec4 mv2 = modelViewMatrix * vec4(p + vel * 0.05, 1.0);
    vec2 d = mv2.xy - mv.xy;
    float l = length(d);
    vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float len = size + l * 1.6;
    mv.xy += dir * c.x * len + nrm * c.y * size * 0.35;
  } else {
    float a = aSize.z * t + aPos.x * 3.1;
    float cs = cos(a), sn = sin(a);
    mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
  }
  gl_Position = projectionMatrix * mv;
  vCol = mix(aC0, aC1, age);
  vUv = c + 0.5;
  vType = type;
  vAge = age;
  vMode = aMode;
}`;

const FS = /* glsl */ `
varying vec4 vCol;
varying vec2 vUv;
varying float vType;
varying float vAge;
varying float vMode;
void main() {
  vec2 q = vUv - 0.5;
  float d = length(q) * 2.0;
  float a;
  if (vType < 0.5) {
    a = pow(max(0.0, 1.0 - d), 2.2);
  } else if (vType < 1.5) {
    float along = 1.0 - abs(q.x) * 2.0;
    float across = 1.0 - abs(q.y) * 2.0;
    a = pow(max(0.0, across), 2.0) * pow(max(0.0, along), 0.8);
  } else if (vType < 2.5) {
    float w = 0.06 + 0.1 * (1.0 - vAge);
    a = smoothstep(w, 0.0, abs(d - 0.82)) * step(d, 1.0);
  } else if (vType < 3.5) {
    float rim = smoothstep(0.62, 0.92, d) * step(d, 1.0) * (1.0 - smoothstep(0.92, 1.0, d));
    float hi = smoothstep(0.28, 0.0, length(q - vec2(-0.16, 0.16)));
    a = rim * 0.8 + hi * 0.9;
  } else {
    float n = sin(q.x * 13.0 + vAge * 3.0) * sin(q.y * 11.0 - vAge * 2.0) * 0.12;
    a = smoothstep(1.0, 0.25, d + n);
  }
  a *= vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * a, a * vMode);
}`;

export class Particles {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cap: number;
  private head = 0;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aTime: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aC0: THREE.InstancedBufferAttribute;
  private aC1: THREE.InstancedBufferAttribute;
  private aMode: THREE.InstancedBufferAttribute;
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  time = 0;

  constructor(capacity: number) {
    this.cap = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(3);
    this.aVel = mk(3);
    this.aTime = mk(4);
    this.aSize = mk(4);
    this.aC0 = mk(4);
    this.aC1 = mk(4);
    this.aMode = mk(1);
    // Park all slots in the past so they start dead.
    for (let i = 0; i < capacity; i++) this.aTime.setXYZW(i, -1000, 1, 0, 0);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aVel', this.aVel);
    this.geo.setAttribute('aTime', this.aTime);
    this.geo.setAttribute('aSize', this.aSize);
    this.geo.setAttribute('aC0', this.aC0);
    this.geo.setAttribute('aC1', this.aC1);
    this.geo.setAttribute('aMode', this.aMode);
    this.geo.instanceCount = capacity;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uDrift: { value: new THREE.Vector3(-1.5, 0, 0) } },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  set drift(x: number) {
    this.mat.uniforms.uDrift.value.x = x;
  }

  emit(e: Emit) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    const c1 = e.c1 ?? e.c0;
    this.aPos.setXYZ(i, e.x, e.y, e.z ?? 0);
    this.aVel.setXYZ(i, e.vx ?? 0, e.vy ?? 0, e.vz ?? 0);
    this.aTime.setXYZW(i, this.time + (e.delay ?? 0), e.life, e.drag ?? 0, e.lift ?? 0);
    this.aSize.setXYZW(i, e.size0, e.size1, e.spin ?? 0, e.type);
    this.aC0.setXYZW(i, e.c0.r, e.c0.g, e.c0.b, e.a0 ?? 1);
    this.aC1.setXYZW(i, c1.r, c1.g, c1.b, e.a1 ?? 0);
    this.aMode.setX(i, e.alphaMode ?? 0);
    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
  }

  update(dt: number) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (this.dirtyMax >= 0) {
      const attrs = [this.aPos, this.aVel, this.aTime, this.aSize, this.aC0, this.aC1, this.aMode];
      for (const a of attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(this.dirtyMin * a.itemSize, (this.dirtyMax - this.dirtyMin + 1) * a.itemSize);
        a.needsUpdate = true;
      }
      this.dirtyMin = Infinity;
      this.dirtyMax = -1;
    }
  }

  clear() {
    for (let i = 0; i < this.cap; i++) this.aTime.setXYZW(i, -1000, 1, 0, 0);
    this.aTime.clearUpdateRanges();
    this.aTime.needsUpdate = true;
  }
}
