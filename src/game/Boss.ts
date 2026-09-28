// KING FOSSIL: a colossal mechanical coelacanth. Rises from the trench,
// fights in three phases (aimed shots, fans, radial bursts, minions, gun pods,
// a sweeping mouth laser and a lunge), sheds armor between phases, and sinks
// in a chain of explosions when destroyed.
import * as THREE from 'three';
import { hdr } from '../gfx/materials';
import type { BossModel } from '../gfx/models';
import { clamp, damp, easeInOutCubic, rand } from '../core/math';
import type { Stage } from './Stage';

type State = 'enter' | 'fight' | 'shift' | 'dying' | 'dead';

const HOME_X = 8.2;

/** Shortest signed angle from a to b. */
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const SCALE = 1.25;

const LASER_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LASER_FS = /* glsl */ `
uniform float uTime;
uniform float uMode;   // 0 = warning line, 1 = full beam
uniform float uFade;
varying vec2 vUv;
void main() {
  float y = clamp(abs(vUv.y - 0.5) * 2.0, 0.0, 1.0);
  float warn = smoothstep(0.25, 0.0, y) * (0.5 + 0.5 * step(0.5, fract(uTime * 14.0)));
  float core = smoothstep(0.35, 0.0, y);
  float glow = pow(1.0 - y, 2.5);
  float wob = 0.85 + 0.15 * sin(vUv.x * 80.0 - uTime * 60.0);
  vec3 beam = vec3(4.5, 4.0, 3.6) * core * wob + vec3(3.2, 0.7, 0.35) * glow;
  vec3 c = mix(vec3(3.0, 0.4, 0.3) * warn, beam, uMode);
  float tip = smoothstep(0.0, 0.03, vUv.x);
  gl_FragColor = vec4(c * uFade * tip, 0.0);
}`;

export class Boss {
  state: State = 'enter';
  maxHp: number;
  hp: number;
  x = 22;
  y = -16;
  z = -60;
  t = 0;
  private stateT = 0;
  private phaseSeen = 1;
  podHp = [0, 0];
  private podMax: number;
  private timers = { aim: 1.2, fan: 2.6, radial: 3.2, summon: 5, pod: 2, laser: 6, lunge: 9 };
  private jaw = 0;
  private jawTarget = 0;
  private laser: THREE.Mesh;
  private laserMat: THREE.ShaderMaterial;
  private laserState: 'idle' | 'charge' | 'fire' = 'idle';
  private laserT = 0;
  private laserAngle = Math.PI;
  private lungeT = -1;
  private lastHitSfx = 0;
  private lastFlash = 0;
  private wobble = 1;
  private hx: number[] = [];
  private hy: number[] = [];
  private hr: number[] = [];
  private tmp = new THREE.Vector3();
  mouth = new THREE.Vector3();
  corePos = new THREE.Vector3();
  private deathTimer = 0;

  constructor(readonly model: BossModel, private s: Stage, parent: THREE.Object3D, hpScale: number) {
    this.maxHp = Math.round(900 * hpScale);
    this.hp = this.maxHp;
    this.podMax = Math.round(45 * hpScale);
    this.podHp = [this.podMax, this.podMax];
    parent.add(model.root);
    model.root.scale.setScalar(SCALE);
    model.root.visible = true;
    for (const p of model.pods) p.visible = true;
    for (const pl of model.plates) pl.visible = true;
    this.laserMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uMode: { value: 0 }, uFade: { value: 0 } },
      vertexShader: LASER_VS,
      fragmentShader: LASER_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    const lg = new THREE.PlaneGeometry(60, 1.6);
    lg.translate(30, 0, 0);
    this.laser = new THREE.Mesh(lg, this.laserMat);
    this.laser.visible = false;
    this.laser.renderOrder = 40;
    this.laser.frustumCulled = false;
    parent.add(this.laser);
    this.model.mouthGlow.visible = false;
    this.model.coreMat.color.copy(hdr(0x40e8ff, 4));
    this.pose(0);
  }

  get phase(): 1 | 2 | 3 {
    const f = this.hp / this.maxHp;
    return f > 0.66 ? 1 : f > 0.33 ? 2 : 3;
  }

  get vulnerable() {
    return this.state === 'fight';
  }

  get alive() {
    return this.state !== 'dead';
  }

  dispose() {
    this.model.root.removeFromParent();
    this.laser.removeFromParent();
    this.laser.geometry.dispose();
    this.laserMat.dispose();
  }

  // ------------------------------------------------------------ pose + hitboxes
  private pose(dt: number) {
    const m = this.model;
    const r = m.root;
    r.position.set(this.x, this.y, this.z);
    const w = this.t * (1.7 * this.wobble);
    // head
    m.head.rotation.z = 0.06 * Math.sin(w + 0.9) + (this.state === 'enter' ? 0.25 * (1 - this.stateT / 5.5) : 0);
    this.jaw = damp(this.jaw, this.jawTarget, 10, dt);
    m.jaw.rotation.z = 0.02 + this.jaw * 0.5;
    // spine
    let jx = 0;
    let jy = 0;
    for (let k = 0; k < m.segs.length; k++) {
      const a = (0.1 + 0.05 * k) * Math.sin(w - k * 0.9) * (this.state === 'dying' ? 1.8 : 1);
      const g = m.segs[k];
      g.position.set(jx, jy, 0);
      g.rotation.z = a;
      g.rotation.y = 0.05 * Math.sin(w * 0.7 - k * 0.8);
      jx += Math.cos(a) * m.segLen[k];
      jy += Math.sin(a) * m.segLen[k];
    }
    m.tail.rotation.y = Math.sin(w * 1.2) * 0.25;
    for (const g of m.gears) g.rotation.z += dt * 2.2;
    const eyeK = 2 + Math.sin(this.t * 6) * 0.4 + (this.phase === 3 ? 1.2 : 0);
    for (const e of m.eyes) e.scale.setScalar(eyeK);
    m.core.rotation.y += dt * 1.5;
    m.core.rotation.x += dt * 0.9;
    r.updateMatrixWorld(true);

    // hitboxes in world space
    this.hx.length = this.hy.length = this.hr.length = 0;
    for (const h of m.hit) {
      h.obj.getWorldPosition(this.tmp);
      this.hx.push(this.tmp.x);
      this.hy.push(this.tmp.y);
      this.hr.push(h.r * SCALE);
    }
    m.mouthMarker.getWorldPosition(this.mouth);
    m.core.getWorldPosition(this.corePos);
    m.flasher.update(this.s.time);
  }

  // ------------------------------------------------------------ damage
  /** Test a bullet; applies damage and returns true on a hit. */
  hitTest(bx: number, by: number, br: number, dmg: number): boolean {
    if (this.state === 'dead' || this.state === 'dying' || this.z < -3) return false;
    const m = this.model;
    for (let i = 0; i < m.hit.length; i++) {
      const h = m.hit[i];
      if (h.kind === 'pod' && this.podHp[h.pod!] <= 0) continue;
      const dx = bx - this.hx[i];
      const dy = by - this.hy[i];
      const rr = this.hr[i] + br;
      if (dx * dx + dy * dy > rr * rr) continue;
      if (!this.vulnerable) {
        this.s.effects.hitSpark(bx, by, new THREE.Color(1.2, 1.6, 2.2));
        return true;
      }
      if (h.kind === 'pod') this.damagePod(h.pod!, dmg, bx, by);
      else this.damage(h.kind === 'core' ? dmg * 2 : dmg, bx, by, h.kind === 'core');
      return true;
    }
    return false;
  }

  /** Player body contact. */
  touches(px: number, py: number, rx: number, ry: number): boolean {
    if (this.state === 'dead' || this.state === 'dying' || this.z < -3) return false;
    for (let i = 0; i < this.hx.length; i++) {
      const h = this.model.hit[i];
      if (h.kind === 'pod' && this.podHp[h.pod!] <= 0) continue;
      const r = this.hr[i] * 0.85;
      const dx = (px - this.hx[i]) / (rx + r);
      const dy = (py - this.hy[i]) / (ry + r);
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  }

  laserHits(px: number, py: number): boolean {
    if (this.laserState !== 'fire' || this.laserT < 0.08) return false;
    const dx = px - this.mouth.x;
    const dy = py - this.mouth.y;
    const ux = Math.cos(this.laserAngle);
    const uy = Math.sin(this.laserAngle);
    const along = dx * ux + dy * uy;
    if (along < 0) return false;
    const perp = Math.abs(dx * uy - dy * ux);
    return perp < 0.62;
  }

  damage(dmg: number, x: number, y: number, crit = false) {
    if (!this.vulnerable) return;
    this.hp = Math.max(0, this.hp - dmg);
    // Strobe instead of a constant tint so sustained fire still reads as hits.
    if (this.s.time - this.lastFlash > 0.14) {
      this.lastFlash = this.s.time;
      this.model.flasher.flash(this.s.time, 0.04, crit ? 0x3fb8ff : 0xffc0a0, crit ? 0.6 : 0.22);
    }
    this.s.effects.hitSpark(x, y, crit ? new THREE.Color(1.2, 3, 4) : undefined);
    if (this.s.time - this.lastHitSfx > 0.06) {
      this.s.audio.sfx('sfx_boss_hit', { vol: 0.45, pan: x / 20, rate: crit ? 1.25 : rand(0.95, 1.05), throttle: 0.05 });
      this.lastHitSfx = this.s.time;
    }
    if (this.hp <= 0) this.beginDeath();
    else if (this.phase > this.phaseSeen) this.beginShift();
  }

  damagePod(i: number, dmg: number, x: number, y: number) {
    if (this.podHp[i] <= 0) return;
    this.podHp[i] -= dmg;
    this.s.effects.hitSpark(x, y);
    this.model.flasher.flash(this.s.time, 0.04, 0xffb090, 0.3);
    if (this.podHp[i] <= 0) {
      const p = this.model.pods[i];
      p.getWorldPosition(this.tmp);
      this.s.effects.explode(this.tmp.x, this.tmp.y, this.tmp.z, 1.3, 'plasma');
      this.s.audio.sfx('sfx_explode_big', { vol: 0.8, pan: this.tmp.x / 20 });
      p.visible = false;
      this.s.addScore(5000, this.tmp.x, this.tmp.y);
      this.s.spawnPowerup(this.tmp.x, this.tmp.y, i === 0 ? 'P' : 'S');
    }
  }

  /** Bomb damage: core + pods. */
  bomb() {
    if (!this.vulnerable) return;
    this.damage(45, this.corePos.x, this.corePos.y);
    for (let i = 0; i < 2; i++) this.damagePod(i, 20, this.hx[0], this.hy[0]);
  }

  private beginShift() {
    this.phaseSeen = this.phase;
    this.state = 'shift';
    this.stateT = 0;
    this.stopLaser();
    this.jawTarget = 1;
    this.s.audio.sfx('sfx_boss_roar', { vol: 0.9 });
    this.s.audio.duck(0.5, 1.4);
    this.s.rig.shake(0.6);
    this.s.renderer.kickAberration(0.8);
    // Blow off armor plates to expose the glowing frame.
    const m = this.model;
    const idx = this.phase === 2 ? [0, 2] : [1, 3, 4];
    for (const i of idx) {
      const pl = m.plates[i];
      if (!pl.visible) continue;
      pl.visible = false;
      m.segs[i].getWorldPosition(this.tmp);
      this.s.effects.explode(this.tmp.x + 1, this.tmp.y, this.tmp.z + 1, 1.4, 'fire');
      this.s.effects.debris.burst(this.tmp.x + 1, this.tmp.y, 1, 8, 9, 0.7);
    }
    this.s.audio.sfx('sfx_explode_big', { vol: 0.9 });
    if (this.phase === 3) {
      m.flasher.tint(new THREE.Color(0x8a1010), 0.35);
      m.coreMat.color.copy(hdr(0xff4040, 5));
      this.wobble = 1.5;
    } else {
      this.wobble = 1.2;
    }
  }

  private beginDeath() {
    this.state = 'dying';
    this.stateT = 0;
    this.deathTimer = 0;
    this.stopLaser();
    this.jawTarget = 1;
    this.model.mouthGlow.visible = false;
    this.s.audio.sfx('sfx_boss_explode', { vol: 1 });
    this.s.audio.stopMusic(1.5);
    this.s.onBossDying();
  }

  private stopLaser() {
    this.laserState = 'idle';
    this.laser.visible = false;
    this.model.mouthGlow.visible = false;
  }

  // ------------------------------------------------------------ attacks
  private aimAt(fx: number, fy: number) {
    const p = this.s.player;
    return p.alive ? Math.atan2(p.y - fy, p.x - fx) : Math.PI;
  }

  private fireAimed(speed: number, big: boolean) {
    const m = this.mouth;
    const a = this.aimAt(m.x, m.y);
    this.s.fireEnemyBullet(m.x, m.y, Math.cos(a) * speed, Math.sin(a) * speed, big);
    this.s.effects.muzzle(m.x, m.y, true);
    this.jawTarget = Math.max(this.jawTarget, 0.5);
  }

  private fireFan(count: number, spread: number, speed: number, big: boolean) {
    const m = this.mouth;
    const c = this.aimAt(m.x, m.y);
    for (let i = 0; i < count; i++) {
      const a = c + THREE.MathUtils.lerp(-spread, spread, count === 1 ? 0.5 : i / (count - 1));
      this.s.fireEnemyBullet(m.x, m.y, Math.cos(a) * speed, Math.sin(a) * speed, big);
    }
    this.s.effects.muzzle(m.x, m.y, true);
    this.jawTarget = 1;
    this.s.audio.sfx('sfx_enemy_shot', { vol: 0.5, rate: 0.7 });
  }

  private fireRadial(count: number, speed: number) {
    const c = this.corePos;
    const off = this.t * 0.7;
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + off;
      this.s.fireEnemyBullet(c.x, c.y, Math.cos(a) * speed, Math.sin(a) * speed, false, true);
    }
    this.s.effects.particles.emit({ x: c.x, y: c.y, z: 0.5, life: 0.35, size0: 1, size1: 4.5, c0: new THREE.Color(0.6, 2.4, 3.2), a0: 1, a1: 0, type: 2 });
    this.s.audio.sfx('sfx_shoot_big', { vol: 0.5, rate: 0.6 });
  }

  private firePods() {
    for (let i = 0; i < 2; i++) {
      if (this.podHp[i] <= 0) continue;
      const p = this.model.pods[i];
      p.getWorldPosition(this.tmp);
      const x = this.tmp.x - 1.2;
      const y = this.tmp.y;
      const a = this.aimAt(x, y);
      const sp = 6.4 * (0.9 + this.s.difficulty * 0.1);
      for (const o of [-0.2, 0, 0.2]) this.s.fireEnemyBullet(x, y, Math.cos(a + o) * sp, Math.sin(a + o) * sp);
      this.s.effects.muzzle(x, y, false);
    }
  }

  private updateLaser(dt: number) {
    const mat = this.laserMat;
    mat.uniforms.uTime.value = this.s.time;
    if (this.laserState === 'idle') return;
    this.laserT += dt;
    const m = this.mouth;
    this.laser.position.set(m.x, m.y, 0.2);
    if (this.laserState === 'charge') {
      // Track the player while charging, then lock.
      this.laserAngle += angDiff(this.laserAngle, this.aimAt(m.x, m.y)) * (1 - Math.exp(-dt * 4));
      this.laser.rotation.z = this.laserAngle;
      this.laser.scale.set(1, 0.35, 1);
      mat.uniforms.uMode.value = 0;
      mat.uniforms.uFade.value = Math.min(1, this.laserT * 3);
      const g = this.model.mouthGlow;
      g.visible = true;
      g.scale.setScalar(1 + this.laserT * 3.2 + Math.sin(this.s.time * 40) * 0.2);
      this.jawTarget = 1;
      if (this.laserT >= 1.1) {
        this.laserState = 'fire';
        this.laserT = 0;
        this.s.audio.sfx('sfx_laser', { vol: 0.9 });
        this.s.rig.shake(0.35);
      }
    } else {
      this.laserAngle += Math.sign(angDiff(this.laserAngle, this.aimAt(m.x, m.y))) * dt * 0.12;
      this.laser.rotation.z = this.laserAngle;
      const k = Math.min(1, this.laserT * 8) * Math.min(1, (1.4 - this.laserT) * 5);
      this.laser.scale.set(1, 0.4 + k * 0.9, 1);
      mat.uniforms.uMode.value = 1;
      mat.uniforms.uFade.value = k;
      this.model.mouthGlow.scale.setScalar(4 + Math.sin(this.s.time * 50) * 0.4);
      if (Math.random() < 0.5) {
        const d = rand(2, 30);
        this.s.effects.particles.emit({
          x: m.x + Math.cos(this.laserAngle) * d, y: m.y + Math.sin(this.laserAngle) * d, z: rand(-0.3, 0.3),
          vx: rand(-2, 2), vy: rand(-2, 2), life: 0.3, size0: 0.4, size1: 0.1, c0: new THREE.Color(3, 1, 0.4), a0: 1, a1: 0, type: 0,
        });
      }
      if (this.laserT >= 1.4) this.stopLaser();
    }
    this.laser.visible = true;
  }

  // ------------------------------------------------------------ frame
  update(dt: number) {
    this.t += dt;
    this.stateT += dt;
    this.jawTarget = Math.max(0, this.jawTarget - dt * 1.6);
    const ph = this.phase;

    if (this.state === 'enter') {
      const k = easeInOutCubic(clamp(this.stateT / 5.5, 0, 1));
      // Rise from the trench on a curve toward the arena.
      this.x = THREE.MathUtils.lerp(24, HOME_X, k);
      this.y = THREE.MathUtils.lerp(-18, 0, k) + Math.sin(k * Math.PI) * 5;
      this.z = THREE.MathUtils.lerp(-62, 0, k);
      if (this.stateT > 1.2 && this.stateT - dt <= 1.2) {
        this.s.audio.sfx('sfx_boss_roar', { vol: 1 });
        this.jawTarget = 1;
        this.s.rig.shake(0.5);
      }
      if (this.stateT >= 5.5) {
        this.state = 'fight';
        this.stateT = 0;
      }
    } else if (this.state === 'fight' || this.state === 'shift') {
      // Menacing hover + optional lunge.
      let tx = HOME_X + Math.sin(this.t * 0.7) * 1.1;
      const ty = Math.sin(this.t * 1.1 * this.wobble) * 2.3 * (ph === 3 ? 1.25 : 1);
      if (this.lungeT >= 0) {
        this.lungeT += dt;
        const l = this.lungeT;
        const push = l < 0.6 ? -0.4 * (l / 0.6) : l < 1.3 ? -0.4 + 1.4 * easeInOutCubic((l - 0.6) / 0.7) : 1 - easeInOutCubic(Math.min(1, (l - 1.3) / 1.2));
        tx -= push * 6.5;
        if (l > 2.5) this.lungeT = -1;
      }
      this.x = damp(this.x, tx, 3, dt);
      this.y = damp(this.y, ty, 2.5, dt);
      this.z = damp(this.z, 0, 3, dt);

      if (this.state === 'shift') {
        this.jawTarget = 1;
        if (this.stateT > 1.4) {
          this.state = 'fight';
          this.stateT = 0;
        }
      } else {
        this.attack(dt, ph);
      }
    } else if (this.state === 'dying') {
      this.dying(dt);
    }

    this.updateLaser(dt);
    this.pose(dt);
    this.s.env.pulseFog(this.state === 'fight' && ph === 3 ? 0.5 + 0.5 * Math.sin(this.t * 3) : 0);
  }

  private attack(dt: number, ph: 1 | 2 | 3) {
    const T = this.timers;
    const diff = this.s.difficulty;
    for (const k of Object.keys(T) as (keyof typeof T)[]) T[k] -= dt * diff;
    const busy = this.laserState !== 'idle' || this.lungeT >= 0;

    if (T.aim <= 0) {
      T.aim = ph === 1 ? 1.1 : ph === 2 ? 0.8 : 0.56;
      if (!busy) this.fireAimed(ph === 3 ? 10 : 8.3, ph === 3);
    }
    if (T.fan <= 0) {
      T.fan = ph === 1 ? 2.6 : ph === 2 ? 2.0 : 1.6;
      if (!busy) this.fireFan(ph === 1 ? 5 : ph === 2 ? 7 : 9, 0.55, 7, ph === 3);
    }
    if (T.radial <= 0) {
      T.radial = ph === 1 ? 999 : ph === 2 ? 3.0 : 2.3;
      if (ph > 1) this.fireRadial(ph === 2 ? 12 : 16, 6);
    }
    if (T.summon <= 0) {
      T.summon = ph === 1 ? 999 : ph === 2 ? 5.2 : 4.4;
      if (ph > 1) this.s.spawnMinion(this.mouth.x - 0.5, this.mouth.y + rand(-1.3, 1.3));
    }
    if (T.pod <= 0) {
      T.pod = 2.3;
      this.firePods();
    }
    if (T.laser <= 0) {
      T.laser = ph === 1 ? 999 : ph === 2 ? 8.5 : 6.2;
      if (ph > 1 && this.lungeT < 0) {
        this.laserState = 'charge';
        this.laserT = 0;
        this.laserAngle = this.aimAt(this.mouth.x, this.mouth.y);
        this.s.audio.sfx('sfx_laser_charge', { vol: 0.8 });
      }
    }
    if (T.lunge <= 0) {
      T.lunge = 9.5;
      if (ph === 3 && this.laserState === 'idle') {
        this.lungeT = 0;
        this.jawTarget = 1;
        this.s.audio.sfx('sfx_boss_roar', { vol: 0.6, rate: 1.2 });
      }
    }
  }

  private dying(dt: number) {
    this.deathTimer += dt;
    const m = this.model;
    // Sink and roll.
    this.y -= dt * (0.6 + this.stateT * 1.1);
    this.x += dt * 0.6;
    m.root.rotation.x += dt * 0.35;
    m.root.rotation.z -= dt * 0.08;
    this.jawTarget = 1;
    if (this.deathTimer > 0.13 && this.stateT < 3.3) {
      this.deathTimer = 0;
      const i = Math.floor(Math.random() * this.hx.length);
      const x = this.hx[i] + rand(-0.8, 0.8);
      const y = this.hy[i] + rand(-0.8, 0.8);
      this.s.effects.explode(x, y, rand(-1, 1.5), rand(0.8, 1.6), Math.random() < 0.3 ? 'plasma' : 'boss');
      this.s.audio.sfx('sfx_explode', { vol: 0.7, pan: x / 20, rate: rand(0.8, 1.1), throttle: 0.08 });
      m.flasher.flash(this.s.time, 0.05, 0xffc0a0, 0.6);
    }
    if (this.stateT >= 3.6) {
      this.s.effects.explode(this.hx[0], this.hy[0], 1, 4.2, 'boss');
      this.s.effects.explode(this.corePos.x, this.corePos.y, 1, 3, 'plasma');
      this.s.effects.shockwave(this.hx[0], this.hy[0], 0);
      this.s.effects.debris.burst(this.hx[0], this.hy[0], 0, 40, 16, 0.9);
      this.s.audio.sfx('sfx_explode_big', { vol: 1 });
      this.s.rig.shake(1);
      this.s.renderer.kickAberration(1.2);
      this.state = 'dead';
      m.root.visible = false;
      this.s.onBossDefeated();
    }
  }
}
