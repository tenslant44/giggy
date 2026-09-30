// =====================================================================
// Textures module — procedural canvas textures (bricks with grout, wood
// grain, wallpaper, tiles, graffiti, framed paintings, metal, hay,
// cardboard cows, signage...) plus a cached material factory.
// Every texture gets subtle noise so no surface is perfectly flat.
// =====================================================================
import * as THREE from 'three';
import { rng } from './state.js';

const texCache = new Map();
const matCache = new Map();

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function hsl(h, s, l) { return `hsl(${h},${s}%,${l}%)`; }

// Multiplicative grain + blotches so surfaces feel tactile.
function grain(g, w, h, amt = 18, seed = 1, blotch = 0.08) {
  const r = rng(seed);
  if (blotch > 0) {
    for (let i = 0; i < 40; i++) {
      const x = r() * w, y = r() * h, rad = 20 + r() * w * 0.25;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      const d = r() < 0.5 ? 0 : 255;
      grd.addColorStop(0, `rgba(${d},${d},${d},${blotch * r()})`); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  }
  const img = g.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amt;
    d[i] = Math.max(0, Math.min(255, d[i] + n)); d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n)); d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

function finish(c, key, { repeat = [1, 1], alpha = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 4;
  t.userData.alpha = alpha;
  texCache.set(key, t);
  return t;
}

// ---------------- generators ----------------
const GEN = {
  bricks({ base = [12, 55, 42], grout = '#cfc6b8', seed = 3, rows = 8, cols = 4 } = {}) {
    const [c, g] = canvas(512, 512); const r = rng(seed);
    g.fillStyle = grout; g.fillRect(0, 0, 512, 512);
    const bh = 512 / rows, bw = 512 / cols;
    for (let y = 0; y < rows; y++) for (let x = -1; x < cols + 1; x++) {
      const ox = (y % 2) * bw / 2;
      g.fillStyle = hsl(base[0] + (r() - 0.5) * 10, base[1] + (r() - 0.5) * 15, base[2] + (r() - 0.5) * 14);
      g.fillRect(x * bw + ox + 4, y * bh + 4, bw - 8, bh - 8);
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x * bw + ox + 4, y * bh + bh - 10, bw - 8, 6);
    }
    grain(g, 512, 512, 26, seed);
    return c;
  },
  graffitiBricks({ seed = 5 } = {}) {
    const c = GEN.bricks({ seed, base: [8, 45, 38] }); const g = c.getContext('2d'); const r = rng(seed * 7);
    const cols = ['#ff3fa4', '#27e0ff', '#ffe135', '#7dff4f', '#9b5bff', '#ff7b2e'];
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let k = 0; k < 3; k++) {
      const col = cols[(r() * cols.length) | 0];
      g.lineWidth = 18 + r() * 14; g.strokeStyle = '#111'; const pts = [];
      let x = 60 + r() * 380, y = 120 + r() * 280;
      for (let i = 0; i < 6; i++) { pts.push([x, y]); x += (r() - 0.4) * 120; y += (r() - 0.5) * 120; }
      for (const pass of [0, 1]) {
        g.strokeStyle = pass ? col : '#111'; g.lineWidth = pass ? 16 : 26;
        g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
      }
    }
    g.font = 'bold 88px sans-serif'; g.textAlign = 'center';
    const words = ['ヤバい', 'OSAKA', 'カメレオン', 'NINJA', '忍', 'WOW'];
    const wd = words[(r() * words.length) | 0];
    g.lineWidth = 10; g.strokeStyle = '#111'; g.strokeText(wd, 256, 300);
    g.fillStyle = cols[(r() * cols.length) | 0]; g.fillText(wd, 256, 300);
    for (let i = 0; i < 60; i++) { g.fillStyle = cols[(r() * cols.length) | 0]; g.globalAlpha = 0.6; g.beginPath(); g.arc(r() * 512, r() * 512, 1 + r() * 4, 0, 7); g.fill(); }
    g.globalAlpha = 1;
    return c;
  },
  wood({ base = [28, 45, 38], seed = 7, planks = 6, vertical = false } = {}) {
    const [c, g] = canvas(512, 512); const r = rng(seed);
    const pw = 512 / planks;
    for (let p = 0; p < planks; p++) {
      const L = base[2] + (r() - 0.5) * 12;
      g.fillStyle = hsl(base[0] + (r() - 0.5) * 6, base[1], L); g.fillRect(p * pw, 0, pw, 512);
      for (let i = 0; i < 26; i++) {
        g.strokeStyle = `rgba(40,20,5,${0.05 + r() * 0.12})`; g.lineWidth = 1 + r() * 2.5;
        g.beginPath(); const x0 = p * pw + r() * pw;
        for (let y = 0; y <= 512; y += 16) g.lineTo(x0 + Math.sin(y * 0.02 + i + p) * 4 + Math.sin(y * 0.07 + i) * 1.5, y);
        g.stroke();
      }
      if (r() < 0.7) { // knot
        const kx = p * pw + pw * (0.3 + r() * 0.4), ky = r() * 512;
        for (let k = 6; k > 0; k--) { g.strokeStyle = `rgba(60,25,5,${0.15})`; g.lineWidth = 2; g.beginPath(); g.ellipse(kx, ky, k * 2.2, k * 5, 0, 0, 7); g.stroke(); }
      }
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(p * pw, 0, 3, 512);
      const seam = r() * 512; g.fillRect(p * pw, seam, pw, 2);
    }
    grain(g, 512, 512, 14, seed, 0.05);
    if (vertical) return c;
    const [c2, g2] = canvas(512, 512); g2.translate(256, 256); g2.rotate(Math.PI / 2); g2.drawImage(c, -256, -256); return c2;
  },
  wallpaper({ base = '#6b2a3a', fg = '#d8b36a', seed = 9, style = 0 } = {}) {
    const [c, g] = canvas(512, 512);
    g.fillStyle = base; g.fillRect(0, 0, 512, 512);
    g.fillStyle = fg; g.strokeStyle = fg;
    if (style === 0) { // damask-ish diamonds
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
        const cx = x * 128 + (y % 2) * 64, cy = y * 128;
        g.globalAlpha = 0.55; g.beginPath(); g.moveTo(cx, cy - 40); g.quadraticCurveTo(cx + 34, cy, cx, cy + 40); g.quadraticCurveTo(cx - 34, cy, cx, cy - 40); g.fill();
        g.globalAlpha = 0.35; g.beginPath(); g.arc(cx, cy, 10, 0, 7); g.fill();
        g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 52, 0, 7); g.stroke();
      }
    } else { // stripes
      for (let x = 0; x < 512; x += 64) { g.globalAlpha = 0.5; g.fillRect(x, 0, 20, 512); g.globalAlpha = 0.25; g.fillRect(x + 30, 0, 6, 512); }
    }
    g.globalAlpha = 1;
    grain(g, 512, 512, 10, seed, 0.06);
    return c;
  },
  tiles({ a = '#e8e4da', b = '#2c2c34', size = 8, seed = 11, checker = true, grout = '#8a8578' } = {}) {
    const [c, g] = canvas(512, 512); const r = rng(seed); const s = 512 / size;
    g.fillStyle = grout; g.fillRect(0, 0, 512, 512);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const col = checker ? ((x + y) % 2 ? a : b) : a;
      g.fillStyle = col; g.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
      g.fillStyle = `rgba(255,255,255,${r() * 0.08})`; g.fillRect(x * s + 2, y * s + 2, s - 4, (s - 4) / 3);
    }
    grain(g, 512, 512, 12, seed, 0.1);
    return c;
  },
  concrete({ base = 128, seed = 13, tint = [0, 0, 0], cracks = 6 } = {}) {
    const [c, g] = canvas(512, 512); const r = rng(seed);
    g.fillStyle = `rgb(${base + tint[0]},${base + tint[1]},${base + tint[2]})`; g.fillRect(0, 0, 512, 512);
    grain(g, 512, 512, 30, seed, 0.18);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.5;
    for (let i = 0; i < cracks; i++) { g.beginPath(); let x = r() * 512, y = r() * 512; g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 60; y += (r() - 0.5) * 60; g.lineTo(x, y); } g.stroke(); }
    return c;
  },
  sewerBricks({ seed = 17 } = {}) {
    const c = GEN.bricks({ seed, base: [95, 12, 30], grout: '#3d4436', rows: 10, cols: 5 }); const g = c.getContext('2d'); const r = rng(seed);
    for (let i = 0; i < 14; i++) { // slime streaks
      const x = r() * 512, w = 6 + r() * 20; const grd = g.createLinearGradient(0, 300, 0, 512);
      grd.addColorStop(0, 'rgba(80,140,40,0)'); grd.addColorStop(1, 'rgba(80,140,40,0.55)');
      g.fillStyle = grd; g.fillRect(x, 260 + r() * 100, w, 512);
    }
    return c;
  },
  metal({ base = [150, 155, 160], seed = 19, rivets = true, rust = 0.2 } = {}) {
    const [c, g] = canvas(256, 256); const r = rng(seed);
    g.fillStyle = `rgb(${base})`; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y++) { g.fillStyle = `rgba(255,255,255,${r() * 0.06})`; g.fillRect(0, y, 256, 1); }
    for (let i = 0; i < 20 * rust; i++) { const x = r() * 256, y = r() * 256, rad = 5 + r() * 30; const grd = g.createRadialGradient(x, y, 0, x, y, rad); grd.addColorStop(0, 'rgba(130,60,20,0.6)'); grd.addColorStop(1, 'rgba(130,60,20,0)'); g.fillStyle = grd; g.fillRect(x - rad, y - rad, rad * 2, rad * 2); }
    if (rivets) for (let x = 16; x < 256; x += 56) for (const y of [12, 244]) { g.fillStyle = 'rgba(0,0,0,0.4)'; g.beginPath(); g.arc(x + 1, y + 1, 5, 0, 7); g.fill(); g.fillStyle = 'rgba(255,255,255,0.4)'; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
    grain(g, 256, 256, 14, seed, 0.1);
    return c;
  },
  hay({ seed = 23 } = {}) {
    const [c, g] = canvas(256, 256); const r = rng(seed);
    g.fillStyle = '#c9a54a'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1400; i++) {
      g.strokeStyle = hsl(40 + r() * 14, 55 + r() * 20, 35 + r() * 35); g.lineWidth = 1 + r();
      const x = r() * 256, y = r() * 256, a = (r() - 0.5) * 0.9, l = 8 + r() * 20;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    g.fillStyle = 'rgba(90,50,20,0.5)'; g.fillRect(0, 80, 256, 6); g.fillRect(0, 170, 256, 6);
    return c;
  },
  cardboard({ seed = 29 } = {}) {
    const [c, g] = canvas(256, 256);
    g.fillStyle = '#b98b58'; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 6) { g.fillStyle = 'rgba(80,50,20,0.08)'; g.fillRect(0, y, 256, 2); }
    g.fillStyle = 'rgba(60,30,10,0.3)'; g.fillRect(0, 124, 256, 8);
    g.font = 'bold 30px sans-serif'; g.fillStyle = 'rgba(60,30,10,0.45)'; g.fillText('THIS SIDE UP ↑', 20, 60);
    grain(g, 256, 256, 16, seed, 0.1);
    return c;
  },
  cow({ seed = 31 } = {}) { // cardboard cow standee with alpha cut-out
    const [c, g] = canvas(512, 384); const r = rng(seed);
    g.clearRect(0, 0, 512, 384);
    g.fillStyle = '#fafafa'; g.strokeStyle = '#222'; g.lineWidth = 8;
    const body = () => { g.beginPath(); g.ellipse(250, 170, 170, 95, 0, 0, 7); g.moveTo(430, 150); g.ellipse(430, 130, 60, 48, -0.3, 0, 7);
      for (const lx of [130, 180, 310, 360]) g.rect(lx - 16, 220, 32, 140); };
    body(); g.fill();
    g.save(); body(); g.clip();
    g.fillStyle = '#1a1a1a';
    for (let i = 0; i < 9; i++) { g.beginPath(); const x = 100 + r() * 300, y = 100 + r() * 150; for (let k = 0; k < 9; k++) { const a = k / 9 * 6.28, rr = 22 + r() * 30; g.lineTo(x + Math.cos(a) * rr * 1.4, y + Math.sin(a) * rr); } g.fill(); }
    g.fillStyle = '#f2a7b4'; g.beginPath(); g.ellipse(470, 150, 26, 22, 0, 0, 7); g.fill();
    g.fillStyle = '#111'; g.beginPath(); g.arc(425, 115, 7, 0, 7); g.fill();
    g.fillStyle = '#e9b0bd'; g.beginPath(); g.ellipse(240, 250, 30, 18, 0, 0, 7); g.fill();
    g.restore();
    body(); g.stroke();
    g.fillStyle = '#3a2a1a'; for (const lx of [130, 180, 310, 360]) g.fillRect(lx - 16, 340, 32, 20);
    return c;
  },
  painting({ seed = 37 } = {}) { // framed painting (frame baked into texture)
    const [c, g] = canvas(256, 320); const r = rng(seed);
    const kind = (r() * 4) | 0;
    g.fillStyle = '#6b4a1e'; g.fillRect(0, 0, 256, 320);
    g.fillStyle = '#c9a44a'; g.fillRect(8, 8, 240, 304); g.fillStyle = '#8a6420'; g.fillRect(20, 20, 216, 280);
    const X = 28, Y = 28, W = 200, H = 264;
    g.save(); g.beginPath(); g.rect(X, Y, W, H); g.clip();
    if (kind === 0) { // landscape
      const sky = g.createLinearGradient(0, Y, 0, Y + H); sky.addColorStop(0, hsl(200 + r() * 30, 60, 70)); sky.addColorStop(1, hsl(30 + r() * 20, 70, 80));
      g.fillStyle = sky; g.fillRect(X, Y, W, H);
      g.fillStyle = hsl(40, 80, 60); g.beginPath(); g.arc(X + 50 + r() * 100, Y + 70, 22, 0, 7); g.fill();
      for (let k = 0; k < 3; k++) { g.fillStyle = hsl(100 + k * 20, 35, 45 - k * 10); g.beginPath(); g.moveTo(X, Y + H); for (let x = 0; x <= W; x += 20) g.lineTo(X + x, Y + 140 + k * 40 + Math.sin(x * 0.03 + r() * 5) * 25); g.lineTo(X + W, Y + H); g.fill(); }
    } else if (kind === 1) { // portrait
      g.fillStyle = hsl(r() * 360, 30, 22); g.fillRect(X, Y, W, H);
      g.fillStyle = hsl(r() * 360, 45, 30); g.beginPath(); g.ellipse(X + W / 2, Y + H, 90, 110, 0, 0, 7); g.fill();
      g.fillStyle = '#e6c2a0'; g.beginPath(); g.ellipse(X + W / 2, Y + 110, 45, 58, 0, 0, 7); g.fill();
      g.fillStyle = hsl(20, 40, 18); g.beginPath(); g.ellipse(X + W / 2, Y + 70, 50, 28, 0, Math.PI, 0); g.fill();
      g.fillStyle = '#222'; g.fillRect(X + W / 2 - 20, Y + 105, 8, 5); g.fillRect(X + W / 2 + 12, Y + 105, 8, 5);
      g.fillStyle = '#a0504a'; g.fillRect(X + W / 2 - 12, Y + 138, 24, 4);
    } else if (kind === 2) { // abstract blocks
      for (let i = 0; i < 9; i++) { g.fillStyle = hsl(r() * 360, 70, 50); g.fillRect(X + r() * W, Y + r() * H, 30 + r() * 90, 30 + r() * 90); }
      g.strokeStyle = '#111'; g.lineWidth = 7; for (let i = 0; i < 4; i++) { g.beginPath(); const x = X + r() * W; g.moveTo(x, Y); g.lineTo(x, Y + H); g.stroke(); }
    } else { // still life
      g.fillStyle = hsl(30, 25, 25); g.fillRect(X, Y, W, H);
      g.fillStyle = hsl(30, 30, 40); g.fillRect(X, Y + 190, W, 80);
      for (let i = 0; i < 4; i++) { g.fillStyle = hsl([0, 40, 90, 280][i], 70, 45); g.beginPath(); g.arc(X + 40 + i * 40, Y + 180 - (i % 2) * 15, 22, 0, 7); g.fill(); }
    }
    g.restore();
    grain(g, 256, 320, 16, seed, 0.05);
    return c;
  },
  sign({ text = 'ラーメン', bg = '#d6263a', fg = '#fff5d0', seed = 41 } = {}) {
    const [c, g] = canvas(128, 512);
    g.fillStyle = bg; g.fillRect(0, 0, 128, 512);
    g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(8, 8, 112, 496);
    g.fillStyle = fg; g.font = 'bold 84px sans-serif'; g.textAlign = 'center';
    const chars = [...text]; const step = 480 / chars.length;
    chars.forEach((ch, i) => g.fillText(ch, 64, 40 + step * (i + 0.72)));
    grain(g, 128, 512, 10, seed, 0.04);
    return c;
  },
  shutter({ seed = 43 } = {}) {
    const [c, g] = canvas(256, 256);
    for (let y = 0; y < 256; y += 16) { const gr = g.createLinearGradient(0, y, 0, y + 16); gr.addColorStop(0, '#9aa0a6'); gr.addColorStop(0.5, '#c7ccd1'); gr.addColorStop(1, '#6d7278'); g.fillStyle = gr; g.fillRect(0, y, 256, 16); }
    grain(g, 256, 256, 16, seed, 0.15);
    return c;
  },
  vending({ seed = 47 } = {}) {
    const [c, g] = canvas(256, 512); const r = rng(seed);
    g.fillStyle = hsl(r() * 360, 70, 45); g.fillRect(0, 0, 256, 512);
    g.fillStyle = '#e8f4ff'; g.fillRect(20, 30, 216, 280);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) { g.fillStyle = hsl(r() * 360, 75, 55); g.fillRect(30 + x * 34, 45 + y * 68, 24, 44); g.fillStyle = '#fff'; g.fillRect(34 + x * 34, 50 + y * 68, 6, 30); }
    g.fillStyle = '#222'; g.fillRect(40, 380, 176, 60); g.fillStyle = '#ffec70'; g.fillRect(200, 330, 30, 30);
    g.fillStyle = '#fff'; g.font = 'bold 30px sans-serif'; g.fillText('つめた〜い', 40, 360);
    grain(g, 256, 512, 10, seed, 0.03);
    return c;
  },
  books({ seed = 53 } = {}) {
    const [c, g] = canvas(512, 512); const r = rng(seed);
    g.fillStyle = '#3a2410'; g.fillRect(0, 0, 512, 512);
    for (let s = 0; s < 4; s++) {
      let x = 8; const y0 = s * 128 + 10;
      while (x < 500) { const w = 12 + r() * 22, h = 80 + r() * 34; g.fillStyle = hsl(r() * 360, 45, 22 + r() * 25); g.fillRect(x, y0 + 114 - h, w, h); g.fillStyle = 'rgba(255,230,160,0.5)'; g.fillRect(x + 2, y0 + 114 - h + 12, w - 4, 3); x += w + 1; }
      g.fillStyle = '#5c3a1a'; g.fillRect(0, y0 + 114, 512, 14);
    }
    grain(g, 512, 512, 12, seed, 0.05);
    return c;
  },
  marble({ seed = 59, tint = 235 } = {}) {
    const [c, g] = canvas(512, 512); const r = rng(seed);
    g.fillStyle = `rgb(${tint},${tint - 3},${tint - 8})`; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 30; i++) {
      g.strokeStyle = `rgba(90,90,100,${0.05 + r() * 0.15})`; g.lineWidth = 0.5 + r() * 2.5; g.beginPath();
      let x = r() * 512, y = r() * 512; g.moveTo(x, y);
      for (let k = 0; k < 14; k++) { x += (r() - 0.3) * 50; y += (r() - 0.5) * 50; g.lineTo(x, y); }
      g.stroke();
    }
    grain(g, 512, 512, 8, seed, 0.06);
    return c;
  },
  grass({ seed = 61 } = {}) { const [c, g] = canvas(256, 256); const r = rng(seed); g.fillStyle = '#5b7d34'; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 2500; i++) { g.fillStyle = hsl(80 + r() * 30, 45, 25 + r() * 25); g.fillRect(r() * 256, r() * 256, 2, 4 + r() * 5); } return c; },
  dirt({ seed = 67 } = {}) { const [c, g] = canvas(256, 256); g.fillStyle = '#7a5a3a'; g.fillRect(0, 0, 256, 256); grain(g, 256, 256, 40, seed, 0.25); return c; },
  rug({ seed = 71, base = '#7a1f2a', trim = '#e0b35a' } = {}) {
    const [c, g] = canvas(512, 512); const r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, 512, 512); g.strokeStyle = trim; g.lineWidth = 14; g.strokeRect(24, 24, 464, 464); g.lineWidth = 4; g.strokeRect(50, 50, 412, 412);
    g.fillStyle = trim; for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28; g.beginPath(); g.ellipse(256 + Math.cos(a) * 110, 256 + Math.sin(a) * 110, 30, 12, a, 0, 7); g.fill(); }
    g.beginPath(); g.arc(256, 256, 50, 0, 7); g.fill(); g.fillStyle = base; g.beginPath(); g.arc(256, 256, 30, 0, 7); g.fill();
    grain(g, 512, 512, 22, seed, 0.1); return c;
  },
  water({ seed = 73 } = {}) { const [c, g] = canvas(256, 256); const r = rng(seed); g.fillStyle = '#2d4a3a'; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 80; i++) { g.strokeStyle = `rgba(160,220,170,${r() * 0.2})`; g.lineWidth = 1 + r() * 2; g.beginPath(); const x = r() * 256, y = r() * 256; g.moveTo(x, y); g.quadraticCurveTo(x + 20, y + (r() - 0.5) * 8, x + 40, y); g.stroke(); } return c; },
  asphalt({ seed = 79 } = {}) { const c = GEN.concrete({ base: 62, seed, cracks: 10 }); const g = c.getContext('2d'); g.fillStyle = 'rgba(255,240,200,0.55)'; g.fillRect(250, 0, 12, 200); g.fillRect(250, 300, 12, 212); return c; },
  plaster({ seed = 83, col = [214, 204, 186] } = {}) { const [c, g] = canvas(256, 256); g.fillStyle = `rgb(${col})`; g.fillRect(0, 0, 256, 256); grain(g, 256, 256, 14, seed, 0.12); return c; },
  fabric({ seed = 89, col = '#2f4f7a' } = {}) { const [c, g] = canvas(128, 128); g.fillStyle = col; g.fillRect(0, 0, 128, 128); for (let i = 0; i < 128; i += 4) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(i, 0, 2, 128); g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, i, 128, 2); } grain(g, 128, 128, 12, seed, 0.05); return c; },
  grate({ seed = 97 } = {}) { const [c, g] = canvas(256, 256); g.clearRect(0, 0, 256, 256); g.fillStyle = '#4a4f52'; for (let i = 0; i < 256; i += 32) { g.fillRect(i, 0, 10, 256); g.fillRect(0, i, 256, 10); } return c; },
};

// Public: texture by generator name + params (cached by key).
export function tex(name, params = {}, repeat = [1, 1]) {
  const key = name + JSON.stringify(params) + repeat.join(',');
  if (texCache.has(key)) return texCache.get(key);
  const c = GEN[name](params);
  return finish(c, key, { repeat });
}

// Public: cached standard material.
export function mat(name, params = {}, { repeat = [1, 1], rough = 0.85, metal = 0, emissive = null, alphaTest = 0, side = THREE.FrontSide, color = 0xffffff } = {}) {
  const key = name + JSON.stringify(params) + repeat.join(',') + rough + metal + emissive + alphaTest + side + color;
  if (matCache.has(key)) return matCache.get(key);
  const t = name ? tex(name, params, repeat) : null;
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: rough, metalness: metal, alphaTest, side, color, transparent: false });
  if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveMap = t; m.emissiveIntensity = 1; }
  matCache.set(key, m);
  return m;
}
export function plainMat(color, { rough = 0.8, metal = 0, emissive = 0 } = {}) {
  const key = 'plain' + color + rough + metal + emissive;
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: emissive ? 1 : 0 });
  matCache.set(key, m); return m;
}
