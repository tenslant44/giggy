// =====================================================================
// Audio module — every sound is synthesized with Web Audio. Includes
// SFX (footsteps, tag, jingles, countdown...) and a tiny step sequencer
// that plays procedural party music per game phase.
// =====================================================================
import { Settings, rng } from './state.js';

let ctx = null, master, sfxBus, musicBus, noiseBuf;
let musicTrack = 'none', nextNoteTime = 0, step = 0, patterns = {};
const lastPlay = {};

export const Audio = {
  // Must be called from a user gesture.
  init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolume();
    buildPatterns();
    setInterval(schedule, 25);
  },
  applyVolume() {
    if (!ctx) return;
    master.gain.value = Settings.volume;
    musicBus.gain.value = Settings.music * 0.55;
  },
  suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
  resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); },
  music(track) {
    if (track === musicTrack) return;
    musicTrack = track; step = 0;
    if (ctx) nextNoteTime = ctx.currentTime + 0.1;
  },
  play(name, opt = {}) {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const gap = { step: 0.06, paint: 0.07, pick: 0.05 }[name] || 0.02;
    if (lastPlay[name] && now - lastPlay[name] < gap) return;
    lastPlay[name] = now;
    const fn = SFX[name]; if (fn) fn(now, opt);
  },
};

// ---------- synthesis primitives ----------
function tone(t, freq, dur, { type = 'sine', vol = 0.3, bus = sfxBus, slide = 0, attack = 0.005 } = {}) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(bus); o.start(t); o.stop(t + dur + 0.05);
}
function noise(t, dur, { vol = 0.3, freq = 1200, q = 1, type = 'bandpass', bus = sfxBus, slide = 0 } = {}) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (slide) f.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(bus); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}
const N = n => 440 * Math.pow(2, (n - 69) / 12);

const SFX = {
  step(t, o) { noise(t, 0.08, { vol: (o.vol ?? 0.25) * (o.sprint ? 1.2 : 1), freq: 300 + Math.random() * 250, q: 1.5, type: 'lowpass' }); tone(t, 90 + Math.random() * 20, 0.06, { vol: 0.08, type: 'sine' }); },
  jump(t) { tone(t, 300, 0.18, { type: 'square', vol: 0.08, slide: 2.2 }); },
  land(t) { noise(t, 0.12, { vol: 0.3, freq: 220, type: 'lowpass' }); },
  tag(t) { noise(t, 0.1, { vol: 0.35, freq: 2500, q: 2 }); tone(t, 660, 0.08, { type: 'triangle', vol: 0.15 }); },
  miss(t) { tone(t, 220, 0.35, { type: 'sawtooth', vol: 0.12, slide: 0.4 }); noise(t, 0.2, { vol: 0.2, freq: 500 }); },
  stun(t) { for (let i = 0; i < 4; i++) tone(t + i * 0.09, 900 - i * 120, 0.12, { type: 'square', vol: 0.06 }); },
  found(t) { [72, 76, 79, 84, 88].forEach((n, i) => tone(t + i * 0.07, N(n), 0.25, { type: 'square', vol: 0.09 })); noise(t, 0.3, { vol: 0.2, freq: 5000, slide: 0.3 }); },
  foundMe(t) { [79, 75, 72, 67].forEach((n, i) => tone(t + i * 0.12, N(n), 0.3, { type: 'triangle', vol: 0.15 })); },
  tick(t) { tone(t, 880, 0.1, { type: 'square', vol: 0.08 }); },
  tickFinal(t) { tone(t, 1320, 0.25, { type: 'square', vol: 0.1 }); },
  go(t) { [60, 64, 67].forEach(n => tone(t, N(n), 0.6, { type: 'sawtooth', vol: 0.07 })); tone(t, N(72), 0.7, { type: 'square', vol: 0.08 }); noise(t, 0.4, { vol: 0.25, freq: 3000, slide: 0.2 }); },
  hide(t) { [67, 72].forEach((n, i) => tone(t + i * 0.12, N(n), 0.3, { type: 'triangle', vol: 0.15 })); },
  win(t) { [60, 64, 67, 72, 67, 72, 76, 79].forEach((n, i) => tone(t + i * 0.11, N(n), 0.3, { type: 'square', vol: 0.08 })); [48, 55, 60].forEach(n => tone(t + 0.88, N(n), 1.2, { type: 'triangle', vol: 0.12 })); },
  lose(t) { [67, 66, 65, 64].forEach((n, i) => tone(t + i * 0.28, N(n), 0.4, { type: 'sawtooth', vol: 0.07, slide: 0.97 })); tone(t + 1.1, N(52), 1.0, { type: 'triangle', vol: 0.14, slide: 0.9 }); },
  paint(t) { noise(t, 0.09, { vol: 0.05, freq: 1800 + Math.random() * 800, q: 3 }); },
  pick(t) { tone(t, 1200, 0.07, { type: 'sine', vol: 0.12, slide: 1.6 }); },
  click(t) { tone(t, 700, 0.05, { type: 'triangle', vol: 0.1 }); },
  pose(t) { noise(t, 0.2, { vol: 0.15, freq: 900, slide: 2.5 }); },
  clone(t) { tone(t, 400, 0.25, { type: 'sine', vol: 0.15, slide: 3 }); noise(t, 0.25, { vol: 0.2, freq: 1500, slide: 3 }); },
  door(t) { noise(t, 0.9, { vol: 0.3, freq: 180, type: 'lowpass' }); tone(t, 70, 0.9, { type: 'sawtooth', vol: 0.06, slide: 1.4 }); },
  fill(t) { noise(t, 0.3, { vol: 0.15, freq: 600, slide: 3 }); },
};

// ---------- procedural music sequencer ----------
function buildPatterns() {
  const mk = (seed, root, scale, bpm, density, prog) => {
    const r = rng(seed);
    const mel = [];
    for (let i = 0; i < 64; i++) mel.push(r() < density ? scale[(r() * scale.length) | 0] + (r() < 0.25 ? 12 : 0) : null);
    return { root, scale, bpm, mel, prog };
  };
  const penta = [0, 2, 4, 7, 9, 12, 14];
  const minor = [0, 3, 5, 7, 10, 12, 15];
  patterns.menu = mk(11, 60, penta, 112, 0.55, [0, 5, 7, 5]);
  patterns.prep = mk(29, 62, penta, 124, 0.45, [0, 9, 5, 7]);
  patterns.hunt = mk(47, 57, minor, 138, 0.5, [0, 0, 8, 7]);
  patterns.results = mk(73, 65, penta, 100, 0.35, [0, 5, 9, 7]);
}
function schedule() {
  if (!ctx || ctx.state !== 'running' || musicTrack === 'none') return;
  const p = patterns[musicTrack]; if (!p) return;
  const sp = 60 / p.bpm / 4; // 16th notes
  if (nextNoteTime < ctx.currentTime - 0.2) nextNoteTime = ctx.currentTime + 0.05;
  while (nextNoteTime < ctx.currentTime + 0.12) {
    const t = nextNoteTime, s = step % 64, bar = (step >> 4) % 4;
    const chordRoot = p.root + p.prog[bar];
    const b = musicBus;
    if (s % 4 === 0) { tone(t, 120, 0.12, { type: 'sine', vol: 0.35, bus: b, slide: 0.35 }); } // kick
    if (s % 8 === 4) noise(t, 0.12, { vol: 0.12, freq: 1800, q: 0.8, bus: b }); // snare
    if (s % 2 === 1) noise(t, 0.03, { vol: 0.05, freq: 8000, type: 'highpass', bus: b }); // hat
    if (s % 4 === 0 || s % 4 === 3 && musicTrack === 'hunt') tone(t, N(chordRoot - 24 + (s % 8 === 6 ? 7 : 0)), sp * 1.8, { type: 'triangle', vol: 0.22, bus: b });
    if (s % 8 === 2) [0, 4, 7].forEach(iv => tone(t, N(chordRoot + iv + (p.scale === patterns.hunt.scale && iv === 4 ? -1 : 0)), sp * 1.2, { type: 'square', vol: 0.025, bus: b }));
    const m = p.mel[s];
    if (m !== null) tone(t, N(p.root + 12 + m), sp * 1.6, { type: s % 16 < 8 ? 'square' : 'triangle', vol: 0.045, bus: b });
    nextNoteTime += sp; step++;
  }
}
