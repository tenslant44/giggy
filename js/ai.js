// =====================================================================
// AI module
//  - Hider bots:
//      1. shortlist hide spots (walls/corners, spaced from other hiders,
//         low exposure to walkways, reachable in time),
//      2. EVALUATE them by rendering each spot's background and scoring
//         colour uniformity + darkness (easy to camouflage = good),
//      3. walk there, pose, auto-paint by projecting the rendered
//         background onto the body from several viewpoints (with
//         lighting compensation),
//      4. SELF-CHECK: render themselves from seeker-eye viewpoints with
//         the same contrast metric seekers use; if they stand out, try a
//         different pose and repaint, keeping the best result,
//      5. drop decoy clones out in the open to bait seekers.
//  - Seeker bots: coordinated patrol (shared visit memory, avoid other
//    seekers' goals, prefer hide-spot-dense areas), head that glances at
//    nooks, pixel-based detection (render with/without the target and
//    measure contrast), an INVESTIGATE state that walks closer to
//    anything faintly suspicious, and line-of-fire checks before tagging
//    to avoid wrong-tag stuns. Vision only — no reading hider positions.
// =====================================================================
import * as THREE from 'three';
import { Renderer, LIN2SRGB } from './renderer.js';
import { Rig, getWhiteTex } from './character.js';
import { findPath, inRoom } from './maps.js';
import { Physics } from './physics.js';
import { State, Config, rand, pick, clamp, angleDamp } from './state.js';

const SKILL = {
  easy: { detectK: 2.6, floor: 0.12, fov: 90, range: 18, react: 0.9, visEvery: 0.32, projRes: 48, angles: [0], comp: 0.4, noise: 0.08, shortlist: 4, spotCorner: 0.8, retries: 0, walk: 3.8, run: 5.2 },
  medium: { detectK: 4.6, floor: 0.085, fov: 105, range: 24, react: 0.5, visEvery: 0.2, projRes: 96, angles: [0, -0.8, 0.8], comp: 0.85, noise: 0.025, shortlist: 8, spotCorner: 1.6, retries: 1, walk: 4.3, run: 6.2 },
  hard: { detectK: 7.5, floor: 0.06, fov: 115, range: 30, react: 0.25, visEvery: 0.14, projRes: 128, angles: [0, -0.7, 0.7, -1.5, 1.5], comp: 1, noise: 0.008, shortlist: 14, spotCorner: 2.5, retries: 2, walk: 4.8, run: 7 },
};
export const skill = () => SKILL[Config.skill];

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
const detCam = new THREE.PerspectiveCamera(12, 1, 0.1, 80);
const projCam = new THREE.PerspectiveCamera(50, 1, 0.1, 60);
const evalCam = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
const rayc = new THREE.Raycaster();

// Offscreen renders are the expensive part: share a per-frame budget.
let renderBudget = 0;
export function beginAIFrame() { renderBudget = 3; }
const spend = n => { if (renderBudget < n) return false; renderBudget -= n; return true; };

// ---------------------------------------------------------------------
// Map knowledge (derived from geometry only — never from hider positions)
// ---------------------------------------------------------------------
// Exposure: how many walkway points can see a spot (lower = sneakier).
function exposure(spot) {
  if (spot.exp !== undefined) return spot.exp;
  let n = 0;
  for (const p of State.map.nav) {
    if (p.room) continue;
    const d = Math.hypot(p.x - spot.x, p.z - spot.z);
    if (d > 12 || d < 0.5) continue;
    if (!Physics.segBlocked(p.x, p.z, spot.x, spot.z, 0, 0.4, 1.5, true)) n++;
  }
  spot.exp = n;
  return n;
}

// ---------------------------------------------------------------------
// Hider bot
// ---------------------------------------------------------------------
export function initHiderAI(agent) {
  agent.ai = { mode: 'choose', path: [], wait: rand(0.1, 1.2), spot: null, painted: false, cands: [], tried: [], best: null, retries: 0 };
}

function shortlist(agent) {
  const map = State.map, sk = skill(), p = agent.body.pos, r = map.room;
  const taken = State.agents.filter(a => a !== agent && a.ai && a.ai.spot).map(a => a.ai.spot);
  const timeLeft = State.phase === 'prep' ? State.timer : 0;
  const scored = [];
  for (const s of map.spots) {
    if (taken.some(t => Math.hypot(t.x - s.x, t.z - s.z) < 3)) continue;
    const dist = Math.hypot(s.x - p.x, s.z - p.z);
    if (dist / sk.walk > timeLeft - 22) continue; // leave time to paint & self-check
    const far = Math.hypot(s.x - r.cx, s.z - r.cz);
    const score = s.corner * sk.spotCorner - exposure(s) * 0.12 + Math.min(far, 20) * 0.08 + Math.random() * 1.5;
    scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, sk.shortlist).map(o => ({ spot: o.s, pre: o.score, val: null }));
}

// Render the background a seeker would see behind the spot; uniform & dark = good.
function evaluateSpot(agent, c) {
  const s = c.spot, S = 24;
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
  evalCam.position.set(s.x + fx * 4.5, 1.45, s.z + fz * 4.5);
  for (let k = 0; k < 5 && !Physics.clear(evalCam.position.x, evalCam.position.z, 0.15, 1.2, 1.8); k++) evalCam.position.lerp(v1.set(s.x, 1.45, s.z), 0.25);
  evalCam.lookAt(s.x, 0.8, s.z);
  evalCam.fov = 26; evalCam.aspect = 1; evalCam.updateProjectionMatrix(); evalCam.updateMatrixWorld();
  const buf = Renderer.renderPixels(evalCam, S, S, [agent.char.root]);
  // body region: central columns, full height
  let n = 0, mr = 0, mg = 0, mb = 0;
  const px = [];
  for (let y = 2; y < S - 2; y++) for (let x = 8; x < 16; x++) {
    const i = (y * S + x) * 4; const r = LIN2SRGB[buf[i]], g = LIN2SRGB[buf[i + 1]], b = LIN2SRGB[buf[i + 2]];
    px.push(r, g, b); mr += r; mg += g; mb += b; n++;
  }
  mr /= n; mg /= n; mb /= n;
  let v = 0;
  for (let i = 0; i < px.length; i += 3) v += (px[i] - mr) ** 2 + (px[i + 1] - mg) ** 2 + (px[i + 2] - mb) ** 2;
  const sd = Math.sqrt(v / n) / 255;           // 0 = perfectly flat colour
  const lum = (0.3 * mr + 0.59 * mg + 0.11 * mb) / 255;
  c.val = c.pre * 0.25 - sd * 9 - lum * 1.2;
}

function choosePose(spot) {
  if (Config.skill === 'easy') return pick(['crouch', 'curl', 'wall', 'stand', 'sit']);
  if (spot.open) return pick(['curl', 'lie']);
  if (spot.corner >= 1) return pick(['curl', 'crouch', 'wall']);
  return pick(['wall', 'crouch', 'curl', 'wall']);
}
const RETRY_POSES = ['curl', 'crouch', 'wall', 'sit', 'lie'];

export function updateHiderAI(agent, dt, move) {
  const ai = agent.ai, p = agent.body.pos, sk = skill();
  if (agent.char.locked) { move.x = 0; move.z = 0; return; }
  switch (ai.mode) {
    case 'choose':
      if ((ai.wait -= dt) > 0) break;
      ai.cands = shortlist(agent);
      if (!ai.cands.length) {
        const n = pick(State.map.nav.filter(q => !q.room));
        ai.spot = { x: n.x, z: n.z, yaw: rand(0, 6.28), corner: 0, open: true };
        ai.path = findPath(State.map, p.x, p.z, ai.spot.x, ai.spot.z); ai.mode = 'walk';
        break;
      }
      ai.evalIdx = 0; ai.mode = 'evaluate';
      break;
    case 'evaluate': {
      // one spot render per frame (budgeted)
      if (ai.evalIdx < ai.cands.length && (Config.skill === 'easy' || ai.cands.length === 1)) { ai.cands.forEach(c => (c.val = c.pre)); ai.evalIdx = ai.cands.length; }
      while (ai.evalIdx < ai.cands.length && spend(1)) evaluateSpot(agent, ai.cands[ai.evalIdx++]);
      if (ai.evalIdx < ai.cands.length) break;
      ai.cands.sort((a, b) => b.val - a.val);
      ai.spot = ai.cands[0].spot;
      ai.path = findPath(State.map, p.x, p.z, ai.spot.x, ai.spot.z);
      ai.mode = 'walk'; ai.stuck = 0;
      break;
    }
    case 'walk': {
      // someone else grabbed the spot? pick again
      if (State.agents.some(a => a !== agent && a.ai && a.ai.spot && a.ai.mode !== 'choose' && a.ai.mode !== 'evaluate' && a.ai.spot !== ai.spot && Math.hypot(a.ai.spot.x - ai.spot.x, a.ai.spot.z - ai.spot.z) < 1.5)) { ai.mode = 'choose'; ai.spot = null; break; }
      if (followPath(agent, dt, move, sk.run) || (State.phase === 'prep' && State.timer < 12)) {
        ai.mode = 'settle'; ai.wait = 0.8;
        ai.pose = choosePose(ai.spot); agent.char.setPose(ai.pose);
        ai.tried = [ai.pose]; ai.best = null; ai.retries = 0;
      }
      break;
    }
    case 'settle':
      agent.yaw = angleDamp(agent.yaw, ai.spot.yaw, 8, dt);
      if ((ai.wait -= dt) <= 0) startPainting(agent);
      break;
    case 'painting': break; // projection job running
    case 'check': selfCheck(agent); break;
    case 'done':
      if (!ai.cloned) { ai.cloned = true; placeBotClones(agent); }
      break;
  }
}
function startPainting(agent) {
  const ai = agent.ai;
  ai.mode = 'painting';
  agent.yaw = ai.spot.yaw; agent.char.root.rotation.y = agent.yaw;
  agent.char.snapPose(); agent.char.root.updateMatrixWorld(true);
  queuePaint(agent);
}
// After painting: look at ourselves the way a seeker would.
function selfCheck(agent) {
  const ai = agent.ai, sk = skill(), c = agent.char;
  if (!spend(2)) return;
  const center = c.centerWorld(v1).clone();
  let tot = 0, n = 0;
  for (const a of [-0.5, 0.5]) {
    const yaw = agent.yaw + a;
    const eye = v2.set(center.x + Math.sin(yaw) * 5, 1.45, center.z + Math.cos(yaw) * 5);
    for (let k = 0; k < 5 && !Physics.clear(eye.x, eye.z, 0.15, 1.2, 1.8); k++) eye.lerp(v3.set(center.x, 1.45, center.z), 0.25);
    tot += detectScore(eye, center, c, null); n++;
  }
  const score = tot / n;
  if (!ai.best || score < ai.best.score) ai.best = { score, pose: c.pose };
  const timeOk = State.phase === 'prep' && State.timer > 10;
  if (score > 0.25 && ai.retries < sk.retries && timeOk) {
    ai.retries++;
    const next = RETRY_POSES.find(p => !ai.tried.includes(p));
    if (next) { ai.tried.push(next); c.setPose(next); startPainting(agent); return; }
  }
  if (ai.best.pose !== c.pose && timeOk) { c.setPose(ai.best.pose); ai.retries = 99; startPainting(agent); return; }
  ai.mode = 'done';
}
function placeBotClones(agent) {
  const n = Math.min(Config.clones, Config.skill === 'hard' ? 3 : Config.skill === 'medium' ? 2 : 1);
  const map = State.map, me = agent.body.pos;
  // decoys go in plain view on walkways/near the seeker room, where seekers will waste tags on them
  const spots = map.spots.filter(s => Math.hypot(s.x - me.x, s.z - me.z) > 6).sort((a, b) => exposure(b) - exposure(a)).slice(0, 12);
  for (let i = 0; i < n && spots.length; i++) {
    const s = spots.splice((Math.random() * spots.length) | 0, 1)[0];
    State.hooks.spawnClone(agent, s.x, Physics.groundAt(s.x, s.z, 0.2, 1), s.z, s.yaw);
  }
}

// ---------------------------------------------------------------------
// Auto-paint job: project rendered background onto the body.
// ---------------------------------------------------------------------
const paintQueue = [];
let job = null;
function queuePaint(agent) { if (!paintQueue.includes(agent)) paintQueue.push(agent); }
export function forcePaint(agent) { queuePaint(agent); }

function startJob(agent) {
  const c = agent.char, sk = skill();
  c.root.updateMatrixWorld(true);
  const center = c.centerWorld(new THREE.Vector3());
  const hide = [c.root, ...agent.clones.map(k => k.char.root)];
  const yaw = agent.yaw, R = sk.projRes, views = [];
  const white = getWhiteTex(), map0 = c.material.map;
  c.setMaterialProps(0, 0.85);
  for (const a of sk.angles) {
    const dx = Math.sin(yaw + a), dz = Math.cos(yaw + a);
    const D = 3.2 + 1.6 * c.scale;
    projCam.fov = 2 * Math.atan((1.25 * c.height) / D) * 180 / Math.PI + 10;
    projCam.aspect = 1; projCam.position.set(center.x + dx * D, 1.45, center.z + dz * D);
    for (let k = 0; k < 6 && !Physics.clear(projCam.position.x, projCam.position.z, 0.15, 1.2, 1.8); k++) projCam.position.lerp(center, 0.2);
    projCam.lookAt(center); projCam.updateProjectionMatrix(); projCam.updateMatrixWorld();
    const bg = Renderer.renderPixels(projCam, R, R, hide);
    let lit = null;
    if (sk.comp > 0) {
      c.material.map = white; c.material.needsUpdate = true;
      lit = Renderer.renderPixels(projCam, R, R, agent.clones.map(k => k.char.root));
      c.material.map = map0; c.material.needsUpdate = true;
    }
    const vp = new THREE.Matrix4().multiplyMatrices(projCam.projectionMatrix, projCam.matrixWorldInverse);
    const fwd = new THREE.Vector3(); projCam.getWorldDirection(fwd);
    const parts = c.meshes.map(m => {
      const M = new THREE.Matrix4().multiplyMatrices(vp, m.matrixWorld).elements;
      const inv = new THREE.Matrix3().setFromMatrix4(m.matrixWorld).invert();
      const lv = fwd.clone().negate().applyMatrix3(inv).normalize();
      return { M, lv };
    });
    views.push({ bg, lit, parts, front: a === 0 });
  }
  const b = () => 1 + (Math.random() - 0.5) * sk.noise * 2;
  job = { agent, views, R, k: 0, comp: sk.comp, bias: [b(), b(), b()] };
}

// bilinear sample of a linear RGBA byte buffer, returns 0..1
function sample(buf, R, sx, sy, ch) {
  const x = clamp(sx - 0.5, 0, R - 1.001), y = clamp(sy - 0.5, 0, R - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i00 = (y0 * R + x0) * 4 + ch, i10 = i00 + 4, i01 = i00 + R * 4, i11 = i01 + 4;
  return ((buf[i00] * (1 - fx) + buf[i10] * fx) * (1 - fy) + (buf[i01] * (1 - fx) + buf[i11] * fx) * fy) / 255;
}

function stepJob(budgetMs) {
  const t0 = performance.now();
  const { agent, views, R, comp, bias } = job;
  const c = agent.char, data = c.data, used = Rig.used, L = Rig.texLocal, Nn = Rig.texNormal, P = Rig.texPart;
  if (!c.data) { job = null; return; }
  const total = used.length;
  while (job.k < total) {
    const end = Math.min(total, job.k + 20000);
    for (let k = job.k; k < end; k++) {
      const idx = used[k], i4 = idx * 4, i3 = idx * 3, part = P[idx];
      const lx = L[i3], ly = L[i3 + 1], lz = L[i3 + 2], nx = Nn[i3], ny = Nn[i3 + 1], nz = Nn[i3 + 2];
      // choose the view that faces this texel most directly (front view gets a small bias)
      let best = 0, bestDot = -2;
      for (let v = 0; v < views.length; v++) {
        const lv = views[v].parts[part].lv; const d = nx * lv.x + ny * lv.y + nz * lv.z + (views[v].front ? 0.15 : 0);
        if (d > bestDot) { bestDot = d; best = v; }
      }
      const V = views[best], M = V.parts[part].M;
      const w = M[3] * lx + M[7] * ly + M[11] * lz + M[15];
      const sx = ((M[0] * lx + M[4] * ly + M[8] * lz + M[12]) / w * 0.5 + 0.5) * R;
      const sy = ((M[1] * lx + M[5] * ly + M[9] * lz + M[13]) / w * 0.5 + 0.5) * R;
      for (let ch = 0; ch < 3; ch++) {
        let lin = sample(V.bg, R, sx, sy, ch);
        if (comp > 0 && V.lit && bestDot > -0.1) {
          const lt = Math.max(0.03, sample(V.lit, R, sx, sy, ch));
          lin = lin / (1 + (lt - 1) * comp);
        }
        lin = Math.min(1, lin * bias[ch]);
        data[i4 + ch] = LIN2SRGB[Math.round(lin * 255)];
      }
    }
    job.k = end;
    if (performance.now() - t0 > budgetMs) break;
  }
  c.markDirty();
  if (job.k >= total) {
    const ai = agent.ai;
    ai.painted = true;
    ai.mode = skill().retries > 0 || Config.skill !== 'easy' ? 'check' : 'done';
    job = null;
  }
}

export function updatePaintJobs() {
  if (job) {
    if (!job.agent.char.data || job.agent.found) { job = null; return; }
    stepJob(5); return;
  }
  while (paintQueue.length) {
    const a = paintQueue.shift();
    if (a.char && a.char.data && !a.found) { startJob(a); break; }
  }
}
export function resetAI() { paintQueue.length = 0; job = null; }
// Force-finish anything pending (hunt starting)
export function finishPaintJobs() {
  let guard = 0;
  while ((job || paintQueue.length) && guard++ < 50) { if (!job) updatePaintJobs(); if (job) stepJob(1e9); }
  for (const a of State.agents) if (a.ai && (a.ai.mode === 'check' || a.ai.mode === 'painting')) a.ai.mode = 'done';
}

// ---------------------------------------------------------------------
// Seeker bot
// ---------------------------------------------------------------------
export function initSeekerAI(agent) {
  agent.ai = {
    mode: 'wait', path: [], susp: new Map(), lookT: rand(0, 6), nextVis: rand(0.05, 0.3), chase: null, react: 0,
    visits: agent.ai?.visits || new Map(), glance: null, glanceT: 0, glanced: new Map(), fails: 0, pauseT: 0, goal: null,
  };
  agent.lookYaw = agent.yaw;
}

export function updateSeekerAI(agent, dt, move) {
  const ai = agent.ai, p = agent.body.pos, sk = skill();
  ai.lookT += dt;
  if (agent.stunT > 0) { move.x = move.z = 0; return; }
  if (State.phase !== 'hunt') {
    move.x = move.z = 0;
    agent.yaw += Math.sin(ai.lookT * 0.7) * dt * 0.8; agent.lookYaw = agent.yaw; agent.lookOff = 0;
    return;
  }
  // --- vision ---
  ai.nextVis -= dt;
  if (ai.nextVis <= 0 && spend(2)) { ai.nextVis = sk.visEvery * (0.85 + Math.random() * 0.3); look(agent, sk); }
  for (const [t, s] of ai.susp) { const ns = s - dt * 0.05; if (ns <= 0 || !t.alive) ai.susp.delete(t); else ai.susp.set(t, ns); }

  // most suspicious thing we've noticed
  let focus = null, fs = 0;
  for (const [t, s] of ai.susp) if (s > fs) { fs = s; focus = t; }

  if (ai.mode === 'chase') { chase(agent, dt, move, sk); updateLook(agent, dt, ai.chase); return; }
  if (focus && fs > 1) { startChase(agent, focus, sk); return; }

  if (focus && fs > 0.2) {
    // --- investigate: walk towards the faint oddity to get a better look ---
    const tp = focus.char.root.position, d = Math.hypot(tp.x - p.x, tp.z - p.z);
    if (ai.mode !== 'investigate' || ai.invTarget !== focus) { ai.mode = 'investigate'; ai.invTarget = focus; ai.path = findPath(State.map, p.x, p.z, tp.x, tp.z); }
    if (d < 2.6) move.x = move.z = 0; else followPath(agent, dt, move, sk.walk);
    updateLook(agent, dt, focus);
    ai.invT = (ai.invT || 0) + dt;
    if (ai.invT > 7) { ai.susp.set(focus, fs * 0.3); ai.invT = 0; ai.mode = 'patrol'; ai.path = []; }
    return;
  }
  if (ai.mode === 'investigate') { ai.mode = 'patrol'; ai.path = []; ai.invT = 0; }
  ai.mode = 'patrol';
  // --- patrol ---
  if (ai.pauseT > 0) { ai.pauseT -= dt; move.x = move.z = 0; agent.yaw += dt * 2.2; updateLook(agent, dt, null); return; }
  if (!ai.path.length) pickPatrolGoal(agent);
  if (followPath(agent, dt, move, ai.fast ? sk.run : sk.walk)) { ai.path = []; ai.pauseT = Config.skill === 'easy' ? 0 : rand(0.6, 1.4); }
  updateLook(agent, dt, null);
}

// Head control: focus target > glance at a nearby nook > sweep ahead.
function updateLook(agent, dt, focus) {
  const ai = agent.ai, p = agent.body.pos;
  let want;
  if (focus) { const t = focus.char.root.position; want = Math.atan2(t.x - p.x, t.z - p.z); }
  else {
    ai.glanceT -= dt;
    if (ai.glanceT <= 0) {
      ai.glance = null; ai.glanceT = 0.7;
      let best = null, bs = -1e9;
      for (const s of State.map.spots) {
        const dx = s.x - p.x, dz = s.z - p.z, d = Math.hypot(dx, dz);
        if (d > 11 || d < 1) continue;
        const ang = Math.atan2(dx, dz), diff = Math.abs(((ang - agent.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (diff > 1.9) continue;
        const last = ai.glanced.get(s) ?? -99;
        if (State.roundTime - last < 12) continue;
        if (Physics.segBlocked(p.x, p.z, s.x, s.z, 0, 0.4, 1.5, false)) continue;
        const sc = -d * 0.2 - diff + s.corner * 0.5 + Math.random();
        if (sc > bs) { bs = sc; best = s; }
      }
      if (best) { ai.glance = best; ai.glanced.set(best, State.roundTime); }
    }
    if (ai.glance) want = Math.atan2(ai.glance.x - p.x, ai.glance.z - p.z);
    else want = agent.yaw + Math.sin(ai.lookT * 1.4) * 0.8;
  }
  agent.lookYaw = angleDamp(agent.lookYaw ?? agent.yaw, want, 7, dt);
  let off = ((agent.lookYaw - agent.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  agent.lookOff = clamp(off, -1.9, 1.9);
}

function startChase(agent, t, sk) {
  const ai = agent.ai;
  ai.mode = 'chase'; ai.chase = t; ai.path = []; ai.react = sk.react + Math.random() * 0.25; ai.repathT = 0; ai.fails = 0;
}
function chase(agent, dt, move, sk) {
  const ai = agent.ai, p = agent.body.pos, t = ai.chase;
  if (!t || !t.alive) { ai.mode = 'patrol'; ai.path = []; ai.chase = null; return; }
  const tp = t.char.root.position;
  const d = Math.hypot(tp.x - p.x, tp.z - p.z);
  const reach = 1.5 + t.char.radius;
  if (d < reach) {
    move.x = move.z = 0;
    agent.yaw = angleDamp(agent.yaw, Math.atan2(tp.x - p.x, tp.z - p.z), 12, dt);
    ai.react -= dt;
    if (ai.react > 0) return;
    // line-of-fire check: make sure the tag ray would actually hit the target
    const eye = agent.eye(v2).clone();
    const aimPts = [t.char.centerWorld(v1).clone(), t.char.headWorld(new THREE.Vector3()), t.char.root.position.clone().add(v3.set(0, 0.3 * t.char.scale, 0))];
    for (const c of aimPts) {
      const dir = c.clone().sub(eye).normalize();
      if (lineOfFire(eye, dir, t)) {
        agent.aimDir = dir;
        State.hooks.tag(agent);
        ai.mode = 'patrol'; ai.path = []; ai.chase = null; ai.susp.delete(t);
        return;
      }
    }
    // blocked: step around to another side and retry
    ai.fails++;
    ai.react = 0.3;
    if (ai.fails > 4) { agent.aimDir = aimPts[0].sub(eye).normalize(); State.hooks.tag(agent); ai.mode = 'patrol'; ai.chase = null; ai.path = []; return; }
    const a = Math.atan2(p.x - tp.x, p.z - tp.z) + (ai.fails % 2 ? 1.1 : -1.1);
    const nx = tp.x + Math.sin(a) * 1.1, nz = tp.z + Math.cos(a) * 1.1;
    if (Physics.clear(nx, nz, 0.3)) ai.path = [{ x: nx, z: nz }];
    return;
  }
  if (ai.path.length && ai.path.length < 3 && ai.fails > 0) { followPath(agent, dt, move, sk.walk); return; }
  if (!ai.path.length || ai.repathT <= 0) { ai.path = findPath(State.map, p.x, p.z, tp.x, tp.z); ai.repathT = 1.5; }
  ai.repathT -= dt;
  followPath(agent, dt, move, sk.run);
}
function lineOfFire(eye, dir, t) {
  rayc.set(eye, dir); rayc.far = 2.6; rayc.near = 0;
  const objs = [...State.map.rayMeshes];
  for (const o of State.targets) if (o.alive) objs.push(...o.char.meshes);
  const hit = rayc.intersectObjects(objs, false)[0];
  return hit && hit.object.userData.char === t.char;
}

function pickPatrolGoal(agent) {
  const map = State.map, p = agent.body.pos, ai = agent.ai;
  const now = State.roundTime;
  const others = State.agents.filter(a => a !== agent && a.role === 'seeker' && a.ai && a.ai.goal).map(a => a.ai.goal);
  let best = null, bs = -1e9;
  const spotBias = Config.skill === 'hard' ? 0.85 : Config.skill === 'medium' ? 0.7 : 0.5;
  for (let i = 0; i < 16; i++) {
    const cand = Math.random() < spotBias && map.spots.length ? pick(map.spots) : pick(map.nav);
    if (!cand || cand.room) continue;
    const key = Math.round(cand.x / 4) + ',' + Math.round(cand.z / 4);
    const last = Math.max(ai.visits.get(key) ?? -999, sharedVisits.get(key) ?? -999);
    const d = Math.hypot(cand.x - p.x, cand.z - p.z);
    let s = Math.min(60, now - last) - d * 0.35 + Math.random() * 6;
    // spread out: avoid where teammates are heading
    for (const g of others) { const gd = Math.hypot(g.x - cand.x, g.z - cand.z); if (gd < 8) s -= (8 - gd) * 3; }
    // dense nook areas are worth more
    if (Config.skill !== 'easy') s += map.spots.filter(o => Math.abs(o.x - cand.x) < 3 && Math.abs(o.z - cand.z) < 3).length * 1.5;
    if (s > bs) { bs = s; best = { cand, key }; }
  }
  if (!best) return;
  ai.visits.set(best.key, now); sharedVisits.set(best.key, now);
  ai.goal = { x: best.cand.x, z: best.cand.z };
  ai.fast = Math.hypot(best.cand.x - p.x, best.cand.z - p.z) > 12 && Config.skill !== 'easy';
  ai.path = findPath(map, p.x, p.z, best.cand.x, best.cand.z);
}
const sharedVisits = new Map();
export function resetSharedMemory() { sharedVisits.clear(); }

// Pick a candidate target in view & render-compare it.
const bufA = new Uint8Array(40 * 40 * 4), bufB = new Uint8Array(40 * 40 * 4);
function look(agent, sk) {
  const eye = agent.eye(v1).clone();
  const lookYaw = agent.yaw + (agent.lookOff || 0);
  const fx = Math.sin(lookYaw), fz = Math.cos(lookYaw);
  const cands = [];
  for (const t of State.targets) {
    if (!t.alive || t.owner === agent) continue;
    const c = t.char.centerWorld(v2);
    const dx = c.x - eye.x, dz = c.z - eye.z, d = Math.hypot(dx, dz);
    if (d > sk.range || d < 0.3) continue;
    const cos = (dx * fx + dz * fz) / d;
    if (cos < Math.cos((sk.fov / 2) * Math.PI / 180)) continue;
    if (Physics.segBlocked(eye.x, eye.z, c.x, c.z, 0, 0.4, 1.9, false) && Physics.segBlocked(eye.x, eye.z, c.x, c.z, 0, 1.4, 1.9, false)) continue;
    cands.push({ t, d, s: agent.ai.susp.get(t) || 0 });
  }
  if (!cands.length) return;
  // keep checking what we already find suspicious, otherwise nearest-first with some variety
  cands.sort((a, b) => (b.s - a.s) || (a.d - b.d));
  const { t, d } = cands[0].s > 0.05 && Math.random() < 0.7 ? cands[0] : (Math.random() < 0.6 ? cands.sort((a, b) => a.d - b.d)[0] : pick(cands));
  const c = t.char.centerWorld(v2).clone();
  // 3D occlusion: check centre and head, the body may be partly visible
  let visible = false;
  for (const pt of [c, t.char.headWorld(new THREE.Vector3())]) {
    const dd = eye.distanceTo(pt);
    rayc.set(eye, v3.subVectors(pt, eye).normalize()); rayc.far = dd; rayc.near = 0;
    const occ = rayc.intersectObjects(State.map.rayMeshes, false);
    if (!occ.length || occ[0].distance > dd - 0.4) { visible = true; break; }
  }
  if (!visible) return;
  const score = detectScore(eye, c, t.char, agent.char.root);
  const gain = Math.max(0, score - sk.floor) * sk.detectK * 0.3 * (d < 4 ? 1.7 : d < 8 ? 1.2 : 1);
  if (gain <= 0) return;
  agent.ai.susp.set(t, (agent.ai.susp.get(t) || 0) + gain);
}
// Render the target window with and without the body; return contrast score.
export function detectScore(eye, center, char, selfRoot) {
  const S = 40;
  detCam.position.copy(eye); detCam.lookAt(center);
  detCam.fov = 12; detCam.aspect = 1; detCam.updateProjectionMatrix(); detCam.updateMatrixWorld();
  const self = selfRoot ? [selfRoot] : [];
  Renderer.renderPixels(detCam, S, S, self, bufA);
  Renderer.renderPixels(detCam, S, S, [...self, char.root], bufB);
  let sum = 0;
  for (let i = 0; i < S * S * 4; i += 4) {
    const dr = LIN2SRGB[bufA[i]] - LIN2SRGB[bufB[i]], dg = LIN2SRGB[bufA[i + 1]] - LIN2SRGB[bufB[i + 1]], db = LIN2SRGB[bufA[i + 2]] - LIN2SRGB[bufB[i + 2]];
    const dd = Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db) / 255;
    if (dd > 0.045) sum += dd - 0.045;
  }
  return (sum / (S * S)) * 12;
}

// ---------------------------------------------------------------------
// Shared path following. Returns true when the path is complete.
// ---------------------------------------------------------------------
function followPath(agent, dt, move, speed) {
  const ai = agent.ai, p = agent.body.pos;
  while (ai.path.length && Math.hypot(ai.path[0].x - p.x, ai.path[0].z - p.z) < 0.35) ai.path.shift();
  if (!ai.path.length) { move.x = move.z = 0; return true; }
  if (ai.path.length > 1 && !Physics.segBlocked(p.x, p.z, ai.path[1].x, ai.path[1].z, 0.32, 0.3, 1.6, false)) ai.path.shift();
  const t = ai.path[0];
  const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz);
  // slow down on final approach so bots stop precisely on their spot
  const sp = ai.path.length === 1 ? Math.min(speed, 1 + d * 3) : speed;
  move.x = (dx / d) * sp; move.z = (dz / d) * sp;
  agent.yaw = angleDamp(agent.yaw, Math.atan2(dx, dz), 8, dt);
  const moved = Math.hypot(p.x - (ai.lx ?? p.x), p.z - (ai.lz ?? p.z));
  ai.lx = p.x; ai.lz = p.z;
  ai.stuck = moved < sp * dt * 0.2 ? (ai.stuck || 0) + dt : 0;
  if (ai.stuck > 1.0) { ai.stuck = 0; if (ai.path.length === 1) { ai.path = []; return true; } ai.path.shift(); agent.body.vel.y = 6; }
  return false;
}
export { inRoom };
