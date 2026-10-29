// 키보드·마우스 입력. 포인터 잠금 상태에서만 게임 입력을 받는다.
import { BTN } from './shared/constants.js';

const KEY_BTN = { Space: BTN.JUMP, ShiftLeft: BTN.SHIFT, ShiftRight: BTN.SHIFT, KeyE: BTN.E, KeyQ: BTN.Q, KeyR: BTN.RELOAD };

export class Input {
  constructor(target) {
    this.target = target;
    this.keys = new Set();
    this.mouse = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.sens = 1;
    this.sensScale = 1;
    this.enabled = false;
    this.locked = false;
    this.onKey = null; // (code) => bool: true 면 게임 입력으로 쓰지 않음

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.release();
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      const k = 0.0022 * this.sens * this.sensScale;
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || !this.enabled) return;
      if (e.button === 0) this.mouse |= BTN.FIRE;
      if (e.button === 2) this.mouse |= BTN.ALT;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse &= ~BTN.FIRE;
      if (e.button === 2) this.mouse &= ~BTN.ALT;
    });
    document.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    window.addEventListener('keydown', (e) => {
      if (this.onKey && this.onKey(e)) return;
      if (!this.locked || !this.enabled) return;
      if (['Space', 'Tab', 'KeyQ', 'KeyE', 'KeyR'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.release());
  }

  release() {
    this.keys.clear();
    this.mouse = 0;
  }

  lock() {
    if (!this.locked) {
      const p = this.target.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // 이동 축(-1..1)
  axes() {
    if (!this.enabled) return [0, 0];
    const k = this.keys;
    const mx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const mz = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    return [mx, mz];
  }

  buttons() {
    if (!this.enabled) return 0;
    let b = this.mouse;
    for (const code of this.keys) if (KEY_BTN[code]) b |= KEY_BTN[code];
    return b;
  }
}
