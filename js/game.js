// =====================================================================
// Modes module — round flow (setup -> prep -> hunt -> results), the four
// game modes (Basic / Infection / Double / Reverse), agents (player +
// bots), tagging, clones, player controller and camera modes.
// =====================================================================
import * as THREE from 'three';
import { State, Config, Settings, Bus, clamp, damp, rand, pick, angleDamp } from './state.js';
import { scene, camera, Renderer } from './renderer.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { Character } from './character.js';
import { PaintMode, PaintEngine } from './paint.js';
import { loadMap, unloadMap, openDoors, updateMap, inRoom } from './maps.js';
import { Physics } from './physics.js';
import * as AI from './ai.js';

const NAMES = ['Mochi', 'Tofu', 'Wasabi', 'Yuzu', 'Natto', 'Daifuku', 'Onigiri', 'Kinako', 'Dango', 'Matcha', 'Ume', 'Sakura'];
const TAG_RANGE = 2.6;
const PLAYER_SCALE = 0.85; // the player is a touch smaller than bots
const WALK = 4.3, SPRINT = 7.2, JUMP_V = 7.2;

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const thumbCam = new THREE.PerspectiveCamera(40, 0.8, 0.05, 100);

// ---------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------
class Agent {
  constructor({ name, isPlayer = false, size = 1 }) {
    this.name = name; this.isPlayer = isPlayer; this.size = size;
    this.role = 'hider'; this.char = null;
    this.body = { pos: null, vel: new THREE.Vector3(), radius: 0.3, height: 1.6, grounded: true };
    this.yaw = 0; this.pitch = 0; this.lookOff = 0;
    this.stamina = 1; this.exhausted = false; this.stunT = 0; this.tagCD = 0;
    this.found = false; this.foundAt = 0; this.foundBy = null; this.finds = 0;
    this.clones = []; this.stepDist = 0; this.ai = null; this.aimDir = new THREE.Vector3(0, 0, 1);
    this.wasHider = false; this.card = null;
  }
  setChar(c) {
    this.char = c; this.body.pos = c.root.position; this.body.radius = c.radius; this.body.height = c.height; this.body.vel.set(0, 0, 0);
  }
  eye(out) { return out.copy(this.body.pos).add(v3.set(0, 1.45 * this.char.scale, 0)); }
}

// ---------------------------------------------------------------------
// Game (Modes)
// ---------------------------------------------------------------------
export const Game = {
  cam: { yaw: 0, pitch: 0.25, dist: 3.4 },
  spec: { pos: new THREE.Vector3(), yaw: 0, pitch: 0 },
  expectUnlock: false,
  lastTick: -1,

  init() {
    State.hooks = { tag: a => this.tag(a), spawnClone: (a, x, y, z, yaw) => this.spawnClone(a, x, y, z, yaw) };
    PaintMode.onClose = () => { if (State.screen === 'game' && !State.paused) this.lock(); };
    Input.on('key', (c, e) => this.onKey(c, e));
    Input.on('keyup', c => this.onKeyUp(c));
    Input.on('down', e => this.onMouseDown(e));
    Input.on('lock', locked => this.onLockChange(locked));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { Audio.suspend(); if (State.screen === 'game' && State.phase !== 'over') this.pause(); }
      else Audio.resume();
    });
  },

  // ---------- match / round lifecycle ----------
  startMatch() {
    State.round = 0; State.seekerRotation = Math.floor(Math.random() * 100);
    this.agents = null;
    this.startRound();
  },
  cleanupRound() {
    PaintMode.close(); UI.closeWheel();
    for (const a of State.agents) {
      if (a.char) a.char.dispose();
      if (a.hideChar) a.hideChar.dispose();
      a.clones.forEach(k => k.char.dispose());
    }
    State.targets = [];
    AI.resetAI(); AI.resetSharedMemory();
  },
  startRound() {
    this.cleanupRound();
    State.map = loadMap(Config.map);
    State.screen = 'game'; State.paused = false; State.phase = 'prep'; State.timer = Config.prepTime; State.roundTime = 0;
    PaintEngine.clearHistory();
    UI.clearFeed();

    // agents persist across rounds (scores/names), recreate if config changed
    if (!this.agents || this.agents.length !== Config.bots + 1) {
      const names = [...NAMES].sort(() => Math.random() - 0.5);
      this.agents = [new Agent({ name: 'You', isPlayer: true, size: Config.size })];
      for (let i = 0; i < Config.bots; i++) this.agents.push(new Agent({ name: names[i], size: pick([0.75, 1, 1, 1, 1.25, Config.skill === 'hard' ? 0.5 : 1]) }));
    }
    State.agents = this.agents; State.player = this.agents[0];
    State.player.size = Config.size;
    for (const a of State.agents) {
      a.found = false; a.foundAt = 0; a.foundBy = null; a.finds = 0; a.clones = []; a.hideChar = null;
      a.stunT = 0; a.tagCD = 0; a.stamina = 1; a.card = null; a.wasHider = false; a.ai = null;
    }
    this.assignRoles();
    // spawn bodies
    const map = State.map;
    const hSpawn = map.nav.filter(p => !p.room && Math.hypot(p.x - map.hiderSpawn[0], p.z - map.hiderSpawn[1]) < 6);
    const rSpawn = map.nav.filter(p => p.room);
    let hi = 0, si = 0;
    const shuffle = arr => arr.sort(() => Math.random() - 0.5);
    shuffle(hSpawn); shuffle(rSpawn);
    for (const a of State.agents) {
      const hider = a.role === 'hider';
      const c = new Character({ scale: (hider ? a.size : 1) * (a.isPlayer ? PLAYER_SCALE : 1), name: a.name });
      scene.add(c.root);
      a.setChar(c);
      const sp = hider ? hSpawn[hi++ % Math.max(1, hSpawn.length)] : rSpawn[si++ % Math.max(1, rSpawn.length)];
      const jitter = hider ? 0.5 : 0.3;
      c.root.position.set((sp ? sp.x : 0) + rand(-jitter, jitter), 0, (sp ? sp.z : 0) + rand(-jitter, jitter));
      a.yaw = hider ? rand(0, 6.28) : Math.atan2(map.room.cx - c.root.position.x, map.room.cz - c.root.position.z) + Math.PI;
      if (!hider) { const [ix, iz] = map.room.inward; a.yaw = Math.atan2(-ix, -iz); }
      c.root.rotation.y = a.yaw;
      c.setSeeker(!hider);
      c.setNameTag(a.isPlayer ? null : a.name, hider ? '#9be34a' : '#ff8ab8');
      if (hider) { a.wasHider = true; State.targets.push({ char: c, owner: a, kind: 'hider', alive: true }); }
      if (!a.isPlayer) hider ? AI.initHiderAI(a) : AI.initSeekerAI(a);
    }
    // player camera
    const P = State.player;
    this.cam.yaw = P.yaw + Math.PI; this.cam.pitch = 0.25; this.cam.dist = 2.6 + 1.6 * P.char.scale;
    State.camMode = P.role === 'hider' ? 'third' : 'first';
    P.pitch = 0;
    UI.show(null);
    Audio.music('prep');
    if (P.role === 'hider') { UI.popup('HIDE!', '#9be34a'); Audio.play('hide'); }
    else { UI.popup('WAIT…', '#29d3f0'); }
    const modeName = { basic: 'Basic', infection: 'Infection', double: 'Double', reverse: 'Reverse' }[Config.mode];
    UI.feed(`Round ${State.round + 1} · ${modeName} · ${map.name}`);
    this.lastTick = -1;
    this.lock();
  },
  assignRoles() {
    const A = State.agents, n = A.length, P = A[0];
    A.forEach(a => (a.role = 'hider'));
    if (Config.mode === 'double') return;
    const rot = State.seekerRotation;
    const bots = A.slice(1);
    const order = bots.map((b, i) => bots[(i + rot) % bots.length]);
    if (Config.mode === 'reverse') {
      A.forEach(a => (a.role = 'seeker'));
      let hider;
      if (Config.role === 'hider') hider = P;
      else if (Config.role === 'seeker') hider = order[0];
      else hider = A[rot % n];
      hider.role = 'hider';
      return;
    }
    let k = Math.max(1, Math.round(n / 5));
    let pool = order;
    if (Config.role === 'seeker') { P.role = 'seeker'; k--; }
    else if (Config.role === 'random') pool = [...A].map((_, i) => A[(i + rot) % n]);
    for (const a of pool) { if (k <= 0) break; if (a.role !== 'seeker') { a.role = 'seeker'; k--; } }
  },

  // Prep -> Hunt
  startHunt() {
    State.phase = 'hunt'; State.timer = Config.huntTime; State.roundTime = 0;
    PaintMode.close(); if (UI.wheel.open) UI.closeWheel();
    // bots that never reached a spot freeze where they are and paint quickly
    for (const a of State.agents) if (!a.isPlayer && a.role === 'hider' && a.ai && a.ai.mode !== 'done' && a.ai.mode !== 'painting' && a.ai.mode !== 'check') {
      a.ai.spot = a.ai.spot || { yaw: a.yaw }; a.char.setPose(pick(['crouch', 'curl', 'stand'])); a.char.snapPose();
      a.ai.mode = 'painting'; a.char.root.updateMatrixWorld(true);
      AI.forcePaint(a);
    }
    AI.finishPaintJobs();
    for (const a of State.agents) if (a.role === 'hider') { a.char.locked = true; a.body.vel.set(0, 0, 0); }
    if (Config.mode === 'double') {
      // everyone leaves a frozen statue behind and hunts from the waiting room
      const rSpawn = State.map.nav.filter(p => p.room).sort(() => Math.random() - 0.5);
      State.agents.forEach((a, i) => {
        a.hideChar = a.char;
        const c = new Character({ scale: a.isPlayer ? PLAYER_SCALE : 1, name: a.name }); scene.add(c.root);
        const sp = rSpawn[i % rSpawn.length];
        c.root.position.set(sp.x, 0, sp.z);
        const [ix, iz] = State.map.room.inward; a.yaw = Math.atan2(-ix, -iz); c.root.rotation.y = a.yaw;
        c.setSeeker(true); c.setNameTag(a.isPlayer ? null : a.name, '#ff8ab8');
        a.setChar(c); a.role = 'seeker';
        if (!a.isPlayer) AI.initSeekerAI(a);
      });
      State.camMode = 'first';
      State.player.pitch = 0;
    }
    openDoors(State.map);
    Audio.play('go'); Audio.play('door'); Audio.music('hunt');
    UI.popup('GO!', '#ff4f9a'); State.shake = 0.35;
  },

  endRound(reason) {
    if (State.phase === 'over') return;
    State.phase = 'over';
    PaintMode.close(); if (UI.wheel.open) UI.closeWheel();
    const P = State.player, A = State.agents;
    const hiders = A.filter(a => a.wasHider);
    // thumbnails for anyone who survived (found ones were captured at tag time)
    for (const h of hiders) if (!h.card) h.card = this.thumb(h.hideChar || h.char);
    let title, seekWin, sub = '', scores = null, playerWon;
    const alive = hiders.filter(h => !h.found);
    if (Config.mode === 'double') {
      scores = [...A].sort((a, b) => b.finds - a.finds).map(a => ({ name: a.name, finds: a.finds }));
      const top = scores[0]; const tie = scores.filter(s => s.finds === top.finds).length > 1;
      title = tie ? 'DRAW!' : `${top.name === 'You' ? 'YOU WIN' : top.name + ' WINS'}!`;
      playerWon = !tie && top.name === 'You'; seekWin = false;
      sub = 'Most finds wins';
    } else if (Config.mode === 'reverse') {
      const h = hiders[0];
      if (h.found) { title = `${h.foundBy.name === 'You' ? 'YOU' : h.foundBy.name.toUpperCase()} FOUND THEM!`; seekWin = true; playerWon = h.foundBy === P; }
      else { title = 'THE HIDER WINS!'; seekWin = false; playerWon = h === P; }
    } else {
      seekWin = alive.length === 0;
      title = seekWin ? 'SEEKERS WIN!' : 'HIDERS WIN!';
      const playerSide = P.wasHider && Config.mode !== 'infection' ? 'hider' : (P.wasHider && Config.mode === 'infection' ? (P.found ? 'seeker' : 'hider') : 'seeker');
      playerWon = seekWin ? playerSide === 'seeker' : playerSide === 'hider';
      sub = seekWin ? 'Every Hider was found!' : `${alive.length} Hider${alive.length > 1 ? 's' : ''} survived the hunt!`;
    }
    const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const cards = hiders.map(h => ({
      name: h.name, img: h.card, alive: !h.found, me: h.isPlayer,
      status: h.found ? `Found at ${fmt(h.foundAt)} by ${h.foundBy.name}` : `Survived ${fmt(State.roundTime)}!`,
    }));
    Audio.music('results');
    Audio.play(playerWon ? 'win' : 'lose');
    UI.popup(playerWon ? 'YOU WIN!' : 'TIME UP!', playerWon ? '#9be34a' : '#ff4f9a');
    if (playerWon) UI.confetti(innerWidth / 2, innerHeight / 3, 220, 1.3);
    setTimeout(() => {
      if (State.phase !== 'over' || State.screen !== 'game') return;
      State.screen = 'results';
      this.expectUnlock = Input.locked; Input.exitLock();
      UI.results({ title, seekWin, sub, cards, scores });
    }, 2300);
  },
  nextRound() { State.round++; State.seekerRotation++; this.startRound(); },
  quit() {
    this.cleanupRound(); unloadMap();
    State.screen = 'menu'; State.phase = 'none'; State.paused = false;
    this.expectUnlock = Input.locked; Input.exitLock();
    UI.show('menu'); Audio.music('menu');
  },

  thumb(char) {
    const c = char.centerWorld(v1), yaw = char.root.rotation.y, d = 2.2 * char.scale + 1.6;
    thumbCam.position.set(c.x + Math.sin(yaw) * d, c.y + 0.35, c.z + Math.cos(yaw) * d);
    thumbCam.lookAt(c);
    return Renderer.thumbnail(thumbCam, 160, 200);
  },

  // ---------- pause / pointer lock ----------
  lock() { if (State.screen === 'game' && !PaintMode.open) Input.requestLock(); },
  pause() {
    if (State.screen !== 'game' || State.paused || State.phase === 'over') return;
    State.paused = true; PaintMode.endStroke();
    if (UI.wheel.open) UI.closeWheel();
    this.expectUnlock = Input.locked; Input.exitLock();
    UI.show('pause');
  },
  resume() { State.paused = false; UI.show(null); if (!PaintMode.open) this.lock(); },
  onLockChange(locked) {
    if (locked) { this.expectUnlock = false; return; }
    if (this.expectUnlock) { this.expectUnlock = false; return; }
    if (State.screen === 'game' && !PaintMode.open && State.phase !== 'over') this.pause();
  },

  // ---------- input ----------
  onKey(code, e) {
    if (State.screen !== 'game' || State.paused) {
      if (code === 'Escape' && State.paused && UI.current() === 'pause') this.resume();
      return;
    }
    const P = State.player;
    if (PaintMode.open) { if (code === 'KeyQ') this.openWheel(); else PaintMode.key(code, e); return; }
    if (code === 'Escape') { this.pause(); return; }
    const prepHider = P.role === 'hider' && State.phase === 'prep' && !P.char.locked;
    if (code === 'KeyE' && prepHider) { this.expectUnlock = Input.locked; PaintMode.openFor(P.char, [P.char.root]); if (UI.wheel.open) UI.closeWheel(); return; }
    if (code === 'KeyQ' && prepHider) { this.openWheel(); return; }
    if (code === 'KeyC' && prepHider) { this.playerClone(); return; }
  },
  onKeyUp(code) {
    if (code === 'KeyQ' && UI.wheel.open) {
      const id = UI.closeWheel();
      if (id && State.phase === 'prep') { State.player.char.setPose(id); Audio.play('pose'); }
    }
  },
  openWheel() { UI.openWheel(State.player.char.pose); },
  onMouseDown(e) {
    if (State.screen !== 'game' || State.paused || PaintMode.open) return;
    if (!Input.locked) { this.lock(); return; }
    const P = State.player;
    if (e.button === 0 && P.role === 'seeker' && State.phase === 'hunt') {
      camera.getWorldDirection(P.aimDir);
      this.tag(P);
    }
  },
  playerClone() {
    const P = State.player;
    if (P.clones.length >= Config.clones) { UI.feed('No clones left!'); return; }
    this.spawnClone(P, P.body.pos.x, P.body.pos.y, P.body.pos.z, P.char.root.rotation.y);
    UI.feed(`Clone placed (${Config.clones - P.clones.length} left)`);
  },
  spawnClone(agent, x, y, z, yaw) {
    const c = agent.char.makeClone();
    c.root.position.set(x, y, z); c.root.rotation.y = yaw;
    scene.add(c.root);
    const t = { char: c, owner: agent, kind: 'clone', alive: true };
    agent.clones.push(t); State.targets.push(t);
    if (agent.isPlayer) { Audio.play('clone'); }
  },

  // ---------- tagging ----------
  tag(agent) {
    if (agent.tagCD > 0 || agent.stunT > 0 || State.phase !== 'hunt') return;
    agent.tagCD = 0.45;
    const eye = agent.eye(v1);
    raycaster.set(eye, agent.aimDir); raycaster.far = TAG_RANGE; raycaster.near = 0;
    const objs = [...State.map.rayMeshes];
    for (const t of State.targets) if (t.alive && t.owner !== agent) objs.push(...t.char.meshes);
    for (const a of State.agents) if (a !== agent && a.role === 'seeker' && a.char) objs.push(...a.char.meshes);
    const hit = raycaster.intersectObjects(objs, false)[0];
    if (agent.isPlayer) Audio.play('tag');
    if (!hit) return;
    const ch = hit.object.userData.char;
    const target = ch && State.targets.find(t => t.char === ch && t.alive);
    if (target && target.kind === 'hider') { this.found(target, agent); return; }
    if (target && target.kind === 'clone') {
      target.alive = false; this.poof(target.char);
      this.stun(agent, 2.5, 'DECOY!');
      UI.feed(`${agent.name} tagged ${target.owner.name}'s clone!`);
      return;
    }
    if (ch) return; // another seeker: harmless bump
    this.stun(agent, 1.2, 'WRONG!');
  },
  stun(agent, t, label) {
    agent.stunT = t;
    if (agent.isPlayer) { Audio.play('miss'); Audio.play('stun'); UI.popup(label, '#ff4f9a'); State.shake = 0.25; }
  },
  poof(char) {
    const p = char.centerWorld(v2).clone().project(camera);
    if (p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2) UI.confetti((p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight, 40, 0.5);
    char.root.visible = false;
    setTimeout(() => char.root.parent && char.root.parent.remove(char.root), 50);
  },
  found(target, by) {
    target.alive = false;
    const o = target.owner;
    o.found = true; o.foundAt = State.roundTime; o.foundBy = by; by.finds++;
    o.card = this.thumb(target.char);
    // clones of a found hider vanish too
    for (const k of o.clones) if (k.alive) { k.alive = false; this.poof(k.char); }
    const P = State.player;
    const p = target.char.centerWorld(v2).clone().project(camera);
    const onScreen = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    if (by.isPlayer || o.isPlayer || onScreen) {
      UI.popup('FOUND!', '#ffd23f');
      UI.confetti(onScreen ? (p.x + 1) / 2 * innerWidth : innerWidth / 2, onScreen ? (1 - p.y) / 2 * innerHeight : innerHeight / 2, 140);
      State.shake = 0.3;
    }
    Audio.play(o.isPlayer ? 'foundMe' : 'found');
    UI.feed(`${by.name} found ${o.name}!`);

    if (Config.mode === 'infection') {
      o.role = 'seeker'; o.char.locked = false; o.char.setSeeker(true); o.char.setPose('stand');
      o.char.setNameTag(o.isPlayer ? null : o.name, '#ff8ab8');
      if (o.isPlayer) { PaintMode.close(); State.camMode = 'first'; o.pitch = 0; UI.popup('INFECTED!', '#ff4f9a'); }
      else AI.initSeekerAI(o);
    } else {
      this.poof(target.char);
      if (Config.mode !== 'double') {
        o.role = 'spectator';
        if (o.isPlayer) this.enterSpectate();
      }
    }
    if (Config.mode === 'reverse') { this.endRound('found'); return; }
    if (!State.targets.some(t => t.kind === 'hider' && t.alive)) this.endRound('all');
  },
  enterSpectate() {
    State.camMode = 'spectate'; PaintMode.close();
    this.spec.pos.copy(camera.position); this.spec.yaw = this.cam.yaw + Math.PI; this.spec.pitch = -0.3;
  },

  // ---------- per-frame ----------
  update(dt) {
    if (State.screen !== 'game' && State.screen !== 'results') return;
    const map = State.map, P = State.player;
    if (State.paused || State.screen === 'results') { this.updateCamera(0); return; }
    // timers
    if (State.phase === 'prep') {
      State.timer -= dt;
      const sec = Math.ceil(State.timer);
      if (sec <= 5 && sec !== this.lastTick && sec > 0) { this.lastTick = sec; Audio.play('tick'); }
      if (State.timer <= 0) this.startHunt();
    } else if (State.phase === 'hunt') {
      State.timer -= dt; State.roundTime += dt;
      const sec = Math.ceil(State.timer);
      if (sec <= 10 && sec !== this.lastTick && sec > 0) { this.lastTick = sec; Audio.play(sec <= 3 ? 'tickFinal' : 'tick'); }
      if (State.timer <= 0) this.endRound('time');
    }
    updateMap(map, dt);
    AI.beginAIFrame();
    // agents
    const move = { x: 0, z: 0 };
    for (const a of State.agents) {
      if (a.role === 'spectator') { if (a.isPlayer) this.playerInput(a, dt, move); continue; }
      a.stunT = Math.max(0, a.stunT - dt); a.tagCD = Math.max(0, a.tagCD - dt);
      let sprint = false, jump = false;
      move.x = move.z = 0;
      if (a.isPlayer) ({ sprint, jump } = this.playerInput(a, dt, move));
      else if (State.phase !== 'over') {
        if (a.role === 'hider') AI.updateHiderAI(a, dt, move);
        else AI.updateSeekerAI(a, dt, move);
      }
      if (a.char.locked || a.stunT > 0 || State.phase === 'over') { move.x = move.z = 0; jump = false; }
      this.moveAgent(a, dt, move, sprint, jump);
    }
    AI.updatePaintJobs();
    // nametag visibility: seekers always; hiders only for spectators/after round
    const reveal = P.role === 'spectator' || State.phase === 'over';
    for (const a of State.agents) if (a.char && a.char.tag) a.char.showTag(a.role !== 'hider' || reveal);
    this.updateCamera(dt);
    this.updateHUD();
  },
  playerInput(a, dt, move) {
    let sprint = false, jump = false;
    if (PaintMode.open || UI.wheel.open) {
      if (UI.wheel.open) {
        if (Input.locked) { const [dx, dy] = Input.consume(); UI.moveWheel(dx, dy); }
        else UI.moveWheel(Input.mx - innerWidth / 2, Input.my - innerHeight / 2, true);
      }
      return { sprint, jump };
    }
    const [mdx, mdy] = Input.consume();
    const sens = 0.0022 * Settings.sensitivity;
    const looking = Input.locked;
    if (State.camMode === 'first') {
      if (looking) { a.yaw -= mdx * sens; a.pitch = clamp(a.pitch - mdy * sens, -1.45, 1.45); }
    } else if (State.camMode === 'third') {
      if (looking) { this.cam.yaw -= mdx * sens; this.cam.pitch = clamp(this.cam.pitch + mdy * sens, -0.6, 1.3); }
    } else if (State.camMode === 'spectate') {
      if (looking) { this.spec.yaw -= mdx * sens; this.spec.pitch = clamp(this.spec.pitch - mdy * sens, -1.5, 1.5); }
      return { sprint, jump };
    }
    if (a.role === 'spectator' || a.char.locked) return { sprint, jump };
    let fx = 0, fz = 0;
    if (Input.down('KeyW')) fz += 1; if (Input.down('KeyS')) fz -= 1;
    if (Input.down('KeyA')) fx += 1; if (Input.down('KeyD')) fx -= 1;
    const len = Math.hypot(fx, fz);
    const yaw = State.camMode === 'first' ? a.yaw : this.cam.yaw + Math.PI;
    sprint = Input.down('ShiftLeft') || Input.down('ShiftRight');
    if (len > 0) {
      fx /= len; fz /= len;
      const s = Math.sin(yaw), c = Math.cos(yaw);
      const wx = fz * s + fx * c, wz = fz * c - fx * s;
      const canSprint = sprint && !a.exhausted && a.stamina > 0;
      const sp = canSprint ? SPRINT : WALK;
      move.x = wx * sp; move.z = wz * sp;
      sprint = canSprint;
      if (State.camMode === 'third') a.yaw = angleDamp(a.yaw, Math.atan2(wx, wz), 12, dt);
    } else sprint = false;
    jump = Input.pressedOnce('Space');
    return { sprint, jump };
  },
  moveAgent(a, dt, move, sprint, jump) {
    const b = a.body;
    const accel = b.grounded ? 30 : 7;
    b.vel.x = damp(b.vel.x, move.x, accel / 3, dt);
    b.vel.z = damp(b.vel.z, move.z, accel / 3, dt);
    if (jump && b.grounded) { b.vel.y = JUMP_V; b.grounded = false; if (a.isPlayer) Audio.play('jump'); }
    // stamina
    const moving = Math.hypot(move.x, move.z) > 0.1;
    if (sprint && moving) { a.stamina -= dt * 0.28; if (a.stamina <= 0) { a.stamina = 0; a.exhausted = true; } }
    else { a.stamina = Math.min(1, a.stamina + dt * 0.18); if (a.stamina > 0.3) a.exhausted = false; }
    if (!a.char.locked) Physics.move(b, dt);
    if (b.landed) { b.landed = false; if (a.isPlayer) Audio.play('land'); }
    a.char.root.rotation.y = a.yaw;
    const speed = Math.hypot(b.vel.x, b.vel.z);
    a.char.update(dt, { speed, grounded: b.grounded, vy: b.vel.y });
    // footsteps (audible cue for hiders!)
    if (b.grounded && speed > 0.6) {
      a.stepDist += speed * dt;
      if (a.stepDist > 1.25 * a.char.scale + 0.3) {
        a.stepDist = 0;
        const d = camera.position.distanceTo(b.pos);
        const vol = a.isPlayer ? 0.22 : 0.3 * Math.max(0, 1 - d / 18);
        if (vol > 0.02) Audio.play('step', { vol, sprint: speed > 5.5 });
      }
    }
  },

  // ---------- camera ----------
  updateCamera(dt) {
    const P = State.player; if (!P || !P.char) return;
    camera.fov = Settings.fov; camera.updateProjectionMatrix();
    if (PaintMode.open) { PaintMode.update(dt); return; }
    if (State.camMode === 'first') {
      const eye = P.eye(v1);
      camera.position.copy(eye);
      const cp = Math.cos(P.pitch);
      camera.lookAt(eye.x + Math.sin(P.yaw) * cp, eye.y + Math.sin(P.pitch), eye.z + Math.cos(P.yaw) * cp);
    } else if (State.camMode === 'third') {
      const c = P.char, target = v1.copy(c.root.position).add(v2.set(0, c.height * 0.85 + 0.2, 0));
      const cy = this.cam.yaw, cpch = this.cam.pitch;
      const dist = this.cam.dist;
      const dir = v2.set(Math.sin(cy) * Math.cos(cpch), Math.sin(cpch), Math.cos(cy) * Math.cos(cpch));
      raycaster.set(target, dir); raycaster.far = dist; raycaster.near = 0;
      const hit = raycaster.intersectObjects(State.map.rayMeshes, false)[0];
      const d = hit ? Math.max(0.4, hit.distance - 0.25) : dist;
      camera.position.copy(target).addScaledVector(dir, d);
      camera.lookAt(target);
    } else if (State.camMode === 'spectate') {
      const s = this.spec, sp = (Input.down('ShiftLeft') ? 16 : 7) * dt;
      const f = v1.set(Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), Math.cos(s.yaw) * Math.cos(s.pitch));
      const r = v2.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
      if (!State.paused && State.screen === 'game') {
        if (Input.down('KeyW')) s.pos.addScaledVector(f, sp); if (Input.down('KeyS')) s.pos.addScaledVector(f, -sp);
        if (Input.down('KeyA')) s.pos.addScaledVector(r, sp); if (Input.down('KeyD')) s.pos.addScaledVector(r, -sp);
        if (Input.down('Space')) s.pos.y += sp; if (Input.down('ControlLeft') || Input.down('KeyC')) s.pos.y -= sp;
      }
      s.pos.y = clamp(s.pos.y, 0.3, 14);
      camera.position.copy(s.pos); camera.lookAt(v3.copy(s.pos).add(f));
    }
    if (State.shake > 0) {
      State.shake = Math.max(0, State.shake - dt);
      const k = State.shake * 0.25;
      camera.position.x += (Math.random() - 0.5) * k; camera.position.y += (Math.random() - 0.5) * k;
    }
  },

  // ---------- HUD ----------
  updateHUD() {
    const P = State.player; if (!P) return;
    const alive = State.targets.filter(t => t.kind === 'hider' && t.alive).length;
    const phase = State.phase === 'prep' ? 'PREP' : State.phase === 'hunt' ? 'HUNT' : 'END';
    UI.hud({
      phase, timer: State.timer, urgent: State.timer < 10 && State.phase !== 'over', hiders: alive, role: P.role,
      stamina: P.stamina, showStamina: P.role !== 'spectator' && !P.char.locked,
      crosshair: State.camMode === 'first' && !PaintMode.open,
    });
    UI.stun(P.stunT > 0 && P.role === 'seeker');
    UI.waitWall(P.role === 'seeker' && State.phase === 'prep', State.timer);
    // crosshair range indicator (throttled via cheap distance check)
    // crosshair turns pink when a surface is within tag reach (static geometry only: no info leak)
    if (State.camMode === 'first' && P.role === 'seeker' && State.phase === 'hunt') {
      if ((this.crossT = (this.crossT || 0) - 1) <= 0) {
        this.crossT = 6;
        raycaster.set(P.eye(v1), camera.getWorldDirection(v2)); raycaster.far = TAG_RANGE; raycaster.near = 0;
        UI.crossRange(raycaster.intersectObjects(State.map.rayMeshes, false).length > 0);
      }
    } else UI.crossRange(false);
    let h = '';
    if (!Input.locked && !PaintMode.open && State.phase !== 'over') h = 'Click to capture the mouse';
    else if (PaintMode.open) h = '';
    else if (P.role === 'spectator') h = 'Spectating · <kbd>WASD</kbd> fly · <kbd>Space</kbd>/<kbd>Ctrl</kbd> up/down · <kbd>Shift</kbd> fast';
    else if (P.role === 'hider' && State.phase === 'prep') h = `<kbd>E</kbd> Paint · <kbd>Q</kbd> Pose · <kbd>C</kbd> Clone (${Config.clones - P.clones.length}) · Find a spot before time runs out!`;
    else if (P.role === 'hider') h = 'Frozen! Look around with the mouse… and don\'t get found';
    else if (State.phase === 'prep') h = 'Waiting room… the door opens when prep ends';
    else if (State.phase === 'hunt') h = '<kbd>LMB</kbd> Tag · <kbd>Shift</kbd> Sprint · <kbd>Space</kbd> Jump · Wrong tags stun you!';
    UI.hint(h);
  },
};
