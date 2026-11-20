import * as THREE from 'three';
import { template } from './polyhedra.js';

// A composition is a list of solids, each a template placed with a position,
// orientation and edge length (metres). Solids attach face to face; they may
// never overlap.

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

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
  }

  add(type, edge, position, quaternion = new THREE.Quaternion()) {
    const s = new Solid(this.nextId++, type, edge, position, quaternion);
    this.solids.push(s);
    return s;
  }

  remove(id) { this.solids = this.solids.filter((s) => s.id !== id); }
  get(id) { return this.solids.find((s) => s.id === id) || null; }

  serialize() { return { nextId: this.nextId, solids: this.solids.map((s) => s.toJSON()) }; }

  restore(data) {
    this.nextId = data.nextId;
    this.solids = data.solids.map((d) => new Solid(d.id, d.type, d.edge, new THREE.Vector3().fromArray(d.p), new THREE.Quaternion().fromArray(d.q)));
  }

  // Lowest point of all solids (y).
  minY() {
    let y = Infinity;
    for (const s of this.solids) for (const v of s.worldVerts()) y = Math.min(y, v.y);
    return y;
  }

  // Shift every solid so the composition rests on y = 0.
  settle() {
    if (!this.solids.length) return;
    const dy = -this.minY();
    for (const s of this.solids) s.position.y += dy;
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
    const blocker = this.overlapping(type, edge, best.position, best.quaternion);
    if (blocker) return { error: 'Another solid already fills that space.', blocker };
    return { solid: this.add(type, edge, best.position, best.quaternion) };
  }
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
