// Loaded (Nano Banana) textures plus procedural canvas textures.
import * as THREE from 'three';
import { mulberry32 } from '../core/math';

export interface TextureSet {
  seabed: THREE.Texture;
  rock: THREE.Texture;
  rust: THREE.Texture;
  backdrop: THREE.Texture;
  panel: THREE.Texture;
  panelFine: THREE.Texture;
  glow: THREE.Texture;
}

export async function loadTextures(renderer: THREE.WebGLRenderer, onProgress: (f: number) => void): Promise<TextureSet> {
  const loader = new THREE.TextureLoader();
  const files = ['seabed', 'rock', 'rust', 'backdrop'] as const;
  let done = 0;
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const loaded = await Promise.all(
    files.map(
      (f) =>
        new Promise<THREE.Texture>((resolve) => {
          loader.load(
            `textures/${f}.jpg`,
            (t) => {
              t.colorSpace = THREE.SRGBColorSpace;
              t.wrapS = t.wrapT = f === 'backdrop' ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
              t.anisotropy = maxAniso;
              done++;
              onProgress(done / files.length);
              resolve(t);
            },
            undefined,
            () => {
              // Keep going with a flat texture if one image fails.
              done++;
              onProgress(done / files.length);
              resolve(new THREE.Texture());
            },
          );
        }),
    ),
  );
  const panel = makePanelTexture(1024, 7, 5);
  panel.anisotropy = maxAniso;
  const panelFine = makePanelTexture(512, 11, 6);
  panelFine.anisotropy = maxAniso;
  return {
    seabed: loaded[0],
    rock: loaded[1],
    rust: loaded[2],
    backdrop: loaded[3],
    panel,
    panelFine,
    glow: makeGlowTexture(),
  };
}

/**
 * Tileable sci-fi hull plating: recursively split panels with beveled seams,
 * rivets and vent grilles. Grey values drive color detail, bump and roughness.
 */
export function makePanelTexture(size: number, seed: number, depth: number): THREE.CanvasTexture {
  const rnd = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c4c4c4';
  g.fillRect(0, 0, size, size);

  // Soft large-scale variation.
  for (let i = 0; i < 90; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = (0.05 + rnd() * 0.2) * size;
    const v = 180 + Math.floor(rnd() * 50);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${v},${v},${v},0.25)`);
    grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = grd;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      g.save();
      g.translate(ox, oy);
      g.fillRect(x - r, y - r, r * 2, r * 2);
      g.restore();
    }
  }

  const rects: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, h: number, d: number) => {
    if (d <= 0 || (w < size / 14 && h < size / 14) || (d < depth - 1 && rnd() < 0.18)) {
      rects.push([x, y, w, h]);
      return;
    }
    if (w > h ? rnd() < 0.8 : rnd() < 0.2) {
      const k = Math.round((0.3 + rnd() * 0.4) * w);
      split(x, y, k, h, d - 1);
      split(x + k, y, w - k, h, d - 1);
    } else {
      const k = Math.round((0.3 + rnd() * 0.4) * h);
      split(x, y, w, k, d - 1);
      split(x, y + k, w, h - k, d - 1);
    }
  };
  split(0, 0, size, size, depth);

  const lw = Math.max(2, size / 256);
  for (const [x, y, w, h] of rects) {
    const tone = 170 + Math.floor(rnd() * 60);
    g.fillStyle = `rgb(${tone},${tone},${tone})`;
    g.fillRect(x + lw, y + lw, w - lw * 2, h - lw * 2);
    // bevel: light top/left, dark bottom/right
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(x + lw, y + lw, w - lw * 2, lw);
    g.fillRect(x + lw, y + lw, lw, h - lw * 2);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(x + lw, y + h - lw * 2, w - lw * 2, lw);
    g.fillRect(x + w - lw * 2, y + lw, lw, h - lw * 2);
    // seams
    g.fillStyle = '#4a4a4a';
    g.fillRect(x, y, w, lw);
    g.fillRect(x, y, lw, h);
    // rivets in corners
    if (w > size / 16 && h > size / 16) {
      const rr = lw * 1.3;
      for (const [px, py] of [
        [x + lw * 4, y + lw * 4],
        [x + w - lw * 4, y + lw * 4],
        [x + lw * 4, y + h - lw * 4],
        [x + w - lw * 4, y + h - lw * 4],
      ]) {
        g.fillStyle = '#707070';
        g.beginPath();
        g.arc(px, py, rr, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.beginPath();
        g.arc(px - rr * 0.3, py - rr * 0.3, rr * 0.45, 0, Math.PI * 2);
        g.fill();
      }
    }
    // vents
    if (rnd() < 0.14 && w > size / 10 && h > size / 12) {
      const n = 4 + Math.floor(rnd() * 5);
      const vx = x + w * 0.2;
      const vw = w * 0.6;
      for (let i = 0; i < n; i++) {
        const vy = y + h * 0.25 + (i * h * 0.5) / n;
        g.fillStyle = '#383838';
        g.fillRect(vx, vy, vw, lw * 1.5);
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.fillRect(vx, vy + lw * 1.5, vw, lw * 0.6);
      }
    }
  }
  // fine grain
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeGlowTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.15)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

/** Letter badge used inside power-up orbs. */
export function makeLetterTexture(letter: string, color: string): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.font = '900 88px Orbitron, "Chakra Petch", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 18;
  g.fillStyle = '#ffffff';
  g.fillText(letter, s / 2, s / 2 + 4);
  g.shadowBlur = 0;
  g.fillText(letter, s / 2, s / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
