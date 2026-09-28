// Global tuning for Silver Tide 3D.
//
// World units: the play plane is z = 0, x grows to the right, y grows up.
// The 2D original ran at 960x540 px; 1 world unit = 30 px, so its tuning maps
// over with PX() for distances and speeds.

export const PX = (px: number) => px / 30;

// Visible play field (16:9). The camera always fits this rectangle.
export const FIELD = { halfW: 16, halfH: 9 };

// Player movement bounds (keeps the ship clear of the HUD bars).
export const BOUNDS = { minX: -15.0, maxX: 15.0, minY: -7.7, maxY: 7.7 };

export const SPAWN_X = 18.5;
export const DESPAWN_X = -19.5;

export const PLAYER = {
  speed: PX(340),
  maxWeapon: 5,
  startLives: 3,
  startBombs: 2,
  fireBase: 0.19, // seconds between volleys at weapon level 1
  invulnSpawn: 2.0,
  bulletSpeed: PX(780),
  hitRx: 0.85,
  hitRy: 0.32,
};

// Score thresholds that award an extra life.
export const EXTENDS = [60000, 160000, 320000];

export const STAGE = {
  zoneB: 27, // seconds: zone changes
  zoneC: 55,
  warningAt: 80,
  bossAt: 84,
  scrollSpeed: 5.2, // world units / second
};

export const STORAGE_KEYS = {
  hi: 'silvertide3d_hi',
  settings: 'silvertide3d_settings',
};

export const COLORS = {
  cyan: '#6fe9ff',
  gold: '#ffd166',
  red: '#ff4d5e',
  green: '#54f27a',
  blue: '#7fb2ff',
};
