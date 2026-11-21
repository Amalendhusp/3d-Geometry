import * as THREE from 'three';

// A shell is the exterior surface of a composition, made of rigid panels.
//
//  - Panels come from the faces of the solids. A face that exactly meets a
//    face of another solid (same vertices, opposite normals) is internal: both
//    are dropped and never come back while the composition is unchanged.
//  - Panels keep their rest polygon (closed form, composition frame) and a
//    rigid matrix M that places them in their current pose.
//  - An edge shared by exactly two panels is either a 'hinge' (the panels
//    stay joined and can only rotate about it) or a 'cut'. Edges shared by
//    more than two panels are always cut (locked).
//  - Each connected group of panels has a base panel that never moves.

const Q = 1e5; // 10 µm, for the text form of keys
const vkey = (v) => `${Math.round(v.x * Q)},${Math.round(v.y * Q)},${Math.round(v.z * Q)}`;

// Points within a small tolerance are the same vertex. Rotated solids do
// not land on round coordinates, so plain rounding could split one vertex
// in two; this merges by distance and names each vertex by its first copy.
class VertexIndex {
  constructor(tol = 2e-6) {
    this.tol = tol;
    this.cell = tol * 8;
    this.grid = new Map();
    this.pts = [];
    this.keys = [];
  }

  id(v) {
    const c = this.cell;
    const ix = Math.floor(v.x / c), iy = Math.floor(v.y / c), iz = Math.floor(v.z / c);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
          if (!list) continue;
          for (const i of list) if (this.pts[i].distanceTo(v) <= this.tol) return i;
        }
      }
    }
    const i = this.pts.length;
    this.pts.push(v.clone());
    this.keys.push(vkey(v));
    const k = `${ix},${iy},${iz}`;
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k).push(i);
    return i;
  }
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Shell {
  constructor() {
    this.panels = [];
    this.edges = [];
    this.internal = [];
    this.bases = new Set();
    this.edgeLen = 0.12;
  }

  // ------------------------------------------------------------ building

  build(composition) {
    const faces = composition.solids.flatMap((s) => s.worldFaces());
    this.edgeLen = composition.solids.length ? Math.min(...composition.solids.map((s) => s.edge)) : 0.12;
    const vix = new VertexIndex(this.edgeLen * 2e-5);
    for (const f of faces) f.vid = f.verts.map((v) => vix.id(v));
    const byKey = new Map();
    for (const f of faces) {
      const k = f.vid.slice().sort((a, b) => a - b).join(';');
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(f);
    }
    const removed = new Set();
    this.internal = [];
    for (const list of byKey.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (removed.has(a) || removed.has(b) || a.solid === b.solid) continue;
          if (a.normal.dot(b.normal) < -0.999) {
            removed.add(a); removed.add(b);
            this.internal.push({ a: `${a.solid.id}:${a.fi}`, b: `${b.solid.id}:${b.fi}`, verts: a.verts.map((v) => v.clone()) });
          }
        }
      }
    }
    this.panels = faces.filter((f) => !removed.has(f)).map((f) => ({
      id: `${f.solid.id}:${f.fi}`,
      solidId: f.solid.id,
      type: f.solid.type,
      fi: f.fi,
      vid: f.vid,
      verts: f.verts,
      normal: f.normal,
      centroid: f.centroid,
      M: new THREE.Matrix4(),
      edges: [],
    }));
    const map = new Map();
    for (const p of this.panels) {
      const n = p.verts.length;
      for (let i = 0; i < n; i++) {
        const a = p.verts[i], b = p.verts[(i + 1) % n];
        const ka = vix.keys[p.vid[i]], kb = vix.keys[p.vid[(i + 1) % n]];
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (!map.has(k)) map.set(k, { key: k, a: a.clone(), b: b.clone(), uses: [], type: 'cut', locked: false });
        const e = map.get(k);
        e.uses.push({ panel: p, i });
        p.edges[i] = e;
      }
    }
    this.edges = [...map.values()];
    // Stable edge numbers: the matching labels on both sides of a cut.
    let no = 1;
    for (const e of this.edges) {
      e.shared = e.uses.length === 2;
      e.locked = e.uses.length > 2;
      e.type = 'cut';
      e.no = e.uses.length >= 2 ? no++ : 0;
    }
    this.panels.forEach((p, i) => { p.no = i + 1; });
    this.panelById = new Map(this.panels.map((p) => [p.id, p]));
    this.net = { status: 'unchecked' };
    this.chooseBases();
  }

  other(e, p) {
    if (!e.shared) return null;
    return e.uses[0].panel === p ? e.uses[1].panel : e.uses[0].panel;
  }

  // Panels joined by any shared edge (a separate group per detached shell).
  pieces() {
    return components(this.panels, (p) => p.edges.filter((e) => e.shared).map((e) => this.other(e, p)));
  }

  chooseBases() {
    this.bases = new Set();
    for (const comp of this.pieces()) {
      let best = null, bs = Infinity;
      for (const p of comp) {
        const s = p.normal.y * 10 + p.centroid.y;
        if (s < bs - 1e-9) { bs = s; best = p; }
      }
      this.bases.add(best.id);
    }
  }

  setBase(panel) {
    const comp = this.pieces().find((c) => c.includes(panel));
    for (const p of comp) this.bases.delete(p.id);
    this.bases.add(panel.id);
  }

  isBase(p) { return this.bases.has(p.id); }

  // ------------------------------------------------------------ geometry

  // Rest-frame hinge axis for panel P on edge e, oriented so that a positive
  // angle swings P outward (toward its outside normal).
  axis(e, P) {
    const u = e.b.clone().sub(e.a).normalize();
    const v = P.centroid.clone().sub(e.a);
    v.addScaledVector(u, -v.dot(u)).normalize();
    if (new THREE.Vector3().crossVectors(u, v).dot(P.normal) < 0) u.negate();
    return { a: e.a, u, v };
  }

  // Current angle of P relative to Q about their shared edge (0 = closed).
  angle(e, P, Q) {
    const { u, v } = this.axis(e, P);
    const rel = _m.copy(Q.M).invert().multiply(P.M);
    const w = v.clone().transformDirection(rel);
    return Math.atan2(new THREE.Vector3().crossVectors(u, v).dot(w), v.dot(w));
  }

  // Interior dihedral angle at rest between P and Q (pi = coplanar).
  interior(e, P, Q) {
    const vp = this.axis(e, P).v, vq = this.axis(e, Q).v;
    const phi = Math.acos(THREE.MathUtils.clamp(vp.dot(vq), -1, 1));
    if (Math.abs(Math.PI - phi) < 1e-6) return Math.PI;
    return vp.dot(Q.normal) < 0 ? phi : 2 * Math.PI - phi;
  }

  // Angle of P relative to Q that lays P flat in Q's plane.
  flatAngle(e, P, Q) { return Math.PI - this.interior(e, P, Q); }

  restRotation(e, P, ang) {
    const { a, u } = this.axis(e, P);
    return new THREE.Matrix4().makeTranslation(a.x, a.y, a.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(u, ang))
      .multiply(new THREE.Matrix4().makeTranslation(-a.x, -a.y, -a.z));
  }

  // Do the two panels on e currently meet along it?
  intact(e) {
    if (!e.shared) return false;
    const [ua, ub] = e.uses;
    const tol = this.edgeLen * 1e-3;
    return e.a.clone().applyMatrix4(ua.panel.M).distanceTo(_v.copy(e.a).applyMatrix4(ub.panel.M)) < tol
      && e.b.clone().applyMatrix4(ua.panel.M).distanceTo(_w.copy(e.b).applyMatrix4(ub.panel.M)) < tol;
  }

  worldPoly(p) { return p.verts.map((v) => v.clone().applyMatrix4(p.M)); }
  worldNormal(p) { return p.normal.clone().transformDirection(p.M); }

  // --------------------------------------------------------------- hinges

  hingeNeighbours(p, except = null) {
    const out = [];
    for (const e of p.edges) {
      if (e === except || e.type !== 'hinge' || !e.shared) continue;
      out.push(this.other(e, p));
    }
    return out;
  }

  hingeComponent(p, except = null) {
    const seen = new Set([p]);
    const stack = [p];
    while (stack.length) {
      const q = stack.pop();
      for (const r of this.hingeNeighbours(q, except)) if (!seen.has(r)) { seen.add(r); stack.push(r); }
    }
    return seen;
  }

  // The panel that stays put in a hinge-connected group.
  rootOf(comp) {
    for (const p of comp) if (this.bases.has(p.id)) return p;
    let best = null;
    for (const p of comp) {
      const y = p.centroid.clone().applyMatrix4(p.M).y;
      if (!best || y < best.y - 1e-9 || (Math.abs(y - best.y) < 1e-9 && p.id < best.p.id)) best = { p, y };
    }
    return best.p;
  }

  // What would swing if P turns about edge e.
  // mode 'group': P and everything hinged beyond it; 'one': P alone.
  plan(P, e, mode) {
    const Q = this.other(e, P);
    if (!Q) return { error: 'That edge is not shared with another panel.' };
    if (e.locked) return { error: 'More than two panels meet at this edge, so it stays cut.' };
    if (!this.intact(e)) return { error: 'These panels are apart. Refold them before hinging this edge.' };
    if (mode === 'one') {
      if (this.isBase(P)) return { error: 'The base panel stays in place. Pick another panel, or set a new base.' };
      return { P, Q, e, mode, moving: [P] };
    }
    if (e.type !== 'hinge') return { error: 'That edge is cut. Make it a hinge, or use One panel.' };
    const side = this.hingeComponent(P, e);
    if (side.has(Q)) {
      return { error: 'These hinges form a closed loop, so the panel cannot swing. Cut one edge of the loop, or use One panel.', loop: this.loopEdges(P, Q, e) };
    }
    const root = this.rootOf(this.hingeComponent(P));
    if (side.has(root)) {
      return { error: 'That side holds the base panel. Choose a panel on the other side, or set a new base.' };
    }
    return { P, Q, e, mode, moving: [...side] };
  }

  // Hinges that, together with e, form a loop through P and Q.
  loopEdges(P, Q, e) {
    const prev = new Map([[P, null]]);
    const queue = [P];
    while (queue.length) {
      const p = queue.shift();
      if (p === Q) break;
      for (const f of p.edges) {
        if (f === e || f.type !== 'hinge' || !f.shared) continue;
        const r = this.other(f, p);
        if (!prev.has(r)) { prev.set(r, { p, f }); queue.push(r); }
      }
    }
    const out = [e];
    let cur = Q;
    while (prev.get(cur)) { out.push(prev.get(cur).f); cur = prev.get(cur).p; }
    return out;
  }

  // Hinge choices for a selected panel, each with whether it can be used.
  hingeOptions(P, mode) {
    const out = [];
    for (const e of P.edges) {
      if (!e.shared) continue;
      if (mode === 'group' && e.type !== 'hinge') continue;
      const plan = this.plan(P, e, mode);
      out.push({ e, ok: !plan.error, reason: plan.error || null });
    }
    return out;
  }

  // Make e the only joined edge of P (One panel mode).
  isolate(P, e) {
    for (const f of P.edges) {
      if (!f.shared || f.locked) continue;
      f.type = f === e ? 'hinge' : 'cut';
    }
  }

  // Rotate a planned group so that P sits at angle `ang` relative to Q.
  setAngle(plan, ang) {
    const { P, Q, e, moving } = plan;
    const delta = ang - this.angle(e, P, Q);
    if (Math.abs(delta) < 1e-12) return;
    const { a, u } = this.axis(e, P);
    const A = a.clone().applyMatrix4(Q.M);
    const U = u.clone().transformDirection(Q.M);
    const R = new THREE.Matrix4().makeTranslation(A.x, A.y, A.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(U, delta))
      .multiply(new THREE.Matrix4().makeTranslation(-A.x, -A.y, -A.z));
    for (const p of moving) p.M.premultiply(R);
  }

  // ----------------------------------------------------- whole-net motion

  // Spanning forest of the hinge graph: parent links from each root, plus
  // hinges that close loops.
  forest() {
    const parent = new Map();
    const order = [];
    const roots = [];
    const loops = new Set();
    const seen = new Set();
    for (const p0 of this.panels) {
      if (seen.has(p0)) continue;
      const root = this.rootOf(this.hingeComponent(p0));
      roots.push(root);
      seen.add(root);
      const queue = [root];
      order.push(root);
      while (queue.length) {
        const p = queue.shift();
        for (const e of p.edges) {
          if (e.type !== 'hinge' || !e.shared) continue;
          const q = this.other(e, p);
          if (!seen.has(q)) {
            seen.add(q);
            parent.set(q, { parent: p, e });
            order.push(q);
            queue.push(q);
          } else if (parent.get(p)?.e !== e) {
            loops.add(e);
          }
        }
      }
    }
    return { parent, order, roots, loops: [...loops] };
  }

  // Current hinge angles of the forest (child relative to parent).
  forestAngles(F) {
    const ang = new Map();
    for (const [c, { parent, e }] of F.parent) ang.set(c, this.angle(e, c, parent));
    return ang;
  }

  // Pose every panel from root matrices and hinge angles.
  applyForest(F, angles, rootMs) {
    for (const p of F.order) {
      const link = F.parent.get(p);
      if (!link) {
        if (rootMs && rootMs.has(p)) p.M.copy(rootMs.get(p));
        continue;
      }
      p.M.multiplyMatrices(link.parent.M, this.restRotation(link.e, p, angles.get(p)));
    }
  }

  flatAngles(F) {
    const ang = new Map();
    for (const [c, { parent, e }] of F.parent) ang.set(c, this.flatAngle(e, c, parent));
    return ang;
  }

  // ------------------------------------------------------------ the net

  sharedEdges() { return this.edges.filter((e) => e.shared && !e.locked); }

  setLayout(hingeSet) {
    for (const e of this.edges) if (e.shared && !e.locked) e.type = hingeSet.has(e) ? 'hinge' : 'cut';
  }

  isCoplanar(e) { return Math.abs(this.interior(e, e.uses[0].panel, e.uses[1].panel) - Math.PI) < 1e-6; }

  // How many panel pairs overlap if the current layout is unfolded flat
  // from the closed form. The shell is left as it was.
  flatOverlaps() {
    const saved = this.panels.map((p) => p.M.clone());
    for (const p of this.panels) p.M.identity();
    const F = this.forest();
    this.applyForest(F, this.flatAngles(F));
    // Only panels of the same unfolding piece can make a net overlap.
    const rootOf = new Map();
    for (const p of F.order) { const l = F.parent.get(p); rootOf.set(p, l ? rootOf.get(l.parent) : p); }
    const res = this.overlaps((a, b) => rootOf.get(a) === rootOf.get(b));
    this.panels.forEach((p, i) => p.M.copy(saved[i]));
    return { pairs: res.pairs.length, loops: F.loops.length, pieces: F.roots.length };
  }

  // Honest status of the current cut-and-hinge layout:
  //   verified   - a spanning tree on each shell piece; unfolds flat, no overlaps
  //   split      - no overlaps, but the hinges leave more pieces than the shell has
  //   overlap    - unfolds flat but panels overlap: not a valid net
  //   loops      - hinges form closed loops: cannot unfold
  //   unresolved - the search gave up; the layout shown is its best attempt
  classify(searchFailed = false) {
    const r = this.flatOverlaps();
    const shellPieces = this.pieces().length;
    let status;
    if (r.loops) status = 'loops';
    else if (r.pairs) status = searchFailed ? 'unresolved' : 'overlap';
    else if (r.pieces > shellPieces) status = 'split';
    else status = 'verified';
    this.net = { status, overlaps: r.pairs, loops: r.loops, pieces: r.pieces, shellPieces, searched: searchFailed };
    return this.net;
  }

  // Spanning tree of each shell piece, grown breadth- or depth-first from
  // its base, taking edges in the order given by `prefer`.
  treeFrom(prefer, depthFirst, pieces = this.pieces()) {
    const hinges = new Set();
    for (const comp of pieces) {
      const root = comp.find((p) => this.isBase(p)) || comp[0];
      const seen = new Set([root]);
      const list = [root];
      while (list.length) {
        const p = depthFirst ? list.pop() : list.shift();
        const es = p.edges.filter((e) => e.shared && !e.locked).sort(prefer);
        for (const e of es) {
          const q = this.other(e, p);
          if (seen.has(q)) continue;
          seen.add(q);
          hinges.add(e);
          list.push(q);
        }
      }
    }
    return hinges;
  }

  // Random spanning forest (one tree per shell piece) that prefers keeping
  // coplanar panels joined.
  randomTree(edges, rng) {
    const w = new Map(edges.map((e) => [e, rng() - (this.isCoplanar(e) ? 0.6 : 0)]));
    const sorted = edges.slice().sort((a, b) => w.get(a) - w.get(b));
    const uf = new Map(this.panels.map((p) => [p, p]));
    const find = (p) => { while (uf.get(p) !== p) { uf.set(p, uf.get(uf.get(p))); p = uf.get(p); } return p; };
    const hinges = new Set();
    for (const e of sorted) {
      const a = find(e.uses[0].panel), b = find(e.uses[1].panel);
      if (a === b) continue;
      uf.set(a, b);
      hinges.add(e);
    }
    return hinges;
  }

  hingeSet() { return new Set(this.sharedEdges().filter((e) => e.type === 'hinge')); }

  // Several different verified nets (one piece per shell piece, flat, no
  // overlaps), for offering alternatives. Leaves the current layout as it
  // was. `exhaustive` is true only when every spanning tree was tried.
  findNets(want = 6, budgetMs = 1500, seed = 11) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const saved = this.hingeSet();
    const edges = this.sharedEdges();
    const shellPieces = this.pieces().length;
    const rng = mulberry32(seed);
    const keyOf = (h) => [...h].map((e) => e.no).sort((a, b) => a - b).join(',');
    const seen = new Set();
    const nets = [];
    let tries = 0;
    let best = null;
    const test = (h) => {
      const k = keyOf(h);
      if (seen.has(k)) return false;
      seen.add(k);
      this.setLayout(h);
      tries++;
      const r = this.flatOverlaps();
      if (!best || r.pairs < best.score) best = { score: r.pairs, hinges: new Set(h) };
      if (r.pairs === 0 && r.loops === 0 && r.pieces === shellPieces) { nets.push(new Set(h)); return true; }
      return false;
    };
    const coplanarFirst = (a, b) => (this.isCoplanar(b) ? 1 : 0) - (this.isCoplanar(a) ? 1 : 0);
    test(this.treeFrom(coplanarFirst, false));
    test(this.treeFrom(() => 0, false));
    test(this.treeFrom(coplanarFirst, true));
    let misses = 0;
    while (nets.length < want && now() - t0 < budgetMs * 0.75 && misses < 400) {
      if (!test(this.randomTree(edges, rng))) misses++;
    }
    if (!nets.length && best) {
      const score = (h) => { this.setLayout(h); tries++; return this.flatOverlaps().pairs; };
      if (this.repairNet(best, edges, score, rng, t0 + budgetMs, now)) {
        const k = keyOf(best.hinges);
        if (!nets.some((n) => keyOf(n) === k)) nets.push(new Set(best.hinges));
      }
    }
    this.setLayout(saved);
    this.classify();
    return { nets, tries, ms: Math.round(now() - t0) };
  }

  // Map from each panel to the root of its hinge tree (one per flat piece).
  pieceRoots(F = this.forest()) {
    const rootOf = new Map();
    for (const p of F.order) { const l = F.parent.get(p); rootOf.set(p, l ? rootOf.get(l.parent) : p); }
    return rootOf;
  }

  // Hinge-connected pieces as arrays of panels.
  hingePieces(F = this.forest()) {
    const rootOf = this.pieceRoots(F);
    const out = new Map();
    for (const p of F.order) {
      const r = rootOf.get(p);
      if (!out.has(r)) out.set(r, []);
      out.get(r).push(p);
    }
    return [...out.values()];
  }

  // Is every panel lying in the surface plane (y = 0 of the shell frame)?
  // Each flat piece is then coplanar. Reports the largest distance from the
  // plane and which way the panels face.
  flatReport(tol = 1e-6) {
    let maxDev = 0, down = 0, up = 0, tilted = 0;
    for (const p of this.panels) {
      for (const v of this.worldPoly(p)) maxDev = Math.max(maxDev, Math.abs(v.y));
      const n = this.worldNormal(p);
      if (n.y < -1 + 1e-9) down++;
      else if (n.y > 1 - 1e-9) up++;
      else tilted++;
    }
    return { ok: maxDev <= tol && tilted === 0, maxDev, down, up, tilted, panels: this.panels.length, pieces: this.hingePieces().length };
  }

  // Overlapping pairs split into pairs inside one flat piece and pairs
  // between different pieces.
  overlapReport() {
    const rootOf = this.pieceRoots();
    const res = this.overlaps();
    let within = 0, between = 0;
    for (const [a, b] of res.pairs) { if (rootOf.get(a) === rootOf.get(b)) within++; else between++; }
    return { ...res, within, between };
  }

  // Default cut-and-hinge layout: a spanning tree of each shell piece whose
  // flat unfolding has no overlapping panels. Tries breadth- and depth-first
  // trees, then random trees that prefer keeping coplanar panels joined,
  // then repairs the best attempt by swapping hinges (a cut edge becomes a
  // hinge, an edge on the loop it closes becomes a cut) within a time limit.
  // Never reports success unless a layout was checked overlap-free.
  defaultNet(budgetMs = 700) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const edges = this.sharedEdges();
    const pieces = this.pieces();
    const rng = mulberry32(7);
    let best = null, tries = 0;
    const score = (hinges) => { this.setLayout(hinges); tries++; return this.flatOverlaps().pairs; };
    const consider = (hinges) => {
      const sc = score(hinges);
      if (!best || sc < best.score) best = { score: sc, hinges: new Set(hinges) };
      return sc === 0;
    };
    const coplanarFirst = (a, b) => (this.isCoplanar(b) ? 1 : 0) - (this.isCoplanar(a) ? 1 : 0);
    const treeFrom = (prefer, depthFirst) => this.treeFrom(prefer, depthFirst, pieces);
    const randomTree = () => this.randomTree(edges, rng);
    let found = consider(treeFrom(coplanarFirst, false)) || consider(treeFrom(() => 0, false)) || consider(treeFrom(coplanarFirst, true));
    while (!found && now() - t0 < budgetMs * 0.4) found = consider(randomTree());
    if (!found && best) found = this.repairNet(best, edges, score, rng, t0 + budgetMs, now);
    if (best) this.setLayout(best.hinges);
    const net = this.classify(!found);
    net.tries = tries;
    net.ms = Math.round(now() - t0);
    return { ok: net.status === 'verified', status: net.status, overlaps: net.overlaps, tries };
  }

  // Local search: swap one hinge for one cut while it does not get worse.
  repairNet(best, edges, score, rng, deadline, now) {
    let cur = new Set(best.hinges);
    let curScore = best.score;
    while (now() < deadline && curScore > 0) {
      const off = edges.filter((e) => !cur.has(e));
      if (!off.length) break;
      const e = off[Math.floor(rng() * off.length)];
      const path = treePath(cur, e.uses[0].panel, e.uses[1].panel, this);
      if (!path || !path.length) continue;
      const f = path[Math.floor(rng() * path.length)];
      cur.delete(f); cur.add(e);
      const sc = score(cur);
      if (sc <= curScore || rng() < 0.04) {
        curScore = sc;
        if (sc < best.score) { best.score = sc; best.hinges = new Set(cur); }
      } else {
        cur.delete(e); cur.add(f);
      }
    }
    return best.score === 0;
  }

  // -------------------------------------------------------- intersections

  // Pairs of panels that pass through each other or overlap in a plane.
  // Contact along shared edges and at corners does not count.
  overlaps(filter = null) {
    const inset = this.edgeLen * 0.02;
    const polys = this.panels.map((p) => {
      const w = this.worldPoly(p);
      const c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length);
      const shrunk = w.map((v) => {
        const d = v.clone().sub(c);
        const len = d.length();
        return c.clone().addScaledVector(d, Math.max(0, len - inset) / len);
      });
      let r = 0;
      for (const v of shrunk) r = Math.max(r, v.distanceTo(c));
      return { poly: shrunk, c, r, n: this.worldNormal(p) };
    });
    const pairs = [];
    const hit = new Set();
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const A = polys[i], B = polys[j];
        if (filter && !filter(this.panels[i], this.panels[j])) continue;
        if (A.c.distanceTo(B.c) > A.r + B.r + 1e-6) continue;
        if (polysIntersect(A, B, this.edgeLen * 2e-3)) {
          pairs.push([this.panels[i], this.panels[j]]);
          hit.add(this.panels[i]); hit.add(this.panels[j]);
        }
      }
    }
    return { pairs, panels: hit };
  }

  // ---------------------------------------------------------- statistics

  stats() {
    const shared = this.sharedEdges();
    const hinges = shared.filter((e) => e.type === 'hinge').length;
    const F = this.forest();
    return {
      panels: this.panels.length,
      removed: this.internal.length * 2,
      hinges,
      cuts: shared.length - hinges,
      locked: this.edges.filter((e) => e.locked).length,
      loops: F.loops.length,
      groups: F.roots.length,
      pieces: this.pieces().length,
    };
  }

  isClosed() { return this.panels.every((p) => isIdentity(p.M)); }

  // ------------------------------------------------------- serialization

  serialize() {
    return {
      types: Object.fromEntries(this.edges.filter((e) => e.shared).map((e) => [e.key, e.type])),
      M: Object.fromEntries(this.panels.map((p) => [p.id, p.M.toArray()])),
      bases: [...this.bases],
      net: this.net ? { status: this.net.status, searched: !!this.net.searched } : null,
    };
  }

  restore(data) {
    if (!data) return;
    for (const e of this.edges) if (e.shared && !e.locked && data.types[e.key]) e.type = data.types[e.key];
    for (const p of this.panels) if (data.M[p.id]) p.M.fromArray(data.M[p.id]);
    if (data.bases) {
      const ids = data.bases.filter((id) => this.panelById.has(id));
      if (ids.length) {
        this.bases = new Set(ids);
        for (const comp of this.pieces()) if (!comp.some((p) => this.bases.has(p.id))) this.chooseBasesFor(comp);
      }
    }
    // Re-check what was saved rather than trusting a stored label.
    this.classify(!!(data.net && data.net.searched && data.net.status === 'unresolved'));
  }

  chooseBasesFor(comp) {
    let best = null, bs = Infinity;
    for (const p of comp) {
      const s = p.normal.y * 10 + p.centroid.y;
      if (s < bs) { bs = s; best = p; }
    }
    this.bases.add(best.id);
  }
}

// ---------------------------------------------------------------- helpers

function components(nodes, nbrs) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const comp = [n];
    seen.add(n);
    for (let i = 0; i < comp.length; i++) {
      for (const m of nbrs(comp[i])) if (m && !seen.has(m)) { seen.add(m); comp.push(m); }
    }
    out.push(comp);
  }
  return out;
}

// Hinge edges on the tree path between two panels (or null).
function treePath(hinges, a, b, shell) {
  const prev = new Map([[a, null]]);
  const queue = [a];
  while (queue.length) {
    const p = queue.shift();
    if (p === b) break;
    for (const e of p.edges) {
      if (!hinges.has(e)) continue;
      const q = shell.other(e, p);
      if (!prev.has(q)) { prev.set(q, { p, e }); queue.push(q); }
    }
  }
  if (!prev.has(b)) return null;
  const out = [];
  for (let cur = b; prev.get(cur); cur = prev.get(cur).p) out.push(prev.get(cur).e);
  return out;
}

function isIdentity(M) {
  const e = M.elements;
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - I[i]) > 1e-6) return false;
  return true;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Do two (already inset) convex planar polygons intersect?
function polysIntersect(A, B, tol) {
  const nA = A.n, nB = B.n;
  const coplanar = Math.abs(nA.dot(nB)) > 0.9995 && Math.abs(B.c.clone().sub(A.c).dot(nA)) < tol;
  if (coplanar) return overlap2D(A.poly, B.poly, nA, tol);
  if (Math.abs(nA.dot(nB)) > 0.9995) return false; // parallel planes
  return crosses(A, B, tol) || crosses(B, A, tol);
}

// Does polygon A cut through the interior of polygon B?
function crosses(A, B, tol) {
  const d = A.poly.map((v) => v.clone().sub(B.c).dot(B.n));
  const pts = [];
  for (let i = 0; i < d.length; i++) {
    const j = (i + 1) % d.length;
    if (Math.abs(d[i]) < 1e-9) pts.push(A.poly[i].clone());
    if ((d[i] > 1e-9 && d[j] < -1e-9) || (d[i] < -1e-9 && d[j] > 1e-9)) {
      const t = d[i] / (d[i] - d[j]);
      pts.push(A.poly[i].clone().lerp(A.poly[j], t));
    }
  }
  if (pts.length < 2) return false;
  let p = pts[0], q = pts[1];
  for (const r of pts) { if (r.distanceTo(p) > q.distanceTo(p)) q = r; }
  // Clip segment p-q to polygon B (in B's plane).
  let t0 = 0, t1 = 1;
  const dir = q.clone().sub(p);
  const n = B.poly.length;
  for (let i = 0; i < n; i++) {
    const a = B.poly[i], b = B.poly[(i + 1) % n];
    const edge = b.clone().sub(a);
    const inward = new THREE.Vector3().crossVectors(B.n, edge).normalize();
    // Make it point toward B's centre.
    if (inward.dot(B.c.clone().sub(a)) < 0) inward.negate();
    const num = p.clone().sub(a).dot(inward);
    const den = dir.dot(inward);
    if (Math.abs(den) < 1e-12) { if (num < 0) return false; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return (t1 - t0) * dir.length() > tol;
}

function overlap2D(P, R, n, tol) {
  const ax = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const e1 = new THREE.Vector3().crossVectors(n, ax).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  const to2 = (poly) => poly.map((v) => [v.dot(e1), v.dot(e2)]);
  const A = to2(P), B = to2(R);
  for (const S of [A, B]) {
    for (let i = 0; i < S.length; i++) {
      const a = S[i], b = S[(i + 1) % S.length];
      let x = -(b[1] - a[1]), y = b[0] - a[0];
      const len = Math.hypot(x, y);
      if (len < 1e-12) continue;
      x /= len; y /= len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of A) { const d = p[0] * x + p[1] * y; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const p of B) { const d = p[0] * x + p[1] * y; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (Math.min(a1, b1) - Math.max(a0, b0) <= tol) return false;
    }
  }
  return true;
}
