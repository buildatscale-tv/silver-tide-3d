// DOM overlay: screens, keyboard/gamepad-driven menus, HUD, messages, popups.
import type { Input } from '../core/Input';
import { settings, type Quality } from '../core/Settings';
import type { ClearResult } from '../game/Stage';

export type ScreenName = 'boot' | 'title' | 'settings' | 'controls' | 'pause' | 'gameover' | 'clear';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const ZONE_NAMES = ['ZONE α · TWILIGHT SHELF', 'ZONE β · DROWNED FOUNDRY', 'ZONE γ · ABYSSAL TRENCH'];
const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];

const SHIP_SVG =
  '<svg viewBox="0 0 34 18"><path d="M2 9 L8 5 L20 5 L33 9 L20 12 L8 13 Z" fill="#cfe9ff"/><path d="M14 5 L10 1 L7 1 L9 5 Z M14 12 L10 17 L7 17 L9 12 Z" fill="#2a6bff"/><rect x="17" y="6" width="6" height="2.5" rx="1" fill="#ff8a2a"/><circle cx="3" cy="9" r="2" fill="#6fe9ff"/></svg>';

export interface HudData {
  score: number;
  hi: number;
  lives: number;
  weapon: number;
  shield: number;
  bombs: number;
  boss: number;
  bossPhase: number;
}

export class UI {
  screen: ScreenName | null = 'boot';
  private focus = 0;
  private last: Partial<HudData> = {};
  private msgTimer = 0;
  private warnTimer = 0;
  onAction?: (screen: ScreenName, act: string) => void;
  onSettingChanged?: (key: string) => void;
  onSound?: (kind: 'move' | 'select') => void;
  private screenBeforeSettings: ScreenName = 'title';
  /** Ignore menu input briefly after a screen opens (avoids mashed fire keys selecting items). */
  private lockUntil = 0;

  constructor() {
    // Mouse support for every menu.
    document.querySelectorAll<HTMLElement>('.menu').forEach((menu) => {
      const name = menu.dataset.menu as ScreenName;
      const buttons = Array.from(menu.querySelectorAll('button'));
      buttons.forEach((b, i) => {
        b.addEventListener('mouseenter', () => {
          if (this.screen !== name) return;
          if (this.focus !== i) this.onSound?.('move');
          this.setFocus(i);
        });
        b.addEventListener('click', (e) => {
          if (this.screen !== name) return;
          this.setFocus(i);
          this.activate(e.shiftKey ? -1 : 1);
        });
        b.addEventListener('contextmenu', (e) => {
          if (this.screen !== name || !b.dataset.set) return;
          e.preventDefault();
          this.setFocus(i);
          this.activate(-1);
        });
      });
    });
    this.refreshSettings();
  }

  // ------------------------------------------------------------ screens
  show(name: ScreenName | null) {
    if (name === 'settings' && this.screen && this.screen !== 'settings') this.screenBeforeSettings = this.screen;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('show'));
    this.screen = name;
    this.lockUntil = performance.now() + 450;
    if (name) $(`#${name}`).classList.add('show');
    this.setFocus(0);
    if (name === 'settings') this.refreshSettings();
  }

  get settingsReturn() {
    return this.screenBeforeSettings;
  }

  private buttons(): HTMLButtonElement[] {
    if (!this.screen) return [];
    return Array.from(document.querySelectorAll<HTMLButtonElement>(`.menu[data-menu="${this.screen}"] button`));
  }

  private setFocus(i: number) {
    const b = this.buttons();
    if (!b.length) return;
    this.focus = (i + b.length) % b.length;
    b.forEach((x, k) => x.classList.toggle('focus', k === this.focus));
  }

  /** Menu navigation; call every frame while a menu screen is visible. */
  update(input: Input) {
    const b = this.buttons();
    if (!b.length || performance.now() < this.lockUntil) return;
    if (input.pressed('up')) {
      this.setFocus(this.focus - 1);
      this.onSound?.('move');
    }
    if (input.pressed('down')) {
      this.setFocus(this.focus + 1);
      this.onSound?.('move');
    }
    const cur = b[this.focus];
    if (cur?.dataset.set) {
      if (input.pressed('left')) this.activate(-1);
      if (input.pressed('right')) this.activate(1);
    }
    if (input.pressed('confirm')) this.activate(1);
    if (input.pressed('back')) {
      if (this.screen === 'settings' || this.screen === 'controls') this.onAction?.(this.screen, 'back');
      else if (this.screen === 'pause') this.onAction?.('pause', 'resume');
    }
  }

  private activate(dir: number) {
    const b = this.buttons()[this.focus];
    if (!b || !this.screen) return;
    if (b.dataset.set) {
      this.changeSetting(b.dataset.set, dir);
      this.onSound?.('move');
      return;
    }
    this.onSound?.('select');
    this.onAction?.(this.screen, b.dataset.act ?? '');
  }

  private changeSetting(key: string, dir: number) {
    const s = settings.data;
    if (key === 'quality') {
      const i = QUALITIES.indexOf(s.quality);
      settings.set('quality', QUALITIES[(i + dir + QUALITIES.length) % QUALITIES.length]);
    } else if (key === 'music' || key === 'sfx') {
      const v = Math.round((s[key] + dir * 0.1) * 10) / 10;
      settings.set(key, v > 1.001 ? 0 : v < -0.001 ? 1 : v);
    } else if (key === 'shake' || key === 'autoFire' || key === 'showFps') {
      settings.set(key, !s[key]);
    }
    this.refreshSettings();
    this.onSettingChanged?.(key);
  }

  refreshSettings() {
    const s = settings.data;
    const val = (k: string, v: string) => {
      const el = document.querySelector(`button[data-set="${k}"] .val`);
      if (el) el.textContent = v;
    };
    val('quality', s.quality.toUpperCase());
    val('music', `${Math.round(s.music * 100)}%`);
    val('sfx', `${Math.round(s.sfx * 100)}%`);
    val('shake', s.shake ? 'ON' : 'OFF');
    val('autoFire', s.autoFire ? 'ON' : 'OFF');
    val('showFps', s.showFps ? 'ON' : 'OFF');
    $('#fps').classList.toggle('hidden', !s.showFps);
  }

  // ------------------------------------------------------------ boot
  setLoading(f: number, text?: string) {
    $('#loadfill').style.width = `${Math.round(f * 100)}%`;
    if (text) $('#loadtext').textContent = text;
  }

  bootReady() {
    $('#loadtext').textContent = 'SYSTEMS ONLINE';
    $('#bootgo').classList.remove('hidden');
  }

  setTitleHi(v: number) {
    $('#title-hi').textContent = v.toLocaleString();
  }

  // ------------------------------------------------------------ HUD
  showHud(on: boolean) {
    $('#hud').classList.toggle('hidden', !on);
    if (on) this.last = {};
  }

  hud(d: HudData) {
    const L = this.last;
    if (L.score !== d.score) $('#h-score').textContent = d.score.toLocaleString();
    if (L.hi !== d.hi) $('#h-hi').textContent = d.hi.toLocaleString();
    if (L.lives !== d.lives) $('#h-lives').innerHTML = SHIP_SVG.repeat(Math.min(d.lives, 7));
    if (L.weapon !== d.weapon) {
      const el = $('#h-weapon');
      el.innerHTML = Array.from({ length: 5 }, (_, i) => `<i class="${i < d.weapon ? 'on' : ''}"></i>`).join('');
      el.classList.toggle('max', d.weapon >= 5);
    }
    if (L.shield !== d.shield) $('#h-shield').innerHTML = Array.from({ length: 6 }, (_, i) => `<i class="${i < d.shield ? 'on' : ''}"></i>`).join('');
    if (L.bombs !== d.bombs) $('#h-bombs').textContent = String(d.bombs);
    if ((L.boss ?? -1) < 0 !== d.boss < 0) $('#h-boss').classList.toggle('hidden', d.boss < 0);
    if (d.boss >= 0 && L.boss !== d.boss) $('#h-bossfill').style.width = `calc(${(d.boss * 100).toFixed(2)}% - 4px)`;
    Object.assign(L, d);
  }

  zone(i: number) {
    $('#h-zone').textContent = ZONE_NAMES[i] ?? '';
    this.message('', 'stage', 2600, ZONE_NAMES[i]);
  }

  message(text: string, kind: 'stage' | 'info' | 'danger' | 'clear' = 'stage', ms = 2000, sub?: string) {
    const el = $('#msg');
    el.innerHTML = (text ? `<span class="m ${kind}">${text}</span>` : '') + (sub ? `<span class="zone">${sub}</span>` : '');
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => {
      el.querySelectorAll('span').forEach((s) => s.classList.add('out'));
      this.msgTimer = window.setTimeout(() => (el.innerHTML = ''), 460);
    }, ms);
  }

  clearMessage() {
    window.clearTimeout(this.msgTimer);
    $('#msg').innerHTML = '';
  }

  popup(text: string, sx: number, sy: number, color?: string) {
    const layer = $('#popups');
    const s = document.createElement('span');
    s.textContent = text;
    s.style.left = `${sx}px`;
    s.style.top = `${sy}px`;
    if (color) s.style.color = color;
    layer.appendChild(s);
    window.setTimeout(() => s.remove(), 950);
  }

  warning() {
    const w = $('#warning');
    w.classList.remove('hidden');
    window.clearTimeout(this.warnTimer);
    this.warnTimer = window.setTimeout(() => w.classList.add('hidden'), 3600);
  }

  hideWarning() {
    window.clearTimeout(this.warnTimer);
    $('#warning').classList.add('hidden');
  }

  gameOver(score: number, hi: number) {
    $('#go-score').textContent = score.toLocaleString();
    $('#go-hi').textContent = hi.toLocaleString();
    this.show('gameover');
  }

  clear(r: ClearResult) {
    $('#cl-score').textContent = r.score.toLocaleString();
    $('#cl-lives').textContent = `+${r.livesBonus.toLocaleString()}`;
    $('#cl-bombs').textContent = `+${r.bombBonus.toLocaleString()}`;
    $('#cl-total').textContent = r.total.toLocaleString();
    $('#cl-hi').textContent = r.hi.toLocaleString();
    ($('#clear h1') as HTMLElement).textContent = r.loop > 1 ? `LOOP ${r.loop} CLEAR` : 'STAGE 1 CLEAR';
    this.show('clear');
  }

  fps(v: number, scale: number) {
    $('#fps').textContent = `${v.toFixed(0)} FPS · ${(scale * 100).toFixed(0)}% res`;
  }

  muted(on: boolean) {
    $('#mute').classList.toggle('hidden', !on);
  }
}
