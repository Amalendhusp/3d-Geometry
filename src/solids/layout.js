import * as THREE from 'three';

// Flat layout of a shell's net pieces on the work surface.
//
// A piece is a hinge-connected group of panels (one tree of the hinge
// forest). Laying it flat poses its root panel in the surface plane with the
// outside face down and opens every hinge to its flat angle, so the panels of
// a piece are rigidly connected and coplanar. Pieces are then moved and
// turned as rigid wholes in that plane, which keeps every panel's size and
// every edge's identity.

const DOWN = new THREE.Vector3(0, -1, 0);
const FLAT_TOL = 1e-6; // 1 µm

// Is a piece already lying in the surface plane with its outside down?
export function pieceIsFlat(shell, piece, tol = FLAT_TOL) {
  for (const p of piece) {
    if (shell.worldNormal(p).y > -1 + 1e-9) return false;
    for (const v of shell.worldPoly(p)) if (Math.abs(v.y) > tol) return false;
  }
  return true;
}

// Points of a set of panels projected onto the surface (x, z).
function footprint(shell, panels) {
  const pts = [];
  for (const p of panels) for (const v of shell.worldPoly(p)) pts.push(new THREE.Vector2(v.x, v.z));
  return pts;
}

function box2(pts) {
  const b = new THREE.Box2();
  for (const p of pts) b.expandByPoint(p);
  return b;
}

// Turn about the vertical (radians) that gives a piece its smallest
// bounding rectangle: one of its edges then runs along an axis.
function bestYaw(pts, panels, shell) {
  const cands = new Set([0]);
  for (const p of panels) {
    const w = shell.worldPoly(p);
    for (let i = 0; i < w.length; i++) {
      const a = w[i], b = w[(i + 1) % w.length];
      let t = -Math.atan2(b.z - a.z, b.x - a.x);
      t = ((t % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
      cands.add(Math.round(t * 1e4) / 1e4);
    }
  }
  let best = 0, bestArea = Infinity, bestWide = false;
  for (const t of cands) {
    const c = Math.cos(t), s = Math.sin(t);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of pts) {
      // Same as Matrix4.makeRotationY(t) applied to (x, 0, z).
      const x = p.x * c + p.y * s, z = -p.x * s + p.y * c;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const area = (x1 - x0) * (z1 - z0);
    const wide = x1 - x0 >= z1 - z0;
    if (area < bestArea - 1e-12 || (Math.abs(area - bestArea) < 1e-12 && wide && !bestWide)) { bestArea = area; best = t; bestWide = wide; }
  }
  return best;
}

// Root matrices and hinge angles that lay every piece flat and arrange the
// pieces side by side. With keepFlat, pieces already lying flat stay where
// they are and the others are placed clear of them. The shell is left as it
// was; apply the result with shell.applyForest(F, angles, roots).
export function flatTargets(shell, { keepFlat = true, gap = shell.edgeLen * 0.3 } = {}) {
  const F = shell.forest();
  const angles = shell.flatAngles(F);
  const saved = shell.panels.map((p) => p.M.clone());
  const rootOf = shell.pieceRoots(F);
  const pieces = shell.hingePieces(F);
  const roots = new Map();
  const kept = [];
  const placed = [];
  for (const piece of pieces) {
    const r = rootOf.get(piece[0]);
    if (keepFlat && pieceIsFlat(shell, piece)) {
      roots.set(r, r.M.clone());
      kept.push(box2(footprint(shell, piece)));
      continue;
    }
    // Root panel into the surface plane, outside down.
    const q = new THREE.Quaternion().setFromUnitVectors(r.normal.clone().normalize(), DOWN);
    const h = r.verts[0].clone().applyQuaternion(q).y;
    const L = new THREE.Matrix4().makeTranslation(0, -h, 0).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
    shell.applyForest(F, angles, new Map([[r, L]]));
    const pts = footprint(shell, piece);
    const yaw = bestYaw(pts, piece, shell);
    const Ry = new THREE.Matrix4().makeRotationY(yaw);
    const rotated = pts.map((p) => { const v = new THREE.Vector3(p.x, 0, p.y).applyMatrix4(Ry); return new THREE.Vector2(v.x, v.z); });
    const b = box2(rotated);
    placed.push({ r, base: Ry.multiply(L), box: b, area: (b.max.x - b.min.x) * (b.max.y - b.min.y) });
  }
  shell.panels.forEach((p, i) => p.M.copy(saved[i]));

  // Shelf packing, tallest first.
  placed.sort((a, b) => (b.box.max.y - b.box.min.y) - (a.box.max.y - a.box.min.y));
  const total = placed.reduce((s, p) => s + p.area, 0);
  const widest = placed.reduce((m, p) => Math.max(m, p.box.max.x - p.box.min.x), 0);
  const rowW = Math.max(widest, Math.sqrt(total * 1.8));
  let x = 0, z = 0, rowH = 0;
  for (const p of placed) {
    const w = p.box.max.x - p.box.min.x, d = p.box.max.y - p.box.min.y;
    if (x > 0 && x + w > rowW + 1e-9) { x = 0; z += rowH + gap; rowH = 0; }
    p.slot = new THREE.Vector2(x, z);
    x += w + gap;
    rowH = Math.max(rowH, d);
  }
  // Centre the new pieces on the mat, or put them in front of kept ones.
  const packed = new THREE.Box2();
  for (const p of placed) {
    packed.expandByPoint(p.slot);
    packed.expandByPoint(new THREE.Vector2(p.slot.x + p.box.max.x - p.box.min.x, p.slot.y + p.box.max.y - p.box.min.y));
  }
  let off;
  if (kept.length && placed.length) {
    const k = kept.reduce((a, b) => a.union(b), new THREE.Box2());
    off = new THREE.Vector2(k.min.x, k.max.y + gap);
  } else {
    const c = packed.isEmpty() ? new THREE.Vector2() : packed.getCenter(new THREE.Vector2());
    off = c.negate();
  }
  for (const p of placed) {
    const T = new THREE.Matrix4().makeTranslation(p.slot.x - p.box.min.x + off.x, 0, p.slot.y - p.box.min.y + off.y);
    roots.set(p.r, T.multiply(p.base));
  }
  return { F, angles, roots, moved: placed.length, kept: kept.length };
}

// Centre of a set of panels on the surface.
export function pieceCentre(shell, panels) {
  const c = new THREE.Vector3();
  let n = 0;
  for (const p of panels) for (const v of shell.worldPoly(p)) { c.add(v); n++; }
  return n ? c.divideScalar(n) : c;
}

// Rigid move in the surface plane: turn by yaw about `centre`, then shift.
export function planarMove(dx, dz, yaw, centre) {
  return new THREE.Matrix4().makeTranslation(centre.x + dx, 0, centre.z + dz)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeTranslation(-centre.x, 0, -centre.z));
}

// A cut edge of the piece whose matching edge (same number) on another
// piece is close and nearly lined up: the move that makes them meet.
export function edgeSnap(shell, piece, maxDist = shell.edgeLen * 0.2, maxTurn = THREE.MathUtils.degToRad(40)) {
  const inPiece = new Set(piece);
  let best = null;
  for (const P of piece) {
    for (const e of P.edges) {
      if (!e.shared || e.locked || e.type === 'hinge') continue;
      const Q = shell.other(e, P);
      if (inPiece.has(Q)) continue;
      const aP = e.a.clone().applyMatrix4(P.M), bP = e.b.clone().applyMatrix4(P.M);
      const aQ = e.a.clone().applyMatrix4(Q.M), bQ = e.b.clone().applyMatrix4(Q.M);
      if ([aP, bP, aQ, bQ].some((v) => Math.abs(v.y) > 1e-5)) continue;
      let turn = Math.atan2(bQ.z - aQ.z, bQ.x - aQ.x) - Math.atan2(bP.z - aP.z, bP.x - aP.x);
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      if (Math.abs(turn) > maxTurn) continue;
      const mP = aP.clone().add(bP).multiplyScalar(0.5), mQ = aQ.clone().add(bQ).multiplyScalar(0.5);
      const d = mP.distanceTo(mQ);
      if (d > maxDist) continue;
      if (!best || d < best.d) best = { e, P, Q, d, turn, from: mP, to: mQ };
    }
  }
  if (!best) return null;
  // makeRotationY turns +x toward -z, the opposite sense to atan2(z, x).
  best.move = planarMove(best.to.x - best.from.x, best.to.z - best.from.z, -best.turn, best.from);
  return best;
}

// Where each piece's root panel lies on the surface now: the centre of
// its outline and the direction of its first side.
export function netPoses(shell) {
  const out = new Map();
  for (const r of shell.forest().roots) {
    const w = shell.worldPoly(r);
    const c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length);
    out.set(r.id, { c, ang: Math.atan2(w[1].z - w[0].z, w[1].x - w[0].x) });
  }
  return out;
}

// Lay every piece flat after the geometry changed, keeping each root
// panel where it was (same centre, same heading) so the net does not jump.
export function layFlatStable(shell, poses) {
  const F = shell.forest();
  const roots = new Map();
  for (const r of F.roots) {
    let M = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(r.normal.clone().normalize(), DOWN));
    const a = r.verts[0].clone().applyMatrix4(M), b = r.verts[1].clone().applyMatrix4(M);
    const p = poses && poses.get(r.id);
    if (p) M = new THREE.Matrix4().makeRotationY(Math.atan2(b.z - a.z, b.x - a.x) - p.ang).multiply(M);
    const c = r.verts.reduce((s, v) => s.add(v.clone().applyMatrix4(M)), new THREE.Vector3()).divideScalar(r.verts.length);
    const t = p ? p.c : new THREE.Vector3(c.x, 0, c.z);
    roots.set(r, new THREE.Matrix4().makeTranslation(t.x - c.x, -c.y, t.z - c.z).multiply(M));
  }
  shell.applyForest(F, shell.flatAngles(F), roots);
}
