import * as THREE from 'three';
import { Shell } from './shell.js';
import { polyNormal } from './composition.js';

// Free-form editing of the assembled form: move vertices and edges.
//
// The form is its closed shell: vertices (named by their unedited
// positions, so shared vertices move as one), and faces as loops of
// vertices. Pinned vertices never move. Moving vertices go where you drag
// them. By default every face with four or more corners stays planar: the
// other free vertices of those faces move as little as possible to keep
// them flat (they are the "neighbours that must move"). Triangles are
// always flat, so a tetrahedron edits freely. Every result is checked:
// no edge under 5 mm, no collapsed or folded face, no turning inside out,
// no faces passing through each other. When the full move is not
// possible, the move stops at the furthest valid point and says why.

export const MIN_EDGE = 0.005;
export const MIN_ANGLE = 3; // degrees
const PLANAR_TOL = 1e-6;

// Vertices, faces and edges of a closed shell (panel rest positions).
export function editModel(shell) {
  const pos = new Map(), base = new Map();
  for (const p of shell.panels) {
    p.vid.forEach((id, i) => {
      const k = shell.vkeys[id];
      if (!pos.has(k)) { pos.set(k, p.verts[i].clone()); base.set(k, shell.vbase[id].clone()); }
    });
  }
  const faces = shell.panels.map((p) => ({ id: p.id, keys: p.vid.map((id) => shell.vkeys[id]), planar: p.vid.length > 3, normal: p.normal.clone() }));
  const nbr = new Map([...pos.keys()].map((k) => [k, new Set()]));
  const edges = new Map();
  for (const f of faces) {
    for (let i = 0; i < f.keys.length; i++) {
      const a = f.keys[i], b = f.keys[(i + 1) % f.keys.length];
      nbr.get(a).add(b); nbr.get(b).add(a);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edges.has(k)) edges.set(k, [a, b]);
    }
  }
  return { pos, base, faces, nbr, edges: [...edges.values()] };
}

// Smallest-eigenvalue eigenvector of a symmetric 3x3 matrix (Jacobi).
function smallestEigen(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let j = 0;
  for (let k = 1; k < 3; k++) if (a[k][k] < a[j][j]) j = k;
  return new THREE.Vector3(v[0][j], v[1][j], v[2][j]).normalize();
}

// Weighted best-fit plane through points.
function fitPlane(pts, w) {
  let W = 0;
  const c = new THREE.Vector3();
  pts.forEach((p, i) => { c.addScaledVector(p, w[i]); W += w[i]; });
  c.divideScalar(W);
  const m = [0, 0, 0, 0, 0, 0];
  pts.forEach((p, i) => {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z, k = w[i];
    m[0] += k * x * x; m[1] += k * x * y; m[2] += k * x * z; m[3] += k * y * y; m[4] += k * y * z; m[5] += k * z * z;
  });
  return { c, n: smallestEigen(m) };
}

function planarDev(pts) {
  const { c, n } = fitPlane(pts, pts.map(() => 1));
  let d = 0;
  for (const p of pts) d = Math.max(d, Math.abs(p.clone().sub(c).dot(n)));
  return d;
}

// Positions with the moving vertices at their targets, pinned ones fixed,
// and the others moved as little as possible so that every face with four
// or more corners is planar. Returns the positions and the worst face.
export function solvePlanar(model, start, pins, targets, iters = 400) {
  const P = new Map([...start].map(([k, v]) => [k, v.clone()]));
  for (const [k, v] of targets) P.set(k, v.clone());
  const locked = (k) => pins.has(k) || targets.has(k);
  const quads = model.faces.filter((f) => f.planar);
  let worst = { dev: 0, face: null };
  for (let it = 0; it < iters && quads.length; it++) {
    const acc = new Map();
    let dev = 0;
    for (const f of quads) {
      const pts = f.keys.map((k) => P.get(k));
      const w = f.keys.map((k) => (locked(k) ? 1e4 : 1));
      const { c, n } = fitPlane(pts, w);
      f.keys.forEach((k, i) => {
        const d = pts[i].clone().sub(c).dot(n);
        if (Math.abs(d) > dev) dev = Math.abs(d);
        if (locked(k)) return;
        if (!acc.has(k)) acc.set(k, { v: new THREE.Vector3(), n: 0 });
        const a = acc.get(k);
        a.v.addScaledVector(n, -d); a.n++;
      });
    }
    if (dev < 1e-10) break;
    for (const [k, a] of acc) P.get(k).addScaledVector(a.v, 1 / a.n);
  }
  for (const f of quads) {
    const d = planarDev(f.keys.map((k) => P.get(k)));
    if (d > worst.dev) worst = { dev: d, face: f.id };
  }
  return { P, dev: worst.dev, face: worst.face };
}

function signedVolume(model, P) {
  let v = 0;
  for (const f of model.faces) {
    const a = P.get(f.keys[0]);
    for (let i = 1; i < f.keys.length - 1; i++) {
      const b = P.get(f.keys[i]), c = P.get(f.keys[i + 1]);
      v += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
    }
  }
  return v;
}

// Why a set of positions is not a valid form, or null.
export function checkForm(model, P) {
  for (const [a, b] of model.edges) if (P.get(a).distanceTo(P.get(b)) < MIN_EDGE) return 'an edge would get shorter than 5 mm';
  const polys = [];
  for (const f of model.faces) {
    const pts = f.keys.map((k) => P.get(k));
    const n = polyNormal(pts);
    let area = 0;
    const nn = pts.length;
    for (let i = 0; i < nn; i++) {
      const a = pts[(i + nn - 1) % nn], b = pts[i], c = pts[(i + 1) % nn];
      const u = a.clone().sub(b), w = c.clone().sub(b);
      const turn = new THREE.Vector3().crossVectors(w, u).dot(n);
      if (turn <= 0) return `face ${f.id} would fold in on itself`;
      const ang = THREE.MathUtils.radToDeg(u.angleTo(w));
      if (ang < MIN_ANGLE) return `a corner of face ${f.id} would close to ${ang.toFixed(1)}°`;
      area += turn / 2;
    }
    if (area < 1e-6) return `face ${f.id} would collapse`;
    if (f.planar && planarDev(pts) > PLANAR_TOL) return `face ${f.id} would bend out of plane`;
    polys.push({ verts: pts.map((p) => p.clone()), normal: n, M: new THREE.Matrix4() });
  }
  if (signedVolume(model, P) <= 1e-7) return 'the form would turn inside out';
  // Faces passing through each other (the shell's own test, on the closed form).
  let minEdge = Infinity;
  for (const [a, b] of model.edges) minEdge = Math.min(minEdge, P.get(a).distanceTo(P.get(b)));
  const fake = { panels: polys, edgeLen: minEdge, worldPoly: (p) => p.verts.map((v) => v.clone()), worldNormal: (p) => p.normal.clone() };
  if (Shell.prototype.overlaps.call(fake).pairs.length) return 'faces would pass through each other';
  return null;
}

// Move `moving` vertices by `delta` (pinned ones stay), keeping faces
// planar. Returns the positions reached, the fraction of the move done
// (1 = all of it) and, if less, why it stopped.
export function editTo(model, start, pins, moving, delta) {
  const attempt = (t) => {
    const targets = new Map(moving.map((k) => [k, start.get(k).clone().addScaledVector(delta, t)]));
    const s = solvePlanar(model, start, pins, targets);
    if (s.dev > PLANAR_TOL) return { ok: false, P: s.P, reason: `face ${s.face} would have to bend: its pinned corners hold it` };
    const why = checkForm(model, s.P);
    return { ok: !why, P: s.P, reason: why };
  };
  const full = attempt(1);
  if (full.ok) return { t: 1, P: full.P, reason: null };
  let lo = 0, hi = 1, best = null;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const r = attempt(mid);
    if (r.ok) { lo = mid; best = r; } else hi = mid;
  }
  return { t: lo, P: best ? best.P : new Map([...start].map(([k, v]) => [k, v.clone()])), reason: full.reason };
}

// Vertices (other than the moving ones) that moved, and edges whose length changed.
export function changes(model, start, P, moving, tol = 5e-4) {
  const moved = [...P.keys()].filter((k) => !moving.includes(k) && P.get(k).distanceTo(start.get(k)) > tol);
  const edges = model.edges.filter(([a, b]) => Math.abs(P.get(a).distanceTo(P.get(b)) - start.get(a).distanceTo(start.get(b))) > tol);
  return { moved, edges };
}

// Turn solved positions into the composition's edit map.
export function editsFrom(model, P) {
  const out = new Map();
  for (const [k, p] of P) if (p.distanceTo(model.base.get(k)) > 1e-9) out.set(k, p.clone());
  return out;
}
