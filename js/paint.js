// =====================================================================
// Paint module
//  - PaintEngine: bind-space brush dabs (smooth, seam-free, symmetric),
//    per-stroke opacity buffer, bucket fill, eraser, diff-based undo/redo.
//  - PaintMode: the in-game painting UI — orbit camera, HSV picker, hex,
//    recent colours, tools, sliders, eyedropper that samples LIT scene
//    colour through an offscreen render target, live seeker-view preview.
// =====================================================================
import * as THREE from 'three';
import { Rig, NTEX, TEX } from './character.js';
import { Renderer, camera } from './renderer.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { clamp, damp } from './state.js';

// ---------------------------------------------------------------------
// PaintEngine
// ---------------------------------------------------------------------
const strokeA = new Float32Array(NTEX);
const touchedFlag = new Uint8Array(NTEX);
let touched = new Uint32Array(1 << 16), oldCol = new Uint8Array(3 << 16), nt = 0;
const oldPos = new Int32Array(NTEX);
const undoStack = [], redoStack = [];
const MAX_UNDO = 40;

function record(idx, data) {
  if (nt >= touched.length) {
    const t2 = new Uint32Array(touched.length * 2); t2.set(touched); touched = t2;
    const o2 = new Uint8Array(oldCol.length * 2); o2.set(oldCol); oldCol = o2;
  }
  touched[nt] = idx; const i4 = idx * 4, o = nt * 3; oldPos[idx] = o;
  oldCol[o] = data[i4]; oldCol[o + 1] = data[i4 + 1]; oldCol[o + 2] = data[i4 + 2];
  touchedFlag[idx] = 1; nt++;
}

export const PaintEngine = {
  char: null,
  begin(char) { this.char = char; nt = 0; },
  // One soft spherical dab in bind space.
  dab(cx, cy, cz, r, hardness, opacity, rgb) {
    const ch = this.char; if (!ch) return;
    const data = ch.data, B = Rig.texBind, G = Rig.grid;
    const r2 = r * r, h = Math.min(0.999, hardness);
    const x0 = Math.max(0, Math.floor((cx - r - G.min[0]) / G.cs)), x1 = Math.min(G.dims[0] - 1, Math.floor((cx + r - G.min[0]) / G.cs));
    const y0 = Math.max(0, Math.floor((cy - r - G.min[1]) / G.cs)), y1 = Math.min(G.dims[1] - 1, Math.floor((cy + r - G.min[1]) / G.cs));
    const z0 = Math.max(0, Math.floor((cz - r - G.min[2]) / G.cs)), z1 = Math.min(G.dims[2] - 1, Math.floor((cz + r - G.min[2]) / G.cs));
    const [R, Gc, Bc] = rgb;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const rowBase = (z * G.dims[1] + y) * G.dims[0];
      for (let x = x0; x <= x1; x++) {
        const c = rowBase + x, s = G.start[c], e = G.start[c + 1];
        for (let k = s; k < e; k++) {
          const idx = G.items[k], i3 = idx * 3;
          const dx = B[i3] - cx, dy = B[i3 + 1] - cy, dz = B[i3 + 2] - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r2) continue;
          const t = Math.sqrt(d2) / r;
          let a = t <= h ? 1 : 1 - (t - h) / (1 - h);
          a = a * a * (3 - 2 * a); // smoothstep falloff
          if (a <= strokeA[idx]) continue;
          if (!touchedFlag[idx]) record(idx, data);
          strokeA[idx] = a;
          const k2 = a * opacity, i4 = idx * 4, o = this._oldIndex(idx);
          data[i4] = oldCol[o] + (R - oldCol[o]) * k2;
          data[i4 + 1] = oldCol[o + 1] + (Gc - oldCol[o + 1]) * k2;
          data[i4 + 2] = oldCol[o + 2] + (Bc - oldCol[o + 2]) * k2;
        }
      }
    }
    ch.markDirty();
  },
  // texel -> offset of its pre-stroke colour in oldCol
  _oldIndex(idx) { return oldPos[idx]; },
  fill(rgb, partId, opacity = 1) {
    const ch = this.char; const list = partId == null ? Rig.used : Rig.partTexels[partId];
    const data = ch.data;
    for (let k = 0; k < list.length; k++) {
      const idx = list[k]; if (!touchedFlag[idx]) record(idx, data);
      const o = this._oldIndex(idx), i4 = idx * 4;
      data[i4] = oldCol[o] + (rgb[0] - oldCol[o]) * opacity;
      data[i4 + 1] = oldCol[o + 1] + (rgb[1] - oldCol[o + 1]) * opacity;
      data[i4 + 2] = oldCol[o + 2] + (rgb[2] - oldCol[o + 2]) * opacity;
    }
    ch.markDirty();
  },
  end() {
    const ch = this.char; if (!ch || nt === 0) return;
    const idx = touched.slice(0, nt), old = oldCol.slice(0, nt * 3), nw = new Uint8Array(nt * 3);
    for (let k = 0; k < nt; k++) {
      const i = idx[k], i4 = i * 4;
      nw[k * 3] = ch.data[i4]; nw[k * 3 + 1] = ch.data[i4 + 1]; nw[k * 3 + 2] = ch.data[i4 + 2];
      strokeA[i] = 0; touchedFlag[i] = 0;
    }
    undoStack.push({ char: ch, idx, old, nw });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    nt = 0;
  },
  applyDiff(e, useNew) {
    const src = useNew ? e.nw : e.old, d = e.char.data;
    for (let k = 0; k < e.idx.length; k++) { const i4 = e.idx[k] * 4; d[i4] = src[k * 3]; d[i4 + 1] = src[k * 3 + 1]; d[i4 + 2] = src[k * 3 + 2]; }
    e.char.markDirty();
  },
  undo() { const e = undoStack.pop(); if (!e) return false; this.applyDiff(e, false); redoStack.push(e); return true; },
  redo() { const e = redoStack.pop(); if (!e) return false; this.applyDiff(e, true); undoStack.push(e); return true; },
  canUndo() { return undoStack.length > 0; },
  canRedo() { return redoStack.length > 0; },
  clearHistory() { undoStack.length = 0; redoStack.length = 0; },
};

// texel lookup for a UV hit (with neighbour search for padding misses)
export function bindFromUV(uv, out) {
  const px = clamp(Math.floor(uv.x * TEX), 0, TEX - 1), py = clamp(Math.floor(uv.y * TEX), 0, TEX - 1);
  for (let r = 0; r < 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= TEX || y >= TEX) continue;
    const idx = y * TEX + x;
    if (Rig.texPart[idx] !== -1) { const i3 = idx * 3; out.set(Rig.texBind[i3], Rig.texBind[i3 + 1], Rig.texBind[i3 + 2]); return Rig.texPart[idx]; }
  }
  return -1;
}

// ---------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------
export function hsvToRgb(h, s, v) {
  const f = n => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; }
  return [h, mx ? d / mx : 0, mx];
}
export const toHex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
export function fromHex(s) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s.trim()); if (!m) return null;
  let h = m[1]; if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------------------------------------------------------------------
// PaintMode (UI + interaction)
// ---------------------------------------------------------------------
const $ = id => document.getElementById(id);
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
const previewCam = new THREE.PerspectiveCamera(50, 1, 0.05, 200);

export const PaintMode = {
  open: false,
  char: null,
  hideForPick: [],
  hsv: [0, 0, 1],
  rgb: [255, 255, 255],
  recent: [],
  tool: 'brush',
  fillMode: 'body',
  size: 0.08, hard: 0.6, opacity: 1,
  sym: false,
  yaw: 0, pitch: 0.15, dist: 3, tYaw: 0, tPitch: 0.15, tDist: 3,
  painting: false, orbiting: false, lastBind: new THREE.Vector3(), hasLast: false,
  onClose: null,

  init() {
    this.buildPicker();
    const bindSlider = (id, key, lab, fmt) => {
      const el = $(id), lb = $(lab);
      const upd = () => { this[key] = parseFloat(el.value); lb.textContent = fmt(this[key]); };
      el.addEventListener('input', upd); upd();
      this['_' + key + 'El'] = el; this['_' + key + 'Lab'] = () => { el.value = this[key]; lb.textContent = fmt(this[key]); };
    };
    bindSlider('brushSize', 'size', 'bsV', v => Math.round(v * 100) + 'cm');
    bindSlider('brushHard', 'hard', 'bhV', v => Math.round(v * 100) + '%');
    bindSlider('brushOpacity', 'opacity', 'boV', v => Math.round(v * 100) + '%');
    const metal = $('matMetal'), rough = $('matRough');
    const updMat = () => {
      $('bmV').textContent = Math.round(metal.value * 100) + '%'; $('brV').textContent = Math.round(rough.value * 100) + '%';
      if (this.char) this.char.setMaterialProps(parseFloat(metal.value), parseFloat(rough.value));
    };
    metal.addEventListener('input', updMat); rough.addEventListener('input', updMat); updMat();
    this._updMat = () => { if (this.char) { metal.value = this.char.material.metalness; rough.value = this.char.material.roughness; } updMat(); };

    $('ppTools').querySelectorAll('button').forEach(b => b.addEventListener('click', () => this.setTool(b.dataset.t)));
    $('segFill').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      this.fillMode = b.dataset.v; $('segFill').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    }));
    $('ppSym').addEventListener('click', () => { this.sym = !this.sym; $('ppSym').classList.toggle('on', this.sym); Audio.play('click'); });
    $('ppUndo').addEventListener('click', () => this.undo());
    $('ppRedo').addEventListener('click', () => this.redo());
    $('ppReset').addEventListener('click', () => this.reset());
    $('ppClose').addEventListener('click', () => this.close());
    $('hexInput').addEventListener('change', e => { const c = fromHex(e.target.value); if (c) this.setColor(c, true); else e.target.value = toHex(this.rgb); });
    $('hexInput').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });

    Input.on('down', e => this.onDown(e));
    Input.on('up', e => this.onUp(e));
    Input.on('move', e => this.onMove(e));
    Input.on('wheel', e => { if (this.open) this.tDist = clamp(this.tDist * (e.deltaY > 0 ? 1.12 : 0.89), 0.8, 8); });
    this.setColor([255, 255, 255], false);
  },

  // ---------- HSV picker widgets ----------
  buildPicker() {
    const hue = $('hueCanvas'), hg = hue.getContext('2d');
    const grd = hg.createLinearGradient(0, 0, hue.width, 0);
    for (let i = 0; i <= 6; i++) grd.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    hg.fillStyle = grd; hg.fillRect(0, 0, hue.width, hue.height);
    const drag = (el, fn) => {
      let on = false;
      const h = e => { const r = el.getBoundingClientRect(); fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)); };
      el.addEventListener('pointerdown', e => { on = true; el.setPointerCapture(e.pointerId); h(e); });
      el.addEventListener('pointermove', e => on && h(e));
      el.addEventListener('pointerup', () => { if (on) { on = false; this.pushRecent(); } });
    };
    drag($('svWrap'), (x, y) => { this.hsv[1] = x; this.hsv[2] = 1 - y; this.fromHSV(); });
    drag($('hueWrap'), x => { this.hsv[0] = Math.min(0.9999, x); this.fromHSV(); this.drawSV(); });
  },
  drawSV() {
    const c = $('svCanvas'), g = c.getContext('2d'), w = c.width, h = c.height;
    const [r, gg, b] = hsvToRgb(this.hsv[0], 1, 1);
    g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(0, 0, w, h);
    const wg = g.createLinearGradient(0, 0, w, 0); wg.addColorStop(0, '#fff'); wg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = wg; g.fillRect(0, 0, w, h);
    const bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, '#000'); g.fillStyle = bg; g.fillRect(0, 0, w, h);
  },
  fromHSV() { this.rgb = hsvToRgb(...this.hsv); this.refreshColorUI(); },
  setColor(rgb, addRecent) {
    this.rgb = rgb.map(v => clamp(Math.round(v), 0, 255));
    const hsv = rgbToHsv(...this.rgb);
    if (hsv[1] > 0.001 && hsv[2] > 0.001) this.hsv[0] = hsv[0];
    this.hsv[1] = hsv[1]; this.hsv[2] = hsv[2];
    this.drawSV(); this.refreshColorUI();
    if (addRecent) this.pushRecent();
  },
  refreshColorUI() {
    const hex = toHex(this.rgb);
    $('curSwatch').style.background = hex;
    if (document.activeElement !== $('hexInput')) $('hexInput').value = hex;
    $('svKnob').style.left = this.hsv[1] * 100 + '%'; $('svKnob').style.top = (1 - this.hsv[2]) * 100 + '%';
    $('hueKnob').style.left = this.hsv[0] * 100 + '%';
  },
  pushRecent() {
    const hex = toHex(this.rgb);
    this.recent = [hex, ...this.recent.filter(h => h !== hex)].slice(0, 16);
    const box = $('recent'); box.innerHTML = '';
    for (const h of this.recent) {
      const d = document.createElement('div'); d.style.background = h; d.title = h;
      d.addEventListener('click', () => { this.setColor(fromHex(h), true); Audio.play('click'); });
      box.appendChild(d);
    }
  },
  setTool(t) {
    this.tool = t; Audio.play('click');
    $('ppTools').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  },
  refreshButtons() { $('ppUndo').disabled = !PaintEngine.canUndo(); $('ppRedo').disabled = !PaintEngine.canRedo(); },

  // ---------- open / close ----------
  openFor(char, hideForPick) {
    this.char = char; this.hideForPick = hideForPick; this.open = true;
    $('paintPanel').classList.remove('hidden');
    this._updMat();
    // start orbit behind the character, looking at its front-left
    this.tYaw = this.yaw = char.root.rotation.y + Math.PI + 0.5;
    this.tPitch = this.pitch = 0.12; this.tDist = this.dist = 2.6 * char.scale + 0.8;
    this.refreshButtons();
    Input.exitLock();
  },
  close() {
    if (!this.open) return;
    this.endStroke();
    this.open = false;
    $('paintPanel').classList.add('hidden'); $('brushCursor').classList.add('hidden');
    if (this.onClose) this.onClose();
  },

  // ---------- interaction ----------
  pickRay(e) {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(this.char.meshes, false)[0];
    return hit || null;
  },
  onDown(e) {
    if (!this.open) return;
    if (e.button === 2) { this.eyedrop(e.clientX, e.clientY); return; }
    if (e.button === 1) { this.orbiting = true; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (this.tool === 'picker') { this.eyedrop(e.clientX, e.clientY); this.setTool('brush'); return; }
    const hit = this.pickRay(e);
    if (!hit) { this.orbiting = true; return; }
    if (this.tool === 'fill') {
      PaintEngine.begin(this.char);
      const part = this.fillMode === 'part' ? hit.object.userData.part : null;
      PaintEngine.fill(this.rgb, part, this.opacity);
      if (this.sym && part != null) {
        const nm = PART_MIRROR[part]; if (nm !== part) PaintEngine.fill(this.rgb, nm, this.opacity);
      }
      PaintEngine.end(); this.pushRecent(); Audio.play('fill'); this.refreshButtons();
      return;
    }
    this.painting = true; this.hasLast = false;
    PaintEngine.begin(this.char);
    this.paintAt(hit);
  },
  onUp(e) {
    if (!this.open) return;
    if (e.button === 1 || e.button === 0) this.orbiting = false;
    if (e.button === 0) this.endStroke();
  },
  endStroke() {
    if (!this.painting) return;
    this.painting = false; PaintEngine.end();
    if (this.tool === 'brush') this.pushRecent();
    this.refreshButtons();
  },
  onMove(e) {
    if (!this.open) return;
    if (this.orbiting) {
      this.tYaw -= e.movementX * 0.008; this.tPitch = clamp(this.tPitch + e.movementY * 0.006, -1.2, 1.35);
      return;
    }
    const hit = e.target === Input.el ? this.pickRay(e) : null;
    this.updateCursor(e, hit);
    if (this.painting && hit) this.paintAt(hit);
  },
  updateCursor(e, hit) {
    const cur = $('brushCursor');
    if (!hit || this.tool === 'picker' || this.tool === 'fill') { cur.classList.add('hidden'); return; }
    const px = (this.size * this.char.scale) / (hit.distance * Math.tan((camera.fov * Math.PI) / 360)) * (innerHeight / 2);
    cur.classList.remove('hidden');
    cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px';
    cur.style.width = cur.style.height = Math.max(4, px * 2) + 'px';
  },
  paintAt(hit) {
    const part = bindFromUV(hit.uv, tmpV); if (part < 0) return;
    const rgb = this.tool === 'eraser' ? [255, 255, 255] : this.rgb;
    const r = this.size, spacing = Math.max(0.003, r * 0.22);
    const dab = (p) => {
      PaintEngine.dab(p.x, p.y, p.z, r, this.hard, this.opacity, rgb);
      if (this.sym) PaintEngine.dab(-p.x, p.y, p.z, r, this.hard, this.opacity, rgb);
    };
    const d0 = this.hasLast ? tmpV.distanceTo(this.lastBind) : Infinity;
    if (d0 >= 0.4) { dab(tmpV); this.lastBind.copy(tmpV); this.hasLast = true; }
    else {
      // smooth interpolation: evenly spaced dabs along the stroke
      let d = d0, guard = 0;
      while (d >= spacing && guard++ < 400) { this.lastBind.lerp(tmpV, spacing / d); dab(this.lastBind); d = this.lastBind.distanceTo(tmpV); }
    }
    Audio.play('paint');
  },
  eyedrop(x, y) {
    const c = Renderer.sampleScreen(camera, x, y, this.hideForPick);
    this.setColor([c.r, c.g, c.b], true);
    Audio.play('pick');
  },
  undo() { if (PaintEngine.undo()) Audio.play('click'); this.refreshButtons(); },
  redo() { if (PaintEngine.redo()) Audio.play('click'); this.refreshButtons(); },
  reset() {
    PaintEngine.begin(this.char); PaintEngine.fill([255, 255, 255], null, 1); PaintEngine.end();
    this.char.setMaterialProps(0, 0.85); this._updMat(); this.refreshButtons(); Audio.play('fill');
  },
  key(code, e) {
    if (!this.open) return false;
    if (code === 'BracketLeft') { this.size = clamp(this.size / 1.2, 0.01, 0.4); this._sizeLab(); return true; }
    if (code === 'BracketRight') { this.size = clamp(this.size * 1.2, 0.01, 0.4); this._sizeLab(); return true; }
    if (code === 'KeyZ') { if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if (code === 'KeyY') { this.redo(); return true; }
    if (code === 'KeyB') { this.setTool('brush'); return true; }
    if (code === 'KeyX') { this.setTool('eraser'); return true; }
    if (code === 'KeyG') { this.setTool('fill'); return true; }
    if (code === 'KeyI') { this.setTool('picker'); return true; }
    if (code === 'KeyE' || code === 'Escape') { this.close(); return true; }
    return false;
  },

  // ---------- per-frame ----------
  update(dt) {
    if (!this.open) return;
    const c = this.char;
    this.yaw = damp(this.yaw, this.tYaw, 14, dt); this.pitch = damp(this.pitch, this.tPitch, 14, dt); this.dist = damp(this.dist, this.tDist, 12, dt);
    const center = c.centerWorld(tmpV);
    camera.position.set(
      center.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
      center.y + Math.sin(this.pitch) * this.dist,
      center.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist);
    camera.lookAt(center);
  },
  // Live preview: what a seeker standing a few metres in front would see.
  renderPreview() {
    if (!this.open) return;
    const rect = $('previewBox').getBoundingClientRect();
    const c = this.char, yaw = c.root.rotation.y;
    const center = c.centerWorld(tmpV);
    const d = 3.2 * c.scale + 1.2;
    previewCam.fov = 40;
    previewCam.position.set(center.x + Math.sin(yaw) * d, 1.55, center.z + Math.cos(yaw) * d);
    previewCam.lookAt(center.x, center.y, center.z);
    Renderer.renderInset(previewCam, { left: rect.left + 4, bottom: rect.bottom - 4, width: rect.width - 8, height: rect.height - 8 });
  },
};

// mirror map for symmetric part fills (L<->R)
const PART_MIRROR = [0, 1, 3, 2, 5, 4, 7, 6, 9, 8];
