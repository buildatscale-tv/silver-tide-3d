// Player ship, pooled enemies and power-up orbs.
import * as THREE from 'three';
import { BOUNDS, DESPAWN_X, PLAYER } from '../config';
import { clamp, damp, easeOutCubic, rand } from '../core/math';
import type { PlayerModel, EnemyModel, OrbModel } from '../gfx/models';
import type { EnemyDef, Drop } from './waves';
import type { Stage } from './Stage';

// ------------------------------------------------------------ player
export class Player {
  x = -11;
  y = 0;
  vx = 0;
  vy = 0;
  weapon = 1;
  shield = 0;
  bombs: number = PLAYER.startBombs;
  alive = true;
  invulnUntil = 0;
  nextFire = 0;
  private enterT = 0;
  private bank = 0;
  private pitch = 0;
  private throttle = 0.6;
  private shieldPulse = 0;
  private light: THREE.PointLight;

  constructor(readonly model: PlayerModel, parent: THREE.Object3D) {
    parent.add(model.root);
    this.light = new THREE.PointLight(0x5fd8ff, 3, 6, 1.6);
    this.light.position.set(-2.8, 0, 0.9);
    model.root.add(this.light);
  }

  reset(time: number) {
    this.weapon = 1;
    this.shield = 0;
    this.bombs = PLAYER.startBombs;
    this.respawn(time);
  }

  respawn(time: number) {
    this.alive = true;
    this.enterT = 1.1;
    this.x = -21;
    this.y = 0;
    this.vx = this.vy = 0;
    this.invulnUntil = time + PLAYER.invulnSpawn + 1.1;
    this.model.root.visible = true;
  }

  get entering() {
    return this.enterT > 0;
  }

  invulnerable(time: number) {
    return time < this.invulnUntil;
  }

  fireCooldown() {
    return PLAYER.fireBase - (this.weapon - 1) * 0.022;
  }

  hitShield() {
    this.shieldPulse = 1;
  }

  kill() {
    this.alive = false;
    this.model.root.visible = false;
  }

  /** Title-screen idle: hover in place with engines running. */
  idle(dt: number, time: number) {
    this.model.root.visible = true;
    this.model.root.position.set(0, Math.sin(time * 1.3) * 0.25, 0);
    this.model.body.rotation.set(Math.sin(time * 0.9) * 0.12, 0, Math.sin(time * 1.3 + 1) * 0.04);
    this.animateFlames(dt, time, 0.8);
    this.model.shield.visible = false;
  }

  /** `free` skips the bounds clamp (stage-clear fly-off). */
  update(dt: number, time: number, ax: number, ay: number, free = false) {
    if (!this.alive) return;
    const root = this.model.root;
    if (this.enterT > 0) {
      this.enterT = Math.max(0, this.enterT - dt);
      const k = easeOutCubic(1 - this.enterT / 1.1);
      this.x = -21 + (-11 + 21) * k;
      this.vx = PLAYER.speed;
      this.vy = 0;
      ax = 1;
      ay = 0;
    } else {
      this.vx = ax * PLAYER.speed;
      this.vy = ay * PLAYER.speed;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (!free) {
        this.x = clamp(this.x, BOUNDS.minX, BOUNDS.maxX);
        this.y = clamp(this.y, BOUNDS.minY, BOUNDS.maxY);
      }
    }
    root.position.set(this.x, this.y, 0);
    this.bank = damp(this.bank, ay * 0.62, 7, dt);
    this.pitch = damp(this.pitch, ay * 0.1 - ax * 0.03, 6, dt);
    this.model.body.rotation.set(this.bank, -0.16, this.pitch);
    this.throttle = damp(this.throttle, ax > 0.1 ? 1.25 : ax < -0.1 ? 0.35 : 0.7, 5, dt);
    this.animateFlames(dt, time, this.throttle);

    // Shield bubble.
    const sh = this.model.shield;
    this.shieldPulse = Math.max(0, this.shieldPulse - dt * 2.5);
    sh.visible = this.shield > 0 || this.shieldPulse > 0;
    this.model.shieldMat.uniforms.uTime.value = time;
    this.model.shieldMat.uniforms.uAlpha.value = (0.45 + 0.15 * Math.sin(time * 9)) * (this.shield > 0 ? 1 : 0.5) + this.shieldPulse * 1.5;

    // Blink while invulnerable.
    root.visible = !this.invulnerable(time) || this.entering || Math.floor(time * 16) % 2 === 0;
  }

  private animateFlames(_dt: number, time: number, power: number) {
    const m = this.model;
    m.flameMat.uniforms.uTime.value = time;
    m.flameMat.uniforms.uPower.value = 0.7 + power * 0.4;
    for (let i = 0; i < m.flames.length; i++) {
      const f = m.flames[i];
      const flick = 1 + Math.sin(time * 47 + i * 2.1) * 0.08 + Math.sin(time * 23 + i) * 0.06;
      f.scale.x = (0.5 + power * 0.9) * flick * (i === 2 ? 1.2 : 1);
    }
    this.light.intensity = 1.5 + power * 2;
  }
}

// ------------------------------------------------------------ enemies
export class Enemy {
  active = false;
  def!: EnemyDef;
  hp = 0;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  t = 0;
  drop: Drop = 'none';
  entering = 0;
  private enterFrom = new THREE.Vector3();
  private enterTo = new THREE.Vector3();
  private holdX = 0;
  private holding = false;
  private holdUntil = 0;
  private nextFire = 0;
  private spin = 0;

  constructor(readonly model: EnemyModel, parent: THREE.Object3D) {
    model.root.visible = false;
    parent.add(model.root);
  }

  get collidable() {
    return this.active && this.entering <= 0;
  }

  spawn(def: EnemyDef, x: number, y: number, drop: Drop, depth: boolean, hpScale: number) {
    this.def = def;
    this.active = true;
    this.hp = Math.ceil(def.hp * hpScale);
    this.drop = drop;
    this.t = 0;
    this.holding = false;
    this.holdX = rand(3.2, 6.5);
    this.nextFire = (def.fireEvery ?? 1.2) * rand(0.5, 1);
    this.spin = rand(0, 6);
    this.vx = -def.speed;
    this.vy = 0;
    if (depth) {
      this.entering = 1.5;
      this.enterTo.set(rand(9, 13), y, 0);
      this.enterFrom.set(this.enterTo.x + 16, y + rand(-2, 6), -42);
      this.x = this.enterFrom.x;
      this.y = this.enterFrom.y;
      this.z = this.enterFrom.z;
    } else {
      this.entering = 0;
      this.x = x;
      this.y = y;
      this.z = 0;
    }
    this.model.root.visible = true;
    this.model.root.position.set(this.x, this.y, this.z);
    this.model.root.rotation.set(0, 0, 0);
  }

  despawn() {
    this.active = false;
    this.model.root.visible = false;
  }

  update(dt: number, s: Stage) {
    if (!this.active) return;
    this.t += dt;
    const d = this.def;
    const w = d.freq ?? 0;
    const amp = d.amp ?? 0;
    const t = this.t;

    if (this.entering > 0) {
      // Fly in from the background along an arc, then join the play plane.
      this.entering = Math.max(0, this.entering - dt);
      const k = easeOutCubic(1 - this.entering / 1.5);
      const px = this.x;
      const py = this.y;
      this.x = THREE.MathUtils.lerp(this.enterFrom.x, this.enterTo.x, k);
      this.y = THREE.MathUtils.lerp(this.enterFrom.y, this.enterTo.y, k) + Math.sin(k * Math.PI) * 2.5;
      this.z = THREE.MathUtils.lerp(this.enterFrom.z, 0, k);
      this.vx = (this.x - px) / Math.max(dt, 1e-4);
      this.vy = (this.y - py) / Math.max(dt, 1e-4);
      if (this.entering <= 0) {
        this.t = 0;
        this.z = 0;
      }
    } else {
      switch (d.move) {
        case 'straight':
          this.vx = -d.speed;
          this.vy = 0;
          break;
        case 'sine':
        case 'drift':
          this.vx = -d.speed;
          this.vy = amp * w * Math.cos(w * t);
          break;
        case 'swoop':
          this.vx = -d.speed * (0.8 + 0.3 * Math.sin(w * t));
          this.vy = amp * w * Math.cos(w * t);
          break;
        case 'dive':
          this.vx = -d.speed;
          this.vy = Math.min(amp, 2 + 3 * t) * Math.sign(Math.cos(w * t + 0.6));
          break;
        case 'hover':
          if (!this.holding && this.x <= this.holdX) {
            this.holding = true;
            this.holdUntil = t + 3.2;
          }
          if (this.holding && t < this.holdUntil) {
            this.vx = 0;
            this.vy = amp * w * Math.cos(w * t);
          } else {
            this.vx = -d.speed;
            this.vy = 0;
          }
          break;
      }
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.fire(dt, s);
    }

    this.animate(dt, s);

    if (this.x < DESPAWN_X || this.y < -15 || this.y > 15) this.despawn();
  }

  private fire(dt: number, s: Stage) {
    const d = this.def;
    if (!d.fireEvery || !d.fire || d.fire === 'none') return;
    this.nextFire -= dt;
    if (this.nextFire > 0) return;
    this.nextFire = d.fireEvery / s.difficulty;
    if (this.x > 15.5 || this.x < -14) return;
    const p = s.player;
    const bs = (d.bulletSpeed ?? 7) * (0.9 + s.difficulty * 0.1);
    const ax = p.alive ? p.x - this.x : -1;
    const ay = p.alive ? p.y - this.y : 0;
    const a = Math.atan2(ay, ax);
    if (d.fire === 'straight') s.fireEnemyBullet(this.x - 0.6, this.y, -bs, 0);
    else if (d.fire === 'aimed') s.fireEnemyBullet(this.x, this.y, Math.cos(a) * bs, Math.sin(a) * bs);
    else if (d.fire === 'spread') {
      const mx = this.x + Math.cos(a) * 1.9;
      const my = this.y + Math.sin(a) * 1.9;
      for (const off of [-0.26, 0, 0.26]) s.fireEnemyBullet(mx, my, Math.cos(a + off) * bs, Math.sin(a + off) * bs);
      s.effects.muzzle(mx, my, true);
    }
  }

  private animate(dt: number, s: Stage) {
    const r = this.model.root;
    r.position.set(this.x, this.y, this.z);
    const p = this.model.parts;
    const t = this.t;
    const heading = Math.atan2(this.vy, -this.vx || -0.001);
    switch (this.def.kind) {
      case 'drone':
        this.spin += dt * (this.def.move === 'sine' ? 4 : 2.5);
        p.spin.rotation.x = this.spin;
        r.rotation.z = -heading * 0.6;
        r.rotation.y = 0.3 + (this.entering > 0 ? -0.5 : 0);
        break;
      case 'fish': {
        const chomp = Math.max(0, Math.sin(t * 7));
        p.jaw.rotation.z = 0.05 + chomp * 0.32;
        p.tail.rotation.y = Math.sin(t * 9) * 0.45;
        r.rotation.z = -heading * 0.7;
        r.rotation.x = Math.sin(t * 2.3) * 0.18;
        r.rotation.y = 0.38 + Math.sin(t * 9) * 0.06 + (this.entering > 0 ? -0.5 : 0);
        break;
      }
      case 'manta': {
        const flap = Math.sin(t * 4.2);
        p.wl.rotation.x = -flap * 0.42;
        p.wr.rotation.x = flap * 0.42;
        r.rotation.z = -heading * 0.5;
        r.rotation.x = 0.35 + this.vy * 0.05;
        break;
      }
      case 'turret': {
        const pl = s.player;
        const aim = Math.atan2(pl.y - this.y, pl.x - this.x);
        p.barrel.rotation.z = aim + Math.PI;
        p.yaw.rotation.y = Math.sin(t * 0.9) * 0.28;
        p.yaw.rotation.x = Math.sin(t * 0.7) * 0.12;
        break;
      }
      case 'mine':
        p.spin.rotation.x += dt * 0.8;
        p.spin.rotation.y += dt * 1.1;
        (p.glow as THREE.Sprite).material.opacity = 0.5 + 0.5 * Math.max(0, Math.sin(t * 6));
        break;
    }
    this.model.flasher.update(s.time);
    if (this.model.flameMat) this.model.flameMat.uniforms.uTime.value = s.time;
  }
}

// ------------------------------------------------------------ power-ups
export type PowerKind = 'P' | 'S' | 'B';

export class PowerUp {
  active = false;
  x = 0;
  y = 0;
  t = 0;
  constructor(readonly kind: PowerKind, readonly model: OrbModel, parent: THREE.Object3D) {
    model.root.visible = false;
    parent.add(model.root);
  }
  spawn(x: number, y: number) {
    this.active = true;
    this.x = x;
    this.y = y;
    this.t = 0;
    this.model.root.visible = true;
  }
  kill() {
    this.active = false;
    this.model.root.visible = false;
  }
  update(dt: number, time: number) {
    if (!this.active) return;
    this.t += dt;
    this.x += -2.3 * dt;
    this.y += Math.cos(this.t * 3) * 1.6 * dt;
    const r = this.model.root;
    r.position.set(this.x, this.y, 0);
    r.scale.setScalar(0.95 + 0.08 * Math.sin(time * 8));
    this.model.ring.rotation.set(time * 1.7, time * 2.3, 0);
    r.children[1].rotation.set(time * 1.3, time * 0.9, 0);
    this.model.shellMat.uniforms.uTime.value = time;
    if (this.x < -18) this.kill();
  }
}
