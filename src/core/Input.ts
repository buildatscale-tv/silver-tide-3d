// Unified keyboard + gamepad input with per-frame edge detection.

export type Action = 'fire' | 'bomb' | 'pause' | 'confirm' | 'back' | 'up' | 'down' | 'left' | 'right' | 'mute';

const KEYMAP: Record<Action, string[]> = {
  fire: ['Space', 'KeyZ', 'KeyJ'],
  bomb: ['KeyX', 'ShiftLeft', 'ShiftRight', 'KeyK'],
  pause: ['KeyP', 'Escape'],
  confirm: ['Enter', 'NumpadEnter', 'Space', 'KeyZ'],
  back: ['Escape', 'Backspace'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  mute: ['KeyM'],
};

// Standard gamepad mapping button indices.
const PADMAP: Partial<Record<Action, number[]>> = {
  fire: [0, 7, 5],
  bomb: [1, 2, 6, 4],
  pause: [9],
  confirm: [0, 9],
  back: [1, 8],
  up: [12],
  down: [13],
  left: [14],
  right: [15],
};

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

/** Some synthetic or remapped keyboards leave `code` empty; derive it from `key`. */
function codeOf(e: KeyboardEvent): string {
  if (e.code) return e.code;
  const k = e.key;
  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (k === 'Shift') return 'ShiftLeft';
  if (k === 'Esc') return 'Escape';
  if (k.length === 1 && /[a-z]/i.test(k)) return 'Key' + k.toUpperCase();
  return k;
}

export class Input {
  private keys = new Set<string>();
  private now = new Set<Action>();
  private prev = new Set<Action>();
  private anyPressed = false;
  axisX = 0;
  axisY = 0;
  usingPad = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      const code = codeOf(e);
      if (PREVENT.has(code)) e.preventDefault();
      if (!e.repeat) this.anyPressed = true;
      this.keys.add(code);
      this.usingPad = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(codeOf(e)));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('pointerdown', () => (this.anyPressed = true));
  }

  /** Call once per frame before reading input. */
  update() {
    this.prev = this.now;
    this.now = new Set();
    for (const a of Object.keys(KEYMAP) as Action[]) {
      if (KEYMAP[a].some((k) => this.keys.has(k))) this.now.add(a);
    }

    // Gamepads: buttons (incl. D-pad) map to actions; the stick adds analog movement.
    let padX = 0;
    let padY = 0;
    const stickDirs: Action[] = [];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      for (const a of Object.keys(PADMAP) as Action[]) {
        if (PADMAP[a]!.some((i) => p.buttons[i]?.pressed)) {
          this.now.add(a);
          this.usingPad = true;
        }
      }
      const sx = p.axes[0] ?? 0;
      const sy = p.axes[1] ?? 0;
      const mag = Math.hypot(sx, sy);
      if (mag > 0.2) {
        const k = Math.min(1, (mag - 0.2) / 0.75) / mag;
        padX += sx * k;
        padY -= sy * k;
        this.usingPad = true;
        // Let the stick drive menus too (added after the digital axes below).
        if (sy < -0.6) stickDirs.push('up');
        if (sy > 0.6) stickDirs.push('down');
        if (sx < -0.6) stickDirs.push('left');
        if (sx > 0.6) stickDirs.push('right');
      }
      if (p.buttons.some((b) => b.pressed)) this.anyPressed = true;
    }

    // Digital directions (keyboard + D-pad) combine freely, so diagonals work.
    let ax = (this.now.has('right') ? 1 : 0) - (this.now.has('left') ? 1 : 0) + padX;
    let ay = (this.now.has('up') ? 1 : 0) - (this.now.has('down') ? 1 : 0) + padY;
    for (const d of stickDirs) this.now.add(d);
    const len = Math.hypot(ax, ay);
    if (len > 1) {
      ax /= len;
      ay /= len;
    }
    this.axisX = ax;
    this.axisY = ay;
  }

  held(a: Action) {
    return this.now.has(a);
  }

  pressed(a: Action) {
    return this.now.has(a) && !this.prev.has(a);
  }

  /** True once after any key, button, or click since the last call. */
  consumeAny() {
    const v = this.anyPressed;
    this.anyPressed = false;
    return v;
  }
}
