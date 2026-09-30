// =====================================================================
// Maps module — a small builder DSL (boxes with world-scaled UVs, walls
// with doorway gaps, decals, cylinders, lights, statues, seeker waiting
// room with a door) plus five hand-laid procedural maps. After building,
// a navigation grid and weighted hide-spot list are derived
// automatically from the colliders.
// =====================================================================
import * as THREE from 'three';
import { scene, Renderer } from './renderer.js';
import { tex, mat, plainMat } from './textures.js';
import { Physics } from './physics.js';
import { Character, POSES } from './character.js';
import { rng } from './state.js';

const geoCache = new Map();
function boxGeo(w, h, d, tile) {
  const key = [w, h, d, tile].map(v => v.toFixed(3)).join('|');
  let g = geoCache.get(key); if (g) return g;
  g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile);
  }
  geoCache.set(key, g); return g;
}
const cylCache = new Map();
function cylGeo(rt, rb, h, seg = 16) { const k = [rt, rb, h, seg].join('|'); if (!cylCache.has(k)) cylCache.set(k, new THREE.CylinderGeometry(rt, rb, h, seg)); return cylCache.get(k); }
const sphCache = new Map();
function sphGeo(r) { if (!sphCache.has(r)) sphCache.set(r, new THREE.SphereGeometry(r, 16, 12)); return sphCache.get(r); }

// ---------------------------------------------------------------------
class Builder {
  constructor(def) {
    this.def = def;
    this.group = new THREE.Group();
    this.boxes = []; this.rayMeshes = []; this.statues = []; this.doors = []; this.anim = [];
    this.r = rng(def.seed || 1);
  }
  add(m, { cast = true, receive = true, ray = true } = {}) {
    m.castShadow = cast; m.receiveShadow = receive; this.group.add(m); if (ray) this.rayMeshes.push(m); return m;
  }
  collider(minX, minY, minZ, maxX, maxY, maxZ, extra = {}) { const b = { minX, minY, minZ, maxX, maxY, maxZ, ...extra }; this.boxes.push(b); return b; }
  // Box from min/max corners
  box(x0, y0, z0, x1, y1, z1, material, { collide = true, tile = 2, cast = true, ray = true } = {}) {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    const m = new THREE.Mesh(boxGeo(w, h, d, tile), material);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(m, { cast, ray });
    if (collide) m.userData.box = this.collider(x0, y0, z0, x1, y1, z1);
    return m;
  }
  // centre-based box helper
  cbox(x, y, z, w, h, d, material, o) { return this.box(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, material, o); }
  // Wall running along Z at x (thickness t), with doorway gaps [[z0,z1],...]
  wallX(x, z0, z1, h, material, gaps = [], t = 0.3, o = {}) {
    let s = z0; const gs = [...gaps].sort((a, b) => a[0] - b[0]);
    for (const [g0, g1] of gs) { if (g0 > s) this.box(x - t / 2, 0, s, x + t / 2, h, g0, material, o); if (o.lintel !== false) this.box(x - t / 2, 2.4, g0, x + t / 2, h, g1, material, o); s = g1; }
    if (z1 > s) this.box(x - t / 2, 0, s, x + t / 2, h, z1, material, o);
  }
  wallZ(z, x0, x1, h, material, gaps = [], t = 0.3, o = {}) {
    let s = x0; const gs = [...gaps].sort((a, b) => a[0] - b[0]);
    for (const [g0, g1] of gs) { if (g0 > s) this.box(s, 0, z - t / 2, g0, h, z + t / 2, material, o); if (o.lintel !== false) this.box(g0, 2.4, z - t / 2, g1, h, z + t / 2, material, o); s = g1; }
    if (x1 > s) this.box(s, 0, z - t / 2, x1, h, z + t / 2, material, o);
  }
  // Flat decal facing +normal direction given by rotY (0 => faces +z)
  decal(x, y, z, w, h, rotY, material, { ray = true } = {}) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    m.position.set(x, y, z); m.rotation.y = rotY;
    return this.add(m, { cast: false, ray });
  }
  cyl(x, y0, z, r, h, material, { collide = true, rTop = r, seg = 16, cast = true } = {}) {
    const m = new THREE.Mesh(cylGeo(rTop, r, h, seg), material); m.position.set(x, y0 + h / 2, z); this.add(m, { cast });
    if (collide) this.collider(x - r * 0.85, y0, z - r * 0.85, x + r * 0.85, y0 + h, z + r * 0.85);
    return m;
  }
  // Horizontal pipe along an axis
  pipe(x0, y, z0, x1, z1, r, material) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(cylGeo(r, r, len, 14), material);
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.rotation.z = Math.PI / 2; m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    this.add(m);
    if (y - r < 1.6) this.collider(Math.min(x0, x1) - r, y - r, Math.min(z0, z1) - r, Math.max(x0, x1) + r, y + r, Math.max(z0, z1) + r);
    return m;
  }
  sphere(x, y, z, r, material, collide = false) {
    const m = new THREE.Mesh(sphGeo(r), material); m.position.set(x, y, z); this.add(m);
    if (collide) this.collider(x - r * 0.8, y - r, z - r * 0.8, x + r * 0.8, y + r * 0.8, z + r * 0.8);
    return m;
  }
  floor(material, x0, z0, x1, z1, tile = 2, y = 0) {
    const w = x1 - x0, d = z1 - z0;
    const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / tile, uv.getY(i) * d / tile);
    const m = new THREE.Mesh(g, material); m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    return this.add(m, { cast: false });
  }
  ceiling(material, x0, z0, x1, z1, y, tile = 3) {
    const w = x1 - x0, d = z1 - z0;
    const g = new THREE.PlaneGeometry(w, d); g.rotateX(Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / tile, uv.getY(i) * d / tile);
    const m = new THREE.Mesh(g, material); m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    // ceilings do not cast: the "sun" acts as skylight so interiors get real shadows
    return this.add(m, { cast: false, ray: true });
  }
  point(x, y, z, color, intensity = 6, dist = 10, bulb = true) {
    const l = new THREE.PointLight(color, intensity, dist, 1.6); l.position.set(x, y, z); this.group.add(l);
    if (bulb) this.sphere(x, y, z, 0.12, plainMat(color, { emissive: color }));
    return l;
  }
  lantern(x, y, z, color = 0xff5533) {
    const m = new THREE.Mesh(sphGeo(0.28), plainMat(color, { emissive: color, rough: 0.9 }));
    m.scale.set(1, 1.3, 1); m.position.set(x, y, z); this.add(m, { cast: false, ray: false });
    this.cbox(x, y + 0.34, z, 0.2, 0.06, 0.2, plainMat(0x222222), { collide: false, cast: false });
    const l = new THREE.PointLight(color, 5, 7, 1.8); l.position.set(x, y - 0.3, z); this.group.add(l);
  }
  statue(x, z, rotY, poseId, material, scale = 1, pedestal = 0.6) {
    if (pedestal > 0) this.cbox(x, 0, z, 0.9 * scale + 0.2, pedestal, 0.9 * scale + 0.2, mat('marble', { seed: 3, tint: 200 }, { rough: 0.4 }), { tile: 1 });
    const c = new Character({ scale, material });
    c.pose = poseId; c.snapPose();
    c.root.position.set(x, pedestal, z); c.root.rotation.y = rotY;
    this.group.add(c.root);
    c.root.updateMatrixWorld(true);
    c.meshes.forEach(m => { m.userData.char = null; m.userData.statue = true; this.rayMeshes.push(m); });
    if (pedestal <= 0) this.collider(x - 0.3 * scale, 0, z - 0.3 * scale, x + 0.3 * scale, 1.6 * scale, z + 0.3 * scale);
    this.statues.push(c);
    return c;
  }
  // Sealed seeker waiting room. door on side: 'n' (-z), 's' (+z), 'w' (-x), 'e' (+x)
  seekerRoom(x0, z0, x1, z1, side, outerMat, innerMat) {
    const h = 3.2, t = 0.3, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, dw = 1.8;
    const gX = [[cz - dw / 2, cz + dw / 2]], gZ = [[cx - dw / 2, cx + dw / 2]];
    this.wallZ(z0, x0, x1, h, outerMat, side === 'n' ? gZ : [], t);
    this.wallZ(z1, x0, x1, h, outerMat, side === 's' ? gZ : [], t);
    this.wallX(x0, z0, z1, h, outerMat, side === 'w' ? gX : [], t);
    this.wallX(x1, z0, z1, h, outerMat, side === 'e' ? gX : [], t);
    // inner lining + ceiling + roof
    this.ceiling(innerMat, x0, z0, x1, z1, h - 0.01);
    this.box(x0 - t / 2, h, z0 - t / 2, x1 + t / 2, h + 0.3, z1 + t / 2, outerMat, { collide: true });
    const doorMat = mat('metal', { base: [200, 60, 90], seed: 5, rust: 0 }, { rough: 0.5, metal: 0.3 });
    let door;
    if (side === 'n' || side === 's') { const z = side === 'n' ? z0 : z1; door = this.box(cx - dw / 2, 0, z - 0.1, cx + dw / 2, 2.4, z + 0.1, doorMat, { tile: 2 }); }
    else { const x = side === 'w' ? x0 : x1; door = this.box(x - 0.1, 0, cz - dw / 2, x + 0.1, 2.4, cz + dw / 2, doorMat, { tile: 2 }); }
    door.userData.box.door = true;
    this.doors.push(door);
    // wait signs inside
    const signMat = mat('sign', { text: 'まて', bg: '#ff2d6f', fg: '#fff' }, { emissive: 0x662233 });
    const inward = { n: [0, 1], s: [0, -1], w: [1, 0], e: [-1, 0] }[side];
    const back = { n: z1 - 0.17, s: z0 + 0.17 };
    if (side === 'n' || side === 's') this.decal(cx, 1.6, back[side], 0.5, 1.9, side === 'n' ? Math.PI : 0, signMat);
    else this.decal(side === 'w' ? x1 - 0.17 : x0 + 0.17, 1.6, cz, 0.5, 1.9, side === 'w' ? -Math.PI / 2 : Math.PI / 2, signMat);
    this.point(cx, h - 0.4, cz, 0xfff0dd, 5, 9);
    this.room = { x0, z0, x1, z1, cx, cz, inward };
  }
  lights({ sky = 0xbfd8ff, ground = 0x554433, hemi = 0.7, sun = 0xffffff, sunI = 1.8, dir = [-0.5, -1, -0.35], bg = 0x88aadd, fog = null, ambient = 0 }) {
    const hl = new THREE.HemisphereLight(sky, ground, hemi); this.group.add(hl);
    if (ambient) this.group.add(new THREE.AmbientLight(0xffffff, ambient));
    const b = this.def.bounds;
    const cx = (b[0] + b[2]) / 2, cz = (b[1] + b[3]) / 2, ext = Math.max(b[2] - b[0], b[3] - b[1]) * 0.75;
    const dl = new THREE.DirectionalLight(sun, sunI);
    const dv = new THREE.Vector3(...dir).normalize();
    dl.position.set(cx - dv.x * 40, -dv.y * 40, cz - dv.z * 40);
    dl.target.position.set(cx, 0, cz);
    dl.castShadow = true;
    dl.shadow.mapSize.set(Renderer.shadowSize, Renderer.shadowSize);
    const sc = dl.shadow.camera; sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 100;
    dl.shadow.bias = -0.0004; dl.shadow.normalBias = 0.03;
    this.group.add(dl, dl.target);
    this.bg = new THREE.Color(bg);
    this.fog = fog ? new THREE.Fog(fog[0], fog[1], fog[2]) : null;
  }
}

// ---------------------------------------------------------------------
// Map definitions
// ---------------------------------------------------------------------
const MAPS = {};

// ---- 1. Osaka Alley (dusk) ----
MAPS.alley = {
  name: 'Osaka Alley', seed: 101, bounds: [-18, -14, 18, 14], hiderSpawn: [0, 0],
  build(B) {
    B.lights({ sky: 0xffb08a, ground: 0x3a2c50, hemi: 0.85, sun: 0xffc48a, sunI: 2.1, dir: [0.55, -0.6, 0.45], bg: 0xf0906a, fog: [0xd88070, 25, 70] });
    B.floor(mat('asphalt', {}, { rough: 0.95 }), -18, -14, 18, 14, 4);
    const brick = mat('bricks', { seed: 3 }), brick2 = mat('bricks', { seed: 8, base: [25, 35, 55], grout: '#6a6258' }), plaster = mat('plaster', { col: [205, 196, 178] }), plaster2 = mat('plaster', { seed: 5, col: [150, 170, 175] });
    const graf = [0, 1, 2, 3].map(i => mat('graffitiBricks', { seed: 5 + i * 11 }));
    // buildings
    const blds = [[-18, -14, -6, -6, 8, brick], [9, -14, 18, -5, 9, plaster2], [-18, 3, -9, 14, 7, plaster], [-6, 4, 3, 14, 9, brick2], [6, 5, 18, 14, 8, brick]];
    blds.forEach(([x0, z0, x1, z1, h, m]) => B.box(x0, 0, z0, x1, h, z1, m, { tile: 3 }));
    // bounding walls on open sides
    B.box(-18.3, 0, -6, -18, 4, 3, brick); B.box(-18, 0, -14.3, 18, 4, -14, brick); B.box(18, 0, -5, 18.3, 4, 5, brick);
    B.box(-9, 0, 13.8, 6, 4, 14.1, brick2);
    // seeker room in the middle-north block
    B.seekerRoom(-3, -14, 6, -6.5, 's', brick2, plaster);
    // graffiti walls & shutters on building faces
    B.decal(-12, 1.8, -5.97, 5, 3.4, 0, graf[0]); B.decal(13.5, 1.8, -4.97, 5, 3.4, 0, graf[1]);
    B.decal(-13.5, 1.8, 2.97, 6, 3.4, Math.PI, graf[2]); B.decal(12, 1.8, 4.97, 5, 3.4, Math.PI, graf[3]);
    B.decal(-5.97, 1.8, 9, 5, 3.4, Math.PI / 2, graf[1]);
    const shutter = mat('shutter', {}, { rough: 0.5, metal: 0.4 });
    B.decal(-2, 1.3, 3.97, 3, 2.6, Math.PI, shutter); B.decal(-8.5, 1.3, -5.97, 3, 2.6, 0, shutter); B.decal(15.5, 1.3, 4.97, 2.8, 2.6, Math.PI, shutter);
    // vertical kanji signs
    const signs = [['ラーメン', '#d6263a'], ['たこ焼き', '#1f5fbf'], ['居酒屋', '#2a8a3a'], ['カラオケ', '#8a2abf'], ['寿司', '#e07a10']];
    const sp = [[-7, 4.5, -5.6, 0], [10, 4.5, -4.6, 0], [-10, 4.2, 2.6, Math.PI], [4, 4.8, 3.6, Math.PI], [8, 4.5, 4.6, Math.PI]];
    sp.forEach(([x, y, z, ry], i) => { const m = mat('sign', { text: signs[i][0], bg: signs[i][1], seed: i }, { emissive: 0x553322 }); B.cbox(x, y - 1.4, z, 0.6, 2.8, 0.15, m, { collide: false, tile: 3 }).rotation.y = ry; });
    // vending machines
    const vend = i => mat('vending', { seed: 47 + i }, { emissive: 0x333333, rough: 0.4 });
    [[-15, -5.55, 0], [-14, -5.55, 0], [11, 4.45, Math.PI], [-4.5, 3.45, Math.PI]].forEach(([x, z, ry], i) => { const m = B.cbox(x, 0, z, 0.9, 1.9, 0.8, vend(i), { tile: 2 }); m.rotation.y = ry; });
    // wooden crates, trash bags, AC units, pipes, benches, plants
    const crate = mat('wood', { seed: 12, base: [30, 40, 45], planks: 4 }), bag = plainMat(0x2a2a32, { rough: 0.35 }), ac = mat('metal', { base: [210, 210, 205], seed: 2, rust: 0.4 }, { rough: 0.5 });
    [[-7.5, 1.2], [-7.4, 2.2], [7.2, -2.5], [8.3, -3.8], [-16.5, 1.5], [16.8, 3.9], [4.8, 12], [-4.5, 12.3]].forEach(([x, z], i) => { const s = 0.8 + (i % 3) * 0.2; B.cbox(x, 0, z, s, s, s, crate, { tile: 1 }); if (i % 3 === 0) B.cbox(x, s, z, 0.6, 0.6, 0.6, crate, { tile: 1 }); });
    [[-5.4, -5.3], [-5.0, -5.5], [7.5, 3.2], [16.8, -4.2], [-8.3, 12.8]].forEach(([x, z]) => { B.sphere(x, 0.35, z, 0.45, bag, true); B.sphere(x + 0.4, 0.3, z + 0.2, 0.35, bag, false); });
    [[-10, 3.5, -5.7], [-16, 2.6, -5.7], [14, 3.2, -4.7], [-12, 3, 2.7], [10, 3.4, 4.7]].forEach(([x, y, z]) => B.cbox(x, y, z, 1.1, 0.7, 0.55, ac, { collide: false, tile: 1 }));
    const pipeM = mat('metal', { base: [120, 110, 100], seed: 9, rivets: false, rust: 0.8 }, { rough: 0.45, metal: 0.6 });
    [[-6.2, -9], [8.8, -8], [-8.8, 6], [5.8, 8], [2.8, 6]].forEach(([x, z]) => B.cyl(x, 0, z, 0.08, 7, pipeM));
    B.pipe(-18, 3, -5.85, -6, -5.85, 0.1, pipeM); B.pipe(9, 2.5, 4.85, 18, 4.85, 0.1, pipeM);
    const wood = mat('wood', { seed: 3, base: [25, 50, 30], planks: 5 });
    B.cbox(0, 0, 2.8, 2.2, 0.45, 0.6, wood, { tile: 1 }); B.cbox(-13, 0, -1, 0.6, 0.45, 2, wood, { tile: 1 });
    const pot = mat('concrete', { base: 150, seed: 3 }), leaf = plainMat(0x3f7a35, { rough: 0.9 });
    [[-6.5, 3.4], [2.5, -5.6], [17, -1], [-17, -2.2]].forEach(([x, z]) => { B.cyl(x, 0, z, 0.35, 0.6, pot); B.sphere(x, 1.0, z, 0.55, leaf); });
    // power pole & utility box
    B.cyl(4.5, 0, -2.5, 0.16, 9, mat('concrete', { base: 120, seed: 9 }));
    B.cbox(4.5, 0, -1.9, 0.9, 1.3, 0.5, mat('metal', { base: [110, 130, 115], seed: 4, rust: 0.5 }, { rough: 0.6, metal: 0.2 }));
    // lanterns
    [[-8, 2.8, -5.3], [-3, 2.8, 3.4], [2, 2.8, 3.4], [11, 2.8, -4.4], [-12, 2.8, 2.4], [14, 2.8, 4.4], [7.5, 2.8, 0]].forEach(([x, y, z]) => B.lantern(x, y, z, 0xff4a3a));
    // noren curtain
    B.decal(0, 2.1, 3.96, 2.4, 0.9, Math.PI, mat('sign', { text: 'のれん', bg: '#27477a', fg: '#fff' }, { side: THREE.DoubleSide }));
  },
};

// ---- 2. Haunted Mansion with paintings ----
MAPS.mansion = {
  name: 'Mansion', seed: 202, bounds: [-16, -12, 16, 12], hiderSpawn: [0, 0],
  build(B) {
    B.lights({ sky: 0xffe8c8, ground: 0x3a2418, hemi: 0.65, sun: 0xffe2b0, sunI: 1.6, dir: [-0.45, -1, 0.3], bg: 0x1d1420 });
    const floorW = mat('wood', { seed: 21, base: [26, 45, 30], planks: 8 }, { rough: 0.55 });
    B.floor(floorW, -16, -12, 16, 12, 3);
    B.floor(mat('tiles', { a: '#e9e3d5', b: '#3a2e2a', size: 8, seed: 3 }, { rough: 0.4 }), -5, -12, 5, 12, 4, 0.005);
    const wp1 = mat('wallpaper', { base: '#6b2a3a', fg: '#d8b36a', style: 0 }), wp2 = mat('wallpaper', { base: '#2a4a3a', fg: '#c9b57a', style: 1, seed: 4 }), wp3 = mat('wallpaper', { base: '#2f3560', fg: '#d0c090', style: 0, seed: 7 }), wp4 = mat('wallpaper', { base: '#7a6a4a', fg: '#fff0c0', style: 1, seed: 9 });
    const H = 4.2;
    B.wallZ(-12, -16, 16, H, wp1); B.wallZ(12, -16, 16, H, wp1, [[-3, 3]], 0.3, { lintel: false }); B.box(-3, 3.5, 11.85, 3, H, 12.15, wp1);
    B.wallX(-16, -12, 12, H, wp2); B.wallX(16, -12, 12, H, wp3);
    B.wallX(-5, -12, 12, H, wp2, [[-7, -5], [4, 6]]); B.wallX(5, -12, 12, H, wp3, [[-8, -6], [2, 4]]);
    B.wallZ(0, -16, -5, H, wp4, [[-11, -9]]); B.wallZ(-2, 5, 16, H, wp4, [[10, 12]]);
    B.ceiling(mat('plaster', { col: [230, 220, 200] }), -16, -12, 16, 12, H);
    B.seekerRoom(-3, 12, 3, 17, 'n', mat('bricks', { seed: 6, base: [20, 20, 40] }), wp4);
    // paintings everywhere
    const walls = [[-16, 'x', 1], [16, 'x', -1], [-5, 'x', -1], [-5, 'x', 1], [5, 'x', 1], [5, 'x', -1]];
    let seed = 1;
    for (const [x, , dir] of walls) for (const z of [-10, -3, 2, 9]) {
      if (Math.abs(x) === 5 && (z === -3 && x < 0 || z === 2 && x > 0)) continue;
      if (B.r() < 0.25) continue;
      const s = 0.8 + B.r() * 0.6;
      B.decal(x + dir * 0.17, 2.2, z, 1.1 * s, 1.4 * s, dir * Math.PI / 2, mat('painting', { seed: seed++ * 13 }, { rough: 0.6 }));
    }
    for (const x of [-13, -9, 9, 13]) B.decal(x, 2.2, -11.83, 1.2, 1.5, 0, mat('painting', { seed: seed++ * 13 }));
    for (const x of [-12, 12]) B.decal(x, 2.2, 11.83, 1.2, 1.5, Math.PI, mat('painting', { seed: seed++ * 13 }));
    // library (west north): bookshelves
    const books = mat('books', {}, { rough: 0.8 });
    for (const z of [-11.4]) for (const x of [-14.8, -12.4, -10, -7.6]) B.cbox(x, 0, z, 2.2, 3, 0.8, books, { tile: 2.2 });
    B.cbox(-15.4, 0, -6, 0.8, 3, 2.2, books, { tile: 2.2 });
    B.cbox(-10.5, 0, -5.5, 3, 0.8, 1.4, mat('wood', { seed: 4, base: [20, 50, 22] }, { rough: 0.5 }), { tile: 1.5 });
    // lounge (west south): sofas + fireplace + rug
    const fab = mat('fabric', { col: '#6a2030' }), fab2 = mat('fabric', { col: '#2f4f7a', seed: 3 });
    B.floor(mat('rug', {}), -13, 3, -7, 9, 6, 0.01);
    B.cbox(-10, 0, 3.2, 3, 0.5, 1, fab, { tile: 1 }); B.cbox(-10, 0.5, 2.8, 3, 0.6, 0.25, fab, { tile: 1 });
    B.cbox(-13.8, 0, 6, 1, 0.5, 2.6, fab2, { tile: 1 }); B.cbox(-10, 0, 6, 1.6, 0.45, 1, mat('wood', { seed: 9 }), { tile: 1 });
    const fb = mat('bricks', { seed: 14, base: [10, 30, 30] });
    B.box(-11.5, 0, 11, -8.5, 2.2, 11.85, fb, { tile: 1.5 });
    B.box(-10.6, 0.1, 10.95, -9.4, 1.0, 11.02, plainMat(0xff7a20, { emissive: 0xff5a10 }), { collide: false, cast: false });
    B.point(-10, 1.0, 10.4, 0xff7a30, 6, 7, false);
    // dining room (east north): long table + chairs
    const tw = mat('wood', { seed: 31, base: [15, 55, 20], planks: 4 }, { rough: 0.35 });
    B.cbox(10.5, 0.75, -7, 7, 0.1, 1.6, tw, { tile: 2 }); for (const x of [7.5, 13.5]) for (const z of [-7.6, -6.4]) B.cbox(x, 0, z, 0.12, 0.75, 0.12, tw, { tile: 1 });
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) { const x = 8 + i * 1.3, z = -7 + s * 1.2; B.cbox(x, 0, z, 0.5, 0.5, 0.5, tw, { tile: 1 }); B.cbox(x, 0.5, z + s * 0.22, 0.5, 0.7, 0.07, tw, { tile: 1, collide: false }); }
    B.cbox(15.4, 0, -10, 0.9, 2.2, 2.4, mat('wood', { seed: 41, base: [18, 40, 25], planks: 3, vertical: true }), { tile: 2 });
    // gallery (east south): pedestals, suits of armour, benches
    const armour = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, metalness: 0.9, roughness: 0.3 });
    B.statue(8, 10.8, Math.PI, 'stand', armour, 1.05, 0); B.statue(13.5, 10.8, Math.PI, 'statue', armour, 1.05, 0);
    B.statue(15.2, 3, -Math.PI / 2, 'wall', armour, 1, 0);
    B.cbox(10.5, 0, 4, 2.4, 0.45, 0.7, fab, { tile: 1 });
    B.statue(7, 0.5, Math.PI / 2, 'statue', mat('marble', { seed: 3 }, { rough: 0.35 }), 0.75, 0.9);
    // hall pillars, clock, plants, chandeliers
    const marble = mat('marble', { seed: 7 }, { rough: 0.3 });
    for (const z of [-8, -3, 3, 8]) for (const x of [-3.6, 3.6]) B.cyl(x, 0, z, 0.35, H, marble);
    B.cbox(-4.3, 0, -10.8, 0.7, 2.3, 0.5, mat('wood', { seed: 51, base: [20, 60, 18], planks: 2, vertical: true }), { tile: 1 });
    const pot = mat('concrete', { base: 170, seed: 33 }), leaf = plainMat(0x356a2e);
    [[-4.2, 11.2], [4.2, 11.2], [4.2, -11.2], [-15.2, -1], [15.2, -2.8]].forEach(([x, z]) => { B.cyl(x, 0, z, 0.3, 0.6, pot); B.sphere(x, 1.1, z, 0.55, leaf); });
    [[0, -6], [0, 6], [-10.5, -6], [-10.5, 6], [10.5, -7], [10.5, 5]].forEach(([x, z]) => { B.point(x, 3.6, z, 0xffe0a0, 5, 11, false); B.sphere(x, 3.7, z, 0.3, plainMat(0xffe9a8, { emissive: 0xffd070 })); });
  },
};

// ---- 3. Sewer ----
MAPS.sewer = {
  name: 'Sewer', seed: 303, bounds: [-16, -14, 16, 14], hiderSpawn: [0, 0],
  build(B) {
    B.lights({ sky: 0x6f9a7a, ground: 0x1a2018, hemi: 0.55, sun: 0xbfe0c0, sunI: 1.0, dir: [0.3, -1, 0.5], bg: 0x0b120e, fog: [0x14201a, 10, 40] });
    const conc = mat('concrete', { base: 90, seed: 5, tint: [0, 8, 0] }, { rough: 0.9 });
    B.floor(conc, -16, -14, 16, 14, 3);
    const sb = mat('sewerBricks', {}), sb2 = mat('sewerBricks', { seed: 44 });
    const H = 4;
    B.wallZ(-14, -16, 16, H, sb); B.wallZ(14, -16, 16, H, sb, [[-3, 3]], 0.3, { lintel: false }); B.box(-3, 3.5, 13.85, 3, H, 14.15, sb); B.wallX(-16, -14, 14, H, sb); B.wallX(16, -14, 14, H, sb);
    // four solid blocks forming a ring + cross tunnel network
    const blocks = [[-12, -10, -2.2, -2.2], [2.2, -10, 12, -2.2], [-12, 2.2, -2.2, 10], [2.2, 2.2, 12, 10]];
    blocks.forEach(([x0, z0, x1, z1], i) => B.box(x0, 0, z0, x1, H, z1, i % 2 ? sb : sb2, { tile: 2.5 }));
    B.ceiling(mat('concrete', { base: 70, seed: 8 }), -16, -14, 16, 14, H);
    B.seekerRoom(-3, 14, 3, 19, 'n', sb, mat('tiles', { a: '#c8d8c8', b: '#9ab09a', size: 10, seed: 5 }));
    // water channels (visual, walkable) down the tunnel centres
    const water = new THREE.MeshStandardMaterial({ map: tex('water', {}, [1, 1]), roughness: 0.12, metalness: 0.2, color: 0x88aa88 });
    B.floor(water, -0.8, -14, 0.8, 14, 2, 0.02); B.floor(water, -16, -0.8, 16, 0.8, 2, 0.021);
    B.floor(water, -14.6, -13, -13.4, 13, 2, 0.022); B.floor(water, 13.4, -13, 14.6, 13, 2, 0.022);
    // pipes along tunnel walls
    const pipeA = mat('metal', { base: [140, 110, 70], seed: 3, rivets: false, rust: 1 }, { rough: 0.4, metal: 0.7 }), pipeB = mat('metal', { base: [70, 100, 120], seed: 8, rivets: false, rust: 0.6 }, { rough: 0.4, metal: 0.6 });
    B.pipe(-15.6, 3.2, -13, -15.6, 13, 0.25, pipeA); B.pipe(15.6, 2.8, -13, 15.6, 13, 0.3, pipeB);
    B.pipe(-12, 3.4, -13.6, 12, -13.6, 0.2, pipeB); B.pipe(-12, 0.35, 13.55, -2, 13.55, 0.3, pipeA);
    B.pipe(-2, 3, -10, -2, -2.2, 0.15, pipeA); B.pipe(2, 0.4, 2.5, 2, 9.5, 0.28, pipeB);
    for (const [x, z] of [[-15.5, -9], [15.4, 6], [-8, -13.5], [8, 13.5]]) B.cyl(x, 0, z, 0.25, H, pipeA);
    // valves & junction boxes
    const valve = plainMat(0xb03020, { rough: 0.5, metal: 0.5 });
    for (const [x, y, z] of [[-15.3, 1.5, -4], [15.2, 1.5, 9], [-2.05, 1.4, 6]]) { const v = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.05, 8, 16), valve); v.position.set(x, y, z); v.rotation.y = Math.PI / 2; B.add(v); }
    const jb = mat('metal', { base: [90, 95, 90], seed: 12, rust: 0.8 }, { rough: 0.6, metal: 0.4 });
    [[-12.2, 1, -6], [12.2, 1, 6], [6, 1, -10.2], [-6, 1, 10.2]].forEach(([x, y, z]) => B.cbox(x, y, z, 0.6, 1, 0.6, jb, { tile: 1 }));
    // barrels, crates, grates, ladders
    const barrel = mat('metal', { base: [60, 90, 150], seed: 14, rust: 0.6, rivets: false }, { rough: 0.5, metal: 0.4 }), barrel2 = mat('metal', { base: [170, 140, 40], seed: 15, rust: 0.7 }, { rough: 0.5, metal: 0.3 });
    [[-14.8, -12.5], [-14, -12.6], [14.7, 12.5], [3, -12.8], [-3, 12.7], [13.3, -1.8], [-13.3, 2]].forEach(([x, z], i) => B.cyl(x, 0, z, 0.4, 1.1, i % 2 ? barrel : barrel2));
    const crate = mat('wood', { seed: 61, base: [35, 25, 30], planks: 4 });
    [[14.5, -9], [-14.5, 8], [-9, -12.9], [9.5, 12.8]].forEach(([x, z]) => B.cbox(x, 0, z, 1, 1, 1, crate, { tile: 1 }));
    const grate = new THREE.MeshStandardMaterial({ map: tex('grate'), alphaTest: 0.5, transparent: false, metalness: 0.6, roughness: 0.5 });
    [[0, -7], [0, 7], [-7, 0], [7, 0]].forEach(([x, z]) => { const m = B.floor(grate, x - 0.8, z - 0.8, x + 0.8, z + 0.8, 1.6, 0.03); m.material = grate; });
    const lad = mat('metal', { base: [160, 160, 150], seed: 9, rivets: false }, { metal: 0.6, rough: 0.4 });
    for (const [x, z] of [[-2.35, -6], [2.35, 6]]) { B.cbox(x, 0, z - 0.25, 0.08, 4, 0.06, lad, { collide: false }); B.cbox(x, 0, z + 0.25, 0.08, 4, 0.06, lad, { collide: false }); for (let y = 0.3; y < 4; y += 0.35) B.cbox(x, y, z, 0.06, 0.04, 0.5, lad, { collide: false }); }
    // green/yellow hanging lamps
    [[-14, -12], [14, -12], [-14, 12], [14, 12], [0, 0], [-14, 0], [14, 0], [0, -12]].forEach(([x, z], i) => B.point(x, 3.5, z, i % 3 ? 0xc8ff9a : 0xffd070, 8, 14));
  },
};

// ---- 4. Barn with cardboard cows ----
MAPS.barn = {
  name: 'Barn', seed: 404, bounds: [-14, -10, 14, 10], hiderSpawn: [0, 0],
  build(B) {
    B.lights({ sky: 0xffe2a8, ground: 0x4a3420, hemi: 0.75, sun: 0xfff0c8, sunI: 2.0, dir: [0.4, -1, -0.6], bg: 0x7fb8e8 });
    B.floor(mat('dirt', {}), -14, -10, 14, 10, 3);
    B.floor(mat('hay', { seed: 5 }), -14, -10, -7, 10, 2, 0.01);
    const plank = mat('wood', { seed: 71, base: [12, 55, 32], planks: 6, vertical: true }), plank2 = mat('wood', { seed: 73, base: [30, 35, 40], planks: 5, vertical: true }), beam = mat('wood', { seed: 75, base: [25, 40, 25], planks: 2, vertical: true });
    const H = 6;
    B.wallZ(-10, -14, 14, H, plank); B.wallZ(10, -14, 14, H, plank, [[-3, 3]], 0.3, { lintel: false }); B.box(-3, 3.5, 9.85, 3, H, 10.15, plank); B.wallX(-14, -10, 10, H, plank); B.wallX(14, -10, 10, H, plank);
    B.ceiling(plank2, -14, -10, 14, 10, H);
    B.seekerRoom(-3, 10, 3, 15, 'n', plank, plank2);
    // posts & crossbeams
    for (const x of [-7, 0, 7]) for (const z of [-4, 4]) B.cbox(x, 0, z, 0.35, H, 0.35, beam, { tile: 2 });
    for (const x of [-7, 0, 7]) B.cbox(x, 4.6, 0, 0.3, 0.3, 20, beam, { collide: false, tile: 2 });
    // loft on west side with stairs
    B.box(-14, 2.5, -10, -9, 2.8, 2, plank2, { tile: 2 });
    for (let i = 0; i < 8; i++) B.box(-10.5, 0, 2 + (7 - i) * 0.55, -9.1, 0.31 * (i + 1), 2 + (8 - i) * 0.55, plank2, { tile: 1 });
    B.box(-9.1, 2.8, -10, -9, 3.8, 2, beam, { tile: 1 });
    // hay bales
    const hay = mat('hay', {}, { rough: 1 });
    const bales = [[-12.6, 0, 7.3], [-11.4, 0, 7.3], [-12.6, 1, 7.3], [-11.4, 0, 9.2], [-12.6, 0, 9.2], [12, 0, -8], [10.8, 0, -8], [12, 1, -8], [11.4, 2, -8], [4, 0, -8.5], [-4, 0, 8], [9, 0, 8.3], [10.3, 0, 8.3], [-12.5, 2.8, -8], [-11.3, 2.8, -8], [-12.5, 2.8, -3], [-12, 3.8, -8]];
    bales.forEach(([x, y, z]) => B.cbox(x, y, z, 1.15, 1, 0.8, hay, { tile: 1 }));
    // stalls (low fences)
    const fence = mat('wood', { seed: 81, base: [22, 45, 40], planks: 3 });
    for (const x of [2, 5, 8, 11]) B.box(x - 0.08, 0, 5, x + 0.08, 1.3, 10, fence, { tile: 1 });
    B.box(2, 0, 4.9, 3.2, 1.3, 5.05, fence, { tile: 1 }); B.box(5, 0, 4.9, 6.2, 1.3, 5.05, fence, { tile: 1 }); B.box(8, 0, 4.9, 9.2, 1.3, 5.05, fence, { tile: 1 });
    // cardboard cow standees
    const cowMat = i => new THREE.MeshStandardMaterial({ map: tex('cow', { seed: 31 + i }), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
    [[3.5, 7.5, 0.3], [6.5, 7.8, -0.2], [9.6, 7.5, 0.4], [-3, -6, 1.2], [5, -3, -0.6], [-8, 7, 1.5], [12, 1, 1.57]].forEach(([x, z, ry], i) => {
      const m = B.decal(x, 0.95, z, 2.4, 1.8, ry, cowMat(i)); m.castShadow = true;
      const c = Math.cos(ry), s = Math.sin(ry), hw = 1.0;
      B.collider(x - Math.abs(c) * hw - 0.1, 0, z - Math.abs(s) * hw - 0.1, x + Math.abs(c) * hw + 0.1, 1.8, z + Math.abs(s) * hw + 0.1);
      B.cbox(x - s * 0.15, 0, z - c * 0.15, 0.08, 1.2, 0.08, mat('cardboard'), { collide: false });
    });
    // tractor
    const red = plainMat(0xc8322a, { rough: 0.45, metal: 0.3 }), tire = plainMat(0x1a1a1a, { rough: 0.9 });
    B.cbox(6, 0.6, -6.5, 2.6, 1.1, 1.4, red); B.cbox(5.2, 1.7, -6.5, 1.1, 1.1, 1.3, red, { collide: false }); B.cbox(7, 1.7, -6.5, 0.12, 0.8, 0.12, plainMat(0x333333), { collide: false });
    for (const [x, z, r] of [[5, -7.35, 0.75], [5, -5.65, 0.75], [7.1, -7.3, 0.45], [7.1, -5.7, 0.45]]) { const w = new THREE.Mesh(cylGeo(r, r, 0.35, 20), tire); w.rotation.x = Math.PI / 2; w.position.set(x, r, z); B.add(w); }
    // barrels, sacks, cardboard boxes, trough
    const barrel = mat('wood', { seed: 91, base: [28, 50, 30], planks: 8, vertical: true });
    [[13, 9], [12.2, 9.2], [-4, -9.2], [0.8, -9.2], [13.2, -3]].forEach(([x, z]) => B.cyl(x, 0, z, 0.42, 1.1, barrel));
    const sack = plainMat(0xd8c8a0, { rough: 1 });
    [[-6, -9.3], [-5.3, -9.3], [-5.65, -9.2]].forEach(([x, z], i) => { const m = B.sphere(x, 0.35 + (i === 2 ? 0.5 : 0), z, 0.42, sack, true); m.scale.set(1, 0.8, 0.7); });
    const card = mat('cardboard');
    [[2.5, -8.8, 1], [3.4, -9, 0.7], [2.9, -8.9, 0.6, 1]].forEach(([x, z, s, up]) => B.cbox(x, up ? 1 : 0, z, s, s, s, card, { tile: s }));
    B.cbox(-2, 0, 3.2, 3, 0.6, 0.8, mat('metal', { base: [120, 125, 120], seed: 2, rust: 0.8 }, { metal: 0.5, rough: 0.5 }), { tile: 1 });
    [[-10, -3], [4, 0], [10, -3], [-3, 6], [-11, 5]].forEach(([x, z]) => B.point(x, 4.3, z, 0xffd9a0, 6, 12));
  },
};

// ---- 5. Museum with statues ----
MAPS.museum = {
  name: 'Museum', seed: 505, bounds: [-16, -12, 16, 12], hiderSpawn: [0, 0],
  build(B) {
    B.lights({ sky: 0xffffff, ground: 0x8a8070, hemi: 0.8, sun: 0xfffaf0, sunI: 1.9, dir: [-0.3, -1, -0.45], bg: 0x2a2a30 });
    B.floor(mat('tiles', { a: '#d9d2c3', b: '#b8ae9a', size: 6, seed: 9, grout: '#9a927f' }, { rough: 0.3 }), -16, -12, 16, 12, 4);
    const wall = mat('plaster', { col: [236, 232, 222], seed: 7 }), wall2 = mat('plaster', { col: [120, 40, 50], seed: 9 }), wall3 = mat('plaster', { col: [40, 70, 95], seed: 11 });
    const H = 5;
    B.wallZ(-12, -16, 16, H, wall); B.wallZ(12, -16, 16, H, wall, [[-3, 3]], 0.3, { lintel: false }); B.box(-3, 3.5, 11.85, 3, H, 12.15, wall); B.wallX(-16, -12, 12, H, wall2); B.wallX(16, -12, 12, H, wall3);
    B.wallX(-6, -12, 12, H, wall2, [[-8, -5], [3, 6]]); B.wallX(6, -12, 12, H, wall3, [[-6, -3], [5, 8]]);
    B.wallZ(0, -16, -6, H, wall, [[-12, -10]]); B.wallZ(0, 6, 16, H, wall, [[10, 12]]);
    B.ceiling(mat('plaster', { col: [245, 245, 240] }), -16, -12, 16, 12, H);
    B.seekerRoom(-3, 12, 3, 17, 'n', mat('bricks', { seed: 19, base: [30, 10, 60] }), wall);
    const marbleW = mat('marble', { seed: 3 }, { rough: 0.35 }), marbleG = mat('marble', { seed: 5, tint: 190 }, { rough: 0.35 });
    const bronze = new THREE.MeshStandardMaterial({ color: 0x9a6a3a, metalness: 0.85, roughness: 0.35 });
    const poses = POSES.map(p => p.id);
    const spots = [[-12, -8], [-9, -4], [-12, 4], [-9, 8], [-2.5, -8], [2.5, -4], [-2.5, 4], [2.5, 8], [10, -8], [12.5, -4], [10, 4], [12.5, 8]];
    spots.forEach(([x, z], i) => B.statue(x, z, B.r() * 6.28, poses[(i * 3 + 1) % poses.length], i % 4 === 3 ? bronze : i % 2 ? marbleG : marbleW, 0.8 + B.r() * 0.35, B.r() < 0.3 ? 0 : 0.5 + B.r() * 0.3));
    // paintings in galleries
    let seed = 200;
    for (const [x, dir] of [[-16, 1], [16, -1], [-6, 1], [-6, -1], [6, 1], [6, -1]]) for (const z of [-9, -2, 8]) {
      if (B.r() < 0.2) continue;
      B.decal(x + dir * 0.17, 2.3, z, 1.4, 1.8, dir * Math.PI / 2, mat('painting', { seed: seed++ * 7 }, { rough: 0.6 }));
      if (Math.abs(x) === 16) B.cbox(x + dir * 1.1, 0, z, 0.08, 0.9, 0.08, plainMat(0xc9a44a, { metal: 0.8, rough: 0.3 }));
    }
    // benches, rope posts, display cases, plants
    const bench = mat('wood', { seed: 13, base: [25, 40, 30] }, { rough: 0.5 });
    [[-11, 0, 1], [11, 0, 1], [0, -10, 0], [0, 10, 0]].forEach(([x, z, rot]) => { const m = B.cbox(x, 0, z, rot ? 0.6 : 2.2, 0.45, rot ? 2.2 : 0.6, bench, { tile: 1 }); });
    const gold = plainMat(0xd4af37, { metal: 0.9, rough: 0.25 }), velvet = plainMat(0x8a1020, { rough: 0.9 });
    for (const z of [-6, 6]) { for (const x of [-1.5, 0, 1.5]) B.cyl(x, 0, z, 0.06, 0.95, gold, { collide: true }); B.pipe(-1.5, 0.85, z, 1.5, z, 0.03, velvet); }
    const caseM = mat('metal', { base: [60, 60, 70], seed: 3, rivets: false, rust: 0 }, { metal: 0.6, rough: 0.3 });
    [[-13.8, -1], [13.8, 1], [0, 0]].forEach(([x, z]) => { B.cbox(x, 0, z, 1.2, 1, 1.2, caseM); B.sphere(x, 1.25, z, 0.25, plainMat(0x2a8a6a, { rough: 0.2, metal: 0.3 })); });
    const pot = mat('concrete', { base: 200, seed: 21 }), leaf = plainMat(0x2e6a34);
    [[-5.4, 11.3], [5.4, 11.3], [-15.3, -11.3], [15.3, 11.3], [15.3, -11.3]].forEach(([x, z]) => { B.cyl(x, 0, z, 0.3, 0.7, pot); B.sphere(x, 1.2, z, 0.6, leaf); });
    [[-11, -6], [-11, 6], [0, -6], [0, 6], [11, -6], [11, 6]].forEach(([x, z]) => B.point(x, 4.5, z, 0xfff4e0, 5, 12));
  },
};

export const MAP_LIST = Object.entries(MAPS).map(([k, v]) => ({ key: k, name: v.name }));

// ---------------------------------------------------------------------
// Load / unload + navigation derivation
// ---------------------------------------------------------------------
let current = null;
export function unloadMap() {
  if (!current) return;
  scene.remove(current.group);
  current.statues.forEach(s => s.dispose());
  current = null;
}
export function loadMap(key) {
  unloadMap();
  const def = MAPS[key];
  const B = new Builder(def);
  def.build(B);
  scene.add(B.group);
  scene.background = B.bg; scene.fog = B.fog;
  Physics.setBoxes(B.boxes);
  B.group.updateMatrixWorld(true);
  const map = {
    key, name: def.name, def, group: B.group, boxes: B.boxes, rayMeshes: B.rayMeshes, statues: B.statues,
    room: B.room, doors: B.doors, bounds: def.bounds, hiderSpawn: def.hiderSpawn,
  };
  buildNav(map);
  current = map;
  return map;
}

export function inRoom(map, x, z, pad = 0) { const r = map.room; return x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad; }

function buildNav(map) {
  const [bx0, bz0, bx1, bz1] = map.bounds, r = map.room;
  const pts = [];
  const add = (x, z) => {
    if (!Physics.clear(x, z, 0.42, 0.3, 1.6, true)) return;
    if (Physics.groundAt(x, z, 0.3, 1.0) > 0.3) return;
    pts.push({ x, z, room: inRoom(map, x, z), n: [] });
  };
  const S = 1.6;
  for (let x = bx0 + 0.8; x < bx1; x += S) for (let z = bz0 + 0.8; z < bz1; z += S) add(x, z);
  for (let x = r.x0 + 0.8; x < r.x1 - 0.5; x += S) for (let z = r.z0 + 0.8; z < r.z1 - 0.5; z += S) add(x, z);
  // door threshold waypoints so the room connects to the map
  const [ix, iz] = r.inward;
  for (const k of [-1.2, -0.5, 0.5, 1.2]) {
    const bx = ix ? (ix > 0 ? r.x0 : r.x1) : r.cx, bz = iz ? (iz > 0 ? r.z0 : r.z1) : r.cz;
    add(bx - ix * k * 1, bz - iz * k * 1);
  }
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const a = pts[i], b = pts[j], d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d > S * 1.5) continue;
    if (Physics.segBlocked(a.x, a.z, b.x, b.z, 0.3, 0.3, 1.6, true)) continue;
    a.n.push(j); b.n.push(i);
  }
  map.nav = pts;
  // hide spots: walls/props behind, prefer corners
  const spots = [];
  const dirs = 16;
  for (const p of pts) {
    if (p.room) continue;
    for (let k = 0; k < dirs; k++) {
      const a = (k / dirs) * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a), L = 5;
      const t = Physics.segHit(p.x, p.z, p.x + dx * L, p.z + dz * L, 0, 0.4, 1.5, true, 0.7);
      if (t < 0) continue;
      const hx = p.x + dx * L * t, hz = p.z + dz * L * t;
      const sx = hx - dx * 0.4, sz = hz - dz * 0.4;
      if (!Physics.clear(sx, sz, 0.32, 0.3, 1.6, true) || inRoom(map, sx, sz, 0.8)) continue;
      if (Physics.groundAt(sx, sz, 0.3, 1.0) > 0.3) continue;
      let corner = 0;
      for (const s of [-1, 1]) { const px = dz * s, pz = -dx * s; if (Physics.segHit(sx, sz, sx + px * 1.1, sz + pz * 1.1, 0, 0.4, 1.5, true, 0.7) >= 0) corner++; }
      if (spots.some(o => Math.hypot(o.x - sx, o.z - sz) < 1.1)) continue;
      spots.push({ x: sx, z: sz, yaw: Math.atan2(-dx, -dz), corner, wall: [dx, dz] });
    }
  }
  map.spots = spots;
}

export function nearestNav(map, x, z, needLOS = true) {
  let best = -1, bd = 1e9;
  for (let i = 0; i < map.nav.length; i++) {
    const p = map.nav[i], d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd && (!needLOS || d < 1 || !Physics.segBlocked(x, z, p.x, p.z, 0.2, 0.3, 1.6, false))) { bd = d; best = i; }
  }
  return best;
}
// BFS path of nav points from (x,z) to target (tx,tz)
export function findPath(map, x, z, tx, tz) {
  const s = nearestNav(map, x, z), g = nearestNav(map, tx, tz, true);
  if (s < 0 || g < 0) return [{ x: tx, z: tz }];
  const prev = new Int32Array(map.nav.length).fill(-2); prev[s] = -1;
  const q = [s];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]; if (c === g) break;
    for (const n of map.nav[c].n) if (prev[n] === -2) { prev[n] = c; q.push(n); }
  }
  if (prev[g] === -2) return [{ x: tx, z: tz }];
  const path = []; for (let c = g; c !== -1; c = prev[c]) path.push({ x: map.nav[c].x, z: map.nav[c].z });
  path.reverse(); path.push({ x: tx, z: tz });
  return path;
}
export function openDoors(map) {
  for (const d of map.doors) { d.userData.box.off = true; d.userData.opening = true; }
}
export function updateMap(map, dt) {
  for (const d of map.doors) if (d.userData.opening && d.position.y < 3.6) d.position.y += dt * 3;
}
