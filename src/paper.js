import * as THREE from 'three';
import {
  splitConvex, polyCentroid, segDist, clipLineToConvex, convexOverlap,
  sharedSegment, bbox, pointInConvex,
} from './geom2d.js';

// The paper is a set of convex faces. Each face keeps its polygon in flat
// "paper coordinates" (metres, origin at the bottom-left corner of the sheet)
// and a rigid matrix M that places it in the paper's local 3D frame.
// The flat, unfolded sheet lies in the z = 0 plane of that frame.
//
// `off` is a small render-only offset along the face's own z axis that keeps
// stacked layers from z-fighting. Geometry (creases, fold axes) always uses M.

export const LAYER_EPS = 0.0005; // 0.5 mm between stacked layers
const PLANE_TOL = 1e-4;
const AXIS_TOL = 2e-4;
const EDGE_TOL = 1e-5;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

function v3(p, z = 0) { return new THREE.Vector3(p[0], p[1], z); }
function normalOf(M, out = new THREE.Vector3()) { return out.setFromMatrixColumn(M, 2).normalize(); }
function originOf(M, out = new THREE.Vector3()) { return out.setFromMatrixPosition(M); }
function inBase(M) {
  const e = M.elements;
  return Math.abs(Math.abs(e[10]) - 1) < 1e-6 && Math.abs(e[14]) < PLANE_TOL;
}
function heightOf(M, off) { const e = M.elements; return e[14] + e[10] * off; }
function distToLine(p, P, u) {
  _v.subVectors(p, P);
  const t = _v.dot(u);
  return Math.sqrt(Math.max(0, _v.lengthSq() - t * t));
}
function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

let nextFaceId = 1;

export class Paper {
  constructor(paint) {
    this.paint = paint;
    this.root = new THREE.Group();
    this.root.name = 'paper-root';
    this.facesGroup = new THREE.Group();
    this.root.add(this.facesGroup);
    this.faces = [];
    this.adj = [];
    this.pickables = [];
    this.W = 0.3;
    this.H = 0.3;
    this.flat = new THREE.Matrix4();

    this.creaseColors = {
      flat: new THREE.Color('#3f5bd8'),
      folded: new THREE.Color('#2a2c38'),
    };
    this.makeMaterials();
  }

  makeMaterials() {
    const mk = (side, map, hi) => new THREE.MeshStandardMaterial({
      map, side, roughness: 0.93, metalness: 0,
      emissive: hi ? new THREE.Color('#ffb13d') : new THREE.Color('#000000'),
      emissiveIntensity: hi ? 0.1 : 0,
    });
    this.mat = {
      front: mk(THREE.FrontSide, this.paint.front.texture, false),
      back: mk(THREE.BackSide, this.paint.back.texture, false),
      frontHi: mk(THREE.FrontSide, this.paint.front.texture, true),
      backHi: mk(THREE.BackSide, this.paint.back.texture, true),
      creaseF: new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.9, side: THREE.FrontSide,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      }),
      creaseB: new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.9, side: THREE.BackSide,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      }),
    };
  }

  refreshTextures() {
    this.mat.front.map = this.mat.frontHi.map = this.paint.front.texture;
    this.mat.back.map = this.mat.backHi.map = this.paint.back.texture;
    for (const m of Object.values(this.mat)) m.needsUpdate = true;
  }

  get size() { return Math.max(this.W, this.H); }

  // ---------------------------------------------------------------- setup

  reset(W, H) {
    for (const f of this.faces) this.disposeFace(f);
    this.W = W;
    this.H = H;
    this.flat.makeTranslation(-W / 2, -H / 2, 0);
    this.faces = [this.makeFace([[0, 0], [W, 0], [W, H], [0, H]], this.flat.clone(), 0)];
    this.afterTopologyChange();
  }

  makeFace(poly, M, off) {
    const f = { id: nextFaceId++, poly, M, off, group: null };
    this.buildFaceMeshes(f);
    return f;
  }

  buildFaceMeshes(f) {
    const n = f.poly.length;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [x, y] = f.poly[i];
      pos.set([x, y, 0], i * 3);
      nrm.set([0, 0, 1], i * 3);
      uv.set([x / this.W, 1 - y / this.H], i * 2);
    }
    const idx = [];
    for (let i = 1; i < n - 1; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();

    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const front = new THREE.Mesh(g, this.mat.front);
    const back = new THREE.Mesh(g, this.mat.back);
    for (const [m, side] of [[front, 'front'], [back, 'back']]) {
      m.castShadow = true;
      m.userData.face = f;
      m.userData.side = side;
      group.add(m);
    }
    f.group = group;
    f.geometry = g;
    f.front = front;
    f.back = back;
    f.ribbons = null;
    this.facesGroup.add(group);
    this.updateFaceMatrix(f);
  }

  disposeFace(f) {
    if (!f.group) return;
    this.facesGroup.remove(f.group);
    f.geometry.dispose();
    if (f.ribbons) f.ribbons.geometry.dispose();
    f.group = null;
  }

  updateFaceMatrix(f) {
    f.group.matrix.copy(f.M).multiply(_m.makeTranslation(0, 0, f.off));
    f.group.matrixWorldNeedsUpdate = true;
  }

  updateAllMatrices() {
    for (const f of this.faces) this.updateFaceMatrix(f);
  }

  afterTopologyChange() {
    this.pickables = [];
    for (const f of this.faces) this.pickables.push(f.front, f.back);
    this.computeAdjacency();
    this.rebuildRibbons();
  }

  // ------------------------------------------------------------ adjacency

  computeAdjacency() {
    const F = this.faces;
    const boxes = F.map((f) => bbox(f.poly));
    const adj = [];
    for (let i = 0; i < F.length; i++) {
      for (let j = i + 1; j < F.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A[0] > B[2] + EDGE_TOL || B[0] > A[2] + EDGE_TOL || A[1] > B[3] + EDGE_TOL || B[1] > A[3] + EDGE_TOL) continue;
        const P = F[i].poly, Q = F[j].poly;
        for (let a = 0; a < P.length; a++) {
          const a1 = P[a], b1 = P[(a + 1) % P.length];
          for (let b = 0; b < Q.length; b++) {
            const seg = sharedSegment(a1, b1, Q[b], Q[(b + 1) % Q.length], EDGE_TOL);
            if (seg) adj.push({ a: F[i], b: F[j], p: seg[0], q: seg[1] });
          }
        }
      }
    }
    this.adj = adj;
  }

  isFlatCrease(e) {
    const na = normalOf(e.a.M), nb = normalOf(e.b.M, new THREE.Vector3());
    return na.dot(nb) > 0.9999;
  }

  rebuildRibbons() {
    const w = THREE.MathUtils.clamp(this.size * 0.0028, 0.0005, 0.003);
    const perFace = new Map();
    for (const e of this.adj) {
      const col = this.isFlatCrease(e) ? this.creaseColors.flat : this.creaseColors.folded;
      for (const f of [e.a, e.b]) {
        if (!perFace.has(f)) perFace.set(f, []);
        perFace.get(f).push({ p: e.p, q: e.q, col });
      }
    }
    for (const f of this.faces) {
      if (f.ribbons) {
        f.group.remove(f.ribbons, f.ribbonsBack);
        f.ribbons.geometry.dispose();
        f.ribbons = f.ribbonsBack = null;
      }
      const segs = perFace.get(f);
      if (!segs) continue;
      const c = polyCentroid(f.poly);
      const pos = [], col = [], idx = [];
      for (const s of segs) {
        const dx = s.q[0] - s.p[0], dy = s.q[1] - s.p[1];
        const len = Math.hypot(dx, dy) || 1;
        let nx = -dy / len, ny = dx / len;
        if ((c[0] - s.p[0]) * nx + (c[1] - s.p[1]) * ny < 0) { nx = -nx; ny = -ny; }
        const b = pos.length / 3;
        pos.push(
          s.p[0], s.p[1], 0, s.q[0], s.q[1], 0,
          s.q[0] + nx * w, s.q[1] + ny * w, 0, s.p[0] + nx * w, s.p[1] + ny * w, 0,
        );
        for (let k = 0; k < 4; k++) col.push(s.col.r, s.col.g, s.col.b);
        // Wind counter-clockwise when seen from +z.
        const cross = (s.q[0] - s.p[0]) * ny - (s.q[1] - s.p[1]) * nx;
        if (cross > 0) idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        else idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      const front = new THREE.Mesh(g, this.mat.creaseF);
      front.position.z = 0.00004;
      const back = new THREE.Mesh(g, this.mat.creaseB);
      back.position.z = -0.00004;
      front.renderOrder = back.renderOrder = 2;
      f.group.add(front, back);
      f.ribbons = front;
      f.ribbonsBack = back;
    }
  }

  // -------------------------------------------------------------- queries

  // Convert a raycast hit into paper coordinates on the face.
  hitInfo(hit) {
    const f = hit.object.userData.face;
    const inv = _m.copy(f.group.matrixWorld).invert();
    const p = hit.point.clone().applyMatrix4(inv);
    return { face: f, side: hit.object.userData.side, x: p.x, y: p.y, point: hit.point.clone(), distance: hit.distance };
  }

  // Closest face under a world-space point (used for fingertips).
  nearestFace(worldPoint, maxDist) {
    let best = null;
    const inv = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (const f of this.faces) {
      inv.copy(f.group.matrixWorld).invert();
      p.copy(worldPoint).applyMatrix4(inv);
      if (Math.abs(p.z) > maxDist) continue;
      if (!pointInConvex(f.poly, [p.x, p.y], 0)) continue;
      if (!best || Math.abs(p.z) < Math.abs(best.z)) {
        best = { face: f, side: p.z >= 0 ? 'front' : 'back', x: p.x, y: p.y, z: p.z };
      }
    }
    if (best) {
      best.point = new THREE.Vector3(best.x, best.y, 0).applyMatrix4(best.face.group.matrixWorld);
      best.distance = Math.abs(best.z);
    }
    return best;
  }

  // Pure 3D point (paper-local frame) of paper coordinates on a face.
  toLocal(face, x, y) { return v3([x, y]).applyMatrix4(face.M); }

  // World-space plane through a face as rendered.
  renderPlane(face) {
    const m = face.group.matrixWorld;
    const n = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize();
    const o = new THREE.Vector3().setFromMatrixPosition(m);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
  }

  // World point on a face's rendered plane -> paper coordinates of that face.
  worldToPaper(face, worldPoint) {
    const p = worldPoint.clone().applyMatrix4(_m.copy(face.group.matrixWorld).invert());
    return [p.x, p.y];
  }

  coplanar(f, g) {
    const nf = normalOf(f.M), ng = normalOf(g.M, new THREE.Vector3());
    if (Math.abs(nf.dot(ng)) < 1 - 1e-6) return false;
    const of = originOf(f.M), og = originOf(g.M, new THREE.Vector3());
    return Math.abs(og.sub(of).dot(nf)) < PLANE_TOL;
  }

  maxStackHeight() {
    let h = 0;
    for (const f of this.faces) if (inBase(f.M)) h = Math.max(h, Math.abs(f.off));
    return h;
  }

  // Snap a paper point on `face` to nearby corners / crease intersections /
  // edge midpoints of every layer in the same plane.
  snap(face, x, y, radius) {
    const target = this.toLocal(face, x, y);
    let best = null, bd = radius;
    const consider = (p3) => {
      const d = p3.distanceTo(target);
      if (d < bd) { bd = d; best = p3; }
    };
    for (const g of this.faces) {
      if (!this.coplanar(face, g)) continue;
      const P = g.poly;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        consider(v3(a).applyMatrix4(g.M));
        consider(v3([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]).applyMatrix4(g.M));
      }
    }
    if (!best) return null;
    const inv = _m.copy(face.M).invert();
    const p = best.clone().applyMatrix4(inv);
    return [p.x, p.y];
  }

  // Segments (paper-local 3D) where a crease line through A,B (paper coords
  // on `face`) would cut the coplanar layers. Used for previews.
  creaseSegments(face, a, b) {
    const A3 = this.toLocal(face, a[0], a[1]);
    const B3 = this.toLocal(face, b[0], b[1]);
    const segs = [];
    for (const g of this.faces) {
      if (!this.coplanar(face, g)) continue;
      const inv = _m.copy(g.M).invert();
      const ga = A3.clone().applyMatrix4(inv), gb = B3.clone().applyMatrix4(inv);
      const chord = clipLineToConvex(g.poly, [ga.x, ga.y], [gb.x, gb.y]);
      if (!chord) continue;
      const lift = g.off;
      segs.push([
        v3(chord[0], lift).applyMatrix4(g.M),
        v3(chord[1], lift).applyMatrix4(g.M),
      ]);
    }
    return segs;
  }

  // ------------------------------------------------------------- creasing

  // Cut every layer that lies in the plane of `face` along the line through
  // paper points a and b (given in `face` coordinates).
  addCrease(face, a, b) {
    const A3 = this.toLocal(face, a[0], a[1]);
    const B3 = this.toLocal(face, b[0], b[1]);
    const minArea = 2e-7 * this.W * this.H;
    const out = [];
    let count = 0;
    for (const g of this.faces) {
      if (!this.coplanar(face, g)) { out.push(g); continue; }
      const inv = _m.copy(g.M).invert();
      const ga = A3.clone().applyMatrix4(inv), gb = B3.clone().applyMatrix4(inv);
      const parts = splitConvex(g.poly, [ga.x, ga.y], [gb.x, gb.y], 2e-6, minArea);
      if (!parts) { out.push(g); continue; }
      count++;
      for (const poly of parts) out.push(this.makeFace(poly, g.M.clone(), g.off));
      this.disposeFace(g);
    }
    this.faces = out;
    if (count) this.afterTopologyChange();
    return count;
  }

  // -------------------------------------------------------------- folding

  // Start folding the flap that contains the hit point, about the crease
  // nearest to it. viewerLocal is the eye position in the paper-local frame.
  beginFold(hit, viewerLocal, layerMode = 'all') {
    const f = hit.face;
    const pt = [hit.x, hit.y];
    let best = null, bd = Infinity;
    for (const e of this.adj) {
      if (e.a !== f && e.b !== f) continue;
      const d = segDist(pt, e.p, e.q);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return { error: 'Draw a crease first, then grab the paper next to it.' };

    const A = this.toLocal(f, best.p[0], best.p[1]);
    const B = this.toLocal(f, best.q[0], best.q[1]);
    let u = B.clone().sub(A).normalize();
    const P = A;

    const cut = (e) => {
      const p = v3(e.p).applyMatrix4(e.a.M), q = v3(e.q).applyMatrix4(e.a.M);
      return distToLine(p, P, u) < AXIS_TOL && distToLine(q, P, u) < AXIS_TOL;
    };
    const nbrs = new Map(this.faces.map((g) => [g, []]));
    let tmin = Infinity, tmax = -Infinity;
    for (const e of this.adj) {
      if (cut(e)) {
        for (const pp of [e.p, e.q]) {
          const t = v3(pp).applyMatrix4(e.a.M).sub(P).dot(u);
          tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
        }
        continue;
      }
      nbrs.get(e.a).push(e.b);
      nbrs.get(e.b).push(e.a);
    }
    const component = (start) => {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const g = stack.pop();
        for (const h of nbrs.get(g)) if (!seen.has(h)) { seen.add(h); stack.push(h); }
      }
      return seen;
    };

    const moving = component(f);
    if (layerMode === 'all') {
      const n = normalOf(f.M);
      const w = new THREE.Vector3().crossVectors(n, u);
      const sideOf = (g) => {
        const c = polyCentroid(g.poly);
        const d = v3(c).applyMatrix4(g.M).sub(P).dot(w);
        return Math.abs(d) < AXIS_TOL ? 0 : Math.sign(d);
      };
      const grabSide = sideOf(f);
      for (const g of this.faces) {
        if (moving.has(g) || !this.coplanar(f, g) || sideOf(g) !== grabSide) continue;
        const comp = component(g);
        let ok = true;
        for (const h of comp) if (this.coplanar(f, h) && sideOf(h) === -grabSide) { ok = false; break; }
        if (ok) for (const h of comp) moving.add(h);
      }
    }
    if (moving.size === this.faces.length) {
      return { error: 'This crease does not split the paper here. Draw it across the whole sheet.' };
    }

    const axisA = P.clone().addScaledVector(u, tmin);
    const axisB = P.clone().addScaledVector(u, tmax);
    const G = this.toLocal(f, hit.x, hit.y);
    const C = P.clone().addScaledVector(u, G.clone().sub(P).dot(u));
    const v0 = G.clone().sub(C);
    const r = v0.length();
    if (r < 1e-5) return { error: 'Grab the paper a little away from the crease.' };
    const n = normalOf(f.M);
    if (n.dot(viewerLocal.clone().sub(G)) < 0) n.negate();
    if (new THREE.Vector3().crossVectors(u, v0).dot(n) < 0) u.negate();
    const v0n = v0.clone().divideScalar(r);
    const w0 = new THREE.Vector3().crossVectors(u, v0n);

    const s = {
      face: f, C, u, n, v0n, w0, r, G,
      moving: [...moving],
      M0: new Map(), off0: new Map(),
      theta: 0, finalized: false,
      axisA, axisB,
    };
    for (const g of s.moving) s.M0.set(g, g.M.clone());
    for (const g of this.faces) s.off0.set(g, g.off);
    return s;
  }

  setHighlight(session, on) {
    const set = session ? new Set(session.moving) : new Set();
    for (const f of this.faces) {
      const hi = on && set.has(f);
      f.front.material = hi ? this.mat.frontHi : this.mat.front;
      f.back.material = hi ? this.mat.backHi : this.mat.back;
    }
  }

  setFoldAngle(s, theta) {
    if (s.finalized) {
      for (const g of this.faces) g.off = s.off0.get(g) ?? g.off;
      s.finalized = false;
    }
    s.theta = THREE.MathUtils.clamp(theta, -Math.PI, Math.PI);
    const R = new THREE.Matrix4()
      .makeTranslation(s.C.x, s.C.y, s.C.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(s.u, s.theta))
      .multiply(new THREE.Matrix4().makeTranslation(-s.C.x, -s.C.y, -s.C.z));
    for (const g of s.moving) {
      g.M.multiplyMatrices(R, s.M0.get(g));
    }
    this.updateAllMatrices();
  }

  // Fold angle that puts the grab point closest to a 3D point (paper-local).
  angleFromPoint(s, X) {
    const d = X.clone().sub(s.C);
    d.addScaledVector(s.u, -d.dot(s.u));
    if (d.lengthSq() < 1e-8) return s.theta;
    const raw = Math.atan2(s.w0.dot(d), s.v0n.dot(d));
    const th = s.theta + wrapPi(raw - s.theta);
    return THREE.MathUtils.clamp(th, -Math.PI, Math.PI);
  }

  // Fold angle whose grab point lies closest to a ray (paper-local), searched
  // near the current angle so the flap follows the finger continuously.
  angleFromRay(s, origin, dir) {
    const step = THREE.MathUtils.degToRad(1);
    const span = 75;
    const samples = [];
    const G = new THREE.Vector3();
    for (let k = -span; k <= span; k++) {
      const th = s.theta + k * step;
      if (th < -Math.PI - 1e-9 || th > Math.PI + 1e-9) continue;
      G.copy(s.C).addScaledVector(s.v0n, s.r * Math.cos(th)).addScaledVector(s.w0, s.r * Math.sin(th));
      _v.subVectors(G, origin);
      const t = Math.max(0, _v.dot(dir));
      const dist = _v.addScaledVector(dir, -t).length();
      samples.push({ th, dist, t });
    }
    if (!samples.length) return s.theta;
    let dmin = Infinity;
    for (const c of samples) dmin = Math.min(dmin, c.dist);
    // Local minima that are about as good as the best one.
    const good = samples.filter((c, i) => {
      const a = samples[i - 1], b = samples[i + 1];
      const isMin = (!a || a.dist >= c.dist) && (!b || b.dist >= c.dist);
      return isMin && c.dist <= dmin + Math.max(0.002, s.r * 0.03);
    });
    // Prefer the candidate nearest the eye (the flap rises toward the viewer).
    good.sort((p, q) => p.t - q.t);
    return (good[0] || samples[0]).th;
  }

  finalizeFold(s, snap = true) {
    let th = s.theta;
    if (snap) {
      const deg = THREE.MathUtils.radToDeg(Math.abs(th));
      if (deg < 8) th = 0;
      else if (deg > 168) th = Math.sign(th) * Math.PI;
    }
    this.setFoldAngle(s, th);
    this.relayer(s);
    s.finalized = true;
    this.rebuildRibbons();
  }

  // Re-stack every face that lies flat in the base plane after a fold.
  relayer(s) {
    const flipped = Math.abs(Math.abs(s.theta) - Math.PI) < 1e-6;
    const dirSign = Math.sign(s.n.z || 1) * Math.sign(s.theta || 1);
    const moving = new Set(s.moving);
    const BIG = 10;
    const keyed = [];
    for (const g of this.faces) {
      const off0 = s.off0.get(g) ?? g.off;
      g.off = off0;
      if (!inBase(g.M)) continue;
      let key;
      if (!moving.has(g)) key = heightOf(g.M, off0);
      else {
        const M0 = s.M0.get(g);
        const wasBase = inBase(M0);
        const h0 = wasBase ? heightOf(M0, off0) : 0;
        if (wasBase && !flipped) key = h0;
        else if (wasBase) key = dirSign > 0 ? BIG - h0 : -BIG - h0;
        else key = dirSign > 0 ? 2 * BIG : -2 * BIG;
      }
      keyed.push({ g, key });
    }
    this.stack(keyed);
    this.updateAllMatrices();
  }

  // Assign compact layer offsets from an ordering of base-plane faces:
  // a face sits one layer above the highest face it overlaps that is below it.
  stack(keyed) {
    keyed.sort((a, b) => a.key - b.key);
    const polys = keyed.map(({ g }) => g.poly.map((p) => {
      const q = v3(p).applyMatrix4(g.M);
      return [q.x, q.y];
    }));
    const depth = new Array(keyed.length).fill(0);
    for (let i = 0; i < keyed.length; i++) {
      for (let j = 0; j < i; j++) {
        if (depth[j] + 1 > depth[i] && convexOverlap(polys[i], polys[j], 1e-4)) depth[i] = depth[j] + 1;
      }
      const g = keyed[i].g;
      g.off = depth[i] * LAYER_EPS * Math.sign(g.M.elements[10]);
    }
  }

  unfoldAll() {
    for (const f of this.faces) {
      f.M.copy(this.flat);
      f.off = 0;
    }
    this.updateAllMatrices();
    this.rebuildRibbons();
  }

  isFlat() {
    return this.faces.every((f) => f.M.equals(this.flat));
  }

  // ------------------------------------------------------- serialization

  serialize() {
    return {
      W: this.W, H: this.H,
      faces: this.faces.map((f) => ({ poly: f.poly.map((p) => [p[0], p[1]]), M: f.M.toArray(), off: f.off })),
    };
  }

  restore(state) {
    for (const f of this.faces) this.disposeFace(f);
    this.W = state.W;
    this.H = state.H;
    this.flat.makeTranslation(-this.W / 2, -this.H / 2, 0);
    this.faces = state.faces.map((d) => this.makeFace(d.poly.map((p) => [p[0], p[1]]), new THREE.Matrix4().fromArray(d.M), d.off));
    this.afterTopologyChange();
  }

  // World-space bounds of the rendered paper (for resting it on the table).
  worldBounds() {
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    for (const f of this.faces) {
      for (const q of f.poly) {
        p.set(q[0], q[1], 0).applyMatrix4(f.group.matrixWorld);
        box.expandByPoint(p);
      }
    }
    return box;
  }
}
