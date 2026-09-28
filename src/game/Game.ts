// Top-level game controller: loading, state machine, main loop.
import * as THREE from 'three';
import { AudioEngine } from '../core/AudioEngine';
import { Input } from '../core/Input';
import { Renderer } from '../core/Renderer';
import { loadHiScore, saveHiScore, settings } from '../core/Settings';
import { Environment } from '../gfx/Environment';
import { Particles } from '../gfx/Particles';
import { Debris, FlashLights } from '../gfx/Debris';
import { createEnvMap, createMaterials } from '../gfx/materials';
import { loadTextures } from '../gfx/textures';
import { UI, type ScreenName } from '../ui/UI';
import { CameraRig } from './CameraRig';
import { Effects } from './Effects';
import { Stage, type StageHooks } from './Stage';
import { STAGE } from '../config';

type State = 'boot' | 'title' | 'playing' | 'paused' | 'over' | 'clear';

export class Game {
  readonly ui = new UI();
  readonly input = new Input();
  readonly renderer: Renderer;
  readonly audio = new AudioEngine();
  private rig: CameraRig;
  private env!: Environment;
  private stage!: Stage;
  private effects!: Effects;
  state: State = 'boot';
  private last = performance.now();
  private fpsT = 0;
  private hi = loadHiScore();
  private params = new URLSearchParams(location.search);
  private ready = false;

  constructor() {
    this.renderer = new Renderer(document.getElementById('gl')!);
    this.rig = new CameraRig(this.renderer);
    this.renderer.setQuality(settings.data.quality);
  }

  async init() {
    const ui = this.ui;
    let texP = 0;
    let audP = 0;
    const progress = () => ui.setLoading(texP * 0.45 + audP * 0.45);
    const [tex] = await Promise.all([
      loadTextures(this.renderer.renderer, (f) => {
        texP = f;
        progress();
      }),
      this.audio.loadAll((f) => {
        audP = f;
        progress();
      }),
    ]);
    ui.setLoading(0.92, 'BUILDING THE ABYSS…');
    await new Promise((r) => setTimeout(r, 30));

    const scene = this.renderer.scene;
    const mats = createMaterials(tex);
    const envMap = createEnvMap(this.renderer.renderer);
    this.env = new Environment(scene, mats, tex, envMap);
    const particles = new Particles(7000);
    scene.add(particles.mesh);
    const debris = new Debris(mats.debris);
    scene.add(debris.mesh);
    const lights = new FlashLights(scene, 4);
    this.effects = new Effects(particles, debris, lights, this.renderer, this.rig);
    this.env.onBubbles = (x, y, z) => this.effects.bubbleColumn(x, y, z);

    const hooks: StageHooks = {
      message: (t, k, ms) => ui.message(t, k, ms),
      popup: (t, x, y, c) => {
        const v = new THREE.Vector3(x, y, 0).project(this.renderer.camera);
        ui.popup(t, ((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight, c);
      },
      zone: (i) => ui.zone(i),
      warning: () => ui.warning(),
      gameOver: (score, hi) => {
        this.saveHi(hi);
        this.state = 'over';
        ui.gameOver(score, hi);
      },
      clear: (r) => {
        this.saveHi(r.hi);
        this.state = 'clear';
        ui.clear(r);
      },
    };
    this.stage = new Stage(scene, this.env, this.effects, this.audio, this.rig, this.renderer, mats, tex, hooks);
    this.stage.hi = this.hi;
    this.stage.god = this.params.has('god');

    this.applyQuality();
    this.renderer.onQualityApplied = () => this.applyQuality();

    // Compile every shader up front so the first explosion or boss frame never hitches.
    ui.setLoading(0.97, 'COMPILING SHADERS…');
    this.stage.warmup();
    this.rig.update(0.016, 0, 0);
    this.renderer.renderer.compile(scene, this.renderer.camera);
    this.effects.explode(0, 0, 0, 1);
    this.renderer.render(0.016);
    this.effects.particles.clear();
    this.effects.debris.clear();
    this.effects.lights.clear();
    this.stage.hideAll();
    this.stage.titleMode();
    this.rig.setMode('title', true);

    ui.setLoading(1);
    ui.setTitleHi(this.hi);
    ui.bootReady();
    ui.onAction = (s, a) => this.onMenu(s, a);
    ui.onSettingChanged = (k) => {
      if (k === 'quality') this.renderer.setQuality(settings.data.quality);
    };
    ui.onSound = (k) => this.audio.sfx(k === 'move' ? 'sfx_select' : 'sfx_start', { vol: k === 'move' ? 0.5 : 0.35, throttle: 0.02 });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    this.ready = true;

    // Dev instrumentation.
    (window as unknown as { __game: Game }).__game = this;
    if (this.params.has('autostart') || this.params.has('warp')) {
      void this.audio.resume();
      this.startGame(1);
    }
    requestAnimationFrame(() => this.frame());
  }

  private applyQuality() {
    const q = settings.data.quality;
    const shadow = q === 'low' ? 0 : q === 'medium' ? 1024 : q === 'high' ? 2048 : 4096;
    this.env.setShadows(shadow);
    this.env.setPixelRatio(this.renderer.pixelRatio);
    this.env.setDetail(q !== 'low');
  }

  private saveHi(v: number) {
    if (v > this.hi) {
      this.hi = v;
      saveHiScore(v);
      this.ui.setTitleHi(v);
    }
  }

  // ------------------------------------------------------------ flow
  private goTitle() {
    this.state = 'title';
    this.ui.showHud(false);
    this.ui.hideWarning();
    this.ui.clearMessage();
    this.ui.show('title');
    this.stage.titleMode();
    this.env.reset({ scroll: this.env.scroll });
    this.env.setZone(0, true);
    this.rig.setMode('title');
    this.audio.setMuffled(false);
    this.audio.playMusic('bgm_title', { fade: 1.2 });
  }

  private startGame(loop: number, carry = false) {
    const keep = carry ? this.stage.carry() : undefined;
    this.state = 'playing';
    this.ui.show(null);
    this.ui.showHud(true);
    this.ui.hideWarning();
    this.audio.setMuffled(false);
    this.audio.sfx('sfx_start', { vol: 0.6 });
    this.stage.hi = this.hi;
    this.stage.start(loop, keep);
    this.rig.setMode('game');
    const warp = this.params.get('warp');
    const t = Number(this.params.get('t'));
    if (warp === 'boss') {
      this.stage.skipTo(STAGE.warningAt - 0.5);
      this.stage.player.weapon = 4;
      this.stage.player.shield = 3;
    } else if (t > 0) {
      this.stage.skipTo(t);
    }
    this.params.delete('warp');
    this.params.delete('t');
  }

  private pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.ui.show('pause');
    this.audio.setMuffled(true);
  }

  private resume() {
    this.state = 'playing';
    this.ui.show(null);
    this.audio.setMuffled(false);
  }

  private onMenu(screen: ScreenName, act: string) {
    if (screen === 'title') {
      if (act === 'start') this.startGame(1);
      else if (act === 'settings') this.ui.show('settings');
      else if (act === 'controls') this.ui.show('controls');
    } else if (screen === 'settings' || screen === 'controls') {
      if (act === 'back') {
        const ret = screen === 'settings' ? this.ui.settingsReturn : 'title';
        this.ui.show(ret === 'pause' ? 'pause' : 'title');
      }
    } else if (screen === 'pause') {
      if (act === 'resume') this.resume();
      else if (act === 'restart') this.startGame(1);
      else if (act === 'settings') this.ui.show('settings');
      else if (act === 'quit') this.goTitle();
    } else if (screen === 'gameover') {
      if (act === 'restart') this.startGame(1);
      else if (act === 'quit') this.goTitle();
    } else if (screen === 'clear') {
      if (act === 'next') this.startGame(this.stage.loop + 1, true);
      else if (act === 'quit') this.goTitle();
    }
  }

  // ------------------------------------------------------------ loop
  private frame() {
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const raw = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.ready) return;
    const input = this.input;
    input.update();

    if (input.pressed('mute')) this.ui.muted(this.audio.toggleMute());

    switch (this.state) {
      case 'boot':
        if (input.consumeAny()) {
          void this.audio.resume();
          this.goTitle();
        }
        this.titleIdle(raw);
        break;
      case 'title':
        input.consumeAny();
        if (this.ui.screen === 'title' || this.ui.screen === 'settings' || this.ui.screen === 'controls') this.ui.update(input);
        this.titleIdle(raw);
        break;
      case 'playing': {
        if (input.pressed('pause')) {
          this.pause();
          break;
        }
        const dt = raw * this.stage.timeScale;
        this.stage.update(dt, input);
        this.effects.particles.update(dt);
        this.effects.debris.update(dt, -1.5);
        this.effects.lights.update(dt);
        this.ui.hud(this.stage.hud());
        break;
      }
      case 'paused':
        this.ui.update(input);
        break;
      case 'over':
      case 'clear': {
        const dt = raw * this.stage.timeScale;
        this.stage.update(dt, input);
        this.effects.particles.update(dt);
        this.effects.debris.update(dt, -1.5);
        this.effects.lights.update(dt);
        this.ui.hud(this.stage.hud());
        this.ui.update(input);
        break;
      }
    }

    this.renderer.render(raw);
    this.fpsT += raw;
    if (this.fpsT > 0.5 && settings.data.showFps) {
      this.fpsT = 0;
      this.ui.fps(this.renderer.fps, this.renderer.resolutionScale);
    }
  }

  private titleIdle(dt: number) {
    const t = performance.now() / 1000;
    this.stage.player.idle(dt, t);
    this.rig.setTitleFocus(new THREE.Vector3(0, 0, 0));
    this.env.update(dt, 3.2, this.renderer.camera.position);
    this.effects.particles.update(dt);
    this.effects.lights.update(dt);
    this.effects.particles.drift = -1;
    this.rig.update(dt);
  }
}
