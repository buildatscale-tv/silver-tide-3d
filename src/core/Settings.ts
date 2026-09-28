import { STORAGE_KEYS } from '../config';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface SettingsData {
  quality: Quality;
  music: number; // 0..1
  sfx: number; // 0..1
  shake: boolean;
  showFps: boolean;
  autoFire: boolean;
}

const DEFAULTS: SettingsData = {
  quality: 'high',
  music: 0.7,
  sfx: 0.8,
  shake: true,
  showFps: false,
  autoFire: false,
};

function load(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SettingsData>) };
  } catch {
    // Storage can be unavailable (private mode); fall back to defaults.
  }
  return { ...DEFAULTS };
}

type Listener = (s: SettingsData) => void;

class SettingsStore {
  data: SettingsData = load();
  private listeners: Listener[] = [];

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    this.data[key] = value;
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(this.data));
    } catch {
      // ignore
    }
    for (const l of this.listeners) l(this.data);
  }

  onChange(l: Listener) {
    this.listeners.push(l);
  }
}

export const settings = new SettingsStore();

export function loadHiScore(): number {
  try {
    return Number(localStorage.getItem(STORAGE_KEYS.hi) || '0') || 0;
  } catch {
    return 0;
  }
}

export function saveHiScore(v: number) {
  try {
    localStorage.setItem(STORAGE_KEYS.hi, String(Math.floor(v)));
  } catch {
    // ignore
  }
}
