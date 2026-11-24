import * as THREE from 'three';
import { template } from './polyhedra.js';

// Shape (2D) pieces: flat regular polygons that are placed on the work
// surface or attached to an edge of another piece, then folded by hand.
// Pieces lie outside-down, like every flat net here, so folding the flaps
// up closes a form with its printed side out.

export const SHAPES = [
  { key: 'tri', n: 3, name: 'Triangle' },
  { key: 'square', n: 4, name: 'Square' },
  { key: 'pent', n: 5, name: 'Pentagon' },
  { key: 'hex', n: 6, name: 'Hexagon' },
  { key: 'oct', n: 8, name: 'Octagon' },
  { key: 'dec', n: 10, name: 'Decagon' },
];

export const shapeByKey = (k) => SHAPES.find((s) => s.key === k) || SHAPES[1];
export const shapeName = (n) => (SHAPES.find((s) => s.n === n) || { name: `${n}-sided shape` }).name;

// A regular n-gon with side L lying flat at the height of `centre`, its
// outside facing down (corners counter-clockwise about -y).
export function regularPolygon(n, L, centre, yaw = 0) {
  const R = L / (2 * Math.sin(Math.PI / n));
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = yaw + (k + 0.5) * 2 * Math.PI / n;
    out.push(new THREE.Vector3(centre.x + R * Math.cos(a), centre.y, centre.z + R * Math.sin(a)));
  }
  return out;
}

// A regular n-gon that shares the edge a→b of a panel with outward normal
// `normal`, lying in that panel's plane on the far side of the edge, with
// the same outward side. Its first edge runs b→a; its side is |ab|.
export function attachedPolygon(n, a, b, normal) {
  const pts = [b.clone(), a.clone()];
  const dir = a.clone().sub(b);
  const q = new THREE.Quaternion().setFromAxisAngle(normal.clone().normalize(), 2 * Math.PI / n);
  for (let k = 2; k < n; k++) {
    dir.applyQuaternion(q);
    pts.push(pts[k - 1].clone().add(dir));
  }
  return pts;
}

// Rigid motion taking three points to three congruent points.
export function rigidFrom(src, dst) {
  const frame = (p) => {
    const u = p[1].clone().sub(p[0]).normalize();
    const w = new THREE.Vector3().crossVectors(u, p[2].clone().sub(p[0])).normalize();
    const v = new THREE.Vector3().crossVectors(w, u);
    return new THREE.Matrix4().makeBasis(u, v, w).setPosition(p[0]);
  };
  return frame(dst).multiply(frame(src).invert());
}

// Is a flat polygon convex (corners turning one way, none straight-back)?
export function convexIn(pts, n, minEdge = 0, minAngleDeg = 0) {
  const m = pts.length;
  if (m < 3) return false;
  for (let i = 0; i < m; i++) {
    const a = pts[(i + m - 1) % m], b = pts[i], c = pts[(i + 1) % m];
    const d1 = b.clone().sub(a), d2 = c.clone().sub(b);
    if (d2.length() < minEdge) return false;
    const turn = new THREE.Vector3().crossVectors(d1, d2).dot(n);
    if (turn <= 0) return false;
    const ang = Math.PI - d1.angleTo(d2);
    if (ang < THREE.MathUtils.degToRad(minAngleDeg)) return false;
  }
  return true;
}

// ------------------------------------------------------------- closing

// Can a hinge-connected group of panels close into one of the solids in
// `types`? The panels' hinge tree is matched face by face against each
// solid: the panel across a hinge must be the face across the matching
// solid edge, every face used once. Returns where each panel's corners go
// in the closed form (shell frame), with the root panel left where it is
// now, or the reason it does not close.
export function matchClosure(panels, types, worldPoly) {
  if (!panels.length) return { reason: 'There is nothing to fold.' };
  const set = new Set(panels);
  const links = new Map(panels.map((p) => [p, []]));
  let hinges = 0;
  for (const p of panels) {
    p.edges.forEach((e, i) => {
      if (e.type !== 'hinge' || !e.shared) return;
      const u = e.uses.find((x) => x.panel !== p);
      if (!u || !set.has(u.panel)) return;
      links.get(p).push({ i, Q: u.panel, j: u.i });
      hinges++;
    });
  }
  hinges /= 2;
  if (hinges !== panels.length - 1) {
    return { reason: hinges >= panels.length ? 'Its hinges form a closed loop, so it cannot fold as one net.' : 'Its panels are not all joined by hinges.' };
  }
  const len = (p, k) => p.verts[k].distanceTo(p.verts[(k + 1) % p.verts.length]);
  const L = len(panels[0], 0);
  const uniform = panels.every((p) => p.verts.every((_, k) => Math.abs(len(p, k) - L) < L * 1e-6));
  if (!uniform) return { reason: 'Its edges are not all the same length, and the solids it could close into have equal edges.' };
  const counts = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => a[0] - b[0]).map((x) => x.join('x')).join(','); };
  const mine = counts(panels.map((p) => p.verts.length));
  const R0 = panels[0];
  for (const type of types) {
    const T = template(type);
    if (T.faces.length !== panels.length || counts(T.faces.map((f) => f.sides)) !== mine) continue;
    const dir = new Map();
    T.faces.forEach((f, fi) => f.idx.forEach((v, k) => dir.set(`${v}>${f.idx[(k + 1) % f.idx.length]}`, { fi, k })));
    for (let fi = 0; fi < T.faces.length; fi++) {
      if (T.faces[fi].sides !== R0.verts.length) continue;
      for (let r = 0; r < R0.verts.length; r++) {
        const map = tryMap(R0, fi, r, T, dir, links, panels.length);
        if (!map) continue;
        // Corners in the closed form, scaled to the panels' edge.
        const closed = new Map();
        for (const [p, { fi: f, r: rot }] of map) {
          const face = T.faces[f], n = face.sides;
          closed.set(p, p.verts.map((_, k) => T.verts[face.idx[(rot + k) % n]].clone().multiplyScalar(L)));
        }
        // Keep the root panel where it is now; the form closes on its inside.
        const now = worldPoly(R0);
        const G = rigidFrom(closed.get(R0), now);
        for (const pts of closed.values()) for (const v of pts) v.applyMatrix4(G);
        return { type, closed, root: R0, edge: L };
      }
    }
  }
  return { reason: `${panels.length} faces (${describeCounts(panels)}) do not match the net of any solid I know how to close: cube, tetrahedron, octahedron or cuboctahedron.` };
}

function describeCounts(panels) {
  const m = new Map();
  for (const p of panels) m.set(p.verts.length, (m.get(p.verts.length) || 0) + 1);
  const names = { 3: 'triangle', 4: 'square', 5: 'pentagon', 6: 'hexagon', 8: 'octagon', 10: 'decagon' };
  return [...m].map(([n, c]) => `${c} ${names[n] || `${n}-gon`}${c === 1 ? '' : 's'}`).join(', ');
}

function tryMap(R0, fi0, r0, T, dir, links, count) {
  const map = new Map([[R0, { fi: fi0, r: r0 }]]);
  const used = new Set([fi0]);
  const queue = [R0];
  while (queue.length) {
    const P = queue.shift();
    const { fi, r } = map.get(P);
    const f = T.faces[fi], n = f.sides;
    for (const { i, Q, j } of links.get(P)) {
      const si = f.idx[(r + i) % n], si1 = f.idx[(r + i + 1) % n];
      const g = dir.get(`${si1}>${si}`);
      if (!g) return null;
      const m = T.faces[g.fi].sides;
      if (Q.verts.length !== m) return null;
      const rq = ((g.k - j) % m + m) % m;
      const have = map.get(Q);
      if (have) { if (have.fi !== g.fi || have.r !== rq) return null; continue; }
      if (used.has(g.fi)) return null;
      used.add(g.fi);
      map.set(Q, { fi: g.fi, r: rq });
      queue.push(Q);
    }
  }
  return map.size === count ? map : null;
}

// ------------------------------------------------------------- snapping

// Rotation about an axis (point A, unit direction U) that takes x to y, if
// one exists: x and y at the same height along the axis and distance from it.
export function angleAbout(A, U, x, y, tol) {
  const rx = x.clone().sub(A), ry = y.clone().sub(A);
  const hx = rx.dot(U), hy = ry.dot(U);
  if (Math.abs(hx - hy) > tol) return null;
  rx.addScaledVector(U, -hx); ry.addScaledVector(U, -hy);
  const lx = rx.length(), ly = ry.length();
  if (Math.abs(lx - ly) > tol) return null;
  if (lx < tol) return 0;
  return Math.atan2(new THREE.Vector3().crossVectors(rx, ry).dot(U), rx.dot(ry));
}
