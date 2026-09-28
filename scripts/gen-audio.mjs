// Silver Tide 3D: offline music and sound-effect synthesizer.
//
// Renders stereo 44.1 kHz audio with band-limited (polyBLEP) oscillators,
// TPT state-variable filters, FM voices, synthesized drums, Freeverb, ping-pong
// delay, sidechain pumping and a two-pass lookahead limiter. Each track is
// written as WAV and encoded to MP3 with LAME.
//
// Music loops seamlessly: the reverb/delay tail that rings past the loop end
// is folded back onto the loop start, and loop points go to
// src/audio/manifest.json so the game can loop sample-accurately.
//
// Run: npm run gen:audio   (needs `lame` on PATH, e.g. `brew install lame`)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.audio-build');
const OUT = path.join(ROOT, 'public', 'audio');
const MANIFEST = path.join(ROOT, 'src', 'audio', 'manifest.json');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });

const SR = 44100;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- utilities
let seedState = 0x2f6b1d3a;
function rand() {
  let x = seedState;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  seedState = x >>> 0;
  return seedState / 4294967296;
}
const noise = () => rand() * 2 - 1;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const dbToGain = (db) => Math.pow(10, db / 20);

const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
function nm(name) {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error('bad note ' + name);
  return PC[m[1]] + (parseInt(m[2], 10) + 1) * 12;
}

class Stereo {
  constructor(sec) {
    this.n = Math.ceil(sec * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }
  get dur() {
    return this.n / SR;
  }
}

function panGains(p) {
  const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

// ---------------------------------------------------------------- oscillators
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

class Osc {
  constructor(type = 'saw', duty = 0.5, phase = rand()) {
    this.type = type;
    this.duty = duty;
    this.p = phase;
  }
  tick(f) {
    const dt = Math.min(0.49, Math.abs(f) / SR);
    const t = this.p;
    let v;
    switch (this.type) {
      case 'saw':
        v = 2 * t - 1 - blep(t, dt);
        break;
      case 'square':
        v = (t < this.duty ? 1 : -1) + blep(t, dt) - blep((t - this.duty + 1) % 1, dt);
        break;
      case 'tri':
        v = 4 * Math.abs(t - 0.5) - 1;
        break;
      default:
        v = Math.sin(TAU * t);
    }
    this.p = t + dt;
    if (this.p >= 1) this.p -= 1;
    return v;
  }
}

// Zavalishin TPT state-variable filter: stable under fast modulation.
class SVF {
  constructor() {
    this.s1 = 0;
    this.s2 = 0;
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
  }
  run(x, fc, q = 0.707) {
    const g = Math.tan((Math.PI * clamp(fc, 12, SR * 0.47)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.s2;
    const v1 = a1 * this.s1 + a2 * v3;
    const v2 = this.s2 + a2 * this.s1 + a3 * v3;
    this.s1 = 2 * v1 - this.s1;
    this.s2 = 2 * v2 - this.s2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - k * v1 - v2;
    return v2;
  }
}

// ADSR with exponential decay and a squared release.
function env(t, gate, a, d, s, r) {
  a = Math.max(a, 0.0005);
  const pre = (tt) => (tt < a ? tt / a : s + (1 - s) * Math.exp((-(tt - a) * 5) / Math.max(d, 0.001)));
  if (t < gate) return pre(t);
  const rt = t - gate;
  if (rt >= r) return 0;
  const k = 1 - rt / r;
  return pre(gate) * k * k;
}

// ---------------------------------------------------------------- instruments
// Subtractive voice: stack of oscillators -> per-channel filter -> amp env.
function voice(out, t0, dur, midi, vel, P) {
  const {
    oscs = [{ type: 'saw' }],
    a = 0.005, d = 0.2, s = 0.7, r = 0.2,
    cutoff = 4000, fenv = 0, fa = 0.003, fd = 0.25, fs = 0, fr = 0.2, q = 0.8, keytrack = 0,
    vib = 0, vibRate = 5.5, vibDelay = 0.25,
    glide = 0, from = null, pan = 0, drive = 0, gain = 0.3, pitchEnv = 0, pitchDecay = 0.05,
  } = P;
  const f0 = mtof(midi);
  const ffrom = from != null ? mtof(from) : f0;
  const start = Math.floor(t0 * SR);
  const len = Math.floor((dur + r) * SR);
  const O = oscs.map((o) => ({
    osc: new Osc(o.type || 'saw', o.duty ?? 0.5),
    mul: Math.pow(2, (o.detune || 0) / 1200 + (o.oct || 0)),
    g: o.gain ?? 1,
    pg: panGains((o.pan ?? 0) + pan),
  }));
  const fL = new SVF();
  const fR = new SVF();
  const kt = keytrack ? Math.pow(f0 / 261.63, keytrack) : 1;
  const dn = drive ? Math.tanh(drive) : 1;
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    if (idx < 0) continue;
    const t = i / SR;
    let f = glide > 0 ? f0 + (ffrom - f0) * Math.exp(-t / glide) : f0;
    if (pitchEnv) f *= Math.pow(2, (pitchEnv * Math.exp(-t / pitchDecay)) / 12);
    if (vib) {
      const vd = clamp((t - vibDelay) / 0.3, 0, 1);
      f *= Math.pow(2, (vib * vd * Math.sin(TAU * vibRate * t)) / 1200);
    }
    let l = 0;
    let rr = 0;
    for (let k = 0; k < O.length; k++) {
      const o = O[k];
      const v = o.osc.tick(f * o.mul) * o.g;
      l += v * o.pg[0];
      rr += v * o.pg[1];
    }
    const e = env(t, dur, a, d, s, r);
    if (e <= 0 && t > dur) break;
    const fe = fenv ? env(t, dur, fa, fd, fs, fr) : 0;
    const fc = cutoff * kt * Math.pow(2, fenv * fe);
    l = fL.run(l, fc, q);
    rr = fR.run(rr, fc, q);
    if (drive) {
      l = Math.tanh(l * drive) / dn;
      rr = Math.tanh(rr * drive) / dn;
    }
    const g = e * vel * gain;
    out.L[idx] += l * g;
    out.R[idx] += rr * g;
  }
}

// Two-operator FM voice (bells, electric piano, metallic hits).
function fm(out, t0, dur, midi, vel, P) {
  const { ratio = 3.5, index = 3, idxDecay = 0.4, a = 0.002, d = 1.2, s = 0, r = 0.4, pan = 0, gain = 0.25, fb = 0, detune = 0 } = P;
  const fc = mtof(midi) * Math.pow(2, detune / 1200);
  const fmod = fc * ratio;
  const start = Math.floor(t0 * SR);
  const len = Math.floor((dur + r) * SR);
  const [pl, pr] = panGains(pan);
  let pc = rand();
  let pm = rand();
  let last = 0;
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const t = i / SR;
    const e = env(t, dur, a, d, s, r);
    if (e <= 0 && t > dur) break;
    const I = index * Math.exp(-t / idxDecay);
    const m = Math.sin(TAU * pm + fb * last);
    last = m;
    const v = Math.sin(TAU * pc + I * m) * e * vel * gain;
    pc += fc / SR;
    pm += fmod / SR;
    if (pc > 1) pc -= 1;
    if (pm > 1) pm -= 1;
    out.L[idx] += v * pl;
    out.R[idx] += v * pr;
  }
}

// ---------------------------------------------------------------- drums
function kick(out, t0, vel = 1, P = {}) {
  const { f0 = 52, sweep = 150, decay = 0.32, click = 0.35, gain = 0.9 } = P;
  const start = Math.floor(t0 * SR);
  const len = Math.floor((decay * 2.2) * SR);
  let ph = 0;
  const hp = new SVF();
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const t = i / SR;
    const f = f0 + sweep * Math.exp(-t * 30) + 400 * Math.exp(-t * 300);
    ph += f / SR;
    const body = Math.sin(TAU * ph) * (t < 0.02 ? 1 : Math.exp(-(t - 0.02) / decay * 2.2));
    hp.run(noise(), 3000, 0.7);
    const c = hp.hp * Math.exp(-t * 260) * click;
    const v = Math.tanh((body + c) * 1.6) * vel * gain;
    out.L[idx] += v;
    out.R[idx] += v;
  }
}

function snare(out, t0, vel = 1, P = {}) {
  const { tone = 190, decay = 0.18, gain = 0.6, snap = 1, pan = 0 } = P;
  const start = Math.floor(t0 * SR);
  const len = Math.floor(decay * 3 * SR);
  const bp = new SVF();
  let ph = 0;
  const [pl, pr] = panGains(pan);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const t = i / SR;
    ph += (tone * (1 + 0.5 * Math.exp(-t * 60))) / SR;
    const body = Math.sin(TAU * ph) * Math.exp(-t * 28) * 0.8;
    bp.run(noise(), 4200, 0.6);
    const nz = (bp.bp * 1.4 + bp.hp * 0.6) * Math.exp(-t / decay * 2.4) * snap;
    const v = Math.tanh((body + nz) * 1.3) * vel * gain;
    out.L[idx] += v * pl;
    out.R[idx] += v * pr;
  }
}

function clap(out, t0, vel = 1, P = {}) {
  const { gain = 0.5, pan = 0 } = P;
  const start = Math.floor(t0 * SR);
  const len = Math.floor(0.35 * SR);
  const bp = new SVF();
  const [pl, pr] = panGains(pan);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const t = i / SR;
    let e;
    if (t < 0.03) e = Math.exp(-((t % 0.01) * 400)) * 0.9;
    else e = Math.exp(-(t - 0.03) * 16);
    bp.run(noise(), 1300, 1.4);
    const v = bp.bp * e * vel * gain * 2.2;
    out.L[idx] += v * pl;
    out.R[idx] += v * pr;
  }
}

const HAT_F = [205.3, 304.4, 369.6, 522.7, 540, 800];
function hat(out, t0, vel = 1, P = {}) {
  const { open = false, gain = 0.25, pan = 0.15 } = P;
  const start = Math.floor(t0 * SR);
  const dec = open ? 0.32 : 0.045;
  const len = Math.floor(dec * 4 * SR);
  const oscs = HAT_F.map((f) => new Osc('square', 0.5));
  const hp = new SVF();
  const bp = new SVF();
  const [pl, pr] = panGains(pan);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const t = i / SR;
    let m = 0;
    for (let k = 0; k < 6; k++) m += oscs[k].tick(HAT_F[k] * 1.7);
    const x = m * 0.12 + noise() * 0.6;
    bp.run(x, 10000, 0.9);
    hp.run(bp.bp, 7000, 0.7);
    const v = hp.hp * Math.exp(-t / dec) * vel * gain * 1.8;
    out.L[idx] += v * pl;
    out.R[idx] += v * pr;
  }
}

function crash(out, t0, vel = 1, P = {}) {
  const { gain = 0.28, decay = 1.8 } = P;
  const start = Math.floor(t0 * SR);
  const len = Math.floor(decay * 2.5 * SR);
  const hl = new SVF();
  const hr = new SVF();
  const oscs = HAT_F.map(() => new Osc('square'));
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const t = i / SR;
    let m = 0;
    for (let k = 0; k < 6; k++) m += oscs[k].tick(HAT_F[k] * 2.3);
    const e = Math.exp(-t / decay) * (t < 0.004 ? t / 0.004 : 1);
    hl.run(noise() * 0.7 + m * 0.08, 5000, 0.6);
    hr.run(noise() * 0.7 + m * 0.08, 5200, 0.6);
    out.L[idx] += hl.hp * e * vel * gain;
    out.R[idx] += hr.hp * e * vel * gain;
  }
}

function tom(out, t0, midi, vel = 1, P = {}) {
  const { gain = 0.6, decay = 0.35, pan = 0 } = P;
  const f0 = mtof(midi);
  const start = Math.floor(t0 * SR);
  const len = Math.floor(decay * 3 * SR);
  let ph = 0;
  const [pl, pr] = panGains(pan);
  const lp = new SVF();
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const t = i / SR;
    ph += (f0 * (1 + 0.6 * Math.exp(-t * 18))) / SR;
    lp.run(noise(), 1800, 0.7);
    const v = Math.tanh((Math.sin(TAU * ph) + lp.lp * 0.25 * Math.exp(-t * 40)) * Math.exp(-t / decay * 2) * 1.4) * vel * gain;
    out.L[idx] += v * pl;
    out.R[idx] += v * pr;
  }
}

// Noise riser / downlifter sweep.
function sweep(out, t0, dur, P = {}) {
  const { f0 = 300, f1 = 8000, gain = 0.2, q = 2, rise = true, shape = 2 } = P;
  const start = Math.floor(t0 * SR);
  const len = Math.floor(dur * SR);
  const fl = new SVF();
  const fr = new SVF();
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.n) break;
    const u = i / len;
    const fc = f0 * Math.pow(f1 / f0, u);
    const e = rise ? Math.pow(u, shape) * (u > 0.97 ? (1 - u) / 0.03 : 1) : Math.pow(1 - u, shape);
    fl.run(noise(), fc, q);
    fr.run(noise(), fc * 1.05, q);
    out.L[idx] += fl.bp * e * gain;
    out.R[idx] += fr.bp * e * gain;
  }
}

// ---------------------------------------------------------------- effects
function fvChannel(ch, x, fb, damp) {
  let y = 0;
  for (let k = 0; k < 8; k++) {
    const c = ch.combs[k];
    const o = c.b[c.i];
    c.s = o * (1 - damp) + c.s * damp;
    c.b[c.i] = x + c.s * fb;
    if (++c.i >= c.b.length) c.i = 0;
    y += o;
  }
  for (let k = 0; k < 4; k++) {
    const a = ch.aps[k];
    const bo = a.b[a.i];
    const o = -y + bo;
    a.b[a.i] = y + bo * 0.5;
    if (++a.i >= a.b.length) a.i = 0;
    y = o;
  }
  return y;
}

function reverb(inp, { room = 0.86, damp = 0.35, predelay = 0.025, lowcut = 220, highcut = 7000 } = {}) {
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apT = [556, 441, 341, 225];
  const mk = (sp) => ({
    combs: combT.map((c) => ({ b: new Float32Array(c + sp), i: 0, s: 0 })),
    aps: apT.map((c) => ({ b: new Float32Array(c + sp), i: 0 })),
  });
  const chL = mk(0);
  const chR = mk(23);
  const fb = room * 0.28 + 0.7;
  const out = new Stereo(inp.dur);
  const pd = Math.floor(predelay * SR);
  const hpf = new SVF();
  const lpf = new SVF();
  for (let n = 0; n < out.n; n++) {
    const src = n - pd;
    let x = src >= 0 ? (inp.L[src] + inp.R[src]) * 0.015 : 0;
    hpf.run(x, lowcut, 0.7);
    x = lpf.run(hpf.hp, highcut, 0.7);
    out.L[n] = fvChannel(chL, x, fb, damp) * 3;
    out.R[n] = fvChannel(chR, x, fb, damp) * 3;
  }
  return out;
}

function pingpong(inp, time, fb = 0.4, lp = 3500) {
  const dl = Math.max(1, Math.floor(time * SR));
  const bl = new Float32Array(dl);
  const br = new Float32Array(dl);
  let i = 0;
  const out = new Stereo(inp.dur);
  const fl = new SVF();
  const fr = new SVF();
  const hp = new SVF();
  for (let n = 0; n < out.n; n++) {
    hp.run((inp.L[n] + inp.R[n]) * 0.5, 180, 0.7);
    const x = hp.hp;
    const yl = bl[i];
    const yr = br[i];
    bl[i] = fl.run(x + yr * fb, lp);
    br[i] = fr.run(yl * fb, lp);
    if (++i >= dl) i = 0;
    out.L[n] = yl;
    out.R[n] = yr;
  }
  return out;
}

// Gain curve that ducks under each kick (sidechain pump).
function duckCurve(n, kicks, depth = 0.45, rel = 0.16) {
  const g = new Float32Array(n).fill(1);
  const span = Math.floor(rel * 5 * SR);
  for (const tk of kicks) {
    const s0 = Math.floor(tk * SR);
    for (let i = 0; i < span; i++) {
      const idx = s0 + i;
      if (idx >= n || idx < 0) continue;
      const t = i / SR;
      const dip = depth * (t < 0.005 ? t / 0.005 : Math.exp(-(t - 0.005) / rel));
      const v = 1 - dip;
      if (v < g[idx]) g[idx] = v;
    }
  }
  return g;
}

function mixInto(dst, src, gain = 1, curve = null) {
  const n = Math.min(dst.n, src.n);
  for (let i = 0; i < n; i++) {
    const g = curve ? gain * curve[i] : gain;
    dst.L[i] += src.L[i] * g;
    dst.R[i] += src.R[i] * g;
  }
}

function highpass(buf, fc) {
  const a = new SVF();
  const b = new SVF();
  for (let i = 0; i < buf.n; i++) {
    a.run(buf.L[i], fc, 0.7);
    b.run(buf.R[i], fc, 0.7);
    buf.L[i] = a.hp;
    buf.R[i] = b.hp;
  }
}

function rms(buf, from = 0, to = buf.n) {
  let s = 0;
  for (let i = from; i < to; i++) s += buf.L[i] * buf.L[i] + buf.R[i] * buf.R[i];
  return Math.sqrt(s / (2 * Math.max(1, to - from)));
}

function peak(buf) {
  let p = 0;
  for (let i = 0; i < buf.n; i++) p = Math.max(p, Math.abs(buf.L[i]), Math.abs(buf.R[i]));
  return p;
}

function scale(buf, g) {
  for (let i = 0; i < buf.n; i++) {
    buf.L[i] *= g;
    buf.R[i] *= g;
  }
}

// Two-pass limiter: the forward pass handles release, the backward pass
// starts gain reduction before each peak (a lookahead attack). The gain never
// exceeds the per-sample requirement, so output peaks stay under `ceiling`.
function limiter(buf, ceiling = 0.89, releaseMs = 90, attackMs = 2.5) {
  const n = buf.n;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(buf.L[i]), Math.abs(buf.R[i]));
    g[i] = p > ceiling ? ceiling / p : 1;
  }
  const rc = 1 - Math.exp(-1 / ((releaseMs / 1000) * SR));
  const ac = 1 - Math.exp(-1 / ((attackMs / 1000) * SR));
  for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] + (1 - g[i - 1]) * rc);
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + (1 - g[i + 1]) * ac);
  let red = 0;
  for (let i = 0; i < n; i++) {
    buf.L[i] *= g[i];
    buf.R[i] *= g[i];
    red += g[i];
  }
  return 20 * Math.log10(red / n);
}

// Fold the tail past loopEnd back onto loopStart, then cut at loopEnd.
function wrapLoop(buf, loopStart, loopEnd) {
  const s = Math.floor(loopStart * SR);
  const e = Math.floor(loopEnd * SR);
  for (let i = e; i < buf.n; i++) {
    const j = s + (i - e);
    if (j >= e) break;
    buf.L[j] += buf.L[i];
    buf.R[j] += buf.R[i];
  }
  const out = new Stereo(e / SR);
  out.L.set(buf.L.subarray(0, out.n));
  out.R.set(buf.R.subarray(0, out.n));
  return out;
}

function fadeEdges(buf, inMs = 2, outMs = 20) {
  const a = Math.floor((inMs / 1000) * SR);
  const b = Math.floor((outMs / 1000) * SR);
  for (let i = 0; i < a && i < buf.n; i++) {
    buf.L[i] *= i / a;
    buf.R[i] *= i / a;
  }
  for (let i = 0; i < b && i < buf.n; i++) {
    const k = buf.n - 1 - i;
    buf.L[k] *= i / b;
    buf.R[k] *= i / b;
  }
}

// ---------------------------------------------------------------- output
function writeWav(file, buf) {
  const n = buf.n;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const dither = (rand() - rand()) / 32768;
    const l = clamp(buf.L[i] + dither, -1, 1);
    const r = clamp(buf.R[i] + dither, -1, 1);
    b.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    b.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, b);
}

const manifest = { sampleRate: SR, music: {}, sfx: {} };

function encode(name, buf, quality) {
  for (let i = 0; i < buf.n; i++) {
    if (!Number.isFinite(buf.L[i]) || !Number.isFinite(buf.R[i])) throw new Error(`${name}: non-finite sample at ${i}`);
  }
  const wav = path.join(TMP, name + '.wav');
  const mp3 = path.join(OUT, name + '.mp3');
  writeWav(wav, buf);
  execFileSync('lame', ['--silent', '-V', String(quality), '--noreplaygain', wav, mp3]);
  const kb = (fs.statSync(mp3).size / 1024).toFixed(0);
  const pk = 20 * Math.log10(peak(buf) + 1e-9);
  const rm = 20 * Math.log10(rms(buf) + 1e-9);
  console.log(`${name.padEnd(18)} ${buf.dur.toFixed(2).padStart(6)}s  peak ${pk.toFixed(1)} dB  rms ${rm.toFixed(1)} dB  ${kb} KB`);
}

// ---------------------------------------------------------------- music helpers
const CHORD_Q = {
  '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], sus2: [0, 2, 7], sus4: [0, 5, 7], '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], '6': [0, 4, 7, 9],
};
function chord(name) {
  const m = /^([A-G][#b]?)(.*)$/.exec(name);
  const root = PC[m[1]];
  const iv = CHORD_Q[m[2]];
  if (!iv) throw new Error('chord ' + name);
  return { root, iv };
}
// Voice a chord close around a center pitch.
function voicing(name, center = 60) {
  const { root, iv } = chord(name);
  return iv.map((x) => {
    let p = root + x;
    while (p < center - 6) p += 12;
    while (p >= center + 6) p -= 12;
    return p;
  }).sort((a, b) => a - b);
}
function bassNote(name, octave = 2) {
  return chord(name).root + (octave + 1) * 12;
}

// "A4:4 D5:2 .:2" -> events in 16th steps.
function line(str, start = 0) {
  const ev = [];
  let s = start;
  for (const tok of str.trim().split(/\s+/)) {
    const [n, l] = tok.split(':');
    const len = l ? parseFloat(l) : 1;
    if (n !== '.') ev.push({ step: s, len, midi: nm(n) });
    s += len;
  }
  return { ev, end: s };
}
function lines(bars, start = 0) {
  let s = start;
  const ev = [];
  for (const b of bars) {
    const r = line(b, s);
    ev.push(...r.ev);
    s = r.end;
  }
  return ev;
}

// Diatonic shift within a scale (pitch classes); out-of-scale notes snap down.
function diatonic(midi, steps, scale) {
  const pc = ((midi % 12) + 12) % 12;
  let idx = scale.indexOf(pc);
  let base = midi;
  if (idx < 0) {
    for (let k = 1; k < 12; k++) {
      idx = scale.indexOf((pc - k + 12) % 12);
      if (idx >= 0) {
        base = midi - k;
        break;
      }
    }
  }
  // `scale` is sorted ascending from pitch class 0, so octaves line up.
  const oct = Math.floor(base / 12);
  const i = idx + steps;
  const o = oct + Math.floor(i / scale.length);
  return o * 12 + scale[((i % scale.length) + scale.length) % scale.length];
}

// ---------------------------------------------------------------- patches
const P_LEAD = {
  oscs: [{ type: 'saw', detune: -7, pan: -0.25 }, { type: 'saw', detune: 7, pan: 0.25 }, { type: 'square', oct: -1, gain: 0.45, duty: 0.4 }],
  a: 0.006, d: 0.3, s: 0.72, r: 0.18, cutoff: 1400, fenv: 2.2, fd: 0.35, fs: 0.35, q: 0.9, keytrack: 0.5,
  vib: 18, vibRate: 5.6, vibDelay: 0.22, glide: 0.035, gain: 0.2, drive: 1.3,
};
const P_BASS = {
  oscs: [{ type: 'saw', gain: 0.8 }, { type: 'square', oct: -1, gain: 0.6, duty: 0.5 }],
  a: 0.003, d: 0.16, s: 0.55, r: 0.06, cutoff: 260, fenv: 3.4, fd: 0.13, fs: 0.1, q: 1.3, gain: 0.42, drive: 2.2,
};
const supersaw = (n = 7, spread = 22) =>
  Array.from({ length: n }, (_, i) => {
    const u = n === 1 ? 0 : i / (n - 1) - 0.5;
    return { type: 'saw', detune: u * 2 * spread, pan: u * 1.7, gain: 0.38 };
  });
const P_PAD = { oscs: supersaw(7, 24), a: 0.35, d: 0.8, s: 0.8, r: 0.9, cutoff: 1500, fenv: 0.6, fa: 0.6, fd: 1.2, fs: 0.3, q: 0.7, gain: 0.13 };
const P_ARP = {
  oscs: [{ type: 'square', duty: 0.28, gain: 0.7 }, { type: 'saw', detune: 5, gain: 0.5 }],
  a: 0.002, d: 0.14, s: 0.0, r: 0.06, cutoff: 900, fenv: 3.2, fd: 0.12, q: 1.1, keytrack: 0.4, gain: 0.16,
};
const P_STAB = {
  oscs: supersaw(5, 14).concat([{ type: 'square', oct: -1, gain: 0.3 }]),
  a: 0.003, d: 0.22, s: 0.25, r: 0.12, cutoff: 900, fenv: 3.2, fd: 0.16, fs: 0.1, q: 1.0, gain: 0.16, drive: 1.5,
};

// ================================================================ STAGE THEME
function stageTheme() {
  const bpm = 138;
  const st = 60 / bpm / 4;
  const bar = st * 16;
  const introBars = 4;
  const bodyBars = 32;
  const loopStart = introBars * bar;
  const loopEnd = (introBars + bodyBars) * bar;
  const total = loopEnd + 6;
  const T = (barIdx, step = 0) => barIdx * bar + step * st;

  const intro = ['Dm', 'Dm', 'Bb', 'A'];
  const A = ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'C', 'A'];
  const B = ['Gm', 'Dm', 'Bb', 'F', 'Gm', 'Dm', 'Eb', 'A'];
  const C = ['Bb', 'C', 'Dm', 'Dm', 'Bb', 'C', 'A', 'A'];
  const chords = [...intro, ...A, ...A, ...B, ...C];
  // section tag per bar
  const tag = [...intro.map(() => 'I'), ...A.map(() => 'A1'), ...A.map(() => 'A2'), ...B.map(() => 'B'), ...C.map((_, i) => (i < 4 ? 'C0' : 'C1'))];

  const drums = new Stereo(total);
  const bass = new Stereo(total);
  const pad = new Stereo(total);
  const arp = new Stereo(total);
  const lead = new Stereo(total);
  const fx = new Stereo(total);
  const kicks = [];

  for (let b = 0; b < chords.length; b++) {
    const ch = chords[b];
    const tg = tag[b];
    const inSec = (b - introBars + 64) % 8; // bar within 8-bar section
    const full = tg === 'A1' || tg === 'A2' || tg === 'B' || tg === 'C1' || (tg === 'I' && b >= 2);

    // --- drums
    if (full) {
      for (let q = 0; q < 4; q++) {
        kick(drums, T(b, q * 4), q === 0 ? 1 : 0.92);
        kicks.push(T(b, q * 4));
      }
      if (tg === 'B' && inSec === 7) {
        kick(drums, T(b, 14), 0.8);
        kicks.push(T(b, 14));
      }
    }
    const backbeat = tg === 'A1' || tg === 'A2' || tg === 'B' || (tg === 'C1' && inSec < 6);
    if (backbeat) {
      snare(drums, T(b, 4), 0.9);
      snare(drums, T(b, 12), 0.95);
      if (tg === 'B') {
        clap(drums, T(b, 4), 0.7, { pan: -0.1 });
        clap(drums, T(b, 12), 0.7, { pan: 0.1 });
      }
    }
    // hats
    if (tg !== 'I' || b >= 2) {
      for (let s16 = 0; s16 < 16; s16++) {
        const off8 = s16 % 4 === 2;
        if (tg === 'C0' && !off8) continue;
        if (tg === 'I' && s16 % 2 === 1) continue;
        const openHat = off8 && s16 === 14 && b % 2 === 1 && tg !== 'C0';
        const v = off8 ? 0.85 : s16 % 2 === 0 ? 0.45 : 0.3;
        hat(drums, T(b, s16), v * (0.9 + rand() * 0.2), { open: openHat, pan: 0.18 });
      }
    }
    // fills at the end of sections
    if ((tg === 'A1' || tg === 'A2' || tg === 'B') && inSec === 7) {
      [12, 13, 14, 15].forEach((s16, i) => snare(drums, T(b, s16), 0.55 + i * 0.12, { pan: (i - 1.5) * 0.2 }));
    }
    if (tg === 'I' && b === 3) [8, 10, 12, 13, 14, 15].forEach((s16, i) => snare(drums, T(b, s16), 0.45 + i * 0.1));
    if (tg === 'C1' && inSec === 6) for (let s16 = 0; s16 < 16; s16 += 2) snare(drums, T(b, s16), 0.35 + s16 * 0.02);
    if (tg === 'C1' && inSec === 7) for (let s16 = 0; s16 < 16; s16++) snare(drums, T(b, s16), 0.45 + s16 * 0.035);
    if (inSec === 0 && tg !== 'I') crash(drums, T(b), tg === 'C0' ? 0.6 : 1);

    // --- bass
    const root = bassNote(ch, 2);
    if (tg === 'C0') {
      voice(bass, T(b), bar * 0.95, root, 0.9, { ...P_BASS, cutoff: 180, fenv: 1.5, s: 0.8, r: 0.3 });
    } else if (full || tg === 'C1') {
      const pat = [[0, 2, 0], [2, 1, 0], [3, 1, 12], [4, 2, 0], [6, 2, 0], [8, 2, 12], [10, 1, 0], [11, 1, 0], [12, 2, 0], [14, 2, 12]];
      for (const [s16, len, o] of pat) {
        voice(bass, T(b, s16), len * st * 0.82, root + o, s16 % 4 === 0 ? 1 : 0.8, P_BASS);
      }
    }

    // --- pad
    const vc = voicing(ch, 62);
    const padGain = tg === 'C0' ? 1.25 : tg === 'I' ? 0.8 : 1;
    for (const p of vc) voice(pad, T(b), bar, p, padGain, P_PAD);
    if (tg === 'B' || tg === 'C1') voice(pad, T(b), bar, bassNote(ch, 4) + 12, 0.5, P_PAD);

    // --- arp
    {
      const { root: r0, iv } = chord(ch);
      const base = r0 + 5 * 12 + (r0 > 4 ? -12 : 0); // octave 4ish
      const tones = [0, 1, 2].map((k) => base + iv[k]).concat([0, 1, 2].map((k) => base + iv[k] + 12));
      const pattern = [0, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 5, 4, 3, 2, 1];
      for (let s16 = 0; s16 < 16; s16++) {
        let cut = 1;
        if (tg === 'I') cut = 0.35 + (b * 16 + s16) / 64 * 0.9;
        const v = (s16 % 4 === 0 ? 1 : 0.72) * (tg === 'C0' ? 0.8 : 1);
        voice(arp, T(b, s16), st * 0.9, tones[pattern[s16]], v, { ...P_ARP, cutoff: P_ARP.cutoff * cut, pan: s16 % 2 ? 0.3 : -0.3 });
      }
    }
  }

  // --- lead melody
  const scaleDm = [2, 4, 5, 7, 9, 10, 0].sort((a, b) => a - b);
  const melA1 = lines([
    'A4:4 D5:2 E5:2 F5:4 E5:2 D5:2', 'D5:6 C5:2 D5:4 F5:4', 'C5:4 F5:4 A5:4 G5:2 F5:2', 'E5:6 D5:2 E5:4 G5:4',
    'A5:4 F5:2 E5:2 D5:4 F5:4', 'Bb5:6 A5:2 G5:4 F5:4', 'G5:4 E5:4 C5:4 E5:4', 'E5:8 C#5:4 A4:4',
  ], (introBars) * 16);
  const melA2 = lines([
    'A4:4 D5:2 E5:2 F5:4 A5:2 G5:2', 'F5:6 D5:2 Bb4:4 D5:4', 'C5:4 F5:4 A5:4 C6:4', 'G5:6 A5:2 G5:4 E5:4',
    'F5:4 A5:4 D6:6 C6:2', 'Bb5:4 A5:2 G5:2 F5:4 D5:4', 'E5:4 G5:4 C6:4 E6:4', 'E6:4 D6:2 C#6:2 A5:8',
  ], (introBars + 8) * 16);
  const melB = lines([
    'D5:4 G5:4 Bb5:6 A5:2', 'A5:8 F5:4 D5:4', 'F5:4 Bb5:4 D6:6 C6:2', 'C6:8 A5:4 F5:4',
    'G5:4 Bb5:4 D6:4 C6:2 Bb5:2', 'A5:8 F5:4 A5:4', 'G5:4 Bb5:4 Eb6:8', 'E6:4 C#6:4 A5:4 E5:4',
  ], (introBars + 16) * 16);
  const melC = lines(['D5:16', 'E5:16', 'C#5:8 E5:8', 'A5:8 E5:4 C#5:4'], (introBars + 28) * 16);
  let prev = null;
  for (const e of [...melA1, ...melA2, ...melB, ...melC]) {
    const long = e.len >= 8;
    voice(lead, e.step * st, e.len * st * 0.92, e.midi, 0.95, { ...P_LEAD, from: prev, glide: prev ? 0.03 : 0, vib: long ? 22 : 12 });
    prev = e.midi;
  }
  // harmony a diatonic third below in section B
  for (const e of melB) {
    voice(lead, e.step * st, e.len * st * 0.92, diatonic(e.midi, -2, scaleDm), 0.55, { ...P_LEAD, pan: 0.35, gain: 0.13 });
  }

  // --- fx: risers
  sweep(fx, T(0), bar * 4, { f0: 200, f1: 6000, gain: 0.18 });
  sweep(fx, T(introBars + 28), bar * 4, { f0: 250, f1: 9000, gain: 0.2, shape: 2.5 });
  sweep(fx, T(introBars), bar * 1.5, { f0: 7000, f1: 300, gain: 0.12, rise: false });

  return mixSong({ drums, bass, pad, arp, lead, fx, kicks, total, loopStart, loopEnd, delayTime: st * 3, name: 'bgm_stage', leadRev: 0.28, padRev: 0.3 });
}

function mixSong({ drums, bass, pad, arp, lead, fx, extra = [], kicks, loopStart, loopEnd, delayTime, name, leadRev = 0.25, padRev = 0.3, duck = 0.45, targetRms = -15 }) {
  const n = drums.n;
  const duckG = duckCurve(n, kicks, duck);
  const mix = new Stereo(n / SR);
  mixInto(mix, drums, 1);
  mixInto(mix, bass, 1, duckG);
  mixInto(mix, pad, 1, duckG);
  mixInto(mix, arp, 1, duckG);
  mixInto(mix, lead, 1);
  mixInto(mix, fx, 1);
  for (const [buf, g] of extra) mixInto(mix, buf, g);
  // sends
  const dSend = new Stereo(n / SR);
  mixInto(dSend, arp, 0.5);
  mixInto(dSend, lead, 0.35);
  const dly = pingpong(dSend, delayTime, 0.42, 3200);
  const rSend = new Stereo(n / SR);
  mixInto(rSend, lead, leadRev);
  mixInto(rSend, pad, padRev, duckG);
  mixInto(rSend, arp, 0.25);
  mixInto(rSend, drums, 0.08);
  mixInto(rSend, dly, 0.4);
  mixInto(rSend, fx, 0.4);
  const rev = reverb(rSend, { room: 0.88, damp: 0.3 });
  mixInto(mix, dly, 0.45);
  mixInto(mix, rev, 0.55);
  highpass(mix, 28);
  let out = wrapLoop(mix, loopStart, loopEnd);
  const cur = 20 * Math.log10(rms(out) + 1e-9);
  scale(out, dbToGain(targetRms - cur));
  const gr = limiter(out, 0.9);
  console.log(`  ${name}: avg limiter gain ${gr.toFixed(2)} dB`);
  manifest.music[name] = { file: `audio/${name}.mp3`, loopStart, loopEnd, samples: out.n };
  return out;
}

// ================================================================ BOSS THEME
function bossTheme() {
  const bpm = 152;
  const st = 60 / bpm / 4;
  const bar = st * 16;
  const introBars = 2;
  const A = ['Em', 'Em', 'F', 'F', 'Em', 'Em', 'F', 'B'];
  const Bs = ['Am', 'Em', 'F', 'B', 'Am', 'Em', 'C', 'B'];
  const Cs = ['C', 'D', 'Em', 'Em', 'C', 'D', 'B', 'B'];
  const chords = ['Em', 'B', ...A, ...Bs, ...Cs, ...A];
  const tags = ['I', 'I', ...A.map(() => 'A'), ...Bs.map(() => 'B'), ...Cs.map(() => 'C'), ...A.map(() => 'D')];
  const loopStart = introBars * bar;
  const loopEnd = chords.length * bar;
  const total = loopEnd + 6;
  const T = (b, s16 = 0) => b * bar + s16 * st;

  const drums = new Stereo(total);
  const bass = new Stereo(total);
  const pad = new Stereo(total);
  const arp = new Stereo(total);
  const lead = new Stereo(total);
  const fx = new Stereo(total);
  const stabs = new Stereo(total);
  const kicks = [];

  for (let b = 0; b < chords.length; b++) {
    const ch = chords[b];
    const tg = tags[b];
    const inSec = (b - introBars + 64) % 8;
    const root = bassNote(ch, 2);

    if (tg === 'I') {
      // Tom rolls + low hits building into the loop.
      for (let s16 = 0; s16 < 16; s16 += b === 0 ? 4 : 2) tom(drums, T(b, s16), [45, 43, 40, 38][(s16 / 2) % 4], 0.6 + s16 * 0.02, { pan: ((s16 % 8) - 4) / 6 });
      if (b === 1) for (let s16 = 8; s16 < 16; s16++) snare(drums, T(b, s16), 0.4 + (s16 - 8) * 0.07);
      voice(bass, T(b), bar * 0.95, root, 1, { ...P_BASS, cutoff: 200, fenv: 2, s: 0.8, r: 0.2 });
      for (const p of voicing(ch, 58)) voice(pad, T(b), bar, p, 0.9, { ...P_PAD, cutoff: 900 });
      continue;
    }

    // --- drums
    const half = tg === 'C' && inSec < 6;
    const kickSteps = half ? [0, 6, 10] : [0, 2, 3, 6, 8, 10, 11, 14];
    for (const s16 of kickSteps) {
      kick(drums, T(b, s16), s16 % 4 === 0 ? 1 : 0.8, { decay: 0.24, f0: 50 });
      kicks.push(T(b, s16));
    }
    if (half) snare(drums, T(b, 8), 1, { decay: 0.24 });
    else {
      snare(drums, T(b, 4), 0.95);
      snare(drums, T(b, 12), 1);
    }
    for (let s16 = 0; s16 < 16; s16++) {
      if (half && s16 % 2) continue;
      hat(drums, T(b, s16), (s16 % 4 === 2 ? 0.8 : 0.4) * (0.9 + rand() * 0.2), { open: s16 === 14 && inSec % 2 === 1, pan: -0.2 });
    }
    if (inSec === 0) crash(drums, T(b), 1);
    if (inSec === 4 && tg !== 'C') crash(drums, T(b), 0.6);
    if (inSec === 7) {
      [8, 10, 12, 13, 14, 15].forEach((s16, i) => tom(drums, T(b, s16), [50, 47, 45, 43, 40, 38][i], 0.7 + i * 0.05, { pan: 0.5 - i * 0.2 }));
    }

    // --- bass riff
    if (half) {
      voice(bass, T(b), bar * 0.5, root, 1, { ...P_BASS, s: 0.8, cutoff: 220 });
      voice(bass, T(b, 8), bar * 0.45, root + 12, 0.8, { ...P_BASS, s: 0.8, cutoff: 220 });
    } else {
      const riff = [0, 0, 12, 0, 0, 10, 0, 0, 0, 0, 12, 0, 3, 0, 1, 0];
      for (let s16 = 0; s16 < 16; s16++) {
        voice(bass, T(b, s16), st * 0.7, root + riff[s16], s16 % 4 === 0 ? 1 : 0.78, { ...P_BASS, cutoff: 300, fenv: 3.6, fd: 0.09 });
      }
    }

    // --- stabs (3-3-2 syncopation) on A/D
    if (tg === 'A' || tg === 'D') {
      for (const s16 of [0, 6, 12]) for (const p of voicing(ch, 60)) voice(stabs, T(b, s16), st * 1.6, p, s16 === 0 ? 1 : 0.85, P_STAB);
    }

    // --- pad: dark sustained chords
    const pg = tg === 'C' ? 1.2 : 0.8;
    for (const p of voicing(ch, 57)) voice(pad, T(b), bar, p, pg, { ...P_PAD, cutoff: 1100 });

    // --- organ-ish arpeggio in bridge (C) and D
    if (tg === 'C' || tg === 'D' || tg === 'B') {
      const { root: r0, iv } = chord(ch);
      const base = r0 + 6 * 12 - (r0 > 5 ? 12 : 0);
      const tones = [0, 1, 2, 0, 1, 2].map((k, i) => base + iv[k] + (i >= 3 ? 12 : 0));
      const pat = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5, 4, 3];
      for (let s16 = 0; s16 < 16; s16++) {
        voice(arp, T(b, s16), st * 0.8, tones[pat[s16]], s16 % 4 === 0 ? 0.95 : 0.7, { ...P_ARP, cutoff: tg === 'C' ? 1300 : 800, gain: tg === 'C' ? 0.17 : 0.12, pan: s16 % 2 ? 0.35 : -0.35 });
      }
    }
  }

  const scaleE = [4, 6, 7, 9, 11, 0, 2].sort((a, b) => a - b);
  const melB = lines([
    'E5:4 A5:4 C6:6 B5:2', 'B5:8 G5:4 E5:4', 'F5:4 A5:4 C6:4 A5:4', 'B5:6 A5:2 G5:2 F#5:2 D#5:4',
    'E5:2 A5:2 C6:2 E6:2 D6:4 C6:4', 'B5:8 E6:8', 'G6:4 E6:4 C6:4 G5:4', 'F#6:6 D#6:2 B5:4 F#5:4',
  ], (introBars + 8) * 16);
  const melD = lines([
    'E5:3 G5:3 B5:4 E6:6', 'D6:4 B5:4 G5:4 A5:4', 'A5:3 C6:3 F6:4 E6:6', 'C6:4 A5:4 F5:4 E5:4',
    'E5:3 G5:3 B5:4 E6:6', 'F#6:4 G6:4 F#6:4 E6:4', 'F6:4 E6:4 C6:4 A5:4', 'B5:8 D#6:4 F#6:4',
  ], (introBars + 24) * 16);
  const P_BLEAD = { ...P_LEAD, cutoff: 1700, drive: 1.8, gain: 0.19, vib: 16 };
  let prev = null;
  for (const e of [...melB, ...melD]) {
    voice(lead, e.step * st, e.len * st * 0.9, e.midi, 0.95, { ...P_BLEAD, from: prev, glide: prev ? 0.025 : 0 });
    prev = e.midi;
  }
  for (const e of melD) voice(lead, e.step * st, e.len * st * 0.9, diatonic(e.midi, -2, scaleE), 0.5, { ...P_BLEAD, gain: 0.12, pan: -0.35 });

  sweep(fx, 0, bar * 2, { f0: 150, f1: 7000, gain: 0.2 });
  sweep(fx, T(introBars + 22), bar * 2, { f0: 250, f1: 9000, gain: 0.18 });

  return mixSong({ drums, bass, pad, arp, lead, fx, extra: [[stabs, 1]], kicks, loopStart, loopEnd, delayTime: st * 3, name: 'bgm_boss', leadRev: 0.22, padRev: 0.25, duck: 0.35, targetRms: -14.5 });
}

// ================================================================ TITLE THEME
function titleTheme() {
  const bpm = 84;
  const st = 60 / bpm / 4;
  const bar = st * 16;
  const chords = ['Amadd9', 'Fmaj7', 'C', 'G6', 'Amadd9', 'Fmaj7', 'Dm7', 'Esus4', 'Amadd9', 'Fmaj7', 'C', 'G', 'Am', 'Fmaj7', 'Dm7', 'E'];
  const loopStart = 0;
  const loopEnd = chords.length * bar;
  const total = loopEnd + 8;
  const T = (b, s16 = 0) => b * bar + s16 * st;
  const drums = new Stereo(total);
  const bass = new Stereo(total);
  const pad = new Stereo(total);
  const arp = new Stereo(total);
  const lead = new Stereo(total);
  const fx = new Stereo(total);
  const kicks = [];

  for (let b = 0; b < chords.length; b++) {
    const ch = chords[b];
    // sub drone
    voice(bass, T(b), bar, bassNote(ch, 1) + 12, 0.9, { oscs: [{ type: 'sine' }, { type: 'tri', oct: 1, gain: 0.25 }], a: 0.8, d: 1, s: 0.9, r: 1.2, cutoff: 500, gain: 0.35 });
    // warm pad
    for (const p of voicing(ch, 60)) voice(pad, T(b), bar, p, 1, { ...P_PAD, a: 1.4, r: 1.8, cutoff: 1100, gain: 0.12 });
    // bell arpeggio (8ths)
    const { root: r0, iv } = chord(ch);
    const base = r0 + 6 * 12 - (r0 > 6 ? 12 : 0);
    const tones = [...iv.slice(0, 3).map((x) => base + x), base + 12];
    const pat = [0, 1, 2, 3, 2, 1, 3, 2];
    for (let k = 0; k < 8; k++) {
      fm(arp, T(b, k * 2), st * 1.8, tones[pat[k]], k === 0 ? 0.9 : 0.6, { ratio: 3.5, index: 2.2, idxDecay: 0.25, d: 1.1, r: 0.6, gain: 0.13, pan: k % 2 ? 0.45 : -0.45 });
    }
    // heartbeat + shaker from bar 5
    if (b >= 4) {
      kick(drums, T(b, 0), 0.75, { decay: 0.4, f0: 46, click: 0.1, gain: 0.8 });
      kick(drums, T(b, 3), 0.45, { decay: 0.3, f0: 46, click: 0.05, gain: 0.8 });
      kicks.push(T(b, 0));
      for (let s16 = 2; s16 < 16; s16 += 4) hat(drums, T(b, s16), 0.35, { pan: 0.3 });
      if (b >= 8) snare(drums, T(b, 8), 0.35, { decay: 0.3, gain: 0.45, snap: 0.7 });
    }
    // sonar ping every 2 bars
    if (b % 2 === 0) fm(fx, T(b, 6), 0.05, 93, 0.6, { ratio: 1, index: 0.3, d: 1.8, r: 1.5, gain: 0.16, pan: -0.6 });
    if (b % 4 === 1) sweep(fx, T(b, 4), bar * 1.5, { f0: 250, f1: 1200, gain: 0.08, q: 4, shape: 1 });
  }
  const mel = lines([
    'E5:8 C5:4 D5:4', 'E5:12 A4:4', 'G5:8 E5:4 C5:4', 'D5:16',
    'E5:4 A5:4 G5:4 E5:4', 'F5:8 E5:4 C5:4', 'D5:8 F5:4 A5:4', 'G#5:12 E5:4',
  ], 8 * 16);
  let prev = null;
  for (const e of mel) {
    voice(lead, e.step * st, e.len * st * 0.95, e.midi, 0.9, {
      oscs: [{ type: 'tri' }, { type: 'sine', oct: 1, gain: 0.2 }, { type: 'saw', gain: 0.12, detune: 4 }],
      a: 0.05, d: 0.5, s: 0.8, r: 0.6, cutoff: 2200, vib: 14, vibRate: 5, vibDelay: 0.35, glide: prev ? 0.05 : 0, from: prev, gain: 0.26,
    });
    prev = e.midi;
  }
  return mixSong({ drums, bass, pad, arp, lead, fx, kicks, loopStart, loopEnd, delayTime: st * 3, name: 'bgm_title', leadRev: 0.5, padRev: 0.45, duck: 0.15, targetRms: -17 });
}

// ================================================================ JINGLES
function jingle(name, fn, dur) {
  const bufs = { drums: new Stereo(dur), inst: new Stereo(dur), lead: new Stereo(dur) };
  fn(bufs);
  const mix = new Stereo(dur);
  mixInto(mix, bufs.drums, 1);
  mixInto(mix, bufs.inst, 1);
  mixInto(mix, bufs.lead, 1);
  const send = new Stereo(dur);
  mixInto(send, bufs.inst, 0.4);
  mixInto(send, bufs.lead, 0.4);
  mixInto(send, bufs.drums, 0.1);
  mixInto(mix, reverb(send, { room: 0.9 }), 0.6);
  highpass(mix, 28);
  scale(mix, dbToGain(-15 - 20 * Math.log10(rms(mix) + 1e-9)));
  limiter(mix, 0.9);
  fadeEdges(mix, 1, 300);
  return mix;
}

function victory() {
  const st = 60 / 120 / 4;
  return jingle('jingle_victory', ({ drums, inst, lead }) => {
    const mel = line('A4:2 D5:2 F#5:2 A5:6 G5:2 A5:2 B5:4 C#6:4 D6:16').ev;
    let prev = null;
    for (const e of mel) {
      voice(lead, e.step * st, e.len * st * 0.92, e.midi, 1, { ...P_LEAD, cutoff: 2000, gain: 0.22, from: prev, glide: prev ? 0.025 : 0, vib: e.len > 8 ? 25 : 10 });
      prev = e.midi;
    }
    const chs = [['D', 0, 16], ['G', 16, 4], ['A', 20, 4], ['D', 24, 16]];
    for (const [c, s0, l] of chs) {
      for (const p of voicing(c, 60)) voice(inst, s0 * st, l * st, p, 1, { ...P_STAB, s: 0.6, r: 0.8, gain: 0.14, cutoff: 1400 });
      voice(inst, s0 * st, l * st, bassNote(c, 2), 1, { ...P_BASS, s: 0.7, r: 0.5 });
    }
    for (let k = 0; k < 16; k++) fm(inst, (24 + k) * st, st, voicing('D', 84)[k % 3] + (k >= 8 ? 12 : 0), 0.6, { ratio: 3.5, index: 1.8, d: 0.6, gain: 0.08, pan: k % 2 ? 0.5 : -0.5 });
    [0, 4, 8, 12].forEach((s) => kick(drums, s * st, 0.9));
    [4, 12].forEach((s) => snare(drums, s * st, 0.8));
    [16, 18, 20, 21, 22, 23].forEach((s, i) => tom(drums, s * st, [50, 47, 45, 43, 40, 38][i], 0.8));
    kick(drums, 24 * st, 1);
    crash(drums, 24 * st, 1, { decay: 2.4 });
  }, 7.5);
}

function gameOver() {
  const st = 60 / 70 / 4;
  return jingle('jingle_gameover', ({ drums, inst, lead }) => {
    const mel = line('A4:4 F4:4 E4:4 D4:4 C#4:4 E4:4 D4:12').ev;
    for (const e of mel) voice(lead, e.step * st, e.len * st * 0.95, e.midi, 0.9, { oscs: [{ type: 'tri' }, { type: 'saw', gain: 0.15 }], a: 0.03, d: 0.4, s: 0.8, r: 0.9, cutoff: 1800, vib: 16, vibDelay: 0.3, gain: 0.3 });
    const chs = [['Dm', 0, 8], ['Bb', 8, 8], ['A', 16, 8], ['Dm', 24, 12]];
    for (const [c, s0, l] of chs) {
      for (const p of voicing(c, 57)) voice(inst, s0 * st, l * st, p, 1, { ...P_PAD, a: 0.3, r: 1.2, gain: 0.13, cutoff: 1000 });
      voice(inst, s0 * st, l * st, bassNote(c, 1) + 12, 1, { oscs: [{ type: 'sine' }], a: 0.05, s: 0.9, r: 1, cutoff: 600, gain: 0.4 });
    }
    kick(drums, 24 * st, 0.8, { decay: 0.5, f0: 44 });
    crash(drums, 24 * st, 0.5, { decay: 2 });
  }, 9);
}

// ================================================================ SFX
function sfxRender(dur, fn, { rev = 0, room = 0.7, target = -3, hp = 30 } = {}) {
  const dry = new Stereo(dur);
  fn(dry);
  const mix = new Stereo(dur);
  mixInto(mix, dry, 1);
  if (rev > 0) mixInto(mix, reverb(dry, { room, damp: 0.4, predelay: 0.01 }), rev);
  highpass(mix, hp);
  const p = peak(mix);
  scale(mix, dbToGain(target) / Math.max(p, 1e-6));
  fadeEdges(mix, 0.5, Math.min(60, dur * 250));
  return mix;
}

// Generic noise burst through a swept filter.
function noiseBurst(out, t0, dur, P = {}) {
  const { f0 = 6000, f1 = 200, q = 0.7, gain = 1, decay = 0.3, type = 'lp', stereo = true, attack = 0.002 } = P;
  const s0 = Math.floor(t0 * SR);
  const len = Math.floor(dur * SR);
  const fl = new SVF();
  const fr = new SVF();
  for (let i = 0; i < len; i++) {
    const idx = s0 + i;
    if (idx >= out.n) break;
    const t = i / SR;
    const u = i / len;
    const fc = f0 * Math.pow(f1 / f0, u);
    const e = (t < attack ? t / attack : 1) * Math.exp(-t / decay);
    const nl = noise();
    const nr = stereo ? noise() : nl;
    fl.run(nl, fc, q);
    fr.run(nr, fc, q);
    const pick = (f) => (type === 'lp' ? f.lp : type === 'bp' ? f.bp : f.hp);
    out.L[idx] += pick(fl) * e * gain;
    out.R[idx] += pick(fr) * e * gain;
  }
}

function sine(out, t0, dur, fA, fB, P = {}) {
  const { gain = 1, decay = 0.2, attack = 0.002, curve = 30, type = 'sine', pan = 0, am = 0, amRate = 0 } = P;
  const s0 = Math.floor(t0 * SR);
  const len = Math.floor(dur * SR);
  const o = new Osc(type, 0.5, 0);
  const [pl, pr] = panGains(pan);
  for (let i = 0; i < len; i++) {
    const idx = s0 + i;
    if (idx >= out.n) break;
    const t = i / SR;
    const f = fB + (fA - fB) * Math.exp(-t * curve);
    const e = (t < attack ? t / attack : 1) * Math.exp(-t / decay) * (am ? 1 - am * 0.5 * (1 + Math.sin(TAU * amRate * t)) : 1);
    const v = o.tick(f) * e * gain;
    out.L[idx] += v * pl;
    out.R[idx] += v * pr;
  }
}

function crackle(out, t0, dur, P = {}) {
  const { density = 120, gain = 0.5 } = P;
  const count = Math.floor(density * dur);
  for (let k = 0; k < count; k++) {
    const t = t0 + Math.pow(rand(), 1.6) * dur;
    const amp = gain * (1 - (t - t0) / dur) * (0.4 + rand() * 0.6);
    noiseBurst(out, t, 0.03, { f0: 2500 + rand() * 4000, f1: 800, decay: 0.006 + rand() * 0.01, gain: amp, type: 'bp', q: 1.2, stereo: false });
  }
}

function explosion(out, t0, size) {
  // size: 0.5 small .. 2 huge
  const d = 0.4 + size * 0.8;
  noiseBurst(out, t0, d * 1.6, { f0: 7000, f1: 120, decay: d * 0.35, gain: 0.9, q: 0.8 });
  noiseBurst(out, t0, d * 2, { f0: 900, f1: 60, decay: d * 0.6, gain: 1.1, q: 0.9 });
  sine(out, t0, d * 1.5, 120, 32, { decay: d * 0.4, curve: 9, gain: 0.9 + size * 0.3 });
  crackle(out, t0 + 0.02, d * 1.2, { density: 60 + size * 60, gain: 0.35 });
}

function renderSfx() {
  const S = {};
  S.sfx_shoot = sfxRender(0.16, (o) => {
    sine(o, 0, 0.14, 2200, 520, { type: 'square', decay: 0.045, curve: 40, gain: 0.35 });
    sine(o, 0, 0.12, 1400, 300, { type: 'saw', decay: 0.04, curve: 30, gain: 0.25 });
    noiseBurst(o, 0, 0.05, { f0: 9000, f1: 3000, decay: 0.01, type: 'hp', gain: 0.4 });
  }, { rev: 0.15, room: 0.5, target: -6 });
  S.sfx_shoot_big = sfxRender(0.3, (o) => {
    sine(o, 0, 0.25, 1600, 200, { type: 'saw', decay: 0.08, curve: 22, gain: 0.5 });
    sine(o, 0, 0.25, 800, 110, { type: 'square', decay: 0.09, curve: 18, gain: 0.35 });
    noiseBurst(o, 0, 0.12, { f0: 8000, f1: 1500, decay: 0.03, gain: 0.5, type: 'bp' });
  }, { rev: 0.2, room: 0.55, target: -5 });
  S.sfx_enemy_shot = sfxRender(0.14, (o) => {
    sine(o, 0, 0.12, 900, 1500, { type: 'tri', decay: 0.05, curve: 25, gain: 0.6 });
    sine(o, 0, 0.12, 450, 750, { type: 'square', decay: 0.04, curve: 25, gain: 0.15 });
  }, { rev: 0.2, target: -8 });
  S.sfx_hit = sfxRender(0.08, (o) => {
    noiseBurst(o, 0, 0.06, { f0: 4200, f1: 2500, decay: 0.012, gain: 1, type: 'bp', q: 2 });
    sine(o, 0, 0.05, 1800, 900, { decay: 0.015, gain: 0.5 });
  }, { target: -6 });
  S.sfx_explode = sfxRender(1.3, (o) => explosion(o, 0, 0.45), { rev: 0.25, room: 0.75, target: -2 });
  S.sfx_explode_big = sfxRender(2.6, (o) => {
    explosion(o, 0, 1.1);
    explosion(o, 0.09, 0.6);
  }, { rev: 0.35, room: 0.85, target: -1 });
  S.sfx_powerup = sfxRender(0.9, (o) => {
    [72, 76, 79, 84, 88].forEach((m, i) => fm(o, i * 0.055, 0.05, m, 0.9, { ratio: 2, index: 1.5, idxDecay: 0.1, d: 0.35, r: 0.2, gain: 0.5, pan: (i - 2) * 0.3 }));
    sine(o, 0, 0.5, 400, 1600, { type: 'tri', decay: 0.2, curve: -3, gain: 0.15 });
  }, { rev: 0.35, room: 0.7, target: -4 });
  S.sfx_player_hit = sfxRender(0.5, (o) => {
    sine(o, 0, 0.4, 1400, 180, { type: 'saw', decay: 0.12, curve: 14, gain: 0.5, am: 1, amRate: 60 });
    noiseBurst(o, 0, 0.3, { f0: 6000, f1: 800, decay: 0.08, gain: 0.6, type: 'bp', q: 1.5 });
    sine(o, 0, 0.3, 3000, 2000, { decay: 0.05, gain: 0.2 });
  }, { rev: 0.25, target: -3 });
  S.sfx_player_death = sfxRender(2.4, (o) => {
    explosion(o, 0, 1.0);
    sine(o, 0.05, 1.5, 900, 50, { type: 'saw', decay: 0.5, curve: 2.5, gain: 0.3 });
    sine(o, 0.05, 1.5, 905, 52, { type: 'saw', decay: 0.5, curve: 2.5, gain: 0.3, pan: 0.5 });
  }, { rev: 0.35, room: 0.85, target: -1.5 });
  S.sfx_boss_hit = sfxRender(0.22, (o) => {
    fm(o, 0, 0.02, 57, 1, { ratio: 1.414, index: 4, idxDecay: 0.05, d: 0.12, r: 0.05, gain: 0.8 });
    noiseBurst(o, 0, 0.08, { f0: 3000, f1: 1200, decay: 0.02, gain: 0.5, type: 'bp', q: 2 });
  }, { rev: 0.2, target: -5 });
  S.sfx_boss_explode = sfxRender(5.5, (o) => {
    for (let k = 0; k < 7; k++) explosion(o, k * 0.28 + rand() * 0.1, 0.5 + rand() * 0.5);
    explosion(o, 2.3, 2.0);
    sine(o, 2.3, 3, 70, 24, { decay: 1.2, curve: 1.5, gain: 1.2 });
  }, { rev: 0.4, room: 0.92, target: -1 });
  S.sfx_bomb = sfxRender(2.8, (o) => {
    sine(o, 0, 2.5, 160, 28, { decay: 0.9, curve: 2.2, gain: 1.1 });
    noiseBurst(o, 0, 2.5, { f0: 200, f1: 9000, decay: 0.7, gain: 0.4, type: 'bp', q: 0.8, attack: 0.15 });
    noiseBurst(o, 0, 1.5, { f0: 5000, f1: 100, decay: 0.4, gain: 0.8 });
    [84, 88, 91, 96].forEach((m, i) => fm(o, 0.15 + i * 0.07, 0.1, m, 0.5, { ratio: 3.5, index: 2, d: 0.9, gain: 0.25, pan: i % 2 ? 0.6 : -0.6 }));
  }, { rev: 0.4, room: 0.9, target: -1 });
  S.sfx_select = sfxRender(0.12, (o) => {
    sine(o, 0, 0.1, 1320, 1320, { type: 'square', decay: 0.04, gain: 0.3 });
    sine(o, 0.03, 0.08, 1980, 1980, { type: 'square', decay: 0.03, gain: 0.25 });
  }, { rev: 0.2, target: -8 });
  S.sfx_start = sfxRender(1.6, (o) => {
    noiseBurst(o, 0, 0.9, { f0: 300, f1: 9000, decay: 0.5, gain: 0.5, type: 'bp', q: 1.5, attack: 0.3 });
    [69, 74, 78, 81, 86].forEach((m, i) => fm(o, 0.25 + i * 0.07, 0.3, m, 0.8, { ratio: 2, index: 1.2, d: 0.9, gain: 0.35, pan: (i - 2) * 0.35 }));
    sine(o, 0.25, 1, 110, 55, { decay: 0.4, curve: 3, gain: 0.6 });
  }, { rev: 0.45, room: 0.85, target: -3 });
  S.sfx_warning = sfxRender(3.6, (o) => {
    for (let k = 0; k < 4; k++) {
      const t = k * 0.85;
      voice(o, t, 0.6, 45, 1, { oscs: [{ type: 'saw', detune: -8 }, { type: 'saw', detune: 8 }, { type: 'square', oct: -1, gain: 0.6 }], a: 0.03, d: 0.4, s: 0.9, r: 0.2, cutoff: 700, fenv: 1.5, fa: 0.2, fd: 0.4, q: 2, gain: 0.5, drive: 2 });
      voice(o, t, 0.6, 52, 1, { oscs: [{ type: 'saw', detune: -6 }, { type: 'saw', detune: 6 }], a: 0.03, d: 0.4, s: 0.9, r: 0.2, cutoff: 900, fenv: 1.5, fa: 0.2, fd: 0.4, q: 2, gain: 0.35, drive: 2 });
    }
  }, { rev: 0.35, room: 0.85, target: -2 });
  S.sfx_boss_roar = sfxRender(3.2, (o) => {
    voice(o, 0, 2.3, 33, 1, { oscs: [{ type: 'saw', detune: -20 }, { type: 'saw', detune: 17 }, { type: 'square', detune: 5, oct: 1, gain: 0.4 }], a: 0.25, d: 1, s: 0.8, r: 0.7, cutoff: 500, fenv: 1.6, fa: 0.4, fd: 1.4, q: 3, gain: 0.6, drive: 3, vib: 60, vibRate: 22, vibDelay: 0, from: 40, glide: 1.2 });
    noiseBurst(o, 0, 2.8, { f0: 600, f1: 250, decay: 1.2, gain: 0.6, type: 'bp', q: 2.5, attack: 0.3 });
  }, { rev: 0.4, room: 0.9, target: -2 });
  S.sfx_laser_charge = sfxRender(1.1, (o) => {
    sine(o, 0, 1.0, 180, 2400, { type: 'tri', decay: 5, curve: -2.6, gain: 0.35, am: 0.8, amRate: 28 });
    noiseBurst(o, 0, 1.0, { f0: 500, f1: 7000, decay: 5, gain: 0.25, type: 'bp', q: 3, attack: 0.5 });
  }, { rev: 0.2, target: -6 });
  S.sfx_laser = sfxRender(1.5, (o) => {
    voice(o, 0, 1.1, 38, 1, { oscs: [{ type: 'saw', detune: -12 }, { type: 'saw', detune: 12 }, { type: 'square', oct: 1, gain: 0.3 }], a: 0.01, d: 0.3, s: 0.8, r: 0.3, cutoff: 1800, q: 1.5, gain: 0.6, drive: 2.5, vib: 40, vibRate: 30, vibDelay: 0 });
    noiseBurst(o, 0, 1.3, { f0: 5000, f1: 2000, decay: 0.8, gain: 0.35, type: 'hp' });
  }, { rev: 0.25, target: -3 });
  S.sfx_extend = sfxRender(1.2, (o) => {
    [76, 79, 84, 88, 91, 96].forEach((m, i) => fm(o, i * 0.08, 0.1, m, 0.8, { ratio: 3, index: 1.2, d: 0.6, gain: 0.35, pan: (i - 2.5) * 0.25 }));
  }, { rev: 0.4, target: -4 });
  for (const [k, v] of Object.entries(S)) {
    encode(k, v, 4);
    manifest.sfx[k] = `audio/${k}.mp3`;
  }
}

// ---------------------------------------------------------------- main
const t0 = Date.now();
console.log('rendering music…');
encode('bgm_title', titleTheme(), 2);
encode('bgm_stage', stageTheme(), 2);
encode('bgm_boss', bossTheme(), 2);
const v = victory();
encode('jingle_victory', v, 2);
manifest.music.jingle_victory = { file: 'audio/jingle_victory.mp3', loopStart: 0, loopEnd: 0, samples: v.n };
const g = gameOver();
encode('jingle_gameover', g, 2);
manifest.music.jingle_gameover = { file: 'audio/jingle_gameover.mp3', loopStart: 0, loopEnd: 0, samples: g.n };
console.log('rendering sfx…');
renderSfx();
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(ROOT, OUT)}`);
