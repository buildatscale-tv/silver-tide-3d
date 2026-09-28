// Procedural modeling helpers: lofted hulls, extruded fins, merging.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** One cross-section of a lofted hull. The hull runs along +x. */
export interface Sec {
  x: number;
  /** half-width (z) */
  w: number;
  /** half-height (y) */
  h: number;
  y?: number;
  z?: number;
  /** superellipse exponent: 2 = ellipse, higher = boxier */
  n?: number;
}

/**
 * Loft a smooth closed hull through cross-sections (superellipses in the YZ
 * plane). Returns non-indexed geometry with smooth sides and flat end caps.
 */
export function loft(secs: Sec[], seg = 20, caps = true): THREE.BufferGeometry {
  const rings = secs.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const x0 = secs[0].x;
  const x1 = secs[rings - 1].x;
  const ringPts: THREE.Vector3[][] = [];
  for (let r = 0; r < rings; r++) {
    const s = secs[r];
    const e = 2 / (s.n ?? 2);
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const py = (s.y ?? 0) + s.h * Math.sign(c) * Math.pow(Math.abs(c), e);
      const pz = (s.z ?? 0) + s.w * Math.sign(sn) * Math.pow(Math.abs(sn), e);
      pos.push(s.x, py, pz);
      uv.push((s.x - x0) / (x1 - x0 || 1), k / seg);
      pts.push(new THREE.Vector3(s.x, py, pz));
    }
    ringPts.push(pts);
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let k = 0; k < seg; k++) {
      const a = r * (seg + 1) + k;
      const b = a + seg + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const tube = new THREE.BufferGeometry();
  tube.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tube.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  tube.setIndex(idx);
  tube.computeVertexNormals();
  // Weld normals across the UV seam.
  const n = tube.getAttribute('normal') as THREE.BufferAttribute;
  for (let r = 0; r < rings; r++) {
    const a = r * (seg + 1);
    const b = a + seg;
    const nx = n.getX(a) + n.getX(b);
    const ny = n.getY(a) + n.getY(b);
    const nz = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(a, nx / l, ny / l, nz / l);
    n.setXYZ(b, nx / l, ny / l, nz / l);
  }
  const parts = [tube.toNonIndexed()];
  if (caps) {
    const cap = (ring: THREE.Vector3[], s: Sec, flip: boolean) => {
      const cp: number[] = [];
      const cu: number[] = [];
      const cx = s.x;
      const cy = s.y ?? 0;
      const cz = s.z ?? 0;
      for (let k = 0; k < seg; k++) {
        const p = ring[k];
        const q = ring[k + 1];
        if (flip) cp.push(cx, cy, cz, p.x, p.y, p.z, q.x, q.y, q.z);
        else cp.push(cx, cy, cz, q.x, q.y, q.z, p.x, p.y, p.z);
        cu.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
      g.computeVertexNormals();
      return g;
    };
    if (secs[0].w > 0.001 || secs[0].h > 0.001) parts.push(cap(ringPts[0], secs[0], false));
    const last = secs[rings - 1];
    if (last.w > 0.001 || last.h > 0.001) parts.push(cap(ringPts[rings - 1], last, true));
  }
  return merge(parts);
}

/** Extrude a 2D outline (in the XY plane) to a thin plate centered on z = 0. */
export function plate(points: [number, number][], thickness: number, bevel = 0.02, holes: [number, number][][] = []): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 6,
  });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/** Same as plate() but lying flat in the XZ plane (points are x, z). */
export function wing(points: [number, number][], thickness: number, bevel = 0.02): THREE.BufferGeometry {
  const g = plate(points, thickness, bevel);
  // rotateX(+90deg) maps (x, y, z) -> (x, -z, y): outline y becomes world z,
  // and the extrusion depth becomes the (thin) y thickness.
  g.rotateX(Math.PI / 2);
  return g;
}

export interface XF {
  p?: [number, number, number];
  r?: [number, number, number];
  s?: [number, number, number] | number;
}

/** Transform a geometry in place (scale, then rotate XYZ, then translate). */
export function xf(g: THREE.BufferGeometry, t: XF): THREE.BufferGeometry {
  if (t.s !== undefined) {
    if (typeof t.s === 'number') g.scale(t.s, t.s, t.s);
    else g.scale(...t.s);
  }
  if (t.r) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...t.r));
    g.applyMatrix4(m);
  }
  if (t.p) g.translate(...t.p);
  return g;
}

/** Mirror a geometry across z = 0 (for left/right symmetric parts). */
export function mirrorZ(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone();
  m.scale(1, 1, -1);
  // Flip winding so normals stay outward after the mirror.
  const src = m.index ? m.toNonIndexed() : m;
  const p = src.getAttribute('position') as THREE.BufferAttribute;
  const u = src.getAttribute('uv') as THREE.BufferAttribute | undefined;
  for (let i = 0; i < p.count; i += 3) {
    const tx = p.getX(i + 1), ty = p.getY(i + 1), tz = p.getZ(i + 1);
    p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    p.setXYZ(i + 2, tx, ty, tz);
    if (u) {
      const ux = u.getX(i + 1), uy = u.getY(i + 1);
      u.setXY(i + 1, u.getX(i + 2), u.getY(i + 2));
      u.setXY(i + 2, ux, uy);
    }
  }
  const nAttr = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nAttr) {
    for (let i = 0; i < nAttr.count; i += 3) {
      const tx = nAttr.getX(i + 1), ty = nAttr.getY(i + 1), tz = nAttr.getZ(i + 1);
      nAttr.setXYZ(i + 1, nAttr.getX(i + 2), nAttr.getY(i + 2), nAttr.getZ(i + 2));
      nAttr.setXYZ(i + 2, tx, ty, tz);
    }
  }
  return src;
}

/** Geometry plus its mirror across z = 0. */
export function sym(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return merge([g, mirrorZ(g)]);
}

/** Merge geometries of mixed kinds (indexed or not) into one non-indexed geometry. */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geos.map((g) => {
    let q = g.index ? g.toNonIndexed() : g;
    if (!q.getAttribute('normal')) q.computeVertexNormals();
    if (!q.getAttribute('uv')) {
      q = q.clone();
      q.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(q.getAttribute('position').count * 2), 2));
    }
    for (const name of Object.keys(q.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') q.deleteAttribute(name);
    }
    q.morphAttributes = {};
    return q;
  });
  const out = mergeGeometries(prepared, false);
  if (!out) throw new Error('mergeGeometries failed');
  out.computeBoundingSphere();
  return out;
}

export const cyl = (rTop: number, rBot: number, h: number, seg = 16, open = false) =>
  new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);

/** Cylinder lying along +x, from x = 0 to x = len. */
export function tubeX(r0: number, r1: number, len: number, seg = 14): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  g.rotateZ(-Math.PI / 2);
  g.translate(len / 2, 0, 0);
  return g;
}

export const sphere = (r: number, ws = 16, hs = 12) => new THREE.SphereGeometry(r, ws, hs);

/** Mesh helper that enables shadows. */
export function mesh(g: THREE.BufferGeometry, m: THREE.Material, cast = true): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.castShadow = cast;
  o.receiveShadow = false;
  return o;
}
