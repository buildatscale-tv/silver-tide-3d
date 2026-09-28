// One play session of Stage 1: timeline, spawning, weapons, collisions,
// scoring, zone changes, the WARNING sequence and the boss fight.
import * as THREE from 'three';
import { EXTENDS, PLAYER, SPAWN_X, STAGE } from '../config';
import { rand } from '../core/math';
import type { AudioEngine } from '../core/AudioEngine';
import type { Input } from '../core/Input';
import type { Renderer } from '../core/Renderer';
import { settings } from '../core/Settings';
import type { Environment } from '../gfx/Environment';
import { BulletBatch } from '../gfx/BulletBatch';
import type { Mats } from '../gfx/materials';
import { buildBoss, buildDrone, buildManta, buildMine, buildOrb, buildPiranha, buildPlayer, buildTurret, type BossModel, type EnemyModel } from '../gfx/models';
import { makeLetterTexture, type TextureSet } from '../gfx/textures';
import { Boss } from './Boss';
import type { CameraRig } from './CameraRig';
import type { Effects, Palette } from './Effects';
import { Enemy, Player, PowerUp, type PowerKind } from './entities';
import { DEFS, STAGE1, type Drop, type EnemyKind, type WaveEvent } from './waves';

export interface ClearResult {
  score: number;
  livesBonus: number;
  bombBonus: number;
  total: number;
  hi: number;
  loop: number;
}

export interface StageHooks {
  message(text: string, kind?: 'stage' | 'info' | 'danger' | 'clear', ms?: number): void;
  popup(text: string, x: number, y: number, color?: string): void;
  zone(index: number): void;
  warning(): void;
  gameOver(score: number, hi: number): void;
  clear(r: ClearResult): void;
}

interface PBullet {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
  big: boolean;
}

interface EBullet {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  big: boolean;
  cyan: boolean;
  age: number;
}

const COL = {
  pShot: new THREE.Color(0.25, 1.5, 3.6),
  pBig: new THREE.Color(3.6, 1.9, 0.35),
  eShot: new THREE.Color(3.2, 0.5, 1.5),
  eBig: new THREE.Color(3.6, 1.1, 0.22),
  eCyan: new THREE.Color(0.35, 2.2, 3.4),
};

const ENEMY_FX: Record<EnemyKind, { size: number; pal: Palette }> = {
  drone: { size: 0.8, pal: 'fire' },
  fish: { size: 0.95, pal: 'fire' },
  manta: { size: 1.05, pal: 'violet' },
  turret: { size: 1.45, pal: 'fire' },
  mine: { size: 1.15, pal: 'plasma' },
};

export class Stage {
  readonly group = new THREE.Group();
  readonly player: Player;
  private pools: Record<EnemyKind, Enemy[]>;
  private enemies: Enemy[] = [];
  private pb: PBullet[] = [];
  private eb: EBullet[] = [];
  private orbs: PowerUp[] = [];
  private pBatch = new BulletBatch(320);
  private eBatch = new BulletBatch(700);
  private bossModel: BossModel;
  boss: Boss | null = null;

  score = 0;
  hi = 0;
  lives: number = PLAYER.startLives;
  loop = 1;
  /** animation clock (never pauses between phases) */
  time = 0;
  /** stage timeline clock */
  clock = 0;
  phase: 'play' | 'boss' | 'clear' | 'over' = 'play';
  zone = 0;
  timeScale = 1;
  private slowT = 0;
  private waveIdx = 0;
  private pending: { at: number; fn: () => void }[] = [];
  private extendIdx = 0;
  private scrollSpeed: number = STAGE.scrollSpeed;
  private warned = false;
  private clearT = -1;
  private overT = -1;
  private respawnT = -1;
  private bubbleT = 0;
  private autopilot = false;
  /** Dev flag: the player cannot be hit. */
  god = false;

  constructor(
    scene: THREE.Scene,
    readonly env: Environment,
    readonly effects: Effects,
    readonly audio: AudioEngine,
    readonly rig: CameraRig,
    readonly renderer: Renderer,
    mats: Mats,
    tex: TextureSet,
    private hooks: StageHooks,
  ) {
    scene.add(this.group);
    this.group.add(this.pBatch.mesh, this.eBatch.mesh);
    this.player = new Player(buildPlayer(mats), this.group);
    const g = tex.glow;
    const mk = (n: number, f: () => EnemyModel) => Array.from({ length: n }, () => new Enemy(f(), this.group));
    this.pools = {
      drone: mk(34, () => buildDrone(mats, g)),
      fish: mk(18, () => buildPiranha(mats, g)),
      manta: mk(10, () => buildManta(mats, g)),
      turret: mk(6, () => buildTurret(mats, g)),
      mine: mk(8, () => buildMine(mats, g)),
    };
    for (const k of Object.keys(this.pools) as EnemyKind[]) this.enemies.push(...this.pools[k]);
    for (let i = 0; i < 320; i++) this.pb.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, dmg: 1, big: false });
    for (let i = 0; i < 700; i++) this.eb.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, big: false, cyan: false, age: 0 });
    const kinds: [PowerKind, string, number, number][] = [
      ['P', '#ff5a6a', 0xff4d5e, 6],
      ['S', '#54f27a', 0x54f27a, 4],
      ['B', '#7fb2ff', 0x5a8cff, 4],
    ];
    for (const [k, css, hex, n] of kinds) {
      const lt = makeLetterTexture(k, css);
      for (let i = 0; i < n; i++) this.orbs.push(new PowerUp(k, buildOrb(mats, lt, hex, g), this.group));
    }
    this.bossModel = buildBoss(mats, g);
    this.bossModel.root.visible = false;
    this.group.add(this.bossModel.root);
    this.group.visible = false;
  }

  get difficulty() {
    return 1 + (this.loop - 1) * 0.3;
  }

  private get hpScale() {
    return 1 + (this.loop - 1) * 0.35;
  }

  /** Place one of every model in view so shaders compile during loading. */
  warmup() {
    this.group.visible = true;
    let i = 0;
    for (const k of Object.keys(this.pools) as EnemyKind[]) {
      const e = this.pools[k][0];
      e.model.root.visible = true;
      e.model.root.position.set(-8 + i * 4, 0, 0);
      i++;
    }
    for (const o of this.orbs) o.model.root.visible = true;
    this.bossModel.root.visible = true;
    this.bossModel.root.position.set(8, 0, 0);
  }

  hideAll() {
    for (const e of this.enemies) e.despawn();
    for (const o of this.orbs) o.kill();
    this.bossModel.root.visible = false;
    this.group.visible = false;
  }

  // ------------------------------------------------------------ lifecycle
  start(loop: number, keep?: { score: number; lives: number; weapon: number; shield: number; bombs: number }) {
    this.loop = loop;
    this.score = keep?.score ?? 0;
    this.lives = keep?.lives ?? PLAYER.startLives;
    this.extendIdx = EXTENDS.findIndex((v) => v > this.score);
    if (this.extendIdx < 0) this.extendIdx = EXTENDS.length;
    this.clock = 0;
    this.waveIdx = 0;
    this.pending = [];
    this.phase = 'play';
    this.zone = 0;
    this.warned = false;
    this.clearT = this.overT = this.respawnT = -1;
    this.timeScale = 1;
    this.slowT = 0;
    this.autopilot = false;
    this.scrollSpeed = STAGE.scrollSpeed;
    for (const e of this.enemies) e.despawn();
    for (const b of this.pb) b.active = false;
    for (const b of this.eb) b.active = false;
    for (const o of this.orbs) o.kill();
    this.boss?.dispose();
    this.boss = null;
    this.bossModel.root.visible = false;
    this.group.visible = true;
    this.player.reset(this.time);
    if (keep) {
      this.player.weapon = keep.weapon;
      this.player.shield = keep.shield;
      this.player.bombs = keep.bombs;
    }
    this.effects.particles.clear();
    this.effects.debris.clear();
    this.env.reset({ scroll: 0, trenchU: STAGE.zoneC * STAGE.scrollSpeed + 45 });
    this.env.setZone(0, true);
    this.audio.playMusic('bgm_stage', { fade: 0.4 });
    this.hooks.message(loop > 1 ? `STAGE 1 — LOOP ${loop}` : 'STAGE 1', 'stage', 2200);
    this.hooks.zone(0);
  }

  /** Jump the timeline (dev warp). */
  skipTo(t: number) {
    this.clock = t;
    while (this.waveIdx < STAGE1.length && STAGE1[this.waveIdx].t < t) this.waveIdx++;
    const z = t >= STAGE.zoneC ? 2 : t >= STAGE.zoneB ? 1 : 0;
    this.zone = z;
    this.env.setZone(z, true);
    this.env.reset({ scroll: t * STAGE.scrollSpeed, trenchU: STAGE.zoneC * STAGE.scrollSpeed + 45 });
    this.hooks.zone(z);
  }

  /** Title screen: only the player ship is shown, idling. */
  titleMode() {
    for (const e of this.enemies) e.despawn();
    for (const o of this.orbs) o.kill();
    for (const b of this.pb) b.active = false;
    for (const b of this.eb) b.active = false;
    this.boss?.dispose();
    this.boss = null;
    this.bossModel.root.visible = false;
    this.group.visible = true;
    this.player.model.root.visible = true;
    this.drawBullets();
  }

  hud() {
    const b = this.boss;
    return {
      score: this.score,
      hi: this.hi,
      lives: this.lives,
      weapon: this.player.weapon,
      shield: this.player.shield,
      bombs: this.player.bombs,
      boss: b && b.state !== 'enter' && b.state !== 'dead' ? b.hp / b.maxHp : -1,
      bossPhase: b ? b.phase : 1,
    };
  }

  // ------------------------------------------------------------ scoring
  addScore(n: number, x?: number, y?: number) {
    const v = Math.round(n * (1 + (this.loop - 1) * 0.5));
    this.score += v;
    if (this.score > this.hi) this.hi = this.score;
    if (x !== undefined && y !== undefined && n >= 300) this.hooks.popup(v.toLocaleString(), x, y);
    while (this.extendIdx < EXTENDS.length && this.score >= EXTENDS[this.extendIdx]) {
      this.extendIdx++;
      this.lives = Math.min(9, this.lives + 1);
      this.audio.sfx('sfx_extend', { vol: 0.8 });
      this.hooks.message('EXTEND!', 'info', 1400);
    }
  }

  // ------------------------------------------------------------ spawning
  private launch(ev: WaveEvent) {
    const count = ev.count ?? 1;
    const gap = ev.gap ?? 0;
    for (let i = 0; i < count; i++) {
      const drop: Drop = i === count - 1 ? ev.drop ?? 'none' : 'none';
      const fn = () => this.spawnEnemy(ev.def, SPAWN_X, ev.y, drop, !!ev.depth);
      if (i === 0 || gap <= 0) fn();
      else this.pending.push({ at: this.clock + i * gap, fn });
    }
  }

  spawnEnemy(defName: string, x: number, y: number, drop: Drop, depth = false) {
    const def = DEFS[defName];
    if (!def) return;
    const e = this.pools[def.kind].find((q) => !q.active);
    if (!e) return;
    e.spawn(def, x, y, drop, depth, this.hpScale);
  }

  spawnMinion(x: number, y: number) {
    this.spawnEnemy('fish', x, y, Math.random() < 0.15 ? 'always' : 'none');
  }

  spawnPowerup(x: number, y: number, kind?: PowerKind) {
    const r = Math.random();
    const k: PowerKind = kind ?? (r < 0.55 ? 'P' : r < 0.85 ? 'S' : 'B');
    const o = this.orbs.find((q) => q.kind === k && !q.active);
    o?.spawn(Math.min(x, 14), y);
  }

  fireEnemyBullet(x: number, y: number, vx: number, vy: number, big = false, cyan = false) {
    const b = this.eb.find((q) => !q.active);
    if (!b) return;
    b.active = true;
    b.x = x;
    b.y = y;
    b.vx = vx;
    b.vy = vy;
    b.big = big;
    b.cyan = cyan;
    b.age = 0;
  }

  // ------------------------------------------------------------ player weapons
  private fireWeapon() {
    const p = this.player;
    const mx = p.x + 1.55;
    const my = p.y - 0.04;
    const spd = PLAYER.bulletSpeed;
    const shot = (dy: number, deg = 0, dmg = 1, big = false) => {
      const b = this.pb.find((q) => !q.active);
      if (!b) return;
      const a = (deg * Math.PI) / 180;
      b.active = true;
      b.x = mx;
      b.y = my + dy;
      b.vx = Math.cos(a) * spd;
      b.vy = Math.sin(a) * spd;
      b.dmg = dmg;
      b.big = big;
    };
    switch (p.weapon) {
      case 1:
        shot(0);
        break;
      case 2:
        shot(-0.23);
        shot(0.23);
        break;
      case 3:
        shot(0);
        shot(0, -9);
        shot(0, 9);
        break;
      case 4:
        shot(-0.27);
        shot(0.27);
        shot(0, -15);
        shot(0, 15);
        break;
      default:
        shot(0, 0, 2, true);
        shot(-0.37);
        shot(0.37);
        shot(0, -19);
        shot(0, 19);
    }
    this.effects.muzzle(mx, my, p.weapon >= 5);
    this.audio.sfx(p.weapon >= 4 ? 'sfx_shoot_big' : 'sfx_shoot', { vol: 0.28, pan: p.x / 22, rate: rand(0.97, 1.03), throttle: 0.05 });
  }

  private doBomb() {
    const p = this.player;
    if (p.bombs <= 0 || !p.alive || p.entering || this.phase === 'over' || this.phase === 'clear') return;
    p.bombs--;
    p.invulnUntil = Math.max(p.invulnUntil, this.time + 1.2);
    let cleared = 0;
    for (const b of this.eb) {
      if (!b.active) continue;
      b.active = false;
      cleared++;
      this.effects.particles.emit({ x: b.x, y: b.y, z: 0, life: 0.5, size0: 0.6, size1: 0.1, c0: new THREE.Color(1, 2.4, 3.2), a0: 1, a1: 0, type: 0 });
    }
    if (cleared) this.addScore(cleared * 10);
    for (const e of this.enemies) if (e.collidable) this.damageEnemy(e, 4, e.x, e.y);
    this.boss?.bomb();
    this.effects.nova(p.x, p.y);
    this.audio.sfx('sfx_bomb', { vol: 1 });
    this.audio.duck(0.4, 1.2);
  }

  // ------------------------------------------------------------ damage
  private damageEnemy(e: Enemy, dmg: number, x: number, y: number) {
    e.hp -= dmg;
    e.model.flasher.flash(this.time);
    if (e.hp > 0) {
      this.effects.hitSpark(x, y);
      this.audio.sfx('sfx_hit', { vol: 0.35, pan: x / 20, rate: rand(0.9, 1.15), throttle: 0.04 });
      return;
    }
    const fx = ENEMY_FX[e.def.kind];
    this.effects.explode(e.x, e.y, e.z, fx.size, fx.pal);
    const big = e.def.kind === 'turret' || e.def.kind === 'mine';
    this.audio.sfx(big ? 'sfx_explode_big' : 'sfx_explode', { vol: big ? 0.75 : 0.55, pan: e.x / 20, rate: rand(0.9, 1.1), throttle: 0.04 });
    this.addScore(e.def.score, e.x, e.y);
    if (e.drop === 'always' || (e.drop === 'maybe' && Math.random() < 0.3)) this.spawnPowerup(e.x, e.y);
    if (e.def.kind === 'mine') {
      // Mines burst into a slow ring of shrapnel.
      const n = 10;
      const sp = 4.2 * this.difficulty;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(0, 0.3);
        this.fireEnemyBullet(e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, false, true);
      }
    }
    e.despawn();
  }

  private hitPlayer() {
    const p = this.player;
    if (this.god) return;
    if (!p.alive || p.entering || p.invulnerable(this.time) || this.phase === 'over' || this.phase === 'clear') return;
    if (p.shield > 0) {
      p.shield--;
      p.hitShield();
      p.invulnUntil = this.time + 0.7;
      this.audio.sfx('sfx_player_hit', { vol: 0.8 });
      this.rig.shake(0.3);
      this.renderer.kickAberration(0.5);
      this.effects.hitSpark(p.x, p.y, new THREE.Color(1, 3.4, 1.4));
      return;
    }
    p.kill();
    this.effects.explode(p.x, p.y, 0, 1.8, 'plasma');
    this.effects.shockwave(p.x, p.y, 0);
    this.audio.sfx('sfx_player_death', { vol: 1 });
    this.rig.shake(0.8);
    this.renderer.kickAberration(1);
    this.lives--;
    if (this.lives < 0) {
      this.lives = 0;
      this.phase = 'over';
      this.overT = 0;
      this.audio.stopMusic(2);
    } else {
      this.respawnT = 1.5;
    }
  }

  private applyPowerup(o: PowerUp) {
    const p = this.player;
    if (o.kind === 'P') {
      if (p.weapon >= PLAYER.maxWeapon) this.addScore(1000, o.x, o.y);
      p.weapon = Math.min(PLAYER.maxWeapon, p.weapon + 1);
      this.hooks.popup(p.weapon >= PLAYER.maxWeapon ? 'WEAPON MAX' : 'WEAPON UP', o.x, o.y + 0.8, '#ff6d7a');
    } else if (o.kind === 'S') {
      p.shield = Math.min(6, p.shield + 3);
      this.hooks.popup('SHIELD +', o.x, o.y + 0.8, '#54f27a');
    } else {
      p.bombs = Math.min(9, p.bombs + 1);
      this.hooks.popup('BOMB +1', o.x, o.y + 0.8, '#7fb2ff');
    }
    this.addScore(500);
    this.audio.sfx('sfx_powerup', { vol: 0.75 });
    this.effects.particles.emit({ x: o.x, y: o.y, z: 0, life: 0.4, size0: 1, size1: 4, c0: new THREE.Color(2, 2.6, 3), a0: 1, a1: 0, type: 2 });
  }

  // ------------------------------------------------------------ boss flow
  private onWarning() {
    this.warned = true;
    this.audio.stopMusic(1.2);
    this.audio.sfx('sfx_warning', { vol: 0.9 });
    this.hooks.warning();
    this.env.setZone(3);
  }

  private spawnBoss() {
    this.phase = 'boss';
    this.boss = new Boss(this.bossModel, this, this.group, this.hpScale);
    this.audio.playMusic('bgm_boss', { fade: 0.3 });
  }

  onBossDying() {
    this.timeScale = 0.55;
    this.slowT = 3.6;
    for (const b of this.eb) b.active = false;
  }

  onBossDefeated() {
    this.addScore(50000, this.boss?.x, this.boss?.y);
    this.phase = 'clear';
    this.clearT = 0;
    this.timeScale = 0.3;
    this.slowT = 0.9;
    for (const e of this.enemies) if (e.active) this.damageEnemy(e, 999, e.x, e.y);
    this.hooks.message('STAGE CLEAR', 'clear', 3600);
  }

  // ------------------------------------------------------------ frame
  update(dt: number, input: Input) {
    this.time += dt;
    const p = this.player;

    // Slow-motion recovery (measured in real time: dt here is already scaled).
    if (this.slowT > 0) {
      this.slowT -= dt / Math.max(this.timeScale, 0.05);
      if (this.slowT <= 0) this.timeScale = 1;
    }

    // Timeline.
    if (this.phase === 'play') {
      this.clock += dt;
      while (this.waveIdx < STAGE1.length && STAGE1[this.waveIdx].t <= this.clock) this.launch(STAGE1[this.waveIdx++]);
      if (this.zone === 0 && this.clock >= STAGE.zoneB) this.setZone(1);
      if (this.zone === 1 && this.clock >= STAGE.zoneC) this.setZone(2);
      if (!this.warned && this.clock >= STAGE.warningAt) this.onWarning();
      if (this.clock >= STAGE.bossAt && !this.boss) this.spawnBoss();
    } else {
      this.clock += dt;
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= this.clock) {
        const f = this.pending[i].fn;
        this.pending.splice(i, 1);
        if (this.phase === 'play' || this.phase === 'boss') f();
      }
    }

    // Scroll slows down for the boss arena.
    const targetSpeed = this.phase === 'play' ? STAGE.scrollSpeed : this.phase === 'boss' ? 1.6 : 3;
    this.scrollSpeed += (targetSpeed - this.scrollSpeed) * Math.min(1, dt * 0.6);
    this.effects.particles.drift = -this.scrollSpeed * 0.3;

    // Player control.
    let ax = input.axisX;
    let ay = input.axisY;
    if (this.autopilot) {
      ax = 1;
      ay = -p.y * 0.3;
    }
    if (p.alive) {
      if (this.autopilot) ax = Math.min(3, (this.clearT - 3.2) * 2);
      p.update(dt, this.time, ax, ay, this.autopilot);
      const firing = !this.autopilot && (input.held('fire') || settings.data.autoFire) && !p.entering && this.phase !== 'clear';
      if (firing && this.time >= p.nextFire) {
        this.fireWeapon();
        p.nextFire = this.time + p.fireCooldown();
      }
      if (input.pressed('bomb')) this.doBomb();
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) {
        this.bubbleT = 0.06;
        this.effects.engineBubble(p.x - 1.6, p.y);
      }
    }
    if (this.respawnT >= 0) {
      this.respawnT -= dt;
      if (this.respawnT < 0 && this.phase !== 'over') p.respawn(this.time);
    }

    // Entities.
    for (const e of this.enemies) if (e.active) e.update(dt, this);
    for (const o of this.orbs) if (o.active) o.update(dt, this.time);
    this.boss?.update(dt);

    this.updateBullets(dt);
    this.collide();
    this.drawBullets();

    // End states.
    if (this.phase === 'over') {
      this.overT += dt;
      if (this.overT > 1.8 && this.overT - dt <= 1.8) {
        this.audio.playMusic('jingle_gameover', { loop: false, fade: 0.1 });
        this.hooks.gameOver(this.score, this.hi);
      }
    }
    if (this.phase === 'clear') {
      this.clearT += dt;
      if (this.clearT > 1.2 && this.clearT - dt <= 1.2) this.audio.playMusic('jingle_victory', { loop: false, fade: 0.1 });
      if (this.clearT > 3.2 && !this.autopilot) this.autopilot = true;
      if (this.clearT > 6 && this.clearT - dt <= 6) {
        const livesBonus = this.lives * 10000;
        const bombBonus = p.bombs * 5000;
        this.addScore(livesBonus + bombBonus);
        this.hooks.clear({ score: this.score - livesBonus - bombBonus, livesBonus, bombBonus, total: this.score, hi: this.hi, loop: this.loop });
      }
    }

    this.env.update(dt, this.scrollSpeed, this.renderer.camera.position);
    this.rig.update(dt, p.alive ? p.x : 0, p.alive ? p.y : 0);
  }

  private setZone(i: number) {
    this.zone = i;
    this.env.setZone(i);
    this.hooks.zone(i);
  }

  /** Keep-alive state for carrying into the next loop. */
  carry() {
    const p = this.player;
    return { score: this.score, lives: this.lives, weapon: p.weapon, shield: p.shield, bombs: p.bombs };
  }

  private updateBullets(dt: number) {
    for (const b of this.pb) {
      if (!b.active) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x > 19 || b.y > 11 || b.y < -11) b.active = false;
    }
    for (const b of this.eb) {
      if (!b.active) continue;
      b.age += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -19 || b.x > 20 || b.y > 11.5 || b.y < -11.5) b.active = false;
    }
  }

  private collide() {
    const p = this.player;
    const boss = this.boss;
    // Player bullets vs enemies / boss.
    for (const b of this.pb) {
      if (!b.active) continue;
      const br = b.big ? 0.42 : 0.26;
      for (const e of this.enemies) {
        if (!e.collidable) continue;
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        const rr = e.def.radius + br;
        if (dx * dx + dy * dy < rr * rr) {
          this.damageEnemy(e, b.dmg, b.x, b.y);
          b.active = false;
          break;
        }
      }
      if (b.active && boss && boss.hitTest(b.x, b.y, br, b.dmg)) b.active = false;
    }

    if (!p.alive || p.entering) return;
    const cx = p.x - 0.1;
    const cy = p.y;
    const RX = PLAYER.hitRx;
    const RY = PLAYER.hitRy;
    const inv = p.invulnerable(this.time);

    // Enemy bullets vs player (the hitbox is a slim ellipse around the fuselage).
    if (!inv) {
      for (const b of this.eb) {
        if (!b.active) continue;
        const r = b.big ? 0.24 : 0.14;
        const dx = (b.x - cx) / (RX + r);
        const dy = (b.y - cy) / (RY + r);
        if (dx * dx + dy * dy < 1) {
          b.active = false;
          this.hitPlayer();
          break;
        }
      }
    }
    // Bodies.
    for (const e of this.enemies) {
      if (!e.collidable) continue;
      const r = e.def.radius * 0.75;
      const dx = (e.x - cx) / (RX + r);
      const dy = (e.y - cy) / (RY + r);
      if (dx * dx + dy * dy < 1) {
        if (!p.invulnerable(this.time)) {
          this.hitPlayer();
          this.damageEnemy(e, 999, e.x, e.y);
        }
        break;
      }
    }
    if (boss && p.alive && !p.invulnerable(this.time) && (boss.touches(cx, cy, RX, RY) || boss.laserHits(cx, cy))) this.hitPlayer();
    // Power-ups (generous radius).
    for (const o of this.orbs) {
      if (!o.active) continue;
      const dx = o.x - p.x;
      const dy = o.y - p.y;
      if (dx * dx + dy * dy < 1.35 * 1.35) {
        this.applyPowerup(o);
        o.kill();
      }
    }
  }

  private drawBullets() {
    this.pBatch.begin(this.time);
    for (const b of this.pb) {
      if (!b.active) continue;
      const l = Math.hypot(b.vx, b.vy);
      this.pBatch.push(b.x, b.y, 0, b.vx / l, b.vy / l, b.big ? 0.7 : 0.42, b.big ? 2.6 : 2.1, b.big ? COL.pBig : COL.pShot, 0);
    }
    this.pBatch.end();
    this.eBatch.begin(this.time);
    for (const b of this.eb) {
      if (!b.active) continue;
      const s = (b.big ? 0.95 : 0.66) * Math.min(1, 0.4 + b.age * 6);
      this.eBatch.push(b.x, b.y, 0.05, 1, 0, s, s, b.cyan ? COL.eCyan : b.big ? COL.eBig : COL.eShot, 1);
    }
    this.eBatch.end();
  }
}
