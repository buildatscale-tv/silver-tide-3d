// The scrolling underwater world: heightmap seabed, instanced props, ruins,
// far city backdrop, light shafts, jellyfish, marine snow, lighting and the
// zone palettes that shift as the stage goes deeper.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { WATER, underwater } from './underwater';
import { hdr, type Mats } from './materials';
import type { TextureSet } from './textures';
import { merge, xf, tubeX, cyl } from './geometry';
import { clamp, lerp, mulberry32, rand, randInt, pick, smoothstep } from '../core/math';

export const FLOOR_Y = -14;
const HM = 256;
const CELL = 1.5;
// Props spawn this far right of the view center (per category, since the
// visible width grows with depth) and recycle once they pass BEHIND.
const BEHIND = -150;

export interface ZonePalette {
  fog: number;
  density: number;
  sun: number;
  sunColor: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  rim: number;
  caustic: number;
  shafts: number;
  env: number;
  back: number;
}

export const ZONES: ZonePalette[] = [
  // α: Twilight Shelf
  { fog: 0x1a6480, density: 0.0108, sun: 2.8, sunColor: 0xd4f3ff, hemiSky: 0x62c6e8, hemiGround: 0x0c1c26, hemi: 1.1, rim: 1.4, caustic: 1.15, shafts: 1.0, env: 0.95, back: 1.0 },
  // β: Drowned Foundry
  { fog: 0x175070, density: 0.0122, sun: 2.0, sunColor: 0xbfe6ff, hemiSky: 0x4aa2c8, hemiGround: 0x1a1410, hemi: 0.95, rim: 1.5, caustic: 0.75, shafts: 0.55, env: 0.8, back: 0.8 },
  // γ: Abyssal Trench
  { fog: 0x0b2244, density: 0.0142, sun: 1.0, sunColor: 0x9fb8ff, hemiSky: 0x3456a8, hemiGround: 0x06080f, hemi: 0.8, rim: 1.7, caustic: 0.3, shafts: 0.18, env: 0.55, back: 0.5 },
  // boss arena
  { fog: 0x141a40, density: 0.0138, sun: 1.1, sunColor: 0xd6b8ff, hemiSky: 0x5048a8, hemiGround: 0x0a0610, hemi: 0.85, rim: 1.9, caustic: 0.35, shafts: 0.25, env: 0.6, back: 0.55 },
];

// ------------------------------------------------------------ heightmap
function makeHeights(): Float32Array {
  const out = new Float32Array(HM * HM);
  const rnd = mulberry32(90210);
  const octs: [number, number][] = [
    [64, 1.0],
    [32, 0.55],
    [16, 0.3],
    [8, 0.14],
    [4, 0.06],
  ];
  for (const [P, amp] of octs) {
    const G = HM / P;
    const lat = new Float32Array(G * G);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < HM; y++) {
      const gy = y / P;
      const iy = Math.floor(gy);
      let fy = gy - iy;
      fy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < HM; x++) {
        const gx = x / P;
        const ix = Math.floor(gx);
        let fx = gx - ix;
        fx = fx * fx * (3 - 2 * fx);
        const a = lat[(iy % G) * G + (ix % G)];
        const b = lat[(iy % G) * G + ((ix + 1) % G)];
        const c = lat[((iy + 1) % G) * G + (ix % G)];
        const d = lat[((iy + 1) % G) * G + ((ix + 1) % G)];
        out[y * HM + x] += amp * lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
      }
    }
  }
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of out) {
    mn = Math.min(mn, v);
    mx = Math.max(mx, v);
  }
  for (let i = 0; i < out.length; i++) {
    const v = (out[i] - mn) / (mx - mn);
    // Mild ridging for rocky crests.
    out[i] = v * 0.75 + (1 - Math.abs(v * 2 - 1)) * 0.25;
  }
  return out;
}

const TERRAIN_GLSL = /* glsl */ `
uniform sampler2D uHeight;
uniform float uSnap;
uniform float uTrenchU;
uniform float uTrenchDepth;
varying vec2 vTerrUv;
varying float vSlope;
varying float vH;
float hTex(vec2 t) {
  vec2 i = floor(t);
  vec2 f = t - i;
  float a = texture2D(uHeight, (i + vec2(0.5, 0.5)) / 256.0).r;
  float b = texture2D(uHeight, (i + vec2(1.5, 0.5)) / 256.0).r;
  float c = texture2D(uHeight, (i + vec2(0.5, 1.5)) / 256.0).r;
  float d = texture2D(uHeight, (i + vec2(1.5, 1.5)) / 256.0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float terrainH(float u, float z) {
  float n = hTex(vec2(u, z) / ${CELL.toFixed(2)});
  float far = 1.0 - smoothstep(-170.0, -40.0, z);
  float h = ${FLOOR_Y.toFixed(1)} + (n - 0.5) * (7.0 + far * 8.0) + far * 20.0;
  h -= uTrenchDepth * smoothstep(uTrenchU, uTrenchU + 70.0, u) * (1.0 - far * 0.7);
  return h;
}
`;

// ------------------------------------------------------------ instanced prop layer
class InstLayer {
  readonly mesh: THREE.InstancedMesh;
  private head = 0;
  private cap: number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, shadows = false) {
    this.cap = cap;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = true;
    this.clear();
  }

  add(u: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number, color?: THREE.Color) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.m.compose(this.p.set(u, y, z), this.q.setFromEuler(this.e.set(rx, ry, rz)), this.s.set(sx, sy, sz));
    this.mesh.setMatrixAt(i, this.m);
    if (color) this.mesh.setColorAt(i, color);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (color && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    const z = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.cap; i++) this.mesh.setMatrixAt(i, z);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------ pooled mesh props
interface PoolItem {
  obj: THREE.Object3D;
  u: number;
  active: boolean;
  swim?: number;
}

class Pool {
  items: PoolItem[] = [];
  constructor(make: (i: number) => THREE.Object3D, n: number, parent: THREE.Object3D) {
    for (let i = 0; i < n; i++) {
      const obj = make(i);
      obj.visible = false;
      parent.add(obj);
      this.items.push({ obj, u: 0, active: false });
    }
  }
  take(): PoolItem | null {
    const it = this.items.find((i) => !i.active);
    if (!it) return null;
    it.active = true;
    it.obj.visible = true;
    return it;
  }
  behind = BEHIND;
  recycle(scroll: number) {
    for (const it of this.items) {
      if (it.active && it.u - scroll < this.behind) {
        it.active = false;
        it.obj.visible = false;
      }
    }
  }
  clear() {
    for (const it of this.items) {
      it.active = false;
      it.obj.visible = false;
    }
  }
}

// ------------------------------------------------------------ textures for plants
function kelpTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 512);
  const rnd = mulberry32(5);
  g.strokeStyle = '#6e8f3e';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(32, 512);
  g.lineTo(32, 0);
  g.stroke();
  for (let y = 500; y > 10; y -= 18) {
    const side = (y / 18) % 2 < 1 ? 1 : -1;
    const len = 18 + rnd() * 12;
    const grd = g.createLinearGradient(32, y, 32 + side * len, y - 30);
    grd.addColorStop(0, '#7fa24a');
    grd.addColorStop(1, '#b8c86a');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(32 + side * len * 0.5, y - 12, len * 0.6, 6, side * -0.8, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------ geometry builders
function rockGeo(seed: number, detail = 2): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const k1 = rnd() * 10;
  const k2 = rnd() * 10;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n = 1 + 0.22 * Math.sin(x * 3.1 + k1) * Math.cos(z * 2.7 + k2) + 0.12 * Math.sin(y * 5.3 + k2 + x * 2.0) + (rnd() - 0.5) * 0.06;
    const flat = y < -0.2 ? 0.6 : 1; // flattened bottoms sit on the floor
    p.setXYZ(i, x * n * 1.15, y * n * 0.75 * flat, z * n);
    uv[i * 2] = x * 0.5 + z * 0.35 + 0.5;
    uv[i * 2 + 1] = y * 0.5 + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function coralGeo(seed: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const grow = (base: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const end = base.clone().addScaledVector(dir, len);
    const c = new THREE.CylinderGeometry(r * 0.7, r, len, 6);
    c.translate(0, len / 2, 0);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    c.translate(base.x, base.y, base.z);
    parts.push(c);
    const tip = new THREE.SphereGeometry(r * 0.8, 6, 5);
    tip.translate(end.x, end.y, end.z);
    parts.push(tip);
    if (depth <= 0) return;
    const n = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const d = dir.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() * 0.4, rnd() - 0.5).multiplyScalar(1.3)).normalize();
      grow(end, d, len * (0.6 + rnd() * 0.25), r * 0.7, depth - 1);
    }
  };
  grow(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0.9, 0.16, 3);
  return merge(parts);
}

function glowPlantGeo(): THREE.BufferGeometry {
  const stalks: THREE.BufferGeometry[] = [];
  const bulbs: THREE.BufferGeometry[] = [];
  const rnd = mulberry32(77);
  for (let i = 0; i < 5; i++) {
    const h = 0.8 + rnd() * 1.4;
    const x = (rnd() - 0.5) * 0.9;
    const z = (rnd() - 0.5) * 0.9;
    const s = new THREE.CylinderGeometry(0.025, 0.05, h, 5);
    s.translate(x, h / 2, z);
    stalks.push(s);
    const b = new THREE.SphereGeometry(0.1 + rnd() * 0.07, 8, 6);
    b.translate(x, h, z);
    bulbs.push(b);
  }
  const colorize = (g: THREE.BufferGeometry, r: number, gg: number, b: number) => {
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([r, gg, b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  const s = merge(stalks);
  const b = merge(bulbs);
  colorize(s, 0.015, 0.03, 0.03);
  colorize(b, 1, 1, 1);
  const out = new THREE.BufferGeometry();
  const ps = s.getAttribute('position').array as Float32Array;
  const pb = b.getAttribute('position').array as Float32Array;
  const cat = (a: ArrayLike<number>, c: ArrayLike<number>) => {
    const r = new Float32Array(a.length + c.length);
    r.set(a);
    r.set(c, a.length);
    return r;
  };
  out.setAttribute('position', new THREE.BufferAttribute(cat(ps, pb), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(cat(s.getAttribute('normal').array, b.getAttribute('normal').array), 3));
  out.setAttribute('color', new THREE.BufferAttribute(cat(s.getAttribute('color').array, b.getAttribute('color').array), 3));
  return out;
}

function gearGeo(r: number, teeth: number, thick: number) {
  const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(r, r * 0.12, 8, 40)];
  parts.push(new THREE.TorusGeometry(r * 0.35, r * 0.1, 8, 20));
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    parts.push(xf(new THREE.BoxGeometry(r * 0.16, r * 0.22, thick), { r: [0, 0, a], p: [Math.cos(a) * r * 1.13, Math.sin(a) * r * 1.13, 0] }));
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(xf(new THREE.BoxGeometry(r * 0.66, r * 0.07, thick * 0.6), { r: [0, 0, a], p: [Math.cos(a) * r * 0.67, Math.sin(a) * r * 0.67, 0] }));
  }
  return merge(parts);
}

// ------------------------------------------------------------ environment
export class Environment {
  readonly root = new THREE.Group();
  /** Everything that scrolls with the level; x = u - scroll. */
  readonly world = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private rim: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private scene: THREE.Scene;
  scroll = 0;
  zoneIndex = 0;
  private pal: ZonePalette = { ...ZONES[0] };
  private palFrom: ZonePalette = { ...ZONES[0] };
  private palT = 1;

  private heights: Float32Array;
  private terrain: THREE.Mesh;
  private terrainUniforms: Record<string, THREE.IUniform>;
  trenchU = 1e9;
  trenchDepth = 9;

  private rocks: InstLayer[] = [];
  private bigRocks: InstLayer;
  private kelp: InstLayer;
  private coral: InstLayer;
  private glowPlants: InstLayer;
  private pillars: Pool;
  private arches: Pool;
  private pipes: Pool;
  private gears: Pool;
  private towers: Pool;
  private ceilings: Pool;
  private shafts: Pool;
  private jellies: Pool;
  private shaftMat: THREE.ShaderMaterial;
  private jellyMats: THREE.ShaderMaterial[] = [];
  private snow: THREE.Points;
  private snowMat: THREE.ShaderMaterial;
  private backdrop: THREE.Mesh;
  private backMat: THREE.ShaderMaterial;
  private next: Record<string, number> = {};
  private time = 0;
  onBubbles?: (x: number, y: number, z: number) => void;
  private bubbleT = 0;

  constructor(scene: THREE.Scene, mats: Mats, tex: TextureSet, envMap: THREE.Texture) {
    this.scene = scene;
    scene.add(this.root);
    this.root.add(this.world);
    scene.environment = envMap;

    // ---- lights
    this.sun = new THREE.DirectionalLight(0xd4f3ff, 2.8);
    this.sun.position.set(-6, 40, 14);
    this.sun.target.position.set(2, 0, -2);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 20;
    sc.bottom = -20;
    sc.near = 5;
    sc.far = 90;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 3;
    this.root.add(this.sun, this.sun.target);
    this.rim = new THREE.DirectionalLight(0x7fd8ff, 1.4);
    this.rim.position.set(-10, 6, -30);
    this.root.add(this.rim);
    this.hemi = new THREE.HemisphereLight(0x62c6e8, 0x0c1c26, 1.1);
    this.root.add(this.hemi);

    // ---- terrain
    this.heights = makeHeights();
    const ht = new THREE.DataTexture(this.heights, HM, HM, THREE.RedFormat, THREE.FloatType);
    ht.wrapS = ht.wrapT = THREE.RepeatWrapping;
    ht.magFilter = ht.minFilter = THREE.NearestFilter;
    ht.needsUpdate = true;
    this.terrainUniforms = {
      uHeight: { value: ht },
      uSnap: { value: 0 },
      uTrenchU: { value: this.trenchU },
      uTrenchDepth: { value: this.trenchDepth },
      uSand: { value: tex.seabed },
      uRock: { value: tex.rock },
    };
    const tu = this.terrainUniforms;
    const terrainMat = underwater(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 }), {
      key: 'terrain',
      extra: (shader) => {
        Object.assign(shader.uniforms, tu);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\n' + TERRAIN_GLSL)
          .replace(
            '#include <beginnormal_vertex>',
            `float tU = position.x + uSnap;
             float tZ = position.z;
             float h0 = terrainH(tU, tZ);
             float hx = terrainH(tU + 0.75, tZ) - terrainH(tU - 0.75, tZ);
             float hz = terrainH(tU, tZ + 0.75) - terrainH(tU, tZ - 0.75);
             vec3 objectNormal = normalize(vec3(-hx, 1.5, -hz));
             vTerrUv = vec2(tU, tZ);
             vSlope = 1.0 - objectNormal.y;
             vH = h0;`,
          )
          .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, h0, position.z);');
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
             uniform sampler2D uSand;
             uniform sampler2D uRock;
             varying vec2 vTerrUv;
             varying float vSlope;
             varying float vH;`,
          )
          .replace(
            '#include <map_fragment>',
            `vec3 sand = texture2D(uSand, vTerrUv * 0.11).rgb;
             vec3 sandB = texture2D(uSand, vTerrUv * 0.027 + 0.37).rgb;
             vec3 rockC = texture2D(uRock, vTerrUv * 0.06).rgb;
             float mottle = texture2D(uRock, vTerrUv * 0.011).r;
             float rk = smoothstep(0.22, 0.5, vSlope + (mottle - 0.45) * 0.35);
             vec3 tcol = mix(mix(sand, sandB, 0.4) * vec3(1.25, 1.3, 1.35), rockC * 1.1, rk);
             tcol *= mix(0.5, 1.2, smoothstep(-22.0, -9.0, vH));
             diffuseColor.rgb *= tcol;`,
          );
      },
    });
    const tg = new THREE.PlaneGeometry(300, 210, 200, 140);
    tg.rotateX(-Math.PI / 2);
    tg.translate(0, 0, -91);
    this.terrain = new THREE.Mesh(tg, terrainMat);
    this.terrain.receiveShadow = true;
    this.terrain.frustumCulled = false;
    this.root.add(this.terrain);

    // ---- instanced props
    const rockMat = mats.rock;
    for (let i = 0; i < 3; i++) this.rocks.push(new InstLayer(rockGeo(11 + i * 7, 2), rockMat, 140, false));
    this.bigRocks = new InstLayer(rockGeo(99, 3), rockMat, 60, false);
    for (const l of [...this.rocks, this.bigRocks]) this.world.add(l.mesh);

    const kelpMat = underwater(
      new THREE.MeshStandardMaterial({ map: kelpTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, color: 0x6f8a5c, emissive: 0x050d04 }),
      {
        key: 'kelp',
        extra: (shader) => {
          shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             #ifdef USE_INSTANCING
               vec3 ip = instanceMatrix[3].xyz;
               float sx = length(instanceMatrix[0].xyz);
               float sy = length(instanceMatrix[1].xyz);
               float ph = uTime * 1.1 + ip.x * 0.37 + ip.z * 0.23;
               float amp = position.y * position.y * sy * 0.12;
               transformed.x += sin(ph) * amp / sx;
               transformed.z += cos(ph * 0.8) * amp * 0.5 / sx;
             #endif`,
          );
        },
      },
    );
    const kg = merge([new THREE.PlaneGeometry(0.6, 1, 1, 14), xf(new THREE.PlaneGeometry(0.6, 1, 1, 14), { r: [0, Math.PI / 2, 0] })]);
    kg.translate(0, 0.5, 0);
    this.kelp = new InstLayer(kg, kelpMat, 420, false);
    this.world.add(this.kelp.mesh);

    const coralMat = underwater(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.05, emissive: 0x220a10, emissiveIntensity: 1 }));
    this.coral = new InstLayer(merge([coralGeo(3), xf(coralGeo(8), { p: [0.6, 0, 0.3], s: 0.8, r: [0, 1.2, 0] })]), coralMat, 160, false);
    this.world.add(this.coral.mesh);

    const plantMat = underwater(new THREE.MeshBasicMaterial({ color: hdr(0xffffff, 4), vertexColors: true }), { caustics: false });
    this.glowPlants = new InstLayer(glowPlantGeo(), plantMat, 200, false);
    this.world.add(this.glowPlants.mesh);

    // ---- ruins
    const ruin = mats.ruinMetal;
    const rust = mats.rust;
    const amber = new THREE.MeshBasicMaterial({ color: hdr(0xffa040, 3.5) });
    const cyan = new THREE.MeshBasicMaterial({ color: hdr(0x40e0ff, 3) });
    const pillarGeo = merge([
      xf(cyl(1.1, 1.3, 16, 8), { p: [0, 8, 0] }),
      xf(new THREE.BoxGeometry(3.2, 1.0, 3.2), { p: [0, 0.5, 0] }),
      xf(new THREE.BoxGeometry(2.8, 0.8, 2.8), { p: [0, 16.2, 0], r: [0.08, 0.3, 0.05] }),
      xf(new THREE.TorusGeometry(1.25, 0.18, 6, 8), { r: [Math.PI / 2, 0, 0], p: [0, 5, 0] }),
      xf(new THREE.TorusGeometry(1.2, 0.18, 6, 8), { r: [Math.PI / 2, 0, 0], p: [0, 11, 0] }),
    ]);
    const pillarLights = merge([0, 1, 2].map((i) => xf(new THREE.BoxGeometry(0.25, 1.4, 0.1), { p: [0, 3 + i * 4.2, 1.18] })));
    this.pillars = new Pool(() => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(pillarGeo, ruin);
      m.castShadow = false;
      m.receiveShadow = true;
      g.add(m, new THREE.Mesh(pillarLights, amber));
      return g;
    }, 10, this.world);

    const archGeo = merge([
      xf(cyl(1.0, 1.2, 12, 8), { p: [-7, 6, 0] }),
      xf(cyl(1.0, 1.2, 12, 8), { p: [7, 6, 0] }),
      xf(new THREE.TorusGeometry(7, 1.0, 8, 24, Math.PI), { p: [0, 12, 0] }),
      xf(new THREE.TorusGeometry(7, 0.35, 6, 24, Math.PI), { p: [0, 12, 0.9] }),
    ]);
    const archLights = merge([-1, 1].map((s) => xf(new THREE.BoxGeometry(0.2, 5, 0.1), { p: [7 * s, 7, 1.1] })));
    this.arches = new Pool(() => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(archGeo, rust);
      m.receiveShadow = true;
      g.add(m, new THREE.Mesh(archLights, cyan));
      return g;
    }, 4, this.world);

    const pipeGeo = merge([
      tubeX(1.3, 1.3, 36, 16),
      ...[3, 12, 21, 30].map((x) => xf(new THREE.TorusGeometry(1.45, 0.25, 8, 16), { r: [0, Math.PI / 2, 0], p: [x, 0, 0] })),
      xf(tubeX(0.6, 0.6, 12, 10), { r: [0, 0, Math.PI / 2], p: [18, 0, 0] }),
    ]);
    this.pipes = new Pool(() => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(pipeGeo, rust);
      m.receiveShadow = true;
      g.add(m);
      return g;
    }, 6, this.world);

    const bigGear = gearGeo(6, 18, 1.4);
    this.gears = new Pool(() => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bigGear, ruin));
      return g;
    }, 4, this.world);

    const towerGeo = merge([
      xf(cyl(3.5, 6, 40, 10), { p: [0, 20, 0] }),
      xf(cyl(0.2, 3.5, 22, 10), { p: [0, 51, 0] }),
      xf(new THREE.SphereGeometry(5.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), { p: [8, 14, 0] }),
      xf(cyl(2.5, 3.0, 28, 8), { p: [8, 14, 0] }),
      xf(new THREE.TorusGeometry(4.2, 0.6, 6, 10), { r: [Math.PI / 2, 0, 0], p: [0, 32, 0] }),
    ]);
    const towerLights = merge(
      Array.from({ length: 10 }, (_, i) => xf(new THREE.BoxGeometry(0.5, 1.2, 0.2), { p: [((i * 37) % 5) - 2, 6 + i * 3.6, 4.8 - i * 0.12] })),
    );
    this.towers = new Pool((i) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(towerGeo, ruin), new THREE.Mesh(towerLights, i % 2 ? cyan : amber));
      return g;
    }, 10, this.world);
    this.towers.behind = -230;

    const ceilGeo = merge([
      tubeX(1.0, 1.0, 44, 14),
      xf(tubeX(0.6, 0.6, 44, 10), { p: [0, -1.3, 2.2] }),
      ...[4, 15, 26, 37].map((x) => xf(new THREE.TorusGeometry(1.15, 0.22, 6, 14), { r: [0, Math.PI / 2, 0], p: [x, 0, 0] })),
      ...[8, 22, 34].map((x) => xf(cyl(0.35, 0.35, 4, 8), { p: [x, -2.2, 0.4] })),
      ...[8, 22, 34].map((x) => xf(new THREE.BoxGeometry(1.1, 0.6, 1.1), { p: [x, -4.2, 0.4] })),
      xf(new THREE.BoxGeometry(44, 0.5, 5), { p: [22, 1.2, -1.5] }),
    ]);
    const ceilLights = merge([8, 22, 34].map((x) => xf(new THREE.BoxGeometry(0.7, 0.2, 0.7), { p: [x, -4.55, 0.4] })));
    this.ceilings = new Pool(() => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(ceilGeo, rust), new THREE.Mesh(ceilLights, amber));
      return g;
    }, 6, this.world);

    // ---- light shafts
    this.shaftMat = new THREE.ShaderMaterial({
      uniforms: { uTime: WATER.uTime, uIntensity: { value: 1 }, uColor: { value: new THREE.Color(0.35, 0.75, 0.95) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; uniform float uIntensity; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
          float fall = pow(clamp(vUv.y, 0.0, 1.0), 1.6) * smoothstep(0.0, 0.25, vUv.y);
          float flick = 0.75 + 0.25 * sin(uTime * 0.7 + vUv.x * 9.0) * sin(uTime * 0.43 + vUv.y * 5.0);
          float a = edge * fall * flick * uIntensity * 0.16;
          gl_FragColor = vec4(uColor * a, 0.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
    });
    const shaftGeo = new THREE.PlaneGeometry(9, 90);
    shaftGeo.translate(0, -45, 0);
    this.shafts = new Pool(() => {
      const m = new THREE.Mesh(shaftGeo, this.shaftMat);
      m.renderOrder = 2;
      m.frustumCulled = false;
      return m;
    }, 22, this.world);
    this.shafts.behind = -190;

    // ---- jellyfish
    this.jellies = new Pool((i) => this.makeJelly(i), 9, this.world);

    // ---- marine snow
    const N = 2600;
    const sp = new Float32Array(N * 3);
    const sd = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      sp[i * 3] = rand(-45, 45);
      sp[i * 3 + 1] = rand(-18, 18);
      sp[i * 3 + 2] = rand(-70, 24);
      sd[i] = rand(0.4, 1.6);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    this.snowMat = new THREE.ShaderMaterial({
      uniforms: { uTime: WATER.uTime, uScroll: WATER.uScroll, uPixel: { value: 1 }, uColor: { value: new THREE.Color(0.55, 0.85, 0.95) }, uAmount: { value: 1 } },
      vertexShader: `attribute float aSeed; uniform float uTime; uniform float uScroll; uniform float uPixel;
        varying float vA;
        void main(){
          vec3 p = position;
          p.x = mod(p.x - uScroll * 0.92 + uTime * 0.25 * aSeed + 45.0, 90.0) - 45.0;
          p.y = mod(p.y - uTime * 0.35 * aSeed + 18.0, 36.0) - 18.0;
          p.x += sin(uTime * 0.6 * aSeed + position.z) * 0.4;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = -mv.z;
          gl_PointSize = uPixel * aSeed * 70.0 / dist;
          vA = smoothstep(90.0, 20.0, dist) * smoothstep(2.0, 8.0, dist);
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uAmount; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d) * vA * 0.5 * uAmount; gl_FragColor = vec4(uColor * a, 0.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.snow = new THREE.Points(sg, this.snowMat);
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 3;
    this.root.add(this.snow);

    // ---- backdrop (Nano Banana matte painting)
    this.backMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex.backdrop },
        uOffset: { value: 0 },
        uFogColor: WATER.uFogColor,
        uBright: { value: 1 },
        uTime: WATER.uTime,
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D uMap; uniform float uOffset; uniform vec3 uFogColor; uniform float uBright; uniform float uTime; varying vec2 vUv;
        void main(){
          vec2 uv = vec2(vUv.x * 1.0 + uOffset, vUv.y);
          vec3 art = texture2D(uMap, uv).rgb;
          float lum = dot(art, vec3(0.3, 0.5, 0.2));
          vec3 tinted = mix(uFogColor * 0.85, art * 1.35 * uBright + uFogColor * 0.2, 0.6);
          // surface glow above the painting and fade into the deep below it
          float top = smoothstep(0.72, 1.0, vUv.y);
          tinted += uFogColor * top * 0.6 * uBright;
          tinted *= mix(0.55, 1.0, smoothstep(0.0, 0.45, vUv.y));
          tinted += vec3(0.5, 0.9, 1.0) * pow(max(lum - 0.35, 0.0), 2.0) * 1.5 * uBright;
          gl_FragColor = vec4(tinted, 1.0);
        }`,
      depthWrite: false,
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(760, 322), this.backMat);
    this.backdrop.position.set(0, 25, -330);
    this.backdrop.renderOrder = -10;
    this.backdrop.frustumCulled = false;
    this.root.add(this.backdrop);

    this.applyPalette(ZONES[0]);
    this.reset();
  }

  private makeJelly(i: number): THREE.Object3D {
    const colors = [0x40e8ff, 0xff4fd8, 0xffb040, 0x8a7bff];
    const col = colors[i % colors.length];
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: WATER.uTime, uColor: { value: hdr(col, 1.8) }, uPhase: { value: i * 1.7 } },
      vertexShader: `uniform float uTime; uniform float uPhase; varying vec3 vN; varying vec3 vV; varying float vY;
        void main(){
          float pulse = sin(uTime * 2.2 + uPhase);
          vec3 p = position;
          p.xz *= 1.0 + pulse * 0.12 * (1.0 - p.y);
          p.y *= 1.0 - pulse * 0.08;
          vY = position.y;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalMatrix * normal; vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vV; varying float vY;
        void main(){
          float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.0);
          float bands = 0.5 + 0.5 * sin(vY * 30.0 - uTime * 3.0);
          float a = f * 0.9 + 0.12 + bands * 0.08;
          gl_FragColor = vec4(uColor * a, 0.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
    });
    this.jellyMats.push(mat);
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * Math.PI * 0.5;
      pts.push(new THREE.Vector2(Math.sin(a) * 1.0 * (1 - 0.1 * Math.sin(a * 4)), Math.cos(a) * 0.8));
    }
    pts.push(new THREE.Vector2(0.85, -0.05));
    const bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), mat);
    const tmat = new THREE.ShaderMaterial({
      uniforms: { uTime: WATER.uTime, uColor: { value: hdr(col, 1.2) }, uPhase: { value: i * 1.7 } },
      vertexShader: `uniform float uTime; uniform float uPhase; varying float vT;
        void main(){ vec3 p = position; float t = -p.y / 4.0; vT = t;
          p.x += sin(uTime * 1.6 + uPhase + t * 5.0) * t * 0.6; p.z += cos(uTime * 1.3 + uPhase + t * 4.0) * t * 0.4;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vT; void main(){ gl_FragColor = vec4(uColor * clamp(1.0 - vT, 0.0, 1.0) * 0.6, 0.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
    });
    const tg = merge(
      Array.from({ length: 7 }, (_, k) => {
        const a = (k / 7) * Math.PI * 2;
        const g = new THREE.PlaneGeometry(0.07, 4, 1, 12);
        g.translate(Math.cos(a) * 0.55, -2, Math.sin(a) * 0.55);
        return g;
      }),
    );
    const tent = new THREE.Mesh(tg, tmat);
    const g = new THREE.Group();
    g.add(bell, tent);
    g.userData.bob = rand(0, 6);
    return g;
  }

  // ------------------------------------------------------------ height
  private hTex(tx: number, tz: number) {
    const ix = Math.floor(tx);
    const iz = Math.floor(tz);
    const fx = tx - ix;
    const fz = tz - iz;
    const w = (i: number) => ((i % HM) + HM) % HM;
    const H = this.heights;
    const a = H[w(iz) * HM + w(ix)];
    const b = H[w(iz) * HM + w(ix + 1)];
    const c = H[w(iz + 1) * HM + w(ix)];
    const d = H[w(iz + 1) * HM + w(ix + 1)];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }

  heightAt(u: number, z: number) {
    const n = this.hTex(u / CELL, z / CELL);
    const far = 1 - smoothstep(-170, -40, z);
    let h = FLOOR_Y + (n - 0.5) * (7 + far * 8) + far * 20;
    h -= this.trenchDepth * smoothstep(this.trenchU, this.trenchU + 70, u) * (1 - far * 0.7);
    return h;
  }

  // ------------------------------------------------------------ zones
  setZone(i: number, instant = false) {
    this.zoneIndex = i;
    this.palFrom = { ...this.pal };
    this.palT = instant ? 1 : 0;
    if (instant) this.applyPalette(ZONES[i]);
  }

  private applyPalette(p: ZonePalette) {
    this.pal = { ...p };
    WATER.uFogColor.value.setHex(p.fog);
    WATER.uFogDensity.value = p.density;
    WATER.uCaustic.value = p.caustic;
    this.sun.intensity = p.sun;
    this.sun.color.setHex(p.sunColor);
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemi;
    this.rim.intensity = p.rim;
    this.shaftMat.uniforms.uIntensity.value = p.shafts;
    this.scene.environmentIntensity = p.env;
    this.backMat.uniforms.uBright.value = p.back;
  }

  private blendPalette(a: ZonePalette, b: ZonePalette, t: number): ZonePalette {
    const c = (x: number, y: number) => new THREE.Color(x).lerp(new THREE.Color(y), t).getHex();
    const n = (x: number, y: number) => lerp(x, y, t);
    return {
      fog: c(a.fog, b.fog),
      density: n(a.density, b.density),
      sun: n(a.sun, b.sun),
      sunColor: c(a.sunColor, b.sunColor),
      hemiSky: c(a.hemiSky, b.hemiSky),
      hemiGround: c(a.hemiGround, b.hemiGround),
      hemi: n(a.hemi, b.hemi),
      rim: n(a.rim, b.rim),
      caustic: n(a.caustic, b.caustic),
      shafts: n(a.shafts, b.shafts),
      env: n(a.env, b.env),
      back: n(a.back, b.back),
    };
  }

  /** Drive the bloom-friendly red pulse used during the boss fight. */
  pulseFog(k: number) {
    const base = new THREE.Color(this.pal.fog);
    WATER.uFogColor.value.copy(base).lerp(new THREE.Color(0x3a0c1a), clamp(k, 0, 1) * 0.5);
  }

  // ------------------------------------------------------------ lifecycle
  reset(opts: { scroll?: number; trenchU?: number } = {}) {
    this.scroll = opts.scroll ?? 0;
    this.trenchU = opts.trenchU ?? 1e9;
    this.terrainUniforms.uTrenchU.value = this.trenchU;
    for (const l of [...this.rocks, this.bigRocks, this.kelp, this.coral, this.glowPlants]) l.clear();
    for (const p of [this.pillars, this.arches, this.pipes, this.gears, this.towers, this.ceilings, this.shafts, this.jellies]) p.clear();
    const start = this.scroll - 150;
    this.next = {};
    for (const k of ['rock', 'rockFar', 'bigRock', 'kelp', 'coral', 'plant', 'pillar', 'arch', 'pipe', 'gear', 'tower', 'ceiling', 'shaft', 'jelly']) this.next[k] = start + rand(0, 10);
    this.spawnAhead();
  }

  private spawnAhead() {
    const z = this.zoneIndex;
    const AHEAD: Record<string, number> = {
      rock: 60, rockFar: 190, bigRock: 100, kelp: 60, coral: 55, plant: 55, pillar: 95, arch: 95,
      pipe: 60, gear: 85, tower: 215, ceiling: 42, shaft: 140, jelly: 60,
    };
    const step = (key: string, gap: () => number, fn: (u: number) => void) => {
      const limit = this.scroll + AHEAD[key];
      let guard = 0;
      while (this.next[key] < limit && guard++ < 200) {
        const u = this.next[key];
        fn(u);
        this.next[key] = u + gap();
      }
    };

    const rock = (u: number, zz: number, s: number) =>
      pick(this.rocks).add(u, this.heightAt(u, zz) + s * 0.1, zz, rand(-0.3, 0.3), rand(0, 6.28), rand(-0.3, 0.3), s, s * rand(0.6, 1.2), s);
    step('rock', () => rand(4, 9), (u) => rock(u, rand(-4, -38), rand(0.5, 2.6)));
    step('rockFar', () => rand(5, 11), (u) => rock(u, rand(-38, -150), rand(2, 9)));
    step('bigRock', () => rand(18, 40), (u) => {
      const zz = rand(-22, -80);
      const s = rand(6, 14);
      this.bigRocks.add(u, this.heightAt(u, zz) + s * 0.2, zz, rand(-0.2, 0.2), rand(0, 6.28), rand(-0.2, 0.2), s, s * rand(0.5, 1.4), s);
    });
    const kelpGap = z === 0 ? [5, 11] : z === 1 ? [16, 30] : [60, 90];
    step('kelp', () => rand(kelpGap[0], kelpGap[1]), (u) => {
      if (z >= 2) return;
      const zz = Math.random() < 0.08 ? rand(1, 6) : rand(-4, -45);
      const n = randInt(2, 6);
      for (let i = 0; i < n; i++) {
        const uu = u + rand(-2.5, 2.5);
        const z2 = zz + rand(-2.5, 2.5);
        const hMax = z2 > 0 ? 4.5 : 15;
        const h = rand(hMax * 0.45, hMax);
        this.kelp.add(uu, this.heightAt(uu, z2) - 0.3, z2, 0, rand(0, 6.28), rand(-0.12, 0.12), rand(1.4, 2.4), h, rand(1.4, 2.4));
      }
    });
    const coralCols = [0xff7a4a, 0xff5a8a, 0xc05aff, 0xffb040, 0xff4040, 0x5ae0ff];
    step('coral', () => rand(z === 0 ? 4 : 14, z === 0 ? 10 : 30), (u) => {
      if (z >= 2) return;
      const zz = rand(-6, -34);
      const n = randInt(2, 5);
      const col = new THREE.Color(pick(coralCols)).multiplyScalar(0.6);
      for (let i = 0; i < n; i++) {
        const uu = u + rand(-2, 2);
        const z2 = zz + rand(-2, 2);
        const s = rand(0.9, 2.2);
        this.coral.add(uu, this.heightAt(uu, z2) - 0.2, z2, rand(-0.2, 0.2), rand(0, 6.28), rand(-0.2, 0.2), s, s * rand(0.8, 1.3), s, col.clone().multiplyScalar(rand(0.7, 1.2)));
      }
    });
    const plantCols = [new THREE.Color(0.2, 1.0, 1.1), new THREE.Color(1.0, 0.3, 0.9), new THREE.Color(1.0, 0.7, 0.2), new THREE.Color(0.5, 0.5, 1.2)];
    step('plant', () => (z === 2 || z === 3 ? rand(2, 5) : z === 1 ? rand(8, 16) : rand(25, 45)), (u) => {
      const zz = rand(2, -40);
      const s = rand(0.9, 2.0);
      this.glowPlants.add(u, this.heightAt(u, zz) - 0.1, zz, 0, rand(0, 6.28), 0, s, s * rand(0.8, 1.6), s, pick(plantCols));
    });

    const ruins = z === 1 || z === 2;
    step('pillar', () => (ruins ? rand(18, 34) : 400), (u) => {
      if (!ruins) return;
      const it = this.pillars.take();
      if (!it) return;
      const zz = rand(-18, -75);
      it.u = u;
      it.obj.position.set(u, this.heightAt(u, zz) - 1, zz);
      it.obj.rotation.set(rand(-0.12, 0.12), rand(0, 6.28), rand(-0.12, 0.12));
      it.obj.scale.setScalar(rand(0.8, 1.5));
    });
    step('arch', () => (z === 1 ? rand(70, 110) : 400), (u) => {
      if (z !== 1) return;
      const it = this.arches.take();
      if (!it) return;
      const zz = rand(-30, -60);
      it.u = u;
      it.obj.position.set(u, this.heightAt(u, zz) - 1, zz);
      it.obj.rotation.set(0, rand(-0.4, 0.4), rand(-0.08, 0.08));
      it.obj.scale.setScalar(rand(1.0, 1.4));
    });
    step('pipe', () => (ruins ? rand(40, 70) : 400), (u) => {
      if (!ruins) return;
      const it = this.pipes.take();
      if (!it) return;
      const zz = rand(-12, -40);
      it.u = u;
      it.obj.position.set(u, this.heightAt(u + 18, zz) + 0.4, zz);
      it.obj.rotation.set(0, rand(-0.7, 0.7), rand(-0.05, 0.05));
    });
    step('gear', () => (ruins ? rand(60, 100) : 400), (u) => {
      if (!ruins) return;
      const it = this.gears.take();
      if (!it) return;
      const zz = rand(-26, -60);
      it.u = u;
      it.obj.position.set(u, this.heightAt(u, zz) + rand(0, 2), zz);
      it.obj.rotation.set(rand(-0.3, 0.3), rand(-0.6, 0.6), rand(0, 6));
      it.obj.scale.setScalar(rand(0.8, 1.3));
    });
    step('tower', () => (z >= 1 ? rand(35, 65) : rand(80, 140)), (u) => {
      const it = this.towers.take();
      if (!it) return;
      const zz = rand(-125, -190);
      it.u = u;
      it.obj.position.set(u, this.heightAt(u, zz) - 4, zz);
      it.obj.rotation.set(rand(-0.06, 0.06), rand(0, 6.28), rand(-0.08, 0.08));
      it.obj.scale.setScalar(rand(0.9, 1.6));
    });
    step('ceiling', () => (z === 1 ? 44 : 400), (u) => {
      if (z !== 1) return;
      const it = this.ceilings.take();
      if (!it) return;
      const zz = rand(-5, -14);
      it.u = u;
      it.obj.position.set(u, 14.2 - zz * 0.08, zz);
      it.obj.rotation.set(0, rand(-0.1, 0.1), 0);
    });
    step('shaft', () => rand(10, 22), (u) => {
      const it = this.shafts.take();
      if (!it) return;
      const zz = rand(-30, -120);
      it.u = u;
      it.obj.position.set(u, 38, zz);
      it.obj.rotation.set(0, 0, rand(0.18, 0.38));
      it.obj.scale.set(rand(0.6, 1.6), 1, 1);
    });
    step('jelly', () => (z >= 2 ? rand(10, 22) : 400), (u) => {
      if (z < 2) return;
      const it = this.jellies.take();
      if (!it) return;
      const zz = rand(-10, -45);
      it.u = u;
      it.swim = rand(0.5, 1.4);
      it.obj.position.set(u, rand(-6, 10), zz);
      it.obj.scale.setScalar(rand(0.8, 1.8));
      it.obj.rotation.set(0, 0, rand(-0.3, 0.3));
    });
  }

  // ------------------------------------------------------------ frame
  update(dt: number, speed: number, cameraPos: THREE.Vector3) {
    this.time += dt;
    this.scroll += speed * dt;
    WATER.uTime.value = this.time;
    WATER.uScroll.value = this.scroll;
    this.world.position.x = -this.scroll;

    // Terrain moves rigidly: snap sampling to the vertex grid, slide the mesh.
    const spacing = 300 / 200;
    const snapped = Math.floor(this.scroll / spacing) * spacing;
    this.terrainUniforms.uSnap.value = snapped;
    this.terrain.position.x = snapped - this.scroll;

    // Backdrop drifts very slowly and follows the camera for parallax.
    this.backMat.uniforms.uOffset.value = this.scroll * 0.00022;
    this.backdrop.position.x = cameraPos.x * 0.9;
    this.backdrop.position.y = 25 + cameraPos.y * 0.9;

    // Palette blend.
    if (this.palT < 1) {
      this.palT = Math.min(1, this.palT + dt / 7);
      const k = this.palT * this.palT * (3 - 2 * this.palT);
      this.applyPalette(this.blendPalette(this.palFrom, ZONES[this.zoneIndex], k));
      this.palFrom = this.palT >= 1 ? { ...ZONES[this.zoneIndex] } : this.palFrom;
    }

    // Jellyfish swim against the flow and bob.
    for (const it of this.jellies.items) {
      if (!it.active) continue;
      it.u += (it.swim ?? 1) * dt;
      const o = it.obj;
      o.position.x = it.u;
      o.position.y += Math.sin(this.time * 1.1 + (o.userData.bob as number)) * dt * 0.6;
    }

    for (const p of [this.pillars, this.arches, this.pipes, this.gears, this.towers, this.ceilings, this.shafts, this.jellies]) p.recycle(this.scroll);
    this.spawnAhead();

    // Ambient bubble columns in the deeper zones.
    if (this.onBubbles && this.zoneIndex >= 1) {
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) {
        this.bubbleT = rand(0.6, 1.8);
        const x = rand(-28, 34);
        const z = rand(-4, -30);
        this.onBubbles(x, this.heightAt(x + this.scroll, z) + 0.5, z);
      }
    }
  }

  setPixelRatio(pr: number) {
    this.snowMat.uniforms.uPixel.value = pr;
  }

  setShadows(size: number) {
    this.sun.castShadow = size > 0;
    if (size > 0) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  setDetail(high: boolean) {
    this.snow.visible = true;
    this.kelp.mesh.count = high ? 420 : 220;
  }
}
