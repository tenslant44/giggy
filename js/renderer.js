// =====================================================================
// Renderer module — WebGL renderer, scene, cameras, quality presets and
// the offscreen render-target utilities used by the eyedropper, the bot
// auto-painter, the seeker-bot vision system and result thumbnails.
// =====================================================================
import * as THREE from 'three';
import { Settings } from './state.js';

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 300);
export let renderer;

// sRGB <-> linear lookup tables (render targets are read back in linear space)
const LIN2SRGB = new Uint8Array(256);
const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN2SRGB[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export { LIN2SRGB, SRGB2LIN };

const rtCache = new Map();
function getRT(w, h) {
  const k = w + 'x' + h;
  let rt = rtCache.get(k);
  if (!rt) {
    rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true });
    rtCache.set(k, rt);
  }
  return rt;
}

export const Renderer = {
  init(container) {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // keeps sampled colours == displayed colours
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    container.appendChild(renderer.domElement);
    this.applyQuality();
    this.resize();
    addEventListener('resize', () => this.resize());
    return renderer.domElement;
  },
  applyQuality() {
    const q = Settings.quality;
    renderer.setPixelRatio(q === 'high' ? Math.min(devicePixelRatio, 2) : q === 'medium' ? Math.min(devicePixelRatio, 1.25) : 0.8);
    this.shadowSize = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    scene.traverse(o => {
      if (o.isDirectionalLight && o.castShadow && o.shadow.mapSize.x !== this.shadowSize) {
        o.shadow.mapSize.set(this.shadowSize, this.shadowSize);
        if (o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; }
      }
    });
    this.resize();
  },
  shadowSize: 2048,
  resize() {
    if (!renderer) return;
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  },
  // Main frame render (updates shadow maps once per frame).
  render(cam = camera) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, cam);
  },
  // Draw an extra view into a screen rectangle (paint-mode live preview).
  renderInset(cam, rect) {
    const y = innerHeight - rect.bottom;
    renderer.setScissorTest(true);
    renderer.setScissor(rect.left, y, rect.width, rect.height);
    renderer.setViewport(rect.left, y, rect.width, rect.height);
    cam.aspect = rect.width / rect.height; cam.updateProjectionMatrix();
    renderer.render(scene, cam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
  },
  // Render the scene offscreen and return linear RGBA bytes (row 0 = bottom).
  renderPixels(cam, w, h, hide = [], out = null) {
    const rt = getRT(w, h);
    const vis = hide.map(o => o.visible);
    hide.forEach(o => (o.visible = false));
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    const buf = out || new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(null);
    hide.forEach((o, i) => (o.visible = vis[i]));
    return buf;
  },
  // Eyedropper: sample the LIT colour under a screen pixel (sRGB 0..255).
  sampleScreen(cam, px, py, hide = []) {
    const S = 5;
    const c = cam.clone();
    c.setViewOffset(innerWidth, innerHeight, px - S / 2, py - S / 2, S, S);
    c.updateProjectionMatrix();
    const buf = this.renderPixels(c, S, S, hide);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) {
      const i = (y * S + x) * 4; r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
    }
    return { r: LIN2SRGB[Math.round(r / n)], g: LIN2SRGB[Math.round(g / n)], b: LIN2SRGB[Math.round(b / n)] };
  },
  // Result-card thumbnail: render a camera to a data URL.
  thumbnail(cam, w = 160, h = 200) {
    cam.aspect = w / h; cam.updateProjectionMatrix();
    const buf = this.renderPixels(cam, w, h);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4;
      img.data[d] = LIN2SRGB[buf[s]]; img.data[d + 1] = LIN2SRGB[buf[s + 1]]; img.data[d + 2] = LIN2SRGB[buf[s + 2]]; img.data[d + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return cv.toDataURL('image/jpeg', 0.85);
  },
};
