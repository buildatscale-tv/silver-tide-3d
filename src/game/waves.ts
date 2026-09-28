// Enemy archetypes and the Stage 1 timeline (ported from the 2D original and
// extended with depth fly-ins, mines and a third zone).
import { PX } from '../config';

export type EnemyKind = 'drone' | 'fish' | 'manta' | 'turret' | 'mine';
export type Move = 'straight' | 'sine' | 'dive' | 'swoop' | 'hover' | 'drift';
export type Fire = 'none' | 'aimed' | 'straight' | 'spread';
export type Drop = 'none' | 'maybe' | 'always';

export interface EnemyDef {
  kind: EnemyKind;
  hp: number;
  score: number;
  speed: number;
  move: Move;
  amp?: number;
  freq?: number;
  fireEvery?: number;
  fire?: Fire;
  bulletSpeed?: number;
  radius: number;
}

export const DEFS: Record<string, EnemyDef> = {
  drone: { kind: 'drone', hp: 2, score: 100, speed: PX(175), move: 'straight', radius: 0.8 },
  droneSine: { kind: 'drone', hp: 2, score: 120, speed: PX(150), move: 'sine', amp: PX(55), freq: 2.6, radius: 0.8 },
  fish: { kind: 'fish', hp: 3, score: 160, speed: PX(120), move: 'sine', amp: PX(70), freq: 2.0, fireEvery: 1.7, fire: 'aimed', bulletSpeed: PX(205), radius: 0.85 },
  fishDive: { kind: 'fish', hp: 3, score: 170, speed: PX(150), move: 'dive', amp: PX(150), freq: 1.4, fireEvery: 1.9, fire: 'aimed', bulletSpeed: PX(210), radius: 0.85 },
  turret: { kind: 'turret', hp: 9, score: 380, speed: PX(80), move: 'hover', amp: PX(16), freq: 1.4, fireEvery: 1.25, fire: 'spread', bulletSpeed: PX(200), radius: 1.2 },
  manta: { kind: 'manta', hp: 4, score: 230, speed: PX(150), move: 'swoop', amp: PX(95), freq: 1.7, fireEvery: 2.3, fire: 'aimed', bulletSpeed: PX(195), radius: 1.05 },
  mine: { kind: 'mine', hp: 5, score: 200, speed: 2.1, move: 'drift', amp: 0.7, freq: 1.3, radius: 0.9 },
};

export interface WaveEvent {
  t: number; // seconds from stage start
  def: string;
  y: number;
  count?: number;
  gap?: number; // seconds between members of a train
  drop?: Drop;
  /** fly in from the background instead of from the right edge */
  depth?: boolean;
}

const y = (px: number) => (270 - px) / 30;

export const STAGE1: WaveEvent[] = [
  // ---- Zone α: Twilight Shelf
  { t: 1.2, def: 'drone', y: y(150), count: 4, gap: 0.32 },
  { t: 1.4, def: 'drone', y: y(390), count: 4, gap: 0.32 },
  { t: 4.2, def: 'droneSine', y: y(220), count: 6, gap: 0.3 },
  { t: 7.0, def: 'fish', y: y(150) },
  { t: 7.0, def: 'fish', y: y(270) },
  { t: 7.0, def: 'fish', y: y(390) },
  { t: 10.5, def: 'manta', y: y(120), count: 2, gap: 0.7 },
  { t: 12.5, def: 'turret', y: y(150), drop: 'always' },
  { t: 14.0, def: 'droneSine', y: y(320), count: 6, gap: 0.26 },
  { t: 16.5, def: 'drone', y: 3, count: 5, gap: 0.25, depth: true },
  { t: 18.0, def: 'fish', y: y(130), count: 4, gap: 0.52, drop: 'maybe' },
  { t: 20.5, def: 'mine', y: 2.5 },
  { t: 21.0, def: 'mine', y: -3.5 },
  { t: 22.0, def: 'turret', y: y(120) },
  { t: 22.0, def: 'turret', y: y(410), drop: 'always' },
  { t: 24.5, def: 'drone', y: -2, count: 5, gap: 0.25, depth: true },
  { t: 26.0, def: 'manta', y: y(100), count: 3, gap: 0.56 },

  // ---- Zone β: Drowned Foundry
  { t: 28.5, def: 'drone', y: y(140), count: 6, gap: 0.2 },
  { t: 28.7, def: 'drone', y: y(360), count: 6, gap: 0.2 },
  { t: 32.5, def: 'fish', y: y(180), count: 4, gap: 0.48, drop: 'always' },
  { t: 35.0, def: 'mine', y: 4.5 },
  { t: 35.4, def: 'mine', y: 0 },
  { t: 35.8, def: 'mine', y: -4.5 },
  { t: 36.5, def: 'turret', y: y(270), drop: 'always' },
  { t: 38.0, def: 'fishDive', y: y(80), count: 4, gap: 0.42 },
  { t: 40.0, def: 'manta', y: y(130), count: 2, gap: 0.5, depth: true },
  { t: 42.0, def: 'droneSine', y: y(300), count: 5, gap: 0.24 },
  { t: 42.2, def: 'manta', y: y(120), count: 2, gap: 0.5 },
  { t: 46.0, def: 'fish', y: y(150), count: 5, gap: 0.36, drop: 'maybe' },
  { t: 49.0, def: 'turret', y: y(140) },
  { t: 49.2, def: 'turret', y: y(400) },
  { t: 49.5, def: 'drone', y: y(270), count: 6, gap: 0.22 },
  { t: 52.5, def: 'drone', y: 4, count: 5, gap: 0.22, depth: true },
  { t: 52.7, def: 'drone', y: -4, count: 5, gap: 0.22, depth: true, drop: 'always' },

  // ---- Zone γ: Abyssal Trench
  { t: 55.5, def: 'manta', y: y(110), count: 4, gap: 0.42, drop: 'always' },
  { t: 58.5, def: 'fishDive', y: y(90), count: 5, gap: 0.34 },
  { t: 58.7, def: 'droneSine', y: y(330), count: 6, gap: 0.24 },
  { t: 62.0, def: 'mine', y: 5 },
  { t: 62.3, def: 'mine', y: 1.5 },
  { t: 62.6, def: 'mine', y: -2 },
  { t: 62.9, def: 'mine', y: -5.5 },
  { t: 63.5, def: 'drone', y: y(130), count: 8, gap: 0.15 },
  { t: 63.7, def: 'drone', y: y(380), count: 8, gap: 0.15 },
  { t: 64.0, def: 'turret', y: y(260), drop: 'always' },
  { t: 67.5, def: 'manta', y: 3, count: 3, gap: 0.5, depth: true },
  { t: 69.0, def: 'fish', y: 5, count: 3, gap: 0.4 },
  { t: 69.2, def: 'fish', y: -5, count: 3, gap: 0.4, drop: 'maybe' },
  { t: 71.5, def: 'turret', y: 4.5 },
  { t: 71.7, def: 'turret', y: -4.5, drop: 'always' },
  { t: 73.5, def: 'droneSine', y: 0, count: 8, gap: 0.2 },
  { t: 75.5, def: 'fishDive', y: 6, count: 4, gap: 0.3, drop: 'maybe' },
  { t: 77.0, def: 'drone', y: 1, count: 6, gap: 0.2, depth: true },
];
