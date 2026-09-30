// =====================================================================
// Input module — keyboard state, mouse deltas, buttons, wheel and
// pointer-lock management. Other modules poll `Input` each frame or
// subscribe to discrete events via Input.on*.
// =====================================================================

const keys = new Set();
const pressed = new Set();
const handlers = { key: [], keyup: [], down: [], up: [], move: [], wheel: [], lock: [] };

export const Input = {
  dx: 0, dy: 0,            // accumulated mouse movement since last consume
  mx: 0, my: 0,            // cursor position (CSS px)
  buttons: 0,
  locked: false,
  lockWanted: false,       // true when gameplay wants the pointer captured
  el: null,
  down(code) { return keys.has(code); },
  pressedOnce(code) { return pressed.has(code); },
  consume() { const r = [this.dx, this.dy]; this.dx = 0; this.dy = 0; return r; },
  endFrame() { pressed.clear(); this.dx = 0; this.dy = 0; },
  on(type, fn) { handlers[type].push(fn); },
  requestLock() {
    if (!this.el || document.pointerLockElement === this.el) return;
    try {
      const p = this.el.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* pointer lock unsupported (e.g. sandboxed iframe) */ }
  },
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); },
  clear() { keys.clear(); pressed.clear(); this.buttons = 0; this.dx = this.dy = 0; },
  init(el) {
    this.el = el;
    addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      if (!keys.has(e.code)) pressed.add(e.code);
      const repeat = keys.has(e.code);
      keys.add(e.code);
      if (!repeat) handlers.key.forEach(f => f(e.code, e));
    });
    addEventListener('keyup', e => { keys.delete(e.code); handlers.keyup.forEach(f => f(e.code, e)); });
    addEventListener('blur', () => this.clear());
    addEventListener('mousemove', e => {
      this.mx = e.clientX; this.my = e.clientY;
      // Only use relative motion when locked, or when a fallback drag is active
      this.dx += e.movementX || 0; this.dy += e.movementY || 0;
      handlers.move.forEach(f => f(e));
    });
    el.addEventListener('mousedown', e => { this.buttons = e.buttons; handlers.down.forEach(f => f(e)); });
    addEventListener('mouseup', e => { this.buttons = e.buttons; handlers.up.forEach(f => f(e)); });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('wheel', e => { e.preventDefault(); handlers.wheel.forEach(f => f(e)); }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      handlers.lock.forEach(f => f(this.locked));
    });
  },
};
