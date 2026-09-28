// Web Audio engine: decoded buffers, sample-accurate looping music with
// crossfades, panned + throttled sound effects, and a pause "muffle" filter.
import manifest from '../audio/manifest.json';
import { settings } from './Settings';

export type MusicKey = keyof typeof manifest.music;
export type SfxKey = keyof typeof manifest.sfx;

interface MusicEntry {
  file: string;
  loopStart: number;
  loopEnd: number;
  samples: number;
}

interface SfxOpts {
  vol?: number;
  pan?: number;
  rate?: number;
  /** Minimum seconds between plays of this sound. */
  throttle?: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private musicBus: GainNode;
  private musicFilter: BiquadFilterNode;
  private sfxBus: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private lastPlayed = new Map<string, number>();
  private current?: { key: string; src: AudioBufferSourceNode; gain: GainNode };
  private muted = false;
  private duckGain: GainNode;
  private liveVoices = 0;

  constructor() {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master = this.ctx.createGain();
    this.master.connect(comp).connect(this.ctx.destination);

    this.musicFilter = this.ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 22000;
    this.musicFilter.Q.value = 0.5;
    this.duckGain = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(this.duckGain).connect(this.musicFilter).connect(this.master);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);

    this.applyVolumes();
    settings.onChange(() => this.applyVolumes());

    // Browsers (Safari most strictly) only start audio inside a user-gesture handler.
    const unlock = () => {
      if (this.ctx.state !== 'running') void this.ctx.resume();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true });
  }

  get unlocked() {
    return this.ctx.state === 'running';
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  applyVolumes() {
    const s = settings.data;
    const t = this.ctx.currentTime;
    this.musicBus.gain.setTargetAtTime(s.music * 0.8, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.sfx, t, 0.05);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.05);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolumes();
    return this.muted;
  }

  async loadAll(onProgress: (f: number) => void) {
    const jobs: [string, string][] = [];
    for (const [k, v] of Object.entries(manifest.music)) jobs.push([k, (v as MusicEntry).file]);
    for (const [k, v] of Object.entries(manifest.sfx)) jobs.push([k, v as string]);
    let done = 0;
    await Promise.all(
      jobs.map(async ([key, file]) => {
        try {
          const res = await fetch(file);
          const data = await res.arrayBuffer();
          const buf = await this.ctx.decodeAudioData(data);
          this.buffers.set(key, buf);
        } catch (err) {
          console.warn('audio load failed', key, err);
        }
        done++;
        onProgress(done / jobs.length);
      }),
    );
  }

  playMusic(key: MusicKey, { fade = 0.8, loop = true, volume = 1 } = {}) {
    if (this.current?.key === key) return;
    this.stopMusic(fade);
    const buf = this.buffers.get(key);
    if (!buf) return;
    const entry = manifest.music[key] as MusicEntry;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (loop && entry.loopEnd > 0) {
      src.loop = true;
      src.loopStart = entry.loopStart;
      src.loopEnd = Math.min(entry.loopEnd, buf.duration);
    }
    const gain = this.ctx.createGain();
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + Math.max(0.02, fade * 0.5));
    src.connect(gain).connect(this.musicBus);
    src.start(t + 0.01);
    this.current = { key, src, gain };
    src.onended = () => {
      if (this.current?.src === src) this.current = undefined;
    };
  }

  stopMusic(fade = 0.8) {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    const t = this.ctx.currentTime;
    cur.gain.gain.cancelScheduledValues(t);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
    cur.gain.gain.linearRampToValueAtTime(0, t + fade);
    cur.src.stop(t + fade + 0.05);
  }

  /** Muffle music (pause menu) with a lowpass sweep. */
  setMuffled(on: boolean) {
    const t = this.ctx.currentTime;
    this.musicFilter.frequency.cancelScheduledValues(t);
    this.musicFilter.frequency.setTargetAtTime(on ? 650 : 22000, t, on ? 0.08 : 0.15);
  }

  /** Briefly lower the music under a big sound. */
  duck(amount = 0.4, hold = 1.2) {
    const g = this.duckGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(amount, t, 0.05);
    g.setTargetAtTime(1, t + hold, 0.5);
  }

  sfx(key: SfxKey, opts: SfxOpts = {}) {
    if (this.ctx.state !== 'running') return;
    const buf = this.buffers.get(key);
    if (!buf) return;
    const now = this.ctx.currentTime;
    const throttle = opts.throttle ?? 0.03;
    const last = this.lastPlayed.get(key) ?? -1;
    if (now - last < throttle) return;
    if (this.liveVoices > 48) return;
    this.lastPlayed.set(key, now);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = this.ctx.createGain();
    g.gain.value = opts.vol ?? 1;
    let node: AudioNode = src.connect(g);
    if (opts.pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      node = node.connect(p);
    }
    node.connect(this.sfxBus);
    this.liveVoices++;
    src.onended = () => {
      this.liveVoices--;
      src.disconnect();
    };
    src.start(now);
  }
}
