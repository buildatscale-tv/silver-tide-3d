// Shared material library + the underwater environment map.
import * as THREE from 'three';
import { underwater } from './underwater';
import type { TextureSet } from './textures';

export type Mats = ReturnType<typeof createMaterials>;

/** HDR emissive color for MeshBasicMaterial glows (values > 1 drive bloom). */
export const hdr = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

export function createMaterials(tex: TextureSet) {
  const panel = tex.panel;
  const fine = tex.panelFine;
  const std = (p: THREE.MeshStandardMaterialParameters, o = {}) => underwater(new THREE.MeshStandardMaterial(p), o);
  const phys = (p: THREE.MeshPhysicalMaterialParameters, o = {}) => underwater(new THREE.MeshPhysicalMaterial(p), o);
  const glow = (hex: number, k: number) => new THREE.MeshBasicMaterial({ color: hdr(hex, k), fog: false });

  const panelMap = (t: THREE.Texture, rx: number, ry: number) => {
    const c = t.clone();
    c.repeat.set(rx, ry);
    c.needsUpdate = true;
    return c;
  };
  const hullMap = panelMap(panel, 2, 1);
  const fineMap = panelMap(fine, 3, 2);

  return {
    // --- player
    chrome: phys({ color: 0xaab5c2, metalness: 0.88, roughness: 0.32, map: hullMap, bumpMap: hullMap, bumpScale: 0.9, clearcoat: 0.6, clearcoatRoughness: 0.18 }),
    playerBlue: phys({ color: 0x1a4fe0, metalness: 0.45, roughness: 0.32, map: fineMap, bumpMap: fineMap, bumpScale: 0.5, clearcoat: 1, clearcoatRoughness: 0.1 }),
    canopy: phys({ color: 0xff8a2a, emissive: 0xff5200, emissiveIntensity: 0.45, metalness: 0.15, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03 }),
    gunmetal: std({ color: 0x353b46, metalness: 0.85, roughness: 0.42, map: fineMap, bumpMap: fineMap, bumpScale: 0.6 }),
    engineCyan: glow(0x66e0ff, 5),
    engineBlue: glow(0x3a7bff, 3),

    // --- shared enemy palette
    crimson: std({ color: 0xa11c2c, metalness: 0.65, roughness: 0.35, map: fineMap, bumpMap: fineMap, bumpScale: 0.6 }),
    darkSteel: std({ color: 0x252a33, metalness: 0.8, roughness: 0.45, map: hullMap, bumpMap: hullMap, bumpScale: 0.6 }),
    teal: std({ color: 0x1d8f96, metalness: 0.75, roughness: 0.3, map: hullMap, bumpMap: hullMap, bumpScale: 0.8 }),
    bronze: std({ color: 0xb4733a, metalness: 0.9, roughness: 0.33, map: fineMap, bumpMap: fineMap, bumpScale: 0.5 }),
    ivory: std({ color: 0xe8e3d4, metalness: 0.4, roughness: 0.3 }),
    purple: std({ color: 0x6c4ccc, metalness: 0.75, roughness: 0.3, map: hullMap, bumpMap: hullMap, bumpScale: 0.7 }),
    lilac: std({ color: 0xb7a4f0, metalness: 0.8, roughness: 0.28 }),
    steel: std({ color: 0x7d8896, metalness: 0.85, roughness: 0.38, map: hullMap, bumpMap: hullMap, bumpScale: 0.8 }),
    copper: std({ color: 0xc0672e, metalness: 0.9, roughness: 0.32, map: fineMap, bumpMap: fineMap, bumpScale: 0.5 }),
    gold: phys({ color: 0xd9a441, metalness: 1, roughness: 0.24, map: fineMap, bumpMap: fineMap, bumpScale: 0.4, clearcoat: 0.4 }),
    silver: phys({ color: 0xbfc8d2, metalness: 0.95, roughness: 0.3, map: hullMap, bumpMap: hullMap, bumpScale: 1.0, clearcoat: 0.3 }),
    mouth: std({ color: 0x220806, emissive: 0xff3010, emissiveIntensity: 0.4, metalness: 0.3, roughness: 0.7 }),

    eyeYellow: glow(0xffd23a, 6),
    eyeOrange: glow(0xff7a1a, 6),
    eyeRed: glow(0xff2a24, 7),
    magenta: glow(0xff3fd2, 4),
    cyanGlow: glow(0x40e8ff, 4.5),
    amberGlow: glow(0xffa030, 4),

    // --- environment
    rock: std({ color: 0x8a939b, map: panelMap(tex.rock, 1, 1), bumpMap: panelMap(tex.rock, 1, 1), bumpScale: 2.5, roughness: 0.92, metalness: 0.05 }),
    rust: std({ color: 0xb8b0a8, map: panelMap(tex.rust, 1, 1), bumpMap: panelMap(tex.rust, 1, 1), bumpScale: 1.6, roughness: 0.78, metalness: 0.45 }),
    ruinMetal: std({ color: 0x5f6c78, map: panelMap(tex.rust, 2, 2), bumpMap: hullMap, bumpScale: 1, roughness: 0.6, metalness: 0.7 }),
    debris: std({ color: 0x9aa4ae, metalness: 0.9, roughness: 0.35, map: fineMap }),
  };
}

/**
 * Environment map for reflections: a gradient water "sky" with a bright
 * surface, plus a few light panels so chrome picks up crisp highlights.
 */
export function createEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vDir;
        void main(){
          float y = vDir.y;
          vec3 deep = vec3(0.004, 0.02, 0.035);
          vec3 mid = vec3(0.05, 0.22, 0.30);
          vec3 top = vec3(0.55, 0.95, 1.1);
          vec3 c = y < 0.0 ? mix(mid, deep, pow(-y, 0.6)) : mix(mid, top, pow(y, 1.6));
          c += vec3(1.6, 2.0, 2.2) * pow(max(y, 0.0), 24.0);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(sky);
  const panel = (w: number, h: number, pos: [number, number, number], k: number, color = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: hdr(color, k), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel(30, 4, [0, 30, 10], 3, 0xcff4ff);
  panel(4, 26, [-32, 8, -12], 1.6, 0x9fe6ff);
  panel(18, 3, [26, 14, 22], 2.2, 0xffffff);
  panel(10, 10, [10, -30, -20], 0.5, 0x2a8cff);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.015);
  pmrem.dispose();
  return rt.texture;
}
