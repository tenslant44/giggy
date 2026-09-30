// =====================================================================
// Main — boot sequence and the frame loop.
// Module map:
//   state.js     State / Config / Settings / helpers
//   input.js     Input (keyboard, mouse, pointer lock)
//   renderer.js  Renderer (WebGL, render targets, eyedropper sampling)
//   textures.js  procedural canvas textures + materials
//   character.js Character (rig, UV atlas, poses, animation)
//   paint.js     Paint (engine + paint-mode UI)
//   physics.js   collisions & line-of-sight
//   maps.js      Maps (builder, 5 maps, nav + hide spots)
//   ai.js        AI (hider auto-paint, seeker vision)
//   ui.js        UI (screens, HUD, wheel, confetti)
//   audio.js     Audio (procedural SFX + music)
//   game.js      Modes (round flow, tagging, player controller)
// =====================================================================
import { State, Settings, Config } from './state.js';
import { Renderer, camera } from './renderer.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { Character } from './character.js';
import { PaintMode } from './paint.js';
import { Game } from './game.js';

Settings.load();
const canvas = Renderer.init(document.getElementById('app'));
Input.init(canvas);
PaintMode.init();
Game.init();
UI.init({
  start: () => { Audio.init(); Game.startMatch(); },
  resume: () => Game.resume(),
  quit: () => Game.quit(),
  next: () => Game.nextRound(),
  quality: () => Renderer.applyQuality(),
});

// Build the shared rig/atlas tables up front (first Character does it).
setTimeout(() => {
  new Character().dispose();
  State.screen = 'menu';
  UI.show('menu');
  // start menu music on first interaction anywhere
  const kick = () => { Audio.init(); Audio.music(State.screen === 'menu' ? 'menu' : 'prep'); removeEventListener('pointerdown', kick); removeEventListener('keydown', kick); };
  addEventListener('pointerdown', kick); addEventListener('keydown', kick);
  requestAnimationFrame(frame);
  // dev hook: ?autostart&map=..&role=..&prep=.. jumps straight into a round
  const q = new URLSearchParams(location.search);
  if (q.has('autostart')) {
    for (const k of ['map', 'role', 'mode', 'skill']) if (q.get(k)) Config[k] = q.get(k);
    for (const k of ['prep', 'bots']) if (q.get(k)) Config[k === 'prep' ? 'prepTime' : 'bots'] = +q.get(k);
    Game.startMatch();
  }
}, 30);

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  try {
    Game.update(dt);
    Character.flushAll();
    if (State.map && (State.screen === 'game' || State.screen === 'results')) {
      const P = State.player;
      const hideSelf = P && P.char && State.camMode === 'first' && !PaintMode.open;
      if (hideSelf) P.char.root.visible = false;
      Renderer.render(camera);
      if (hideSelf) P.char.root.visible = true;
      PaintMode.renderPreview();
    }
  } catch (err) {
    console.error(err);
  }
  Input.endFrame();
}
