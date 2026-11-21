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
    this.cutEdges = [];
    this.cuts = []; // cut segments in sheet coordinates: { p: [x, y], q: [x, y] }
    this.pieceCount = 1;
    this.pickables = [];
    this.W = 0.3;
    this.H = 0.3;
    this.flat = new THREE.Matrix4();

    this.creaseColors = {
      flat: new THREE.Color('#3f5bd8'),
      folded: new THREE.Color('#2a2c38'),
      cut: new THREE.Color('#c43d1a'),
    };
    this.makeMaterials();
  }

  makeMaterials() {
    const mk = (side, map, hi) => new THREE.MeshStandardMaterial({
      map, side, roughness: 0.93, metalness: 0,
      emissive: new THREE.Color(hi === 'hover' ? '#5aa0ff' : hi ? '#ffb13d' : '#000000'),
      emissiveIntensity: hi === 'hover' ? 0.16 : hi ? 0.1 : 0,
    });
    this.mat = {
      front: mk(THREE.FrontSide, this.paint.front.texture, false),
      back: mk(THREE.BackSide, this.paint.back.texture, false),
      frontHi: mk(THREE.FrontSide, this.paint.front.texture, true),
      backHi: mk(THREE.BackSide, this.paint.back.texture, true),
      frontHover: mk(THREE.FrontSide, this.paint.front.texture, 'hover'),
      backHover: mk(THREE.BackSide, this.paint.back.texture, 'hover'),
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
    this.mat.front.map = this.mat.frontHi.map = this.mat.frontHover.map = this.paint.front.texture;
    this.mat.back.map = this.mat.backHi.map = this.mat.backHover.map = this.paint.back.texture;
    for (const m of Object.values(this.mat)) m.needsUpdate = true;
  }

  get size() { return Math.max(this.W, this.H); }

  // ---------------------------------------------------------------- setup

  reset(W, H) {
    for (const f of this.faces) this.disposeFace(f);
    this.W = W;
    this.H = H;
    this.flat.makeTranslation(-W / 2, -H / 2, 0);
    this.cuts = [];
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
    this.pieceCount = this.pieces().length;
    this.rebuildRibbons();
  }

  // ------------------------------------------------------------ adjacency

  computeAdjacency() {
    const F = this.faces;
    const boxes = F.map((f) => bbox(f.poly));
    const adj = [];
    const cutEdges = [];
    for (let i = 0; i < F.length; i++) {
      for (let j = i + 1; j < F.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A[0] > B[2] + EDGE_TOL || B[0] > A[2] + EDGE_TOL || A[1] > B[3] + EDGE_TOL || B[1] > A[3] + EDGE_TOL) continue;
        const P = F[i].poly, Q = F[j].poly;
        for (let a = 0; a < P.length; a++) {
          const a1 = P[a], b1 = P[(a + 1) % P.length];
          for (let b = 0; b < Q.length; b++) {
            const seg = sharedSegment(a1, b1, Q[b], Q[(b + 1) % Q.length], EDGE_TOL);
            if (!seg) continue;
            const { keep, cut } = this.subtractCuts(seg[0], seg[1]);
            for (const [p, q] of keep) adj.push({ a: F[i], b: F[j], p, q });
            for (const [p, q] of cut) cutEdges.push({ a: F[i], b: F[j], p, q });
          }
        }
      }
    }
    this.adj = adj;
    this.cutEdges = cutEdges;
  }

  // Split a shared edge p-q into the parts that are still joined and the
  // parts that have been cut.
  subtractCuts(p, q) {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const iv = [];
    for (const c of this.cuts) {
      const off = (r) => Math.abs((r[0] - p[0]) * uy - (r[1] - p[1]) * ux);
      if (off(c.p) > EDGE_TOL || off(c.q) > EDGE_TOL) continue;
      const ta = (c.p[0] - p[0]) * ux + (c.p[1] - p[1]) * uy;
      const tb = (c.q[0] - p[0]) * ux + (c.q[1] - p[1]) * uy;
      const lo = Math.max(0, Math.min(ta, tb)), hi = Math.min(len, Math.max(ta, tb));
      if (hi - lo > EDGE_TOL) iv.push([lo, hi]);
    }
    const at = (t) => [p[0] + ux * t, p[1] + uy * t];
    if (!iv.length) return { keep: [[p, q]], cut: [] };
    iv.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of iv) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + EDGE_TOL) last[1] = Math.max(last[1], r[1]);
      else merged.push(r.slice());
    }
    const keep = [], cut = [];
    let t = 0;
    const minLen = EDGE_TOL * 10;
    for (const [lo, hi] of merged) {
      if (lo - t > minLen) keep.push([at(t), at(lo)]);
      cut.push([at(lo), at(hi)]);
      t = hi;
    }
    if (len - t > minLen) keep.push([at(t), at(len)]);
    return { keep, cut };
  }

  // Connected pieces of paper (faces joined by uncut edges).
  pieces() {
    const nbrs = new Map(this.faces.map((g) => [g, []]));
    for (const e of this.adj) { nbrs.get(e.a).push(e.b); nbrs.get(e.b).push(e.a); }
    const seen = new Set();
    const out = [];
    for (const f of this.faces) {
      if (seen.has(f)) continue;
      const comp = [f];
      seen.add(f);
      for (let i = 0; i < comp.length; i++) {
        for (const h of nbrs.get(comp[i])) if (!seen.has(h)) { seen.add(h); comp.push(h); }
      }
      out.push(comp);
    }
    return out;
  }

  pieceOf(face) {
    return this.pieces().find((c) => c.includes(face)) || [face];
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
        perFace.get(f).push({ p: e.p, q: e.q, col, w });
      }
    }
    for (const e of this.cutEdges) {
      for (const f of [e.a, e.b]) {
        if (!perFace.has(f)) perFace.set(f, []);
        perFace.get(f).push({ p: e.p, q: e.q, col: this.creaseColors.cut, w: w * 0.7 });
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
        const sw = s.w;
        pos.push(
          s.p[0], s.p[1], 0, s.q[0], s.q[1], 0,
          s.q[0] + nx * sw, s.q[1] + ny * sw, 0, s.p[0] + nx * sw, s.p[1] + ny * sw, 0,
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
    if (!best) {
      return { error: this.pieceCount > 1
        ? 'This piece has no crease beside it. Draw one, or use Move to slide the piece.'
        : 'Draw a crease first, then grab the paper next to it.' };
    }

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
    if (moving.size >= this.pieceOf(f).length) {
      return { error: 'This crease does not split this piece. Draw it across the whole piece.' };
    }
    if (layerMode === 'all') {
      const n = normalOf(f.M);
      const w = new THREE.Vector3().crossVectors(n, u);
      const sideOf = (g) => {
        const c = polyCentroid(g.poly);
        const d = v3(c).applyMatrix4(g.M).sub(P).dot(w);
        return Math.abs(d) < AXIS_TOL ? 0 : Math.sign(d);
      };
      const grabSide = sideOf(f);
      // Only layers stacked over or under the grabbed flap come along.
      const fInv = new THREE.Matrix4().copy(f.M).invert();
      const proj = new Map();
      const flat = (g) => {
        if (!proj.has(g)) {
          const m = new THREE.Matrix4().multiplyMatrices(fInv, g.M);
          proj.set(g, g.poly.map((p) => { const q = v3(p).applyMatrix4(m); return [q.x, q.y]; }));
        }
        return proj.get(g);
      };
      let grew = true;
      while (grew) {
        grew = false;
        for (const g of this.faces) {
          if (moving.has(g) || !this.coplanar(f, g) || sideOf(g) !== grabSide) continue;
          let touches = false;
          for (const h of moving) {
            if (this.coplanar(f, h) && convexOverlap(flat(g), flat(h), 1e-4)) { touches = true; break; }
          }
          if (!touches) continue;
          const comp = component(g);
          let ok = true;
          for (const h of comp) if (this.coplanar(f, h) && sideOf(h) === -grabSide) { ok = false; break; }
          if (ok) { for (const h of comp) moving.add(h); grew = true; }
        }
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

  // Selected faces (warm tint) and hovered faces (cool tint) together.
  setHighlightSets(selected, hovered) {
    for (const f of this.faces) {
      const sel = selected && selected.has(f), hov = !sel && hovered && hovered.has(f);
      f.front.material = sel ? this.mat.frontHi : hov ? this.mat.frontHover : this.mat.front;
      f.back.material = sel ? this.mat.backHi : hov ? this.mat.backHover : this.mat.back;
    }
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

  // ------------------------------------------------------------- cutting

  // The crease segment nearest a hit, as a 3D line plus the positions along
  // it where crease segments start and end (for snapping cuts to crossings).
  creaseLineAt(hit, maxDist) {
    const f = hit.face;
    const pt = [hit.x, hit.y];
    let best = null, bd = maxDist;
    for (const e of this.adj) {
      if (e.a !== f && e.b !== f) continue;
      const d = segDist(pt, e.p, e.q);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return null;
    const P = this.toLocal(f, best.p[0], best.p[1]);
    const u = this.toLocal(f, best.q[0], best.q[1]).sub(P).normalize();
    const stops = [];
    for (const e of [...this.adj, ...this.cutEdges]) {
      const a = v3(e.p).applyMatrix4(e.a.M), b = v3(e.q).applyMatrix4(e.a.M);
      if (distToLine(a, P, u) > AXIS_TOL || distToLine(b, P, u) > AXIS_TOL) continue;
      stops.push(a.sub(P).dot(u), b.sub(P).dot(u));
    }
    stops.sort((x, y) => x - y);
    const G = this.toLocal(f, hit.x, hit.y);
    const t = G.sub(P).dot(u);
    // The segment under the hit: the closest pair of stops around t.
    let lo = -Infinity, hi = Infinity;
    for (const v of stops) {
      if (v <= t + 1e-9 && v > lo) lo = v;
      if (v >= t - 1e-9 && v < hi) hi = v;
    }
    const ta = v3(best.p).applyMatrix4(f.M).sub(P).dot(u);
    const tb = v3(best.q).applyMatrix4(f.M).sub(P).dot(u);
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-5) { lo = Math.min(ta, tb); hi = Math.max(ta, tb); }
    return { P, u, n: normalOf(f.M), stops, t, segment: [lo, hi], face: f };
  }

  // Cut every joined edge lying on the 3D line P + t u for t in [t0, t1]
  // (through all layers, like scissors). Returns the number of edges cut.
  cutAlong(P, u, t0, t1) {
    const added = [];
    for (const e of this.adj) {
      const A = v3(e.p).applyMatrix4(e.a.M), B = v3(e.q).applyMatrix4(e.a.M);
      if (distToLine(A, P, u) > AXIS_TOL || distToLine(B, P, u) > AXIS_TOL) continue;
      const ta = A.sub(P).dot(u), tb = B.sub(P).dot(u);
      if (Math.abs(tb - ta) < 1e-9) continue;
      const lo = Math.max(Math.min(ta, tb), t0), hi = Math.min(Math.max(ta, tb), t1);
      if (hi - lo < 1e-5) continue;
      const at = (t) => {
        const k = (t - ta) / (tb - ta);
        return [e.p[0] + (e.q[0] - e.p[0]) * k, e.p[1] + (e.q[1] - e.p[1]) * k];
      };
      added.push({ p: at(lo), q: at(hi) });
    }
    if (!added.length) return 0;
    this.cuts.push(...added);
    this.afterTopologyChange();
    return added.length;
  }

  // Lay a piece back down after it was carried: if it ended up close to the
  // table plane and roughly level, flatten it onto the plane and stack it on
  // top of whatever it overlaps.
  settlePiece(piece, M0, off0) {
    const set = new Set(piece);
    let c = new THREE.Vector3();
    let count = 0;
    for (const f of piece) {
      const pc = polyCentroid(f.poly);
      c.add(v3(pc).applyMatrix4(f.M));
      count++;
    }
    c.divideScalar(count);
    const n = normalOf(piece[0].M);
    if (Math.abs(n.z) > Math.cos(THREE.MathUtils.degToRad(35)) && Math.abs(c.z) < 0.08) {
      const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, Math.sign(n.z)));
      const R = new THREE.Matrix4().makeTranslation(c.x, c.y, 0)
        .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      for (const f of piece) {
        f.M.premultiply(R);
        const e = f.M.elements;
        // Remove rounding so the face counts as lying in the plane.
        e[2] = e[6] = 0; e[8] = e[9] = 0; e[10] = Math.sign(e[10]); e[14] = 0;
      }
    }
    const BIG = 10;
    const keyed = [];
    for (const g of this.faces) {
      g.off = off0.get(g) ?? g.off;
      if (!inBase(g.M)) continue;
      if (!set.has(g)) { keyed.push({ g, key: heightOf(g.M, g.off) }); continue; }
      const m0 = M0.get(g);
      const h0 = inBase(m0) ? heightOf(m0, g.off) : 0;
      const flipped = Math.sign(m0.elements[10]) !== Math.sign(g.M.elements[10]);
      keyed.push({ g, key: BIG + (flipped ? -h0 : h0) });
    }
    this.stack(keyed);
    this.updateAllMatrices();
    this.rebuildRibbons();
  }

  setHighlightFaces(faces, on) {
    const set = new Set(on ? faces : []);
    for (const f of this.faces) {
      const hi = set.has(f);
      f.front.material = hi ? this.mat.frontHi : this.mat.front;
      f.back.material = hi ? this.mat.backHi : this.mat.back;
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
      cuts: this.cuts.map((c) => ({ p: c.p.slice(), q: c.q.slice() })),
      faces: this.faces.map((f) => ({ poly: f.poly.map((p) => [p[0], p[1]]), M: f.M.toArray(), off: f.off })),
    };
  }

  restore(state) {
    for (const f of this.faces) this.disposeFace(f);
    this.W = state.W;
    this.H = state.H;
    this.flat.makeTranslation(-this.W / 2, -this.H / 2, 0);
    this.cuts = (state.cuts || []).map((c) => ({ p: c.p.slice(), q: c.q.slice() }));
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
