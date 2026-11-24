import * as THREE from 'three';
import { template, templateMirror } from './polyhedra.js';

// A composition is a list of solids, each a template placed with a position,
// orientation and edge length (metres). Solids attach face to face; they may
// never overlap.

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

// Text key of a point (10 µm), naming a vertex of the unedited form.
const QK = 1e5;
export const vkey = (v) => `${Math.round(v.x * QK)},${Math.round(v.y * QK)},${Math.round(v.z * QK)}`;

// Outward normal of a polygon from its corner order (Newell's method).
export function polyNormal(verts) {
  const n = new THREE.Vector3();
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.normalize();
}

export class Solid {
  constructor(id, type, edge, position, quaternion) {
    this.id = id;
    this.type = type;
    this.edge = edge;
    this.position = position.clone();
    this.quaternion = quaternion.clone();
  }

  get template() { return template(this.type); }

  matrix(out = new THREE.Matrix4()) {
    return out.compose(this.position, this.quaternion, _s.setScalar(this.edge));
  }

  worldVerts() {
    const m = this.matrix(_m);
    return this.template.verts.map((v) => v.clone().applyMatrix4(m));
  }

  worldFaces() {
    const verts = this.worldVerts();
    return this.template.faces.map((f, fi) => {
      const vs = f.idx.map((i) => verts[i].clone());
      const normal = f.normal.clone().applyQuaternion(this.quaternion).normalize();
      const centroid = vs.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(vs.length);
      return { solid: this, fi, verts: vs, normal, centroid, sides: f.sides };
    });
  }

  toJSON() {
    return { id: this.id, type: this.type, edge: this.edge, p: this.position.toArray(), q: this.quaternion.toArray() };
  }
}

export class Composition {
  constructor() {
    this.solids = [];
    this.nextId = 1;
    // Shape change: a stretch of the whole composition along its own X, Y
    // and Z axes. The solids themselves stay regular (building works on
    // them); the stretch is applied to every vertex when the shell is made,
    // so shared vertices stay shared and joined faces stay joined.
    this.shape = new THREE.Vector3(1, 1, 1);
    // Free-form edits: new positions for vertices of the (stretched) form,
    // keyed by where each vertex was before editing, so a vertex shared by
    // several faces or solids moves as one. And faces split into triangles
    // on purpose: face id -> the dividing diagonals, each a pair of corner
    // indices ([i, j] for one diagonal, [[i, j], [k, l], …] for several).
    this.edits = new Map();
    this.tri = new Map();
    // Merged panels: groups of coplanar adjoining faces ("solid:face" ids)
    // that form one convex panel.
    this.merge = [];
    // Shape (2D) pieces: flat polygons placed on the work surface or
    // attached edge to edge. `verts` are where the corners are at rest (flat
    // while the net is being built; the closed form once it has closed).
    this.pieces = [];
    // Free edges glued together by folding (they snapped): pairs of
    // "panel id#edge index".
    this.seams = [];
  }

  isEmpty() { return !this.solids.length && !this.pieces.length; }

  addPiece(n, verts) {
    const pc = { id: this.nextId++, n, verts: verts.map((v) => v.clone()) };
    this.pieces.push(pc);
    return pc;
  }

  piece(id) { return this.pieces.find((p) => p.id === id) || null; }

  removePiece(id) {
    this.pieces = this.pieces.filter((p) => p.id !== id);
    this.seams = this.seams.filter(([a, b]) => !a.startsWith(`${id}:`) && !b.startsWith(`${id}:`));
  }

  // A piece as a face, in the same form as a solid's face.
  pieceFace(pc) {
    const verts = pc.verts.map((v) => v.clone());
    const normal = polyNormal(verts);
    const centroid = verts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(verts.length);
    return { solid: { id: pc.id, type: pc.kind || 'piece', piece: true }, fi: 0, verts, normal, centroid, sides: verts.length };
  }

  isEdited() { return this.edits.size > 0 || this.tri.size > 0 || this.merge.length > 0; }

  isShaped() { return Math.abs(this.shape.x - 1) > 1e-9 || Math.abs(this.shape.y - 1) > 1e-9 || Math.abs(this.shape.z - 1) > 1e-9; }

  shapeMatrix(shape = this.shape) { return new THREE.Matrix4().makeScale(shape.x, shape.y, shape.z); }

  // Faces of all solids after the shape change. A linear stretch keeps
  // every face planar and maps equal vertices to equal vertices.
  shapedFaces(shape = this.shape, edits = this.edits, tri = this.tri) {
    const faces = this.solids.flatMap((s) => s.worldFaces()).concat(this.pieces.map((pc) => this.pieceFace(pc)));
    if (!(Math.abs(shape.x - 1) < 1e-12 && Math.abs(shape.y - 1) < 1e-12 && Math.abs(shape.z - 1) < 1e-12)) {
      const S = this.shapeMatrix(shape);
      const N = new THREE.Matrix3().getNormalMatrix(S);
      for (const f of faces) {
        f.verts = f.verts.map((v) => v.applyMatrix4(S));
        f.centroid.applyMatrix4(S);
        f.normal.applyMatrix3(N).normalize();
      }
    }
    // `base` keeps each corner's unedited position: it names the vertex.
    for (const f of faces) f.base = f.verts.map((v) => v.clone());
    if (!edits.size && !tri.size && !this.merge.length) return faces;
    let out = [];
    for (const f of faces) {
      if (edits.size) f.verts = f.base.map((b) => { const e = edits.get(vkey(b)); return e ? e.clone() : b.clone(); });
      const d = tri.get(`${f.solid.id}:${f.fi}`);
      const loops = d && f.verts.length > 3 ? splitLoops(f.verts.length, diagonalsOf(d)) : null;
      if (loops) {
        loops.forEach((loop, sub) => out.push({ ...f, sub, pid: `${f.solid.id}:${f.fi}.${sub}`, verts: loop.map((k) => f.verts[k].clone()), base: loop.map((k) => f.base[k].clone()), sides: loop.length }));
      } else out.push(f);
    }
    if (this.merge.length) out = mergeFaces(out, this.merge);
    for (const f of out) {
      f.normal = polyNormal(f.verts);
      f.centroid = f.verts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(f.verts.length);
    }
    return out;
  }

  add(type, edge, position, quaternion = template(type).rest) {
    const s = new Solid(this.nextId++, type, edge, position, quaternion);
    this.solids.push(s);
    return s;
  }

  remove(id) { this.solids = this.solids.filter((s) => s.id !== id); }
  get(id) { return this.solids.find((s) => s.id === id) || null; }

  serialize() {
    const out = { nextId: this.nextId, solids: this.solids.map((s) => s.toJSON()) };
    if (this.isShaped()) out.shape = this.shape.toArray();
    if (this.edits.size) out.edits = [...this.edits].map(([k, v]) => [k, ...v.toArray().map((x) => Math.round(x * 1e9) / 1e9)]);
    if (this.tri.size) out.tri = [...this.tri].map(([k, d]) => (Array.isArray(d[0]) ? [k, d.map((x) => [x[0], x[1]])] : [k, d[0], d[1]]));
    if (this.merge.length) out.merge = this.merge.map((g) => g.slice());
    if (this.pieces.length) out.pieces = this.pieces.map((pc) => ({ id: pc.id, n: pc.n, ...(pc.kind ? { kind: pc.kind } : {}), ...(pc.origin != null ? { origin: pc.origin } : {}), v: pc.verts.flatMap((v) => v.toArray().map((x) => Math.round(x * 1e12) / 1e12)) }));
    if (this.seams.length) out.seams = this.seams.map((x) => x.slice());
    return out;
  }

  restore(data) {
    this.nextId = data.nextId;
    this.solids = data.solids.map((d) => new Solid(d.id, d.type, d.edge, new THREE.Vector3().fromArray(d.p), new THREE.Quaternion().fromArray(d.q)));
    this.shape.set(1, 1, 1);
    if (Array.isArray(data.shape) && data.shape.length === 3 && data.shape.every((v) => Number.isFinite(v) && v > 0)) this.shape.fromArray(data.shape);
    this.edits = new Map();
    if (Array.isArray(data.edits)) for (const [k, x, y, z] of data.edits) if (typeof k === 'string' && [x, y, z].every(Number.isFinite)) this.edits.set(k, new THREE.Vector3(x, y, z));
    this.tri = new Map();
    if (Array.isArray(data.tri)) {
      for (const [k, i, j] of data.tri) {
        if (typeof k !== 'string') continue;
        if (Number.isInteger(i) && Number.isInteger(j)) this.tri.set(k, [i, j]);
        else if (Array.isArray(i) && i.length && i.every((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isInteger))) this.tri.set(k, i.map((x) => [x[0], x[1]]));
      }
    }
    this.merge = Array.isArray(data.merge) ? data.merge.filter((g) => Array.isArray(g) && g.length >= 2 && g.every((x) => typeof x === 'string')).map((g) => g.slice()) : [];
    this.pieces = [];
    if (Array.isArray(data.pieces)) {
      for (const d of data.pieces) {
        if (!d || !Number.isInteger(d.id) || !Array.isArray(d.v) || d.v.length < 9 || d.v.length % 3 || !d.v.every(Number.isFinite)) continue;
        const verts = [];
        for (let i = 0; i < d.v.length; i += 3) verts.push(new THREE.Vector3(d.v[i], d.v[i + 1], d.v[i + 2]));
        const pc = { id: d.id, n: d.n || verts.length, verts };
        if (typeof d.kind === 'string') pc.kind = d.kind;
        if (Number.isInteger(d.origin)) pc.origin = d.origin;
        this.pieces.push(pc);
      }
    }
    this.seams = Array.isArray(data.seams) ? data.seams.filter((x) => Array.isArray(x) && x.length === 2 && x.every((k) => typeof k === 'string')).map((x) => x.slice()) : [];
  }

  // Lowest point of all solids (y).
  minY() {
    let y = Infinity;
    for (const s of this.solids) for (const v of s.worldVerts()) y = Math.min(y, v.y);
    for (const pc of this.pieces) for (const v of pc.verts) y = Math.min(y, v.y);
    return y;
  }

  // Shift everything so the composition rests on y = 0.
  settle() {
    if (this.isEmpty()) return;
    const dy = -this.minY();
    if (Math.abs(dy) < 1e-12) return;
    for (const s of this.solids) s.position.y += dy;
    for (const pc of this.pieces) for (const v of pc.verts) v.y += dy;
  }

  // Which existing solid (if any) a pose would overlap.
  overlapping(type, edge, position, quaternion, ignoreId = null) {
    const probe = new Solid(-1, type, edge, position, quaternion);
    for (const s of this.solids) {
      if (s.id === ignoreId) continue;
      if (convexOverlap(probe, s)) return s;
    }
    return null;
  }

  // Edges where two or more solids meet, and whether the solids around each
  // close a full turn (360°) or leave an open angle (a gap). Space need not
  // be filled: this only reports what the arrangement does.
  jointReport() {
    const tol = Math.min(...this.solids.map((s) => s.edge), 1) * 1e-5;
    const pts = [];
    const id = (v) => {
      for (let i = 0; i < pts.length; i++) if (pts[i].distanceTo(v) < tol) return i;
      pts.push(v.clone());
      return pts.length - 1;
    };
    const joints = new Map();
    for (const s of this.solids) {
      const faces = s.worldFaces();
      const seen = new Set();
      for (const f of faces) {
        for (let i = 0; i < f.verts.length; i++) {
          const a = id(f.verts[i]), b = id(f.verts[(i + 1) % f.verts.length]);
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // interior dihedral of this solid at the edge
          const pair = faces.filter((g) => [a, b].every((k) => g.verts.some((v) => v.distanceTo(pts[k]) < tol)));
          if (pair.length !== 2) continue;
          const dihedral = Math.PI - Math.acos(Math.max(-1, Math.min(1, pair[0].normal.dot(pair[1].normal))));
          if (!joints.has(key)) joints.set(key, []);
          joints.get(key).push({ solid: s.id, angle: dihedral });
        }
      }
    }
    // A remaining angle narrower than the sharpest dihedral of any solid
    // (the tetrahedron's 70.53°) is a gap that no solid can ever fill.
    const narrowest = 70.5288;
    let closed = 0;
    const gaps = new Map();
    let over = 0;
    for (const list of joints.values()) {
      if (list.length < 2) continue;
      const sum = list.reduce((t, j) => t + j.angle, 0) * 180 / Math.PI;
      const rest = 360 - sum;
      if (Math.abs(rest) < 0.05) closed++;
      else if (rest < 0) over++;
      else if (rest < narrowest - 0.05) { const g = Math.round(rest * 10) / 10; gaps.set(g, (gaps.get(g) || 0) + 1); }
    }
    return { closed, gaps: [...gaps].sort((x, y) => x[0] - y[0]).map(([angle, count]) => ({ angle, count })), over };
  }

  // Geometric check for a new pose: it must not overlap any solid, and any
  // face it presses against another face must match that face completely
  // (same shape, same vertices). Returns null, or { kind, solid, message }.
  placementProblem(type, edge, position, quaternion, ignoreId = null) {
    const over = this.overlapping(type, edge, position, quaternion, ignoreId);
    if (over) return { kind: 'overlap', solid: over, message: 'That would overlap another solid.' };
    const probe = new Solid(-1, type, edge, position, quaternion);
    const tol = edge * 1e-4;
    const pf = probe.worldFaces();
    for (const s of this.solids) {
      if (s.id === ignoreId) continue;
      for (const a of pf) {
        for (const b of s.worldFaces()) {
          if (a.normal.dot(b.normal) > -0.9999) continue;
          if (Math.abs(b.centroid.clone().sub(a.centroid).dot(a.normal)) > tol) continue;
          if (!facesOverlap(a, b, tol)) continue;
          const same = a.verts.length === b.verts.length && a.verts.every((v) => b.verts.some((w) => w.distanceTo(v) < tol));
          if (!same) return { kind: 'partial', solid: s, message: 'Those faces would only partly touch. Snap to a complete face of the same shape.' };
        }
      }
    }
    return null;
  }

  // Every way a solid of `type` can sit flush against an exterior face of
  // another solid, choosing for each face the orientation closest to `hint`.
  snapCandidates(type, edge, hint, ignoreId = null) {
    const tm = template(type);
    const out = [];
    for (const target of this.solids) {
      if (target.id === ignoreId) continue;
      for (const tf of target.worldFaces()) {
        let best = null;
        for (let fi = 0; fi < tm.faces.length; fi++) {
          const mf = tm.faces[fi];
          if (mf.sides !== tf.sides) continue;
          for (let j = 0; j < tf.verts.length; j++) {
            const pose = alignFace(tm, fi, edge, tf, j);
            if (!pose) continue;
            const ang = hint ? pose.quaternion.angleTo(hint) : 0;
            if (!best || ang < best.ang) best = { ...pose, ang };
          }
        }
        if (best) out.push({ target, face: tf, position: best.position, quaternion: best.quaternion });
      }
    }
    return out;
  }

  // Place a new solid against a face of an existing solid.
  attachTo(targetId, faceIndex, type, edge, hint) {
    const target = this.get(targetId);
    if (!target) return { error: 'Pick a face first.' };
    const tf = target.worldFaces()[faceIndex];
    const tm = template(type);
    let best = null;
    for (let fi = 0; fi < tm.faces.length; fi++) {
      if (tm.faces[fi].sides !== tf.sides) continue;
      for (let j = 0; j < tf.verts.length; j++) {
        const pose = alignFace(tm, fi, edge, tf, j);
        if (!pose) continue;
        const ang = hint ? pose.quaternion.angleTo(hint) : 0;
        if (!best || ang < best.ang) best = { ...pose, ang };
      }
    }
    if (!best) return { error: 'These faces do not match in shape and size.' };
    const problem = this.placementProblem(type, edge, best.position, best.quaternion);
    if (problem) return { error: problem.kind === 'overlap' ? 'Another solid already fills that space.' : problem.message, blocker: problem.solid, problem };
    return { solid: this.add(type, edge, best.position, best.quaternion) };
  }
}

// The diagonals stored for a face: one pair, or a list of pairs.
export function diagonalsOf(d) { return Array.isArray(d[0]) ? d : [d]; }

// Split the corners 0..n-1 of a convex face by non-crossing diagonals.
// Each diagonal (i, j) splits the loop that holds both corners into the
// walk from i forward to j and the walk from j forward to i, so a single
// diagonal gives the same two pieces (and panel ids) as before. Returns null
// for a pair that is not a diagonal of the current pieces.
export function splitLoops(n, diags) {
  let loops = [[...Array(n).keys()]];
  for (const [i, j] of diags) {
    const at = loops.findIndex((l) => l.includes(i) && l.includes(j));
    if (at < 0 || i === j) return null;
    const L = loops[at], m = L.length;
    const a = L.indexOf(i), b = L.indexOf(j);
    const gap = (b - a + m) % m;
    if (gap < 2 || gap > m - 2) return null;
    const A = [], B = [];
    for (let k = a; ; k = (k + 1) % m) { A.push(L[k]); if (k === b) break; }
    for (let k = b; ; k = (k + 1) % m) { B.push(L[k]); if (k === a) break; }
    loops = [...loops.slice(0, at), A, B, ...loops.slice(at + 1)];
  }
  return loops;
}

// One convex panel from a group of coplanar faces that share edges: the
// shared edges cancel and the rest is walked into a single loop. Returns
// null when the faces do not form one simple loop.
export function mergeLoop(faces) {
  const key = (v) => vkey(v);
  const dir = new Map();
  for (const f of faces) {
    const n = f.base.length;
    for (let i = 0; i < n; i++) {
      const a = key(f.base[i]), b = key(f.base[(i + 1) % n]);
      const back = `${b}>${a}`;
      if (dir.has(back)) dir.delete(back);
      else dir.set(`${a}>${b}`, { a, b, f, i });
    }
  }
  const next = new Map();
  for (const d of dir.values()) { if (next.has(d.a)) return null; next.set(d.a, d); }
  const start = dir.values().next().value;
  if (!start) return null;
  const loop = [];
  let d = start;
  for (let guard = 0; guard <= dir.size; guard++) {
    loop.push(d);
    d = next.get(d.b);
    if (!d) return null;
    if (d === start) break;
  }
  if (loop.length !== dir.size) return null;
  return loop.map((x) => ({ vert: x.f.verts[x.i], base: x.f.base[x.i] }));
}

// Is a loop of points convex (corners of 180° allowed) about normal n?
export function isConvexLoop(pts, n, tol = 1e-9) {
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m], c = pts[(i + 2) % m];
    const t = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, b)).dot(n);
    if (t < -tol * a.distanceTo(b) * b.distanceTo(c)) return false;
  }
  return true;
}

function mergeFaces(faces, groups) {
  const byId = new Map(faces.filter((f) => f.sub == null).map((f) => [`${f.solid.id}:${f.fi}`, f]));
  const used = new Set();
  const merged = [];
  for (const g of groups) {
    const fs = g.map((id) => byId.get(id));
    if (fs.some((f) => !f || used.has(f))) continue;
    const loop = mergeLoop(fs);
    if (!loop) continue;
    fs.forEach((f) => used.add(f));
    const f0 = fs[0];
    merged.push({ ...f0, pid: `m(${g.join(',')})`, merged: g.slice(), verts: loop.map((x) => x.vert.clone()), base: loop.map((x) => x.base.clone()), sides: loop.length });
  }
  return faces.filter((f) => !used.has(f)).concat(merged);
}

// Pose of the mirror image of a solid in the plane through `o` with unit
// normal `n`: the reflected vertex set, as the same solid type with a proper
// rotation (reflection · R · S, S being the solid's own mirror symmetry).
export function mirrorPose(solid, o, n) {
  const F = new THREE.Matrix3().set(
    1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z,
    -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z,
    -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z);
  const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(solid.quaternion));
  const M = F.clone().multiply(R).multiply(templateMirror(solid.type));
  const e = M.elements;
  const m4 = new THREE.Matrix4().set(e[0], e[3], e[6], 0, e[1], e[4], e[7], 0, e[2], e[5], e[8], 0, 0, 0, 0, 1);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(m4).normalize();
  const d = solid.position.clone().sub(o).dot(n);
  const position = solid.position.clone().addScaledVector(n, -2 * d);
  return { position, quaternion };
}

// Pose that puts face `fi` of a template (scaled to `edge`) flush against a
// world face `tf`, with its first vertex on tf.verts[j] and normals opposed.
export function alignFace(tm, fi, edge, tf, j) {
  const mf = tm.faces[fi];
  const L = mf.idx.map((i) => tm.verts[i].clone().multiplyScalar(edge));
  const cM = mf.centroid.clone().multiplyScalar(edge);
  const nM = mf.normal.clone();
  const aM = L[0].clone().sub(cM).normalize();
  const bM = new THREE.Vector3().crossVectors(nM, aM);
  const nT = tf.normal.clone().negate();
  const aT = tf.verts[j].clone().sub(tf.centroid).normalize();
  const bT = new THREE.Vector3().crossVectors(nT, aT);
  const FM = new THREE.Matrix4().makeBasis(aM, bM, nM);
  const FT = new THREE.Matrix4().makeBasis(aT, bT, nT);
  const R = FT.multiply(FM.transpose());
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(R).normalize();
  const position = tf.centroid.clone().sub(cM.clone().applyQuaternion(quaternion));
  // Every vertex must land on a vertex of the target face.
  const tol = edge * 1e-4;
  for (const p of L) {
    const w = p.clone().applyQuaternion(quaternion).add(position);
    if (!tf.verts.some((v) => v.distanceTo(w) < tol)) return null;
  }
  return { position, quaternion };
}

// Do two coplanar convex faces share area (not just an edge or corner)?
function facesOverlap(a, b, tol) {
  const n = a.normal;
  const ax = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const e1 = new THREE.Vector3().crossVectors(n, ax).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  const P = a.verts.map((v) => [v.dot(e1), v.dot(e2)]);
  const R = b.verts.map((v) => [v.dot(e1), v.dot(e2)]);
  for (const S of [P, R]) {
    for (let i = 0; i < S.length; i++) {
      const p = S[i], q = S[(i + 1) % S.length];
      let x = -(q[1] - p[1]), y = q[0] - p[0];
      const len = Math.hypot(x, y);
      if (len < 1e-12) continue;
      x /= len; y /= len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const r of P) { const d = r[0] * x + r[1] * y; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const r of R) { const d = r[0] * x + r[1] * y; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (Math.min(a1, b1) - Math.max(a0, b0) <= tol * 10) return false;
    }
  }
  return true;
}

// Separating-axis test for two convex solids. Touching is allowed; they
// overlap only when they interpenetrate by more than a small tolerance.
export function convexOverlap(a, b) {
  const va = a.worldVerts(), vb = b.worldVerts();
  const tol = Math.min(a.edge, b.edge) * 1e-3;
  const axes = [];
  const faceNormals = (s) => s.template.faces.map((f) => f.normal.clone().applyQuaternion(s.quaternion));
  const edgeDirs = (s) => {
    const dirs = [];
    const t = s.template;
    for (const f of t.faces) {
      for (let i = 0; i < f.idx.length; i++) {
        const d = t.verts[f.idx[(i + 1) % f.idx.length]].clone().sub(t.verts[f.idx[i]]).normalize().applyQuaternion(s.quaternion);
        if (!dirs.some((e) => Math.abs(e.dot(d)) > 0.9999)) dirs.push(d);
      }
    }
    return dirs;
  };
  axes.push(...faceNormals(a), ...faceNormals(b));
  for (const ea of edgeDirs(a)) {
    for (const eb of edgeDirs(b)) {
      const c = new THREE.Vector3().crossVectors(ea, eb);
      if (c.lengthSq() > 1e-8) axes.push(c.normalize());
    }
  }
  for (const ax of axes) {
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const v of va) { const d = v.dot(ax); if (d < minA) minA = d; if (d > maxA) maxA = d; }
    for (const v of vb) { const d = v.dot(ax); if (d < minB) minB = d; if (d > maxB) maxB = d; }
    if (Math.min(maxA, maxB) - Math.max(minA, minB) <= tol) return false;
  }
  return true;
}
