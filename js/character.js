// =====================================================================
// Character module — the plain white blobby biped.
//
// Every body part is a LatheGeometry built from a smooth "capsule with
// bumps" profile, which gives a perfect rectangular UV island per part.
// All 10 islands are shelf-packed into one 1024x1024 atlas, so each
// character owns ONE paintable DataTexture.
//
// Because the lathe mapping is analytic we can compute, for every texel,
// its exact part-local position & normal and its rest-pose ("bind")
// position. That table powers seamless 3D-space painting (brush dabs
// operate on bind-space spheres, so strokes flow across UV seams), the
// symmetry tool (mirror bind X), per-part fills and the bot projector.
// =====================================================================
import * as THREE from 'three';
import { damp, lerp } from './state.js';

export const TEX = 1024;
export const NTEX = TEX * TEX;
const PAD = 3;
const SEG = 40, PTS = 30;

// ---------- part definitions (metres at 1x scale) ----------
// joint: pivot the mesh hangs from; off: y offset of the profile bottom
// bumps: [yFromBottom, amplitude (multiplicative), width]
// shape: optional [[y, radius], ...] control points (smoothly interpolated)
// sz: depth (z) squash, e.g. a flatter torso
const HEAD_SHAPE = [[0, 0], [0.004, 0.045], [0.03, 0.058], [0.09, 0.062], [0.13, 0.09], [0.17, 0.128], [0.23, 0.147], [0.3, 0.145], [0.36, 0.118], [0.405, 0.07], [0.43, 0]];
const TORSO_SHAPE = [[0, 0], [0.02, 0.1], [0.06, 0.15], [0.14, 0.168], [0.35, 0.165], [0.52, 0.168], [0.6, 0.15], [0.645, 0.1], [0.665, 0]];
const PART_DEFS = [
  { name: 'torso', joint: 'spine', shape: TORSO_SHAPE, sz: 0.72, off: -0.1, bumps: [] },
  { name: 'head', joint: 'neck', shape: HEAD_SHAPE, off: -0.06, bumps: [] },
  { name: 'uArmL', joint: 'shL', L: 0.37, r0: 0.066, r1: 0.07, off: -0.31, bumps: [] },
  { name: 'uArmR', joint: 'shR', L: 0.37, r0: 0.066, r1: 0.07, off: -0.31, bumps: [] },
  { name: 'lArmL', joint: 'elL', L: 0.4, r0: 0.064, r1: 0.066, off: -0.35, bumps: [] },
  { name: 'lArmR', joint: 'elR', L: 0.4, r0: 0.064, r1: 0.066, off: -0.35, bumps: [] },
  { name: 'uLegL', joint: 'hipL', L: 0.4, r0: 0.08, r1: 0.084, off: -0.33, bumps: [] },
  { name: 'uLegR', joint: 'hipR', L: 0.4, r0: 0.08, r1: 0.084, off: -0.33, bumps: [] },
  { name: 'lLegL', joint: 'knL', L: 0.4, r0: 0.08, r1: 0.08, off: -0.35, bumps: [] },
  { name: 'lLegR', joint: 'knR', L: 0.4, r0: 0.08, r1: 0.08, off: -0.35, bumps: [] },
];
export const PART_NAMES = PART_DEFS.map(p => p.name);
export const HIP_Y = 0.66;
export const JOINTS = ['hips', 'spine', 'neck', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'hipR', 'knR'];

// Build the joint hierarchy (Object3D pivots) in rest pose.
function buildJoints(root) {
  const J = {};
  const mk = (name, parent, x, y, z) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); parent.add(o); J[name] = o; return o; };
  const hips = mk('hips', root, 0, HIP_Y, 0);
  const spine = mk('spine', hips, 0, 0, 0);
  mk('neck', spine, 0, 0.52, 0);
  const shL = mk('shL', spine, 0.2, 0.45, 0); mk('elL', shL, 0, -0.29, 0);
  const shR = mk('shR', spine, -0.2, 0.45, 0); mk('elR', shR, 0, -0.29, 0);
  const hipL = mk('hipL', hips, 0.082, 0, 0); mk('knL', hipL, 0, -0.31, 0);
  const hipR = mk('hipR', hips, -0.082, 0, 0); mk('knR', hipR, 0, -0.31, 0);
  return J;
}

// ---------- profile ----------
function buildProfile(d) {
  const { L, r0, r1, bumps } = d;
  const dense = [];
  const C = 20;
  if (d.shape) {
    // smooth (cosine-eased) interpolation through control points
    const S = d.shape;
    for (let i = 0; i < S.length - 1; i++) for (let k = 0; k < 12; k++) {
      const t = k / 12, e = (1 - Math.cos(t * Math.PI)) / 2;
      dense.push([lerp(S[i][1], S[i + 1][1], e), lerp(S[i][0], S[i + 1][0], t)]);
    }
    dense.push([0, S[S.length - 1][0]]);
    // light smoothing pass
    for (let it = 0; it < 3; it++) for (let i = 1; i < dense.length - 1; i++) dense[i][0] = (dense[i - 1][0] + dense[i][0] * 2 + dense[i + 1][0]) / 4;
  } else {
    for (let i = 0; i <= C; i++) { const a = -Math.PI / 2 + (i / C) * Math.PI / 2; dense.push([Math.cos(a) * r0, r0 + Math.sin(a) * r0]); }
    for (let i = 1; i < C; i++) { const t = i / C; dense.push([lerp(r0, r1, t), lerp(r0, L - r1, t)]); }
    for (let i = 0; i <= C; i++) { const a = (i / C) * Math.PI / 2; dense.push([Math.cos(a) * r1, L - r1 + Math.sin(a) * r1]); }
  }
  for (const p of dense) { let m = 1; for (const [y, a, w] of bumps) m += a * Math.exp(-(((p[1] - y) / w) ** 2)); p[0] *= m; }
  dense[0][0] = 0; dense[dense.length - 1][0] = 0;
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const total = cum[cum.length - 1];
  const pts = []; let k = 0;
  for (let j = 0; j < PTS; j++) {
    const target = (j / (PTS - 1)) * total;
    while (k < cum.length - 2 && cum[k + 1] < target) k++;
    const t = (target - cum[k]) / Math.max(1e-9, cum[k + 1] - cum[k]);
    pts.push(new THREE.Vector2(lerp(dense[k][0], dense[k + 1][0], t), lerp(dense[k][1], dense[k + 1][1], t)));
  }
  pts[0].x = 0; pts[PTS - 1].x = 0;
  let rmax = 0; pts.forEach(p => (rmax = Math.max(rmax, p.x)));
  // per-point normals, same convention as LatheGeometry: (dy, -dx) averaged
  const nrm = [];
  for (let j = 0; j < PTS; j++) {
    const a = pts[Math.max(0, j - 1)], b = pts[Math.min(PTS - 1, j + 1)];
    let nx = b.y - a.y, ny = -(b.x - a.x); const l = Math.hypot(nx, ny) || 1;
    nrm.push([nx / l, ny / l]);
  }
  return { pts, nrm, arc: total, circ: Math.PI * 2 * rmax };
}

// ---------- atlas packing ----------
function packAtlas(parts) {
  let lo = 50, hi = 3000, best = null;
  for (let it = 0; it < 30; it++) {
    const s = (lo + hi) / 2;
    const rects = tryPack(parts, s);
    if (rects) { best = rects; lo = s; } else hi = s;
  }
  return best;
}
function tryPack(parts, s) {
  const items = parts.map((p, i) => ({ i, w: Math.ceil(p.prof.circ * s), h: Math.ceil(p.prof.arc * s) }));
  items.sort((a, b) => b.h - a.h);
  const rects = [];
  let x = PAD, y = PAD, rowH = 0;
  for (const it of items) {
    if (x + it.w + PAD > TEX) { x = PAD; y += rowH + PAD * 2; rowH = 0; }
    if (it.w + PAD * 2 > TEX || y + it.h + PAD > TEX) return null;
    rects[it.i] = { x, y, w: it.w, h: it.h };
    x += it.w + PAD * 2; rowH = Math.max(rowH, it.h);
  }
  return rects;
}

// ---------- shared rig data (built once) ----------
export const Rig = {
  parts: [], geoms: [],
  texPart: new Int8Array(NTEX).fill(-1),
  texLocal: new Float32Array(NTEX * 3),
  texNormal: new Float32Array(NTEX * 3),
  texBind: new Float32Array(NTEX * 3),
  used: null, partTexels: [],
  grid: null,
};

function buildRig() {
  const parts = PART_DEFS.map((d, i) => ({ ...d, id: i, prof: buildProfile(d) }));
  const rects = packAtlas(parts);
  parts.forEach((p, i) => (p.rect = rects[i]));
  Rig.parts = parts;

  // geometries with UVs remapped into the atlas
  for (const p of parts) {
    const g = new THREE.LatheGeometry(p.prof.pts, SEG);
    g.translate(0, p.off, 0);
    if (p.sz) g.scale(1, 1, p.sz);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.rect.x + uv.getX(i) * p.rect.w) / TEX, (p.rect.y + uv.getY(i) * p.rect.h) / TEX);
    g.computeBoundingSphere();
    Rig.geoms.push(g);
  }

  // bind matrices from a rest-pose rig
  const root = new THREE.Object3D();
  const J = buildJoints(root);
  const holders = parts.map(p => { const o = new THREE.Object3D(); J[p.joint].add(o); return o; });
  root.updateMatrixWorld(true);
  const bindM = holders.map(h => h.matrixWorld.clone());

  const used = [];
  const v = new THREE.Vector3();
  for (const p of parts) {
    const { x: rx, y: ry, w: rw, h: rh } = p.rect;
    const list = [];
    const { pts, nrm } = p.prof;
    for (let py = ry - PAD; py < ry + rh + PAD; py++) {
      if (py < 0 || py >= TEX) continue;
      const vv = Math.min(1, Math.max(0, (py + 0.5 - ry) / rh));
      const f = vv * (PTS - 1), j = Math.min(PTS - 2, Math.floor(f)), t = f - j;
      const px_ = lerp(pts[j].x, pts[j + 1].x, t), py_ = lerp(pts[j].y, pts[j + 1].y, t) + p.off;
      let nx = lerp(nrm[j][0], nrm[j + 1][0], t), ny = lerp(nrm[j][1], nrm[j + 1][1], t);
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      for (let px = rx - PAD; px < rx + rw + PAD; px++) {
        if (px < 0 || px >= TEX) continue;
        let u = (px + 0.5 - rx) / rw; u -= Math.floor(u);
        const phi = u * Math.PI * 2, s = Math.sin(phi), c = Math.cos(phi);
        const idx = py * TEX + px;
        if (Rig.texPart[idx] !== -1) continue;
        Rig.texPart[idx] = p.id;
        const i3 = idx * 3;
        const sz = p.sz || 1;
        Rig.texLocal[i3] = px_ * s; Rig.texLocal[i3 + 1] = py_; Rig.texLocal[i3 + 2] = px_ * c * sz;
        { const ax = nx * s, ay = ny, az = (nx * c) / sz, al = Math.hypot(ax, ay, az) || 1;
          Rig.texNormal[i3] = ax / al; Rig.texNormal[i3 + 1] = ay / al; Rig.texNormal[i3 + 2] = az / al; }
        v.set(Rig.texLocal[i3], py_, Rig.texLocal[i3 + 2]).applyMatrix4(bindM[p.id]);
        Rig.texBind[i3] = v.x; Rig.texBind[i3 + 1] = v.y; Rig.texBind[i3 + 2] = v.z;
        used.push(idx); list.push(idx);
      }
    }
    Rig.partTexels[p.id] = Uint32Array.from(list);
  }
  Rig.used = Uint32Array.from(used);
  buildGrid();
}

// Uniform spatial hash over bind positions for fast brush dabs.
function buildGrid() {
  const cs = 0.03, min = [-1.1, -0.2, -0.6], dims = [Math.ceil(2.2 / cs), Math.ceil(2.0 / cs), Math.ceil(1.2 / cs)];
  const ncell = dims[0] * dims[1] * dims[2];
  const count = new Int32Array(ncell + 1);
  const cellOf = new Int32Array(Rig.used.length);
  const B = Rig.texBind;
  const cell = (x, y, z) => {
    const cx = Math.min(dims[0] - 1, Math.max(0, Math.floor((x - min[0]) / cs)));
    const cy = Math.min(dims[1] - 1, Math.max(0, Math.floor((y - min[1]) / cs)));
    const cz = Math.min(dims[2] - 1, Math.max(0, Math.floor((z - min[2]) / cs)));
    return (cz * dims[1] + cy) * dims[0] + cx;
  };
  for (let k = 0; k < Rig.used.length; k++) { const i3 = Rig.used[k] * 3; const c = cell(B[i3], B[i3 + 1], B[i3 + 2]); cellOf[k] = c; count[c + 1]++; }
  for (let c = 0; c < ncell; c++) count[c + 1] += count[c];
  const start = count.slice();
  const items = new Uint32Array(Rig.used.length);
  const fill = start.slice();
  for (let k = 0; k < Rig.used.length; k++) items[fill[cellOf[k]]++] = Rig.used[k];
  Rig.grid = { cs, min, dims, start, items };
}

// ---------- poses ----------
// Joint rotations [x,y,z] in radians; y = hips height offset.
export const POSES = [
  { id: 'stand', name: 'Stand', y: 0, j: { shL: [0, 0, 0.14], shR: [0, 0, -0.14] } },
  { id: 'tpose', name: 'T-Pose', y: 0, j: { shL: [0, 0, 1.57], shR: [0, 0, -1.57] } },
  { id: 'crouch', name: 'Crouch', y: -0.3, j: { hips: [0, 0, 0], spine: [0.55, 0, 0], neck: [-0.35, 0, 0], hipL: [-1.25, 0, 0.18], knL: [2.05, 0, 0], hipR: [-1.25, 0, -0.18], knR: [2.05, 0, 0], shL: [-0.9, 0, 0.15], elL: [-0.7, 0, 0], shR: [-0.9, 0, -0.15], elR: [-0.7, 0, 0] } },
  { id: 'curl', name: 'Curl Up', y: -0.47, j: { spine: [1.05, 0, 0], neck: [0.5, 0, 0], hipL: [-1.9, 0, 0.22], knL: [2.6, 0, 0], hipR: [-1.9, 0, -0.22], knR: [2.6, 0, 0], shL: [-1.35, 0, 0.35], elL: [-1.3, 0, 0], shR: [-1.35, 0, -0.35], elR: [-1.3, 0, 0] } },
  { id: 'lie', name: 'Lie Down', y: -0.55, j: { hips: [-1.57, 0, 0], shL: [0, 0, 0.15], shR: [0, 0, -0.15], hipL: [0, 0, 0.06], hipR: [0, 0, -0.06], neck: [0.15, 0, 0] } },
  { id: 'wall', name: 'Wall-Flat', y: -0.02, j: { spine: [-0.08, 0, 0], neck: [-0.1, 0, 0], shL: [0.12, 0, 0.7], elL: [0, 0, -0.35], shR: [0.12, 0, -0.7], elR: [0, 0, 0.35], hipL: [0, 0, 0.14], hipR: [0, 0, -0.14] } },
  { id: 'sit', name: 'Sit', y: -0.55, j: { spine: [-0.15, 0, 0], hipL: [-1.45, 0, 0.12], knL: [0.25, 0, 0], hipR: [-1.45, 0, -0.12], knR: [0.25, 0, 0], shL: [0.45, 0, 0.35], shR: [0.45, 0, -0.35] } },
  { id: 'head', name: 'Hands on Head', y: 0, j: { shL: [0, 0, 2.35], elL: [0, 0, 1.9], shR: [0, 0, -2.35], elR: [0, 0, -1.9], neck: [0.05, 0, 0] } },
  { id: 'spread', name: 'Spread', y: -0.04, j: { shL: [0, 0, 2.05], shR: [0, 0, -2.05], hipL: [0, 0, 0.38], hipR: [0, 0, -0.38], elL: [0, 0, 0.1], elR: [0, 0, -0.1] } },
  { id: 'statue', name: 'Statue', y: 0, j: { spine: [0, 0.3, 0.05], neck: [-0.25, -0.4, 0], shL: [0, 0, 2.85], elL: [0, 0, 0.1], shR: [-0.55, 0, -0.3], elR: [-1.9, 0, 0], hipL: [-0.55, 0, 0.05], knL: [0.95, 0, 0], hipR: [0.1, 0, -0.08] } },
];
export const POSE_MAP = Object.fromEntries(POSES.map(p => [p.id, p]));

// ---------- shared seeker accessories ----------
let capGeo, visorGeo, capMat, whiteTex;
function accessories() {
  if (capGeo) return;
  capGeo = new THREE.SphereGeometry(0.155, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  visorGeo = new THREE.BoxGeometry(0.2, 0.02, 0.13);
  capMat = new THREE.MeshStandardMaterial({ color: 0xff2d6f, roughness: 0.6 });
  const d = new Uint8Array(4 * 4).fill(255);
  whiteTex = new THREE.DataTexture(d, 2, 2); whiteTex.colorSpace = THREE.SRGBColorSpace; whiteTex.needsUpdate = true;
}
export function getWhiteTex() { accessories(); return whiteTex; }

const allChars = new Set();

// =====================================================================
export class Character {
  // material: optional shared material -> non-paintable body (statues, suits of armour)
  constructor({ scale = 1, name = '', material = null } = {}) {
    if (!Rig.used) buildRig();
    accessories();
    this.root = new THREE.Group();
    this.joints = buildJoints(this.root);
    this.paintable = !material;
    if (material) { this.data = null; this.texture = null; this.material = material; }
    else {
      this.data = new Uint8Array(NTEX * 4).fill(255);
      this.texture = new THREE.DataTexture(this.data, TEX, TEX, THREE.RGBAFormat);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.minFilter = THREE.LinearMipmapLinearFilter;
      this.texture.generateMipmaps = true;
      this.texture.anisotropy = 4;
      this.texture.needsUpdate = true;
      this.material = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.85, metalness: 0 });
    }
    this.meshes = Rig.parts.map((p, i) => {
      const m = new THREE.Mesh(Rig.geoms[i], this.material);
      m.castShadow = true; m.receiveShadow = true;
      m.userData.char = this; m.userData.part = i;
      this.joints[p.joint].add(m);
      return m;
    });
    // seeker cap
    this.cap = new THREE.Group();
    const cap = new THREE.Mesh(capGeo, capMat); cap.castShadow = true;
    const vis = new THREE.Mesh(visorGeo, capMat); vis.position.set(0, 0.005, 0.14);
    this.cap.add(cap, vis); this.cap.position.y = 0.21; this.cap.visible = false;
    this.joints.neck.add(this.cap);

    this.cur = {}; this.target = {};
    for (const j of JOINTS) { this.cur[j] = [0, 0, 0]; this.target[j] = [0, 0, 0]; }
    this.curY = 0;
    this.pose = 'stand';
    this.poseW = 1;
    this.locked = false;
    this.phase = 0; this.time = Math.random() * 10;
    this.dirty = false;
    this.name = name; this.tag = null;
    this.setScale(scale);
    this.snapPose();
    allChars.add(this);
  }
  setScale(s) { this.scale = s; this.root.scale.setScalar(s); this.radius = 0.26 * s; this.height = 1.6 * s; }
  setSeeker(on) { this.cap.visible = on; }
  setMaterialProps(metal, rough) { this.material.metalness = metal; this.material.roughness = rough; }
  markDirty() { this.dirty = true; }
  flush() { if (this.dirty && this.texture) { this.texture.needsUpdate = true; this.dirty = false; } }

  setPose(id) { if (POSE_MAP[id]) this.pose = id; }
  // Snap immediately to the current pose (used for clones & statues).
  snapPose() {
    const p = POSE_MAP[this.pose];
    for (const j of JOINTS) { const v = p.j[j] || [0, 0, 0]; this.cur[j] = [...v]; }
    this.curY = p.y; this.poseW = 1; this.apply();
  }

  // Procedural locomotion -> blends into the selected pose when still.
  update(dt, { speed = 0, grounded = true, vy = 0 } = {}) {
    this.time += dt;
    const moving = speed > 0.25 && !this.locked;
    this.poseW = damp(this.poseW, (moving || !grounded) && !this.locked ? 0 : 1, moving ? 10 : 4, dt);
    const T = this.target;
    for (const j of JOINTS) { T[j][0] = 0; T[j][1] = 0; T[j][2] = 0; }
    let ty = 0;
    // idle breathing
    const br = Math.sin(this.time * 2.2);
    T.spine[0] = br * 0.02; T.shL[2] = 0.14 + br * 0.03; T.shR[2] = -0.14 - br * 0.03; T.neck[0] = -br * 0.02;
    if (grounded && speed > 0.05) {
      const s = Math.min(1, speed / 6.5), stride = 0.35 + s * 0.55;
      this.phase += dt * (4 + speed * 1.55);
      const p = this.phase, sn = Math.sin(p);
      T.hipL[0] = -sn * stride; T.hipR[0] = sn * stride;
      T.knL[0] = Math.max(0, Math.sin(p - 1.4)) * (0.6 + s * 0.9) + 0.05;
      T.knR[0] = Math.max(0, Math.sin(p + Math.PI - 1.4)) * (0.6 + s * 0.9) + 0.05;
      T.shL[0] = sn * stride * 0.9; T.shR[0] = -sn * stride * 0.9;
      T.elL[0] = -0.3 - s * 0.9; T.elR[0] = -0.3 - s * 0.9;
      T.shL[2] = 0.18; T.shR[2] = -0.18;
      T.spine[0] = 0.06 + s * 0.2; T.spine[1] = -sn * 0.12 * s;
      T.hips[1] = sn * 0.1;
      ty = Math.abs(Math.cos(p)) * 0.05 * (0.5 + s) - 0.03 * s;
    } else if (!grounded) {
      const up = vy > 0 ? 1 : 0;
      T.hipL[0] = -0.7; T.knL[0] = 1.1; T.hipR[0] = -0.2 * up; T.knR[0] = 0.5;
      T.shL[2] = 1.0 + up * 0.8; T.shR[2] = -1.0 - up * 0.8; T.spine[0] = 0.1;
    }
    const P = POSE_MAP[this.pose], w = this.poseW;
    for (const j of JOINTS) {
      const pv = P.j[j];
      for (let k = 0; k < 3; k++) T[j][k] = lerp(T[j][k], pv ? pv[k] : (j === 'shL' && k === 2 ? 0.14 : j === 'shR' && k === 2 ? -0.14 : 0), w);
    }
    ty = lerp(ty, P.y, w);
    const rate = this.locked ? 9 : 16;
    for (const j of JOINTS) for (let k = 0; k < 3; k++) this.cur[j][k] = damp(this.cur[j][k], T[j][k], rate, dt);
    this.curY = damp(this.curY, ty, rate, dt);
    this.apply();
    if (this.tag) this.tag.position.y = (this.height + 0.35) / this.scale + Math.min(0, this.curY);
  }
  apply() {
    for (const j of JOINTS) { const c = this.cur[j]; this.joints[j].rotation.set(c[0], c[1], c[2]); }
    this.joints.hips.position.y = HIP_Y + this.curY;
  }

  // Current world-space top of the body (for camera/tag placement)
  headWorld(out) { return this.joints.neck.getWorldPosition(out).add(new THREE.Vector3(0, 0.2 * this.scale, 0)); }
  centerWorld(out) { return this.joints.spine.getWorldPosition(out).add(new THREE.Vector3(0, 0.25 * this.scale, 0)); }

  copyPaintFrom(o) { this.data.set(o.data); this.material.metalness = o.material.metalness; this.material.roughness = o.material.roughness; this.markDirty(); }

  // A detached, frozen copy of this body (decoy clones & statues).
  makeClone() {
    const c = new Character({ scale: this.scale });
    c.copyPaintFrom(this);
    c.pose = this.pose;
    for (const j of JOINTS) c.cur[j] = [...this.cur[j]];
    c.curY = this.curY; c.locked = true; c.apply();
    c.root.position.copy(this.root.position); c.root.rotation.copy(this.root.rotation);
    return c;
  }

  setNameTag(text, color = '#ffffff') {
    if (this.tag) { this.root.remove(this.tag); this.tag.material.map.dispose(); this.tag.material.dispose(); this.tag = null; }
    if (!text) return;
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = Math.min(250, g.measureText(text).width + 30);
    g.fillStyle = 'rgba(27,18,48,0.8)'; g.beginPath(); g.roundRect(128 - w / 2, 8, w, 48, 20); g.fill();
    g.fillStyle = color; g.fillText(text, 128, 33);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, transparent: true }));
    sp.scale.set(0.9 / this.scale, 0.225 / this.scale, 1);
    sp.position.y = (this.height + 0.35) / this.scale;
    sp.renderOrder = 5;
    this.tag = sp; this.root.add(sp);
  }
  showTag(on) { if (this.tag) this.tag.visible = on; }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    if (this.paintable) { this.texture.dispose(); this.material.dispose(); }
    this.setNameTag(null);
    allChars.delete(this);
  }
  static flushAll() { for (const c of allChars) c.flush(); }
}
