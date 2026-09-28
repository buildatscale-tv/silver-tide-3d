// Procedural 3D models for every ship, creature and pickup.
import * as THREE from 'three';
import { cloneUW } from './underwater';
import { hdr, type Mats } from './materials';
import { loft, plate, wing, sym, merge, xf, tubeX, sphere, mesh, mirrorZ, type Sec } from './geometry';

// ------------------------------------------------------------ shared helpers
const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

/** Interpolated cross-section of a loft at x (for trim bands that hug a hull). */
function secAt(secs: Sec[], x: number): Sec {
  for (let i = 0; i < secs.length - 1; i++) {
    const a = secs[i];
    const b = secs[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x || 1);
      const l = (u: number, v: number) => u + (v - u) * t;
      return { x, w: l(a.w, b.w), h: l(a.h, b.h), y: l(a.y ?? 0, b.y ?? 0), n: l(a.n ?? 2, b.n ?? 2) };
    }
  }
  return { ...secs[x < secs[0].x ? 0 : secs.length - 1], x };
}

/** A ring band around a lofted hull between x0 and x1, scaled out by k. */
function band(secs: Sec[], x0: number, x1: number, k = 1.04, seg = 24) {
  const s = (x: number) => {
    const q = secAt(secs, x);
    return { ...q, w: q.w * k, h: q.h * k };
  };
  return loft([s(x0), s((x0 + x1) / 2), s(x1)], seg);
}

/** Flash-on-hit controller for a set of materials. */
export class Flasher {
  private base: { m: THREE.MeshStandardMaterial; c: THREE.Color; i: number }[] = [];
  private until = 0;
  constructor(mats: THREE.Material[]) {
    for (const m of mats) {
      const s = m as THREE.MeshStandardMaterial;
      if (s.emissive) this.base.push({ m: s, c: s.emissive.clone(), i: s.emissiveIntensity });
    }
  }
  flash(now: number, dur = 0.06, color = 0xffffff, k = 1.6) {
    this.until = now + dur;
    for (const b of this.base) {
      b.m.emissive.setHex(color);
      b.m.emissiveIntensity = k;
    }
  }
  /** Set a persistent emissive tint (boss rage, etc). */
  tint(color: THREE.Color, k: number) {
    for (const b of this.base) {
      b.c.copy(color);
      b.i = k;
    }
  }
  update(now: number) {
    if (this.until && now >= this.until) {
      this.until = 0;
      for (const b of this.base) {
        b.m.emissive.copy(b.c);
        b.m.emissiveIntensity = b.i;
      }
    }
  }
}

export function glowSprite(tex: THREE.Texture, color: number, k: number, size: number) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, color: hdr(color, k), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }),
  );
  s.scale.set(size, size, 1);
  return s;
}

// ------------------------------------------------------------ engine flame
const FLAME_VS = /* glsl */ `
varying vec2 vUv;
varying float vFacing;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const FLAME_FS = /* glsl */ `
uniform float uTime;
uniform float uPower;
uniform vec3 uCore;
uniform vec3 uEdge;
varying vec2 vUv;
varying float vFacing;
void main() {
  // CylinderGeometry uv.y is 1 at the tip and 0 at the base (the nozzle).
  float base = clamp(1.0 - vUv.y, 0.0, 1.0);
  float facing = clamp(vFacing, 0.0, 1.0);
  float flick = 0.8 + 0.2 * sin(uTime * 55.0 + vUv.x * 25.0) * sin(uTime * 31.0);
  float a = pow(base, 1.6) * flick * pow(facing, 1.2) * uPower;
  vec3 c = mix(uEdge, uCore, pow(base, 4.0) * facing);
  gl_FragColor = vec4(c * a, 0.0);
}`;

export function flameMaterial(core: number, edge: number, coreK = 6, edgeK = 3) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 1 },
      uCore: { value: hdr(core, coreK) },
      uEdge: { value: hdr(edge, edgeK) },
    },
    vertexShader: FLAME_VS,
    fragmentShader: FLAME_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    side: THREE.DoubleSide,
  });
}

/** Flame cone with its base at the origin, pointing along -x (length 1). */
export function flameGeo() {
  return geo('flame', () => {
    const g = new THREE.CylinderGeometry(0.0, 1, 1, 14, 6, true);
    g.rotateZ(Math.PI / 2); // tip (+y) -> -x
    g.translate(-0.5, 0, 0);
    return g;
  });
}

// ------------------------------------------------------------ player
export interface PlayerModel {
  root: THREE.Group;
  body: THREE.Group;
  flames: THREE.Mesh[];
  flameMat: THREE.ShaderMaterial;
  shield: THREE.Mesh;
  shieldMat: THREE.ShaderMaterial;
  mats: THREE.Material[];
}

const SHIELD_FS = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform vec3 uColor;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.2);
  vec2 h = vec2(atan(vP.z, vP.x) * 4.0, vP.y * 7.0);
  vec2 g = abs(fract(h + vec2(0.0, uTime * 0.6)) - 0.5);
  float hex = smoothstep(0.42, 0.5, max(g.x, g.y));
  float sweep = smoothstep(0.9, 1.0, sin(vP.x * 2.0 - uTime * 5.0));
  float a = (f * 0.9 + hex * 0.18 * f + sweep * 0.15) * uAlpha;
  gl_FragColor = vec4(uColor * a, 0.0);
}`;
const SHIELD_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

export function shieldMaterial(color: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uColor: { value: hdr(color, 2.2) } },
    vertexShader: SHIELD_VS,
    fragmentShader: SHIELD_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
}

export function buildPlayer(m: Mats): PlayerModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(1.12);
  root.add(body);

  const fusSecs: Sec[] = [
    { x: -1.5, w: 0.2, h: 0.18, y: 0.02, n: 2.6 },
    { x: -1.3, w: 0.33, h: 0.27, y: 0.03, n: 2.6 },
    { x: -0.6, w: 0.37, h: 0.3, y: 0.05, n: 2.6 },
    { x: 0.2, w: 0.31, h: 0.28, y: 0.05, n: 2.4 },
    { x: 0.95, w: 0.19, h: 0.17, y: 0.0, n: 2.2 },
  ];
  const chromeGeo = geo('p.chrome', () =>
    merge([
      loft(fusSecs, 24),
      // wing inner panels
      xf(sym(wing([[0.1, 0.3], [-0.78, 1.32], [-1.12, 1.32], [-1.02, 0.3]], 0.07)), { p: [0, -0.07, 0] }),
      // engine nacelles
      xf(sym(xf(tubeX(0.13, 0.155, 1.05), { p: [-1.55, -0.04, 0.33] })), {}),
      // spine / dorsal fin
      plate([[-0.1, 0.28], [-0.62, 0.55], [-0.86, 0.55], [-0.72, 0.28]], 0.05),
    ]),
  );
  const blueGeo = geo('p.blue', () =>
    merge([
      loft([fusSecs[4], { x: 1.3, w: 0.1, h: 0.09, y: -0.02 }, { x: 1.66, w: 0.012, h: 0.012, y: -0.04 }], 24),
      // wing leading edge + tips
      xf(sym(wing([[0.16, 0.3], [-0.78, 1.32], [-0.92, 1.36], [-0.02, 0.3]], 0.08)), { p: [0, -0.07, 0] }),
      xf(sym(wing([[-0.78, 1.32], [-1.14, 1.32], [-1.2, 1.5], [-0.92, 1.5]], 0.08)), { p: [0, -0.07, 0] }),
      // canards
      sym(wing([[0.98, 0.14], [0.62, 0.5], [0.47, 0.5], [0.55, 0.14]], 0.05)),
      // twin canted tail fins
      sym(xf(plate([[-0.72, 0.0], [-1.28, 0.62], [-1.52, 0.62], [-1.44, 0.0]], 0.05), { r: [-0.3, 0, 0], p: [0, 0.22, 0.2] })),
      // intake cowls
      sym(xf(tubeX(0.12, 0.14, 0.4), { p: [-0.62, -0.06, 0.33] })),
    ]),
  );
  const darkGeo = geo('p.dark', () =>
    merge([
      // nozzles
      sym(xf(new THREE.TorusGeometry(0.13, 0.035, 8, 20), { r: [0, Math.PI / 2, 0], p: [-1.56, -0.04, 0.33] })),
      xf(new THREE.TorusGeometry(0.15, 0.04, 8, 20), { r: [0, Math.PI / 2, 0], p: [-1.5, 0.02, 0] }),
      // gun barrels
      sym(xf(tubeX(0.035, 0.035, 0.72), { p: [0.5, -0.19, 0.18] })),
      // intake mouths
      sym(xf(new THREE.CircleGeometry(0.11, 16), { r: [0, -Math.PI / 2, 0], p: [-0.63, -0.06, 0.33] })),
    ]),
  );
  const canopyGeo = geo('p.canopy', () => xf(sphere(1, 28, 14), { s: [0.62, 0.17, 0.2], p: [0.3, 0.25, 0] }));
  const glowGeo = geo('p.glow', () =>
    merge([
      sym(xf(new THREE.CircleGeometry(0.105, 18), { r: [0, -Math.PI / 2, 0], p: [-1.575, -0.04, 0.33] })),
      xf(new THREE.CircleGeometry(0.12, 18), { r: [0, -Math.PI / 2, 0], p: [-1.52, 0.02, 0] }),
    ]),
  );

  const chrome = m.chrome;
  body.add(mesh(chromeGeo, chrome), mesh(blueGeo, m.playerBlue), mesh(darkGeo, m.gunmetal), mesh(canopyGeo, m.canopy), mesh(glowGeo, m.engineCyan, false));

  const flameMat = flameMaterial(0xdff9ff, 0x2f8bff);
  const flames: THREE.Mesh[] = [];
  for (const [y, z, r] of [[-0.04, 0.33, 0.1], [-0.04, -0.33, 0.1], [0.02, 0, 0.12]] as const) {
    const f = new THREE.Mesh(flameGeo(), flameMat);
    f.position.set(-1.58, y, z);
    f.scale.set(1.1, r, r);
    f.renderOrder = 5;
    body.add(f);
    flames.push(f);
  }

  const shieldMat = shieldMaterial(0x54f27a);
  const shield = new THREE.Mesh(geo('p.shield', () => new THREE.SphereGeometry(1, 36, 18)), shieldMat);
  shield.scale.set(2.0, 0.95, 1.35);
  shield.renderOrder = 6;
  root.add(shield);

  return { root, body, flames, flameMat, shield, shieldMat, mats: [chrome] };
}

// ------------------------------------------------------------ enemies
export interface EnemyModel {
  root: THREE.Group;
  /** named moving parts */
  parts: Record<string, THREE.Object3D>;
  flasher: Flasher;
  flameMat?: THREE.ShaderMaterial;
}

export function buildDrone(m: Mats, tex: THREE.Texture): EnemyModel {
  const hull = cloneUW(m.darkSteel);
  const armor = cloneUW(m.crimson);
  const root = new THREE.Group();
  const spin = new THREE.Group();
  root.add(spin);
  const secs: Sec[] = [
    { x: -1.2, w: 0.02, h: 0.02 },
    { x: -0.85, w: 0.16, h: 0.12, y: 0.01, n: 2.5 },
    { x: -0.25, w: 0.3, h: 0.22, y: 0.03, n: 2.6 },
    { x: 0.4, w: 0.32, h: 0.24, y: 0.03, n: 2.6 },
    { x: 0.85, w: 0.24, h: 0.18, n: 2.4 },
    { x: 1.0, w: 0.16, h: 0.13, n: 2.4 },
  ];
  const bodyGeo = geo('d.body', () =>
    merge([loft(secs, 20), xf(new THREE.TorusGeometry(0.1, 0.03, 6, 14), { r: [0, Math.PI / 2, 0], p: [1.0, 0, 0] })]),
  );
  const armorGeo = geo('d.armor', () =>
    merge([
      sym(xf(wing([[-0.55, 0.2], [0.3, 0.95], [0.92, 0.98], [0.72, 0.22]], 0.08), { r: [0.14, 0, 0], p: [0, -0.02, 0] })),
      plate([[-0.15, 0.16], [0.45, 0.6], [0.9, 0.6], [0.72, 0.16]], 0.06),
      plate([[0.1, -0.16], [0.55, -0.45], [0.82, -0.45], [0.7, -0.16]], 0.05),
      band(secs, -0.45, -0.3, 1.06),
      band(secs, 0.55, 0.7, 1.06),
    ]),
  );
  const eyeGeo = geo('d.eye', () => xf(sphere(1, 16, 10), { s: [0.2, 0.06, 0.13], p: [-0.58, 0.13, 0] }));
  const thrustGeo = geo('d.thrust', () => xf(new THREE.CircleGeometry(0.09, 14), { r: [0, Math.PI / 2, 0], p: [1.01, 0, 0] }));
  spin.add(mesh(bodyGeo, hull), mesh(armorGeo, armor), mesh(eyeGeo, m.eyeYellow, false), mesh(thrustGeo, m.amberGlow, false));
  const eg = glowSprite(tex, 0xffc23a, 1.6, 0.8);
  eg.position.set(-0.62, 0.14, 0);
  spin.add(eg);
  const fm = flameMaterial(0xffe0a0, 0xff5a1a, 4, 2);
  const fl = new THREE.Mesh(flameGeo(), fm);
  fl.rotation.y = Math.PI; // point +x (drone faces -x)
  fl.position.set(1.02, 0, 0);
  fl.scale.set(0.8, 0.08, 0.08);
  spin.add(fl);
  return { root, parts: { spin }, flasher: new Flasher([hull, armor]), flameMat: fm };
}

export function buildPiranha(m: Mats, tex: THREE.Texture): EnemyModel {
  const teal = cloneUW(m.teal);
  const bronze = cloneUW(m.bronze);
  const root = new THREE.Group();
  const secs: Sec[] = [
    { x: -1.0, w: 0.1, h: 0.16, y: 0.14 },
    { x: -0.75, w: 0.3, h: 0.42, y: 0.14 },
    { x: -0.3, w: 0.44, h: 0.64, y: 0.07 },
    { x: 0.25, w: 0.4, h: 0.56, y: 0.04 },
    { x: 0.75, w: 0.2, h: 0.3, y: 0.02 },
    { x: 1.02, w: 0.07, h: 0.11, y: 0.0 },
  ];
  const bodyGeo = geo('f.body', () =>
    merge([loft(secs, 22), plate([[-0.35, 0.6], [0.02, 1.12], [0.2, 1.08], [0.5, 0.52]], 0.05)]),
  );
  const bronzeGeo = geo('f.bronze', () =>
    merge([
      band(secs, -0.44, -0.3, 1.05),
      band(secs, 0.26, 0.4, 1.05),
      band(secs, 0.68, 0.78, 1.06),
      sym(xf(wing([[-0.2, 0.36], [0.25, 0.78], [0.38, 0.72], [0.2, 0.36]], 0.04), { p: [0, -0.22, 0], r: [0.2, 0, 0] })),
      plate([[0.0, -0.52], [0.25, -0.85], [0.45, -0.8], [0.45, -0.45]], 0.04),
      // eye sockets
      sym(xf(new THREE.TorusGeometry(0.1, 0.03, 6, 14), { p: [-0.52, 0.3, 0.3] })),
    ]),
  );
  const toothGeo = (x0: number, x1: number, n: number, y: number, z0: number, z1: number, up: boolean) => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const c = new THREE.ConeGeometry(0.035, 0.15, 5);
      if (!up) c.rotateX(Math.PI);
      c.translate(x0 + (x1 - x0) * t, y + (up ? 0.07 : -0.07), 0);
      const z = z0 + (z1 - z0) * t;
      parts.push(xf(c.clone(), { p: [0, 0, z] }), xf(c, { p: [0, 0, -z] }));
    }
    return merge(parts);
  };
  const upperTeeth = geo('f.teethU', () => toothGeo(-0.95, -0.42, 5, -0.2, 0.08, 0.3, false));
  root.add(mesh(bodyGeo, teal), mesh(bronzeGeo, bronze), mesh(upperTeeth, m.ivory, false));

  // jaw
  const jaw = new THREE.Group();
  jaw.position.set(-0.15, -0.2, 0);
  const jawSecs: Sec[] = [
    { x: -0.85, w: 0.1, h: 0.06, y: -0.04 },
    { x: -0.6, w: 0.24, h: 0.12, y: -0.08 },
    { x: -0.1, w: 0.3, h: 0.15, y: -0.06 },
    { x: 0.08, w: 0.24, h: 0.11, y: 0 },
  ];
  jaw.add(mesh(geo('f.jaw', () => loft(jawSecs, 16)), bronze), mesh(geo('f.teethL', () => toothGeo(-0.78, -0.25, 4, 0.02, 0.06, 0.22, true)), m.ivory, false));
  root.add(jaw);

  // eyes
  const eyeGeo = geo('f.eye', () => sym(xf(sphere(0.085, 12, 8), { p: [-0.52, 0.3, 0.31] })));
  root.add(mesh(eyeGeo, m.eyeOrange, false));
  for (const z of [0.36, -0.36]) {
    const g = glowSprite(tex, 0xff7a1a, 1.4, 0.7);
    g.position.set(-0.52, 0.3, z);
    root.add(g);
  }

  // tail
  const tail = new THREE.Group();
  tail.position.set(0.98, 0, 0);
  tail.add(mesh(geo('f.tail', () => plate([[0, 0.05], [0.5, 0.6], [0.7, 0.58], [0.46, 0], [0.7, -0.55], [0.5, -0.58], [0, -0.05]], 0.05)), bronze));
  root.add(tail);
  return { root, parts: { jaw, tail }, flasher: new Flasher([teal, bronze]) };
}

export function buildManta(m: Mats, tex: THREE.Texture): EnemyModel {
  const purple = cloneUW(m.purple);
  const lilac = cloneUW(m.lilac);
  const root = new THREE.Group();
  const secs: Sec[] = [
    { x: -1.35, w: 0.25, h: 0.07 },
    { x: -1.0, w: 0.5, h: 0.17, y: 0.02 },
    { x: -0.3, w: 0.62, h: 0.22, y: 0.03 },
    { x: 0.5, w: 0.45, h: 0.16 },
    { x: 1.05, w: 0.15, h: 0.07 },
  ];
  root.add(
    mesh(geo('m.body', () => merge([loft(secs, 22), plate([[-0.2, 0.15], [0.3, 0.45], [0.7, 0.42], [0.6, 0.12]], 0.05)])), purple),
    mesh(
      geo('m.lilac', () =>
        merge([
          sym(wing([[-1.15, 0.18], [-1.7, 0.28], [-1.65, 0.42], [-1.05, 0.42]], 0.05)),
          band(secs, -0.6, -0.45, 1.05),
          band(secs, 0.2, 0.35, 1.06),
          xf(tubeX(0.06, 0.012, 2.3), { p: [1.0, 0, 0] }),
          sym(xf(tubeX(0.08, 0.1, 0.5), { p: [0.55, 0.02, 0.24] })),
        ]),
      ),
      lilac,
    ),
    mesh(
      geo('m.glow', () =>
        merge([
          sym(xf(sphere(0.07, 10, 8), { p: [-1.06, 0.12, 0.33] })),
          xf(sphere(0.06, 8, 6), { p: [3.3, 0, 0] }),
          sym(xf(new THREE.CircleGeometry(0.07, 12), { r: [0, Math.PI / 2, 0], p: [1.06, 0.02, 0.24] })),
        ]),
      ),
      m.magenta,
      false,
    ),
  );
  const wingGeo = geo('m.wing', () => wing([[-0.95, 0], [-0.15, 1.1], [0.42, 1.8], [0.72, 1.7], [0.6, 0.9], [0.78, 0]], 0.07));
  const stripGeo = geo('m.strip', () => wing([[-0.9, 0.02], [-0.15, 1.08], [0.42, 1.78], [0.47, 1.7], [-0.05, 1.04], [-0.8, 0.02]], 0.085));
  const wl = new THREE.Group();
  wl.position.set(0, 0, 0.5);
  wl.add(mesh(wingGeo, purple), mesh(stripGeo, m.magenta, false));
  const wr = new THREE.Group();
  wr.position.set(0, 0, -0.5);
  wr.add(mesh(geo('m.wingR', () => mirrorZ(wingGeo)), purple), mesh(geo('m.stripR', () => mirrorZ(stripGeo)), m.magenta, false));
  root.add(wl, wr);
  for (const z of [0.36, -0.36]) {
    const g = glowSprite(tex, 0xff3fd2, 1.2, 0.6);
    g.position.set(-1.07, 0.12, z);
    root.add(g);
  }
  return { root, parts: { wl, wr }, flasher: new Flasher([purple, lilac]) };
}

export function buildTurret(m: Mats, tex: THREE.Texture): EnemyModel {
  const steel = cloneUW(m.steel);
  const copper = cloneUW(m.copper);
  const root = new THREE.Group();
  const yaw = new THREE.Group();
  root.add(yaw);
  const oct = (r0: number, r1: number, h: number) => xf(new THREE.CylinderGeometry(r0, r1, h, 8), { r: [Math.PI / 2, 0, Math.PI / 8] });
  yaw.add(
    mesh(geo('t.body', () => merge([oct(1.0, 1.0, 0.9), xf(oct(0.8, 0.95, 0.3), { p: [0, 0, -0.55] })])), steel),
    mesh(
      geo('t.copper', () =>
        merge([
          xf(new THREE.TorusGeometry(1.0, 0.1, 6, 8), { r: [0, 0, Math.PI / 8], p: [0, 0, 0.45] }),
          xf(new THREE.TorusGeometry(1.0, 0.1, 6, 8), { r: [0, 0, Math.PI / 8], p: [0, 0, -0.45] }),
          xf(oct(0.6, 0.72, 0.22), { p: [0, 0, 0.52] }),
          xf(new THREE.CylinderGeometry(0.22, 0.22, 0.8, 10), { r: [Math.PI / 2, 0, 0], p: [0, 1.08, 0] }),
          xf(new THREE.CylinderGeometry(0.22, 0.22, 0.8, 10), { r: [Math.PI / 2, 0, 0], p: [0, -1.08, 0] }),
        ]),
      ),
      copper,
    ),
    mesh(geo('t.eye', () => xf(sphere(0.22, 16, 12), { p: [0, 0, 0.6] })), m.eyeRed, false),
    mesh(
      geo('t.lights', () =>
        merge([xf(sphere(0.07, 8, 6), { p: [0, 1.08, 0.42] }), xf(sphere(0.07, 8, 6), { p: [0, -1.08, 0.42] })]),
      ),
      m.eyeRed,
      false,
    ),
  );
  const eg = glowSprite(tex, 0xff2a24, 1.8, 1.4);
  eg.position.set(0, 0, 0.8);
  yaw.add(eg);
  const barrel = new THREE.Group();
  barrel.position.set(0, 0, 0.1);
  barrel.add(
    mesh(
      geo('t.barrel', () =>
        merge([
          xf(tubeX(0.2, 0.16, 1.9), { r: [0, 0, Math.PI] }),
          xf(new THREE.TorusGeometry(0.19, 0.05, 6, 14), { r: [0, Math.PI / 2, 0], p: [-1.85, 0, 0] }),
          xf(new THREE.TorusGeometry(0.21, 0.05, 6, 14), { r: [0, Math.PI / 2, 0], p: [-1.0, 0, 0] }),
        ]),
      ),
      m.gunmetal,
    ),
  );
  yaw.add(barrel);
  return { root, parts: { yaw, barrel }, flasher: new Flasher([steel, copper]) };
}

export function buildMine(m: Mats, tex: THREE.Texture): EnemyModel {
  const core = cloneUW(m.darkSteel);
  const cop = cloneUW(m.copper);
  const root = new THREE.Group();
  const spin = new THREE.Group();
  root.add(spin);
  const spikes = geo('mine.spikes', () => {
    const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(0.58, 0.06, 6, 24)];
    const n = 14;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.39996;
      const dir = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
      const c = new THREE.ConeGeometry(0.085, 0.42, 6);
      c.translate(0, 0.7, 0);
      c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      parts.push(c);
    }
    return merge(parts);
  });
  spin.add(mesh(geo('mine.core', () => sphere(0.56, 20, 14)), core), mesh(spikes, cop));
  const lights = mesh(
    geo('mine.lights', () => merge([0, 1, 2, 3].map((i) => xf(sphere(0.07, 8, 6), { p: [Math.cos(i * 1.57) * 0.52, 0.18, Math.sin(i * 1.57) * 0.52] })))),
    m.eyeRed,
    false,
  );
  spin.add(lights);
  const g = glowSprite(tex, 0xff2a24, 1.0, 2.2);
  root.add(g);
  return { root, parts: { spin, glow: g }, flasher: new Flasher([core, cop]) };
}

// ------------------------------------------------------------ power-up
const ORB_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.8);
  float band = smoothstep(0.85, 1.0, sin(vP.y * 9.0 + uTime * 4.0));
  gl_FragColor = vec4(uColor * (f * 1.2 + band * 0.25 + 0.06), 0.0);
}`;

export interface OrbModel {
  root: THREE.Group;
  ring: THREE.Mesh;
  shellMat: THREE.ShaderMaterial;
}

export function buildOrb(m: Mats, letterTex: THREE.Texture, color: number, glowTex: THREE.Texture): OrbModel {
  const root = new THREE.Group();
  const shellMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: hdr(color, 1.6) }, uTime: { value: 0 } },
    vertexShader: SHIELD_VS,
    fragmentShader: ORB_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  const shell = new THREE.Mesh(geo('orb.shell', () => new THREE.SphereGeometry(0.62, 28, 16)), shellMat);
  const coreMat = cloneUW(m.chrome);
  const core = new THREE.Mesh(geo('orb.core', () => new THREE.IcosahedronGeometry(0.34, 0)), coreMat);
  const ring = new THREE.Mesh(geo('orb.ring', () => new THREE.TorusGeometry(0.82, 0.035, 8, 40)), new THREE.MeshBasicMaterial({ color: hdr(color, 3) }));
  const letter = new THREE.Sprite(new THREE.SpriteMaterial({ map: letterTex, color: hdr(0xffffff, 1.6), depthTest: false, transparent: true }));
  letter.scale.set(0.95, 0.95, 1);
  letter.renderOrder = 10;
  const halo = glowSprite(glowTex, color, 1.4, 2.8);
  root.add(halo, core, shell, ring, letter);
  return { root, ring, shellMat };
}

// ------------------------------------------------------------ boss
export interface BossModel {
  root: THREE.Group;
  head: THREE.Group;
  jaw: THREE.Group;
  segs: THREE.Group[];
  segLen: number[];
  tail: THREE.Group;
  gears: THREE.Object3D[];
  pods: THREE.Group[];
  core: THREE.Group;
  coreMat: THREE.MeshBasicMaterial;
  eyes: THREE.Sprite[];
  mouthMarker: THREE.Object3D;
  mouthGlow: THREE.Sprite;
  hit: { obj: THREE.Object3D; r: number; kind: 'body' | 'core' | 'pod'; pod?: number }[];
  flasher: Flasher;
  plates: THREE.Mesh[];
}

export function buildBoss(m: Mats, tex: THREE.Texture): BossModel {
  const silver = cloneUW(m.silver);
  const gold = cloneUW(m.gold);
  const root = new THREE.Group();
  const hit: BossModel['hit'] = [];
  const marker = (parent: THREE.Object3D, x: number, y: number, r: number, kind: 'body' | 'core' | 'pod' = 'body', pod?: number) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, 0);
    parent.add(o);
    hit.push({ obj: o, r, kind, pod });
    return o;
  };

  // ---------------- head (neck pivot at origin, faces -x)
  const head = new THREE.Group();
  root.add(head);
  const skull: Sec[] = [
    { x: -4.35, w: 0.22, h: 0.18, y: 0.0, n: 2.2 },
    { x: -3.9, w: 0.75, h: 0.55, y: 0.2, n: 2.3 },
    { x: -3.0, w: 1.12, h: 0.92, y: 0.45, n: 2.3 },
    { x: -1.8, w: 1.38, h: 1.18, y: 0.55, n: 2.4 },
    { x: -0.7, w: 1.44, h: 1.28, y: 0.5, n: 2.4 },
    { x: 0.2, w: 1.38, h: 1.28, y: 0.4, n: 2.4 },
  ];
  head.add(mesh(geo('b.skull', () => loft(skull, 32)), silver));
  const brow = (): THREE.BufferGeometry =>
    sym(xf(wing([[-3.6, 0.55], [-2.4, 1.05], [-1.9, 1.02], [-2.6, 0.5]], 0.12), { p: [0, 1.05, 0], r: [-0.35, 0, 0] }));
  head.add(
    mesh(
      geo('b.headGold', () =>
        merge([
          band(skull, -3.05, -2.85, 1.04),
          band(skull, -1.35, -1.15, 1.04),
          band(skull, -0.25, 0.1, 1.05),
          brow(),
          // eye sockets
          sym(xf(new THREE.TorusGeometry(0.36, 0.08, 8, 20), { p: [-2.65, 0.78, 1.0], r: [0, 0.35, 0] })),
          // gill plates
          sym(xf(sphere(1, 18, 12), { s: [0.55, 0.9, 0.12], p: [-0.55, 0.3, 1.42], r: [0, 0.25, 0] })),
        ]),
      ),
      gold,
    ),
  );
  const teeth = (x0: number, x1: number, n: number, y: number, zf: (t: number) => number, up: boolean, len: number) => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const c = new THREE.ConeGeometry(0.075, len * (1 - Math.abs(t - 0.35) * 0.6), 6);
      if (!up) c.rotateX(Math.PI);
      c.translate(0, up ? len * 0.4 : -len * 0.4, 0);
      const x = x0 + (x1 - x0) * t;
      parts.push(xf(c.clone(), { p: [x, y, zf(t)] }), xf(c, { p: [x, y, -zf(t)] }));
    }
    return merge(parts);
  };
  head.add(mesh(geo('b.teethU', () => teeth(-4.05, -1.9, 8, -0.3, (t) => 0.3 + t * 0.62, false, 0.42)), m.ivory));
  // mouth cavity and guns
  head.add(
    mesh(geo('b.mouth', () => xf(sphere(1, 20, 12), { s: [1.9, 0.5, 0.85], p: [-2.3, -0.5, 0] })), m.mouth, false),
    mesh(
      geo('b.guns', () =>
        merge([
          sym(xf(tubeX(0.13, 0.16, 1.2), { p: [-4.25, -0.52, 0.3] })),
          sym(xf(new THREE.TorusGeometry(0.15, 0.05, 6, 14), { r: [0, Math.PI / 2, 0], p: [-4.25, -0.52, 0.3] })),
        ]),
      ),
      m.gunmetal,
    ),
    mesh(geo('b.eyes', () => sym(xf(sphere(0.3, 16, 12), { p: [-2.65, 0.78, 1.02] }))), m.eyeRed, false),
  );
  const eyes: THREE.Sprite[] = [];
  for (const z of [1.2, -1.2]) {
    const e = glowSprite(tex, 0xff2a24, 2.4, 2.4);
    e.position.set(-2.65, 0.78, z);
    head.add(e);
    eyes.push(e);
  }
  const mouthMarker = new THREE.Object3D();
  mouthMarker.position.set(-4.4, -0.52, 0);
  head.add(mouthMarker);
  const mouthGlow = glowSprite(tex, 0xff5020, 3, 2.6);
  mouthGlow.position.copy(mouthMarker.position);
  mouthGlow.visible = false;
  head.add(mouthGlow);
  marker(head, -2.3, 0.45, 1.6);
  marker(head, -3.7, 0.05, 0.8);
  marker(head, -0.6, 0.4, 1.4);

  // jaw
  const jaw = new THREE.Group();
  jaw.position.set(-0.55, -0.5, 0);
  head.add(jaw);
  const jawSecs: Sec[] = [
    { x: -3.65, w: 0.28, h: 0.12, y: -0.12 },
    { x: -3.2, w: 0.72, h: 0.28, y: -0.28 },
    { x: -2.0, w: 1.0, h: 0.4, y: -0.33 },
    { x: -0.8, w: 1.12, h: 0.42, y: -0.24 },
    { x: 0.15, w: 1.0, h: 0.34, y: -0.1 },
  ];
  jaw.add(
    mesh(geo('b.jaw', () => loft(jawSecs, 26)), silver),
    mesh(geo('b.jawGold', () => merge([band(jawSecs, -2.6, -2.4, 1.05), band(jawSecs, -1.1, -0.9, 1.05)])), gold),
    mesh(geo('b.teethL', () => teeth(-3.45, -1.5, 7, 0.02, (t) => 0.25 + t * 0.6, true, 0.36)), m.ivory),
  );
  marker(jaw, -2.0, -0.3, 0.8);

  // ---------------- body segments
  const segLen = [2.2, 2.0, 1.8, 1.6, 1.3];
  const sizes = [
    { w: 1.38, h: 1.28, y: 0.4 },
    { w: 1.3, h: 1.22, y: 0.3 },
    { w: 1.12, h: 1.04, y: 0.2 },
    { w: 0.92, h: 0.84, y: 0.12 },
    { w: 0.7, h: 0.62, y: 0.06 },
    { w: 0.42, h: 0.38, y: 0.0 },
  ];
  const segs: THREE.Group[] = [];
  const plates: THREE.Mesh[] = [];
  for (let k = 0; k < 5; k++) {
    const L = segLen[k];
    const a = sizes[k];
    const b = sizes[k + 1];
    const secs: Sec[] = [
      { x: -0.25, w: a.w * 0.97, h: a.h * 0.97, y: a.y, n: 2.4 },
      { x: L * 0.45, w: (a.w + b.w) * 0.53, h: (a.h + b.h) * 0.53, y: (a.y + b.y) / 2, n: 2.4 },
      { x: L + 0.05, w: b.w * 0.97, h: b.h * 0.97, y: b.y, n: 2.4 },
    ];
    const g = new THREE.Group();
    g.add(mesh(geo(`b.seg${k}`, () => loft(secs, 28)), silver));
    g.add(mesh(geo(`b.segGold${k}`, () => band(secs, 0.02, 0.22, 1.045)), gold));
    // armor plates (blown off when the boss changes phase)
    const pl = mesh(
      geo(`b.plate${k}`, () => sym(xf(sphere(1, 16, 10, ), { s: [L * 0.32, (a.h + b.h) * 0.3, 0.14], p: [L * 0.5, (a.y + b.y) / 2 + 0.25, (a.w + b.w) * 0.5 * 0.98] }))),
      silver,
    );
    g.add(pl);
    plates.push(pl);
    // cyan energy conduits
    g.add(
      mesh(
        geo(`b.conduit${k}`, () =>
          sym(xf(new THREE.BoxGeometry(L * 0.72, 0.07, 0.05), { p: [L * 0.5, (a.y + b.y) / 2 - 0.2, (a.w + b.w) * 0.53 * 1.0] })),
        ),
        m.cyanGlow,
        false,
      ),
    );
    marker(g, L * 0.5, (a.y + b.y) / 2, Math.max(0.55, (a.h + b.h) * 0.5));
    segs.push(g);
    root.add(g);
  }

  // seg0: dorsal fin, pectoral fins + gun pods, glowing core
  const s0 = segs[0];
  s0.add(
    mesh(geo('b.dorsal', () => plate([[0.0, 1.35], [0.5, 2.7], [0.95, 3.2], [1.35, 3.1], [1.7, 2.3], [2.2, 1.25]], 0.14, 0.04)), silver),
    mesh(
      geo('b.dorsalGold', () =>
        merge([
          plate([[0.0, 1.35], [0.5, 2.7], [0.95, 3.2], [0.85, 3.25], [0.4, 2.75], [-0.1, 1.4]], 0.18, 0.03),
          sym(xf(wing([[0.25, 1.05], [0.95, 2.45], [1.55, 2.55], [1.62, 1.05]], 0.1), { p: [0, -0.72, 0], r: [-0.25, 0, 0] })),
        ]),
      ),
      gold,
    ),
    mesh(geo('b.pect', () => sym(xf(wing([[0.35, 1.05], [1.0, 2.3], [1.45, 2.35], [1.5, 1.05]], 0.12), { p: [0, -0.7, 0], r: [-0.25, 0, 0] }))), silver),
  );
  const pods: THREE.Group[] = [];
  [1, -1].forEach((side, i) => {
    const pod = new THREE.Group();
    pod.position.set(0.35, -1.55, 2.0 * side);
    pod.add(
      mesh(geo('b.pod', () => merge([xf(tubeX(0.3, 0.26, 1.3), { p: [-0.65, 0, 0] }), xf(tubeX(0.1, 0.1, 0.7), { p: [-1.3, 0, 0] })])), m.gunmetal),
      mesh(geo('b.podGold', () => merge([xf(new THREE.TorusGeometry(0.31, 0.06, 6, 16), { r: [0, Math.PI / 2, 0], p: [-0.2, 0, 0] }), xf(new THREE.TorusGeometry(0.29, 0.06, 6, 16), { r: [0, Math.PI / 2, 0], p: [0.35, 0, 0] })])), gold),
      mesh(geo('b.podGlow', () => xf(new THREE.CircleGeometry(0.2, 16), { r: [0, Math.PI / 2, 0], p: [0.66, 0, 0] })), m.cyanGlow, false),
    );
    s0.add(pod);
    pods.push(pod);
    marker(pod, -0.2, 0, 0.6, 'pod', i);
  });
  const core = new THREE.Group();
  core.position.set(1.1, -1.25, 0);
  const coreMat = new THREE.MeshBasicMaterial({ color: hdr(0x40e8ff, 4) });
  core.add(
    new THREE.Mesh(geo('b.core', () => sphere(0.55, 24, 16)), coreMat),
    mesh(geo('b.cage', () => merge([new THREE.TorusGeometry(0.62, 0.07, 8, 24), xf(new THREE.TorusGeometry(0.62, 0.07, 8, 24), { r: [Math.PI / 2, 0, 0] })])), gold),
  );
  const cg = glowSprite(tex, 0x40e8ff, 1.8, 2.2);
  core.add(cg);
  s0.add(core);
  marker(core, 0, 0, 0.7, 'core');

  segs[1].add(mesh(geo('b.dorsal2', () => plate([[0.1, 1.15], [0.6, 2.05], [1.15, 2.15], [1.6, 1.0]], 0.12, 0.03)), silver));
  segs[2].add(mesh(geo('b.ventral', () => plate([[0.2, -0.85], [0.75, -1.85], [1.25, -1.75], [1.5, -0.7]], 0.1, 0.03)), gold));

  // tail: lattice fin + gears
  const tail = new THREE.Group();
  tail.position.set(segLen[4], 0, 0);
  segs[4].add(tail);
  const upper: [number, number][] = [[0, 0.1], [1.5, 2.9], [2.25, 3.15], [1.85, 1.3], [1.0, 0.1]];
  const lower: [number, number][] = upper.map(([x, y]) => [x, -y] as [number, number]).reverse();
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => [a, b, c];
  tail.add(
    mesh(
      geo('b.tailfin', () =>
        merge([
          plate(upper, 0.12, 0.03, [tri([0.55, 0.45], [1.35, 2.2], [1.05, 0.45]), tri([1.45, 1.25], [1.95, 2.8], [1.65, 1.2])]),
          plate(lower, 0.12, 0.03, [tri([0.55, -0.45], [1.05, -0.45], [1.35, -2.2]), tri([1.45, -1.25], [1.65, -1.2], [1.95, -2.8])]),
          xf(tubeX(0.3, 0.18, 1.1), { p: [-0.1, 0, 0] }),
        ]),
      ),
      silver,
    ),
    mesh(
      geo('b.tailGold', () =>
        merge([
          xf(new THREE.BoxGeometry(3.4, 0.12, 0.2), { r: [0, 0, Math.atan2(2.9, 1.5)], p: [0.75, 1.5, 0] }),
          xf(new THREE.BoxGeometry(3.4, 0.12, 0.2), { r: [0, 0, -Math.atan2(2.9, 1.5)], p: [0.75, -1.5, 0] }),
        ]),
      ),
      gold,
    ),
  );
  const gearGeo = geo('b.gear', () => {
    const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(0.5, 0.13, 8, 28)];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      parts.push(xf(new THREE.BoxGeometry(0.16, 0.22, 0.2), { r: [0, 0, a], p: [Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0] }));
    }
    parts.push(xf(new THREE.CylinderGeometry(0.16, 0.16, 0.34, 12), { r: [Math.PI / 2, 0, 0] }));
    return merge(parts);
  });
  const gears: THREE.Object3D[] = [];
  for (const z of [0.36, -0.36]) {
    const gm = mesh(gearGeo, gold);
    gm.position.set(0.1, 0, z);
    tail.add(gm);
    gears.push(gm);
  }
  marker(tail, 0.9, 1.2, 0.8);
  marker(tail, 0.9, -1.2, 0.8);

  return { root, head, jaw, segs, segLen, tail, gears, pods, core, coreMat, eyes, mouthMarker, mouthGlow, hit, flasher: new Flasher([silver, gold]), plates };
}
