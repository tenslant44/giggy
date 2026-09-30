// =====================================================================
// Physics module — axis-aligned box colliders, a capsule-ish character
// mover (step-up, gravity, ceilings) and 2D line-of-sight tests used by
// navigation and bot vision.
// =====================================================================
export const GRAVITY = 22;
const STEP = 0.36;

export const Physics = {
  boxes: [],
  setBoxes(b) { this.boxes = b; },

  // body: { pos:Vector3, vel:Vector3, radius, height, grounded }
  move(body, dt) {
    const p = body.pos, r = body.radius;
    // horizontal, per axis
    p.x += body.vel.x * dt; this.resolve(body, 'x');
    p.z += body.vel.z * dt; this.resolve(body, 'z');
    // vertical
    const prevY = p.y;
    body.vel.y -= GRAVITY * dt;
    p.y += body.vel.y * dt;
    let ground = 0;
    for (const b of this.boxes) {
      if (b.off) continue;
      if (b.maxY > prevY + STEP + 0.01) continue;
      if (!circleRect(p.x, p.z, r * 0.8, b)) continue;
      if (b.maxY > ground) ground = b.maxY;
    }
    if (p.y <= ground) {
      if (!body.grounded && body.vel.y < -6) body.landed = true;
      p.y = ground; body.vel.y = 0; body.grounded = true;
    } else {
      // snap down small steps when walking (stairs)
      if (body.grounded && p.y - ground < STEP && body.vel.y <= 0) { p.y = ground; body.vel.y = 0; }
      else body.grounded = false;
    }
    // ceilings
    if (body.vel.y > 0) {
      for (const b of this.boxes) {
        if (b.off) continue;
        if (b.minY < prevY + body.height - 0.05) continue;
        if (p.y + body.height > b.minY && circleRect(p.x, p.z, r * 0.8, b)) { p.y = b.minY - body.height; body.vel.y = 0; }
      }
    }
  },
  resolve(body, axis) {
    const p = body.pos, r = body.radius;
    for (const b of this.boxes) {
      if (b.off) continue;
      if (b.maxY <= p.y + STEP || b.minY >= p.y + body.height) continue;
      const cx = Math.max(b.minX, Math.min(p.x, b.maxX)), cz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2), push = r - d;
        p.x += (dx / d) * push; p.z += (dz / d) * push;
      } else {
        // centre inside box: push out along the requested axis
        if (axis === 'x') { const l = p.x - b.minX, rr = b.maxX - p.x; p.x = l < rr ? b.minX - r : b.maxX + r; }
        else { const l = p.z - b.minZ, rr = b.maxZ - p.z; p.z = l < rr ? b.minZ - r : b.maxZ + r; }
      }
    }
  },
  // Is the circle at (x,z) free of wall-height boxes?
  clear(x, z, r, y0 = 0.3, y1 = 1.6, ignoreDoors = false) {
    for (const b of this.boxes) {
      if (b.off && !(ignoreDoors && b.door)) continue;
      if (ignoreDoors && b.door) continue;
      if (b.maxY <= y0 || b.minY >= y1) continue;
      if (circleRect(x, z, r, b)) return false;
    }
    return true;
  },
  groundAt(x, z, r = 0.2, maxY = 99) {
    let g = 0;
    for (const b of this.boxes) if (!b.off && b.maxY <= maxY && circleRect(x, z, r, b) && b.maxY > g) g = b.maxY;
    return g;
  },
  // 2D segment vs expanded boxes. Returns hit distance fraction or -1.
  segHit(ax, az, bx, bz, pad = 0, y0 = 0.4, y1 = 1.5, ignoreDoors = false, minTop = 0) {
    let best = -1;
    const dx = bx - ax, dz = bz - az;
    for (const b of this.boxes) {
      if (b.off && !(ignoreDoors && b.door)) continue;
      if (ignoreDoors && b.door) continue;
      if (b.maxY <= y0 || b.minY >= y1 || b.maxY < minTop) continue;
      const t = slab(ax, az, dx, dz, b.minX - pad, b.maxX + pad, b.minZ - pad, b.maxZ + pad);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  },
  segBlocked(ax, az, bx, bz, pad = 0, y0, y1, ignoreDoors) { return this.segHit(ax, az, bx, bz, pad, y0, y1, ignoreDoors) >= 0; },
};

export function circleRect(x, z, r, b) {
  const cx = Math.max(b.minX, Math.min(x, b.maxX)), cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx, dz = z - cz; return dx * dx + dz * dz < r * r;
}
function slab(ax, az, dx, dz, x0, x1, z0, z1) {
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) { if (ax < x0 || ax > x1) return -1; }
  else { let t1 = (x0 - ax) / dx, t2 = (x1 - ax) / dx; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
  if (Math.abs(dz) < 1e-9) { if (az < z0 || az > z1) return -1; }
  else { let t1 = (z0 - az) / dz, t2 = (z1 - az) / dz; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
  return tmin;
}
