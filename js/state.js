// =====================================================================
// State module — persistent settings, the round configuration and the
// shared mutable game state that every other module reads/writes.
// =====================================================================

const SETTINGS_KEY = 'meccha-chameleon-settings-v1';

export const Settings = {
  sensitivity: 1,
  fov: 75,
  volume: 0.8,
  music: 0.45,
  quality: 'medium',
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      for (const k of ['sensitivity', 'fov', 'volume', 'music', 'quality']) if (s[k] !== undefined) this[k] = s[k];
    } catch (e) { /* ignore corrupt storage */ }
  },
  save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        sensitivity: this.sensitivity, fov: this.fov, volume: this.volume, music: this.music, quality: this.quality,
      }));
    } catch (e) { /* storage may be unavailable */ }
  },
};

// Round configuration chosen on the setup screen.
export const Config = {
  mode: 'basic',        // basic | infection | double | reverse
  map: 'alley',
  role: 'hider',        // hider | seeker | random
  bots: 5,
  skill: 'medium',      // easy | medium | hard
  prepTime: 75,
  huntTime: 180,
  size: 1,
  clones: 2,
};

// Live game state.
export const State = {
  screen: 'loading',    // loading | menu | setup | game | results
  phase: 'none',        // prep | release | hunt | over
  paused: false,
  timer: 0,
  roundTime: 0,         // seconds since hunt start
  round: 0,
  agents: [],           // every participant (player + bots)
  player: null,         // the player's agent
  targets: [],          // taggable things: { char, owner, kind:'hider'|'clone', alive }
  map: null,
  camMode: 'third',     // third | first | paint | spectate
  shake: 0,
  seekerRotation: 0,
};

// Tiny event bus so modules can talk without circular imports.
const listeners = {};
export const Bus = {
  on(ev, fn) { (listeners[ev] ||= []).push(fn); },
  emit(ev, ...a) { (listeners[ev] || []).forEach(f => f(...a)); },
};

// Shared math helpers.
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = arr => arr[(Math.random() * arr.length) | 0];
export function damp(a, b, rate, dt) { return lerp(a, b, 1 - Math.exp(-rate * dt)); }
export function angleDamp(a, b, rate, dt) {
  let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * (1 - Math.exp(-rate * dt));
}
export function fmtTime(t) {
  t = Math.max(0, Math.ceil(t));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
// Seeded RNG (mulberry32) for deterministic procedural content.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
