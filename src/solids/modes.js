import * as THREE from 'three';
import { SolidsWorkspace, SolidsTools } from './workspace.js';
import { template, TEMPLATES, restHeight } from './polyhedra.js';
import { SHAPES, shapeByKey, shapeName, regularPolygon, attachedPolygon, rigidFrom, matchClosure } from './pieces.js';
import { Solid, Composition, alignFace, isConvexLoop, polyNormal } from './composition.js';
import { resolveNow } from './suggest.js';
import { Shell } from './shell.js';
import { solvePlanar, checkForm } from './vertexedit.js';

// One workspace, two modeling modes. Shape (2D) builds and folds nets from
// flat regular polygons; Solid (3D) works with closed solids. Both act on
// the same objects (the connected groups of panels in one shell). Switching
// mode folds every net that can close into its solid, or unfolds every
// closed solid into its net, with the existing fold animation.

const EDGE = 0.12; // one workspace unit: the edge of a new shape or solid
export const POLYHEDRA = ['cube', 'tetra', 'octa', 'cubocta'];
const CLOSE_TYPES = ['cube', 'tetra', 'octa', 'cubocta'];
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const pairKey = (e) => e.uses.map((u) => `${u.panel.id}#${u.i}`).sort().join('|');
const isIdentity = (m) => { const e = m.elements; const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; return e.every((v, i) => Math.abs(v - I[i]) < 1e-9); };
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const MODE_TOOLS = {
  shape: [
    { key: 'modify', name: 'Edit', tip: 'Tap an edge between two faces to switch it between hinge and cut; drag a corner to change its angle, or an edge to make the face deeper or narrower (flat or folded; it stops at the last valid position)' },
    { key: 'remove', name: 'Remove', tip: 'Tap a face to remove it, or the edge between two faces to merge them' },
    { key: 'move', name: 'Move', tip: 'Drag a shape or net to move it whole; near a matching free edge of another piece it snaps on and joins with a hinge' },
    { key: 'rotate', name: 'Rotate', tip: 'Drag a piece to turn it as a whole; its connections and folds stay' },
    { key: 'fold', name: 'Fold', tip: 'Drag a panel to swing it about its hinge; free edges coming together light up, and close enough they snap together (a neighbouring panel turns to meet it if needed)' },
    { key: 'cut', name: 'Cut & Join', tip: 'Pull a face away from a hinge to cut it (the hinge on the side you pull from; one hinge per drag, and pulling it back onto its edge keeps it); drag a loose piece, or a part you pull off, to a matching free edge to join it with a hinge. A tap on a hinge cuts it' },
    { key: 'mirror', name: 'Mirror', tip: 'Not yet available: reflect a shape or group across a tapped edge, with a preview first (a later stage)', later: true },
    { key: 'preview', name: '3D', tip: 'Show or hide a translucent preview of the net’s folded form beside it (read-only; it follows your edits)' },
  ],
  solid: [
    { key: 'modify', name: 'Modify', tip: 'Drag a corner or an edge of a solid to reshape it; faces stay flat and it stops at the last valid position' },
    { key: 'remove', name: 'Remove', tip: 'Tap a solid to remove it' },
    { key: 'move', name: 'Move', tip: 'Drag a solid or a joined group to move it whole; over a matching face of another solid it snaps on and attaches' },
    { key: 'rotate', name: 'Rotate', tip: 'Drag a solid to turn it freely in any direction, like turning it in your hand' },
    { key: 'cut', name: 'Cut & Join', tip: 'Pull one solid of a joined group away to cut it off; drag a solid onto a matching face of another to join them' },
    { key: 'mirror', name: 'Mirror', tip: 'Not yet available: mirror across a face with a preview and a tick to confirm (next stage)', later: true },
    { key: 'preview', name: '2D', tip: 'Show or hide a translucent preview of the solid’s net beside it (read-only; it follows your edits)' },
  ],
};

const W = SolidsWorkspace.prototype;
const T = SolidsTools.prototype;

// ------------------------------------------------------------------ state

W.initModes = function () {
  this.state.mode = 'shape';
  this.state.shapeType = 'square';
  this.state.solidType = 'cube';
  this.state.mtool = null;
  this.placing = null;
  this.modeIssues = [];
  this.selComp = null;
};

W.componentOf = function (P) { return this.shell.pieces().find((c) => c.includes(P)) || [P]; };

// Every edge joins two panels: the rest form is a closed shell.
W.restClosed = function (comp) { return comp.every((p) => p.edges.every((e) => e.uses.length >= 2)); };

W.isPiecePanel = function (p) { return !!p.piece; };

// The rest form lies flat in one plane (a net being built from shapes). A
// form whose rest is not flat (a solid, or a box with an opening) folds to
// it in Solid and unfolds from it in Shape.
W.restFlat = function (comp) {
  const n = comp[0].normal.clone().normalize();
  const o = comp[0].verts[0];
  const tol = this.edgeLen * 1e-6;
  return comp.every((p) => p.normal.clone().normalize().dot(n) > 1 - 1e-9 && p.verts.every((v) => Math.abs(v.clone().sub(o).dot(n)) < tol));
};

// The pieces of an object: those of its panels, and those hidden inside it
// (faces pressed together where two solids meet), found through shared
// corners.
W.objectPieces = function (comp) {
  const out = new Set();
  const pts = [];
  for (const p of comp) { const pc = this.comp.piece(p.solidId); if (pc && !out.has(pc)) { out.add(pc); pts.push(...pc.verts); } }
  const hidden = [];
  for (const it of this.shell.internal) {
    for (const k of [it.a, it.b]) { const pc = this.comp.piece(Number(String(k).split(':')[0])); if (pc && !out.has(pc) && !hidden.includes(pc)) hidden.push(pc); }
  }
  const tol = this.edgeLen * 1e-5;
  let grew = true;
  while (grew && hidden.length) {
    grew = false;
    for (let i = hidden.length - 1; i >= 0; i--) {
      const pc = hidden[i];
      if (pc.verts.some((v) => pts.some((q) => q.distanceTo(v) < tol))) { out.add(pc); pts.push(...pc.verts); hidden.splice(i, 1); grew = true; }
    }
  }
  return [...out];
};

// The solid a panel belongs to: the pieces of one polyhedron placed in
// Solid, or the pieces of a form built from shapes.
W.solidUnit = function (P) {
  const pc = this.comp.piece(P.solidId);
  if (!pc) return [];
  const all = this.objectPieces(this.componentOf(P));
  return pc.origin != null ? all.filter((x) => x.origin === pc.origin) : all.filter((x) => x.origin == null);
};

// "2 cubes and 1 tetrahedron", "6 shapes"
W.objectText = function (comp) {
  const pcs = this.objectPieces(comp);
  const kinds = new Map();
  const seen = new Set();
  let own = 0;
  for (const pc of pcs) {
    if (pc.origin == null) { if (comp.some((p) => p.solidId === pc.id)) own++; continue; }
    if (seen.has(pc.origin)) continue;
    seen.add(pc.origin);
    kinds.set(pc.kind, (kinds.get(pc.kind) || 0) + 1);
  }
  const parts = [...kinds].map(([k, n]) => `${n} ${n === 1 ? (TEMPLATES[k]?.name || 'solid').toLowerCase() : (TEMPLATES[k]?.plural || 'solids')}`);
  if (own) parts.push(`${own} shape${own === 1 ? '' : 's'}`);
  return parts.join(' and ') || `${comp.length} face${comp.length === 1 ? '' : 's'}`;
};

// "2 cubes and 6 shapes": everything in the workspace (exports, saves).
W.solidsText = function () {
  const kinds = new Map();
  const seen = new Set();
  let own = 0;
  for (const pc of this.comp.pieces) {
    if (pc.origin == null) { own++; continue; }
    if (seen.has(pc.origin)) continue;
    seen.add(pc.origin);
    kinds.set(pc.kind, (kinds.get(pc.kind) || 0) + 1);
  }
  for (const s of this.comp.solids) kinds.set(s.type, (kinds.get(s.type) || 0) + 1);
  const parts = [...kinds].map(([k, n]) => `${n} ${n === 1 ? (TEMPLATES[k]?.name || 'solid').toLowerCase() : (TEMPLATES[k]?.plural || 'solids')}`);
  if (own) parts.push(`${own} shape${own === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'empty';
};

// Solids stored as polyhedra (saves from earlier versions) become pieces,
// so every tool of both modes works on them. Cuts, hinges and poses carry
// over by panel id.
W.adoptSolids = function () {
  const c = this.comp;
  if (!c.solids.length) return false;
  const st = this.stateById();
  const faces = c.shapedFaces();
  const idMap = new Map();
  const origins = new Map();
  for (const f of faces) {
    if (f.solid.piece) { const pc = c.piece(f.solid.id); if (pc) pc.verts = f.verts.map((v) => v.clone()); continue; }
    const oldId = f.pid || `${f.solid.id}:${f.fi}`;
    if (!origins.has(f.solid.id)) origins.set(f.solid.id, c.nextId++);
    const pc = c.addPiece(f.verts.length, f.verts);
    pc.kind = f.solid.type;
    pc.origin = origins.get(f.solid.id);
    idMap.set(oldId, `${pc.id}:0`);
  }
  c.solids = []; c.edits = new Map(); c.tri = new Map(); c.merge = []; c.shape.set(1, 1, 1);
  const to = (id) => idMap.get(id) || id;
  const mapKey = (k) => k.split('|').map((u) => { const h = u.lastIndexOf('#'); return `${to(u.slice(0, h))}#${u.slice(h + 1)}`; }).sort().join('|');
  const st2 = { edges: new Map([...st.edges].map(([k, v]) => [mapKey(k), v])), M: new Map([...st.M].map(([id, m]) => [to(id), m])), bases: st.bases.map(to) };
  this.shell.build(c);
  this.restoreById(st2);
  this.refreshAll();
  return true;
};

const loadData0 = W.loadData;
W.loadData = function (data, verb) {
  this.lastRefold = null;
  this.selComp = null;
  const ok = loadData0.call(this, data, verb);
  if (ok && this.comp.solids.length) { const before = this.history.pop(); this.adoptSolids(); if (before) this.history.push(before); }
  return ok;
};

const preset0 = W.preset;
W.preset = function (name, record = true) {
  preset0.call(this, name, record);
  this.adoptSolids();
};

// The faces of a polyhedron at a pose, and the pieces they become.
W.solidFacesFor = function (type, edge, position, quaternion) {
  return new Solid(-1, type, edge, position, quaternion).worldFaces().map((f) => ({ verts: f.verts, normal: f.normal, centroid: f.centroid }));
};

W.addSolidPieces = function (type, faces) {
  const origin = this.comp.nextId++;
  for (const f of faces) { const pc = this.comp.addPiece(f.verts.length, f.verts); pc.kind = type; pc.origin = origin; }
  return origin;
};

// What a new solid would run into: a face it passes through or overlaps
// (whole-face contact is fine: that is how solids join), a form inside it.
W.solidProblem = function (faces) {
  const sh = this.shell;
  const p = sh.meets(faces);
  if (p) return { panel: p };
  const tol = this.edgeLen * 1e-4;
  const planes = faces.map((f) => { const n = f.normal.clone().normalize(); return { n, d: n.dot(f.verts[0]) }; });
  for (const q of sh.panels) for (const v of sh.worldPoly(q)) if (planes.every((pl) => pl.n.dot(v) - pl.d < -tol)) return { panel: q };
  return null;
};

W.flashPanel = function (P) {
  if (!P) return;
  this.flashPanels = new Set([P]);
  this.refreshStyles();
  clearTimeout(this.flashPanelsTimer);
  this.flashPanelsTimer = setTimeout(() => { this.flashPanels = null; this.refreshStyles(); }, 1600);
};

// Lowest point of an object (shell frame).
W.lowestY = function (comp) {
  let y = Infinity;
  for (const p of comp) for (const v of this.shell.worldPoly(p)) y = Math.min(y, v.y);
  return y;
};

// Hinge and cut types, poses and bases by panel id and edge index, so they
// survive a rebuild in which corner positions move.
W.stateById = function () {
  const edges = new Map();
  for (const e of this.shell.edges) if (e.shared && e.uses.length === 2) edges.set(pairKey(e), { type: e.type, lock: e.userLock });
  return { edges, M: new Map(this.shell.panels.map((p) => [p.id, p.M.clone()])), bases: [...this.shell.bases] };
};

W.restoreById = function (st, { hinges = [], skip = null } = {}) {
  const sh = this.shell;
  for (const e of sh.edges) {
    if (!e.shared || e.locked || e.uses.length !== 2) continue;
    if (skip && skip(e)) continue;
    const k = pairKey(e);
    const o = st.edges.get(k);
    if (o) { e.type = o.type; e.userLock = o.lock; } else if (hinges.includes(k)) e.type = 'hinge';
  }
  for (const p of sh.panels) { const m = st.M.get(p.id); if (m) p.M.copy(m); }
  const ids = st.bases.filter((id) => sh.panelById.has(id));
  sh.bases = new Set(ids);
  for (const comp of sh.pieces()) if (!comp.some((p) => sh.bases.has(p.id))) sh.chooseBasesFor(comp);
};

// After the composition changed: shell, meshes and checks, keeping state.
W.refreshAll = function () {
  this.shell.classify();
  this.loopEdges.clear();
  this.moving.clear();
  this.netCycle = null;
  this.updatePivot();
  this.buildMeshes();
  this.applyView();
  this.checkOverlaps();
  this.app.layoutTable?.();
  this.app.notify?.();
};

W.rebuildKeep = function (mutate, opts = {}) {
  const st = this.stateById();
  mutate(st);
  this.shell.build(this.comp);
  if (opts.defaultNet) this.shell.defaultNet();
  this.restoreById(st, opts);
  if (opts.after) opts.after();
  this.refreshAll();
};

// ------------------------------------------------------------------ modes

W.setMode = function (m) {
  if (m !== 'shape' && m !== 'solid') return;
  this.tools.finishAll();
  this.stopAnim();
  this.placing = null;
  this.hidePlacePreview();
  this.showPlaceZone(false);
  this.state.mode = m;
  this.state.mtool = null;
  this.state.tool = 'select';
  this.selComp = null;
  this.detach = null;
  this.modeIssues = [];
  const before = this.snapshot();
  const r = m === 'solid' ? this.foldClosable() : this.unfoldClosed();
  if (r.changed) this.pushHistory(before);
  if (m === 'solid' && this.modeIssues.length && !(this.anim && this.anim.check && this.anim.check.kind === 'zip')) this.setRefoldReport({ summary: `${this.modeIssues.length} object${this.modeIssues.length === 1 ? '' : 's'} could not close`, issues: this.modeIssues });
  if (this.anim && this.anim.check && this.anim.check.kind === 'zip') this.anim.check.issues = this.modeIssues.slice();
  const tail = this.modeIssues.length ? (m === 'solid' ? ` ${this.modeIssues.length} object${this.modeIssues.length === 1 ? '' : 's'} could not close · details in Info` : ` ${this.modeIssues.length} object${this.modeIssues.length === 1 ? '' : 's'} could not unfold: ${this.modeIssues[0].text}`) : '';
  if (r.changed && this.anim) this.anim.msg = `${m === 'solid' ? 'Solid (3D)' : 'Shape (2D)'}. ${this.anim.msg}${tail}`;
  else this.app.toast(`${m === 'solid' ? 'Solid (3D)' : 'Shape (2D)'}.${tail}`, tail ? 7000 : 3000);
  this.refreshStyles();
  this.app.notify?.();
};

// Is a face lying face down on the surface?
W.lyingFlat = function (p) {
  const sh = this.shell;
  return sh.worldNormal(p).normalize().y < -1 + 1e-6 && sh.worldPoly(p).every((v) => Math.abs(v.y) < 1e-5);
};

// The poses that lay some objects flat, from where their faces are now and
// how they are connected: every hinge-connected piece (also the ones joined
// to the rest only by cuts) is turned face down where it is and opened at
// its hinges; a piece that would then overlap something slides clear.
W.flatPlan = function (comps) {
  const sh = this.shell;
  const F = sh.forest();
  const from = sh.forestAngles(F);
  const flat = sh.flatAngles(F);
  const to = new Map(from);
  const rootOf = sh.pieceRoots(F);
  const saved = sh.panels.map((p) => p.M.clone());
  const set = new Set(comps.flat());
  const targets = new Map();
  const down = new THREE.Vector3(0, -1, 0);
  const centre = (ps) => { const c = new THREE.Vector3(); let n = 0; for (const p of ps) for (const v of sh.worldPoly(p)) { c.add(v); n++; } return c.divideScalar(Math.max(1, n)); };
  for (const comp of comps) {
    for (const p of comp) if (F.parent.has(p)) to.set(p, flat.get(p));
    for (const r of new Set(comp.map((p) => rootOf.get(p)))) {
      const n = sh.worldNormal(r).normalize();
      const c = centre([r]);
      const q = new THREE.Quaternion().setFromUnitVectors(n, down);
      targets.set(r, new THREE.Matrix4().makeTranslation(c.x, 0, c.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)).multiply(r.M.clone()));
    }
  }
  const apply = () => sh.applyForest(F, to, targets);
  apply();
  // Hinges that close a loop and would be torn apart lying flat.
  const torn = F.loops.filter((e) => set.has(e.uses[0].panel) && !sh.intact(e));
  // Pieces that would overlap another piece or another object slide away.
  for (const comp of comps) {
    const rs = [...new Set(comp.map((p) => rootOf.get(p)))];
    if (rs.length < 2) continue;
    const of = (r) => comp.filter((p) => rootOf.get(p) === r);
    const main = rs.find((r) => sh.bases.has(r.id)) || rs.slice().sort((a, b) => of(b).length - of(a).length)[0];
    for (const r of rs) {
      if (r === main) continue;
      const mine = new Set(of(r));
      const clash = () => sh.overlaps().pairs.some(([a, b]) => mine.has(a) !== mine.has(b));
      if (!clash()) continue;
      const dir = centre([...mine]).sub(centre(of(main)));
      dir.y = 0;
      if (dir.length() < 1e-9) dir.set(1, 0, 0);
      dir.normalize().multiplyScalar(this.edgeLen * 0.2);
      for (let k = 0; k < 80 && clash(); k++) { targets.get(r).premultiply(new THREE.Matrix4().makeTranslation(dir.x, 0, dir.z)); apply(); }
    }
  }
  const self = sh.overlaps().pairs.filter(([a, b]) => set.has(a) && rootOf.get(a) === rootOf.get(b));
  sh.panels.forEach((p, i) => p.M.copy(saved[i]));
  const roots = new Map([...targets].map(([r, M]) => [r, { from: r.M.clone(), to: M }]));
  return { F, from, to, roots, torn, self, pieces: targets.size };
};

// The poses that fold some objects into their 3D (rest) form: every hinge
// back to its rest angle and every piece back to its place, including
// pieces joined to the rest only by cuts.
W.foldPlan = function (comps) {
  const sh = this.shell;
  const F = sh.forest();
  const from = sh.forestAngles(F);
  const to = new Map(from);
  const rootOf = sh.pieceRoots(F);
  const roots = new Map();
  const final = new Map();
  for (const comp of comps) {
    for (const p of comp) { if (F.parent.has(p)) to.set(p, 0); final.set(p, new THREE.Matrix4()); }
    for (const r of new Set(comp.map((p) => rootOf.get(p)))) roots.set(r, { from: r.M.clone(), to: new THREE.Matrix4() });
  }
  return { F, from, to, roots, final };
};

W.runPlan = function (plan, msg, check) {
  this.anim = { kind: 'forest', F: plan.F, from: plan.from, to: plan.to, roots: plan.roots.size ? plan.roots : null, t: 0, dur: 1.2, label: 'mode', final: plan.final && plan.final.size ? plan.final : null, msg, check };
};

// Shape → Solid and Refold: nets built from shapes that close into a known
// solid get that solid's form; then every object whose form is 3D (a solid,
// or a box with an opening) and is not in that form folds into it.
W.foldClosable = function () {
  const sh = this.shell;
  let converted = 0;
  const zipIds = [];
  for (const comp of sh.pieces()) {
    // Anything not already a closed form may close into a known solid as
    // it is connected now (a net built from shapes, or a form a part was
    // cut from and joined back to). An open form that does not folds into
    // its own 3D form below.
    if (this.restClosed(comp)) continue;
    if (!comp.every((p) => this.isPiecePanel(p))) continue;
    const flatRest = this.restFlat(comp);
    if (comp.length < 3) { if (flatRest && comp.some((p) => !this.lyingFlat(p))) this.modeIssues.push({ kind: 'close', short: `${comp.length === 1 ? 'a single shape' : 'two shapes'} cannot fold into a solid`, text: `${comp.length === 1 ? 'A single shape' : 'Two shapes'} cannot fold into a solid, so ${comp.length === 1 ? 'it stays' : 'they stay'} as ${comp.length === 1 ? 'it is' : 'they are'}.`, ids: comp.map((p) => p.id) }); continue; }
    const r = this.closeByLibrary(comp);
    if (r.ok) converted++;
    else zipIds.push({ id: comp[0].id, n: comp.length, flatRest, reason: r.reason });
  }
  // Not a known solid: fold it and join the edges that come together.
  const F = sh.forest();
  const zips = [];
  for (const z of zipIds) {
    const P = sh.panelById.get(z.id);
    const comp = P && this.componentOf(P);
    if (!comp) continue;
    const r = this.zipFold(comp, F, { rest: !z.flatRest });
    if (r.reason || !r.pairs.length) {
      if (z.flatRest) {
        const rows = r.open ? this.zipRows(r) : [];
        this.modeIssues.push({ kind: 'close', short: r.reason ? 'some pieces are joined only by cut edges' : 'no edges can be brought together', text: `A net of ${z.n} faces stays as it is: ${r.reason || 'no free edges can be brought together'}.`, ids: comp.map((p) => p.id), rows });
      }
      continue;
    }
    zips.push({ comp, r });
  }
  const zipped = new Set(zips.flatMap((z) => z.comp));
  const comps = sh.pieces().filter((c) => !zipped.has(c[0]) && !this.restFlat(c) && !c.every((p) => isIdentity(p.M)));
  if (!comps.length && !zips.length) return { changed: converted > 0, n: 0 };
  const plan = this.foldPlan(comps);
  plan.F = F;
  plan.from = sh.forestAngles(F);
  for (const [p, v] of plan.from) if (!plan.to.has(p) || !comps.some((c) => c.includes(p))) plan.to.set(p, v);
  for (const c of comps) for (const p of c) if (F.parent.has(p)) plan.to.set(p, 0);
  for (const { comp, r } of zips) {
    for (const [p, v] of r.x) plan.to.set(p, plan.from.get(p) + wrapAngle(v - plan.from.get(p)));
    const root = comp.find((p) => !F.parent.has(p));
    if (r.rest) plan.roots.set(root, { from: root.M.clone(), to: r.rootTo.clone() });
  }
  if (zips.length) {
    // A form folded down through the surface rises to sit on it.
    const saved = sh.panels.map((p) => p.M.clone());
    const rootMs = new Map([...plan.roots].map(([r, m]) => [r, m.to]));
    sh.applyForest(F, plan.to, rootMs);
    for (const { comp } of zips) {
      const low = this.lowestY(comp);
      if (low < -this.edgeLen * 1e-6) {
        const root = comp.find((p) => !F.parent.has(p));
        const to = new THREE.Matrix4().makeTranslation(0, -low, 0).multiply(rootMs.get(root) || root.M.clone());
        plan.roots.set(root, { from: saved[sh.panels.indexOf(root)].clone(), to });
      }
    }
    sh.panels.forEach((p, i) => p.M.copy(saved[i]));
  }
  const n = comps.length + zips.length;
  const msg = zips.length
    ? `Folded ${n} object${n === 1 ? '' : 's'}.`
    : `Folded ${comps.length} object${comps.length === 1 ? '' : 's'} into ${comps.length === 1 ? 'its' : 'their'} 3D form.`;
  this.runPlan(plan, msg, zips.length
    ? { kind: 'zip', ids: new Set(comps.flat().map((p) => p.id)), zips: zips.map(({ comp, r }) => ({ id: comp[0].id, n: comp.length, pairs: r.pairs.map(([a, b]) => [{ p: a.p, i: a.i }, { p: b.p, i: b.i }]), rows: this.zipRows(r), open: r.open.length })) }
    : { kind: 'closed', ids: new Set(comps.flat().map((p) => p.id)) });
  return { changed: true, n };
};

// Solid → Shape: objects in their 3D form open into their nets.
W.unfoldClosed = function () {
  const comps = this.shell.pieces().filter((c) => !this.restFlat(c) && c.every((p) => isIdentity(p.M)));
  return this.unfoldComps(comps);
};

W.unfoldComps = function (comps) {
  if (!comps.length) return { changed: false, n: 0 };
  const plan = this.flatPlan(comps);
  if (plan.torn.length) {
    const e = plan.torn[0];
    this.modeIssues.push({ kind: 'loop', text: `Hinges form a closed loop (edge ${e.no}, between P${e.uses[0].panel.no} and P${e.uses[1].panel.no}), so that object cannot lie flat. Cut one hinge of the loop (Edit: tap it).`, ids: e.uses.map((u) => u.panel.id) });
    return { changed: false, n: 0, blocked: true };
  }
  const n = comps.length;
  const flatIds = new Set(comps.flat().map((p) => p.id));
  this.comp.seams = this.comp.seams.filter(([a, b]) => !flatIds.has(a.split('#')[0]) && !flatIds.has(b.split('#')[0]));
  const self = plan.self.length ? ` ${plan.self.length} face pair${plan.self.length === 1 ? ' overlaps' : 's overlap'} in the flat layout (red): see Error.` : '';
  this.runPlan(plan, `Laid ${n} object${n === 1 ? '' : 's'} flat (${plan.pieces} piece${plan.pieces === 1 ? '' : 's'}, every face face down on the surface).${self}`, { kind: 'flat', ids: new Set(comps.flat().map((p) => p.id)) });
  return { changed: true, n };
};

// Top toolbar. Unfold lays flat every object that has any face not lying
// face down on the surface, whatever its connections. Refold folds every
// object into its 3D form where that is possible, and says why not.
W.topUnfold = function () {
  this.tools.finishAll(); this.stopAnim(); this.placing = null; this.hidePlacePreview(); this.clearDetach(false);
  this.modeIssues = [];
  const comps = this.shell.pieces().filter((c) => c.some((p) => !this.lyingFlat(p)));
  if (!comps.length) { this.app.toast(this.shell.panels.length ? 'Everything already lies flat: every face is face down on the surface.' : 'Nothing to unfold yet.'); return; }
  const before = this.snapshot();
  const r = this.unfoldComps(comps);
  if (r.changed) this.pushHistory(before);
  else this.app.toast(`Nothing was unfolded: ${this.modeIssues.map((m) => m.text).join(' ')}`, 7000);
  this.app.notify?.();
};

W.topRefold = function () {
  this.tools.finishAll(); this.stopAnim(); this.placing = null; this.hidePlacePreview(); this.clearDetach(false);
  this.modeIssues = [];
  const before = this.snapshot();
  const r = this.foldClosable();
  if (r.changed) this.pushHistory(before);
  if (!r.changed) {
    if (this.modeIssues.length) {
      this.setRefoldReport({ summary: `Not folded · ${this.modeIssues.length === 1 ? (this.modeIssues[0].short || 'it cannot fold') : `${this.modeIssues.length} objects cannot fold`}`, issues: this.modeIssues });
      this.app.toast(`${this.lastRefold.summary} · details in Info`, 5000);
    } else this.app.toast(this.shell.panels.length ? 'Everything is already in its 3D form.' : 'Nothing to fold yet.', 4000);
  } else if (this.anim && this.modeIssues.length && !(this.anim.check && this.anim.check.kind === 'zip')) {
    this.setRefoldReport({ summary: `Folded · ${this.modeIssues.length} not folded`, issues: this.modeIssues });
    this.anim.msg += ` ${this.modeIssues.length} object${this.modeIssues.length === 1 ? '' : 's'} not folded · details in Info`;
  }
  if (this.anim && this.anim.check && this.anim.check.kind === 'zip') this.anim.check.issues = this.modeIssues.slice();
  this.app.notify?.();
};

// The last Refold's full report (Info → Last Refold): a summary and rows,
// each naming the edges Refold tried to join and the faces in the way.
W.setRefoldReport = function ({ summary, sections = [], issues = [] }) {
  const secs = sections.slice();
  for (const m of issues) secs.push({ title: m.text, rows: (m.rows && m.rows.length) ? m.rows : [{ text: m.text, edges: [], blockers: m.ids || [] }] });
  this.lastRefold = { summary, sections: secs, at: Date.now() };
};

// Tapping a row of the report: the edges it names light up (orange) and the
// faces in the way turn red, with their numbers, for a few seconds.
W.focusRefold = function (row) {
  const sh = this.shell;
  const edges = new Set(), faces = new Set();
  for (const [id, i] of row.edges || []) { const P = sh.panelById.get(id); if (P && P.edges[i]) { edges.add(P.edges[i]); faces.add(P); } }
  const blockers = new Set((row.blockers || []).map((id) => sh.panelById.get(id)).filter(Boolean));
  this.refoldEdges = edges.size ? edges : null;
  this.flashPanels = blockers.size ? blockers : null;
  this.refreshStyles();
  const named = [...new Set([...faces, ...blockers])];
  this.showIdLabels(named);
  const box = new THREE.Box3();
  for (const P of named) for (const v of sh.worldPoly(P)) box.expandByPoint(v);
  if (!box.isEmpty()) this.app.focusBox?.(this.worldBox(box));
  this.setTag(row.text.length > 110 ? `${row.text.slice(0, 108)}…` : row.text);
  clearTimeout(this.refoldTimer);
  this.refoldTimer = setTimeout(() => { this.refoldEdges = null; this.flashPanels = null; this.refreshStyles(); this.hideTag(); }, 8000);
};

// A net of pieces that matches a solid gets that solid's closed form as its
// rest form, keeping its current pose, so it can fold closed.
W.closeByLibrary = function (comp) {
  const sh = this.shell;
  if (sh.hingeComponent(comp[0]).size !== comp.length) return { reason: 'some of its pieces are joined to the rest only by cut edges, not hinges. Join them with hinges (drag a piece back to its edge with Cut & Join, or tap a cut edge with Edit where both sides meet) first.' };
  const r = matchClosure(comp, CLOSE_TYPES, (p) => sh.worldPoly(p));
  if (r.reason) return { reason: r.reason.charAt(0).toLowerCase() + r.reason.slice(1) };
  const poses = new Map();
  for (const p of comp) poses.set(p.id, rigidFrom(r.closed.get(p).slice(0, 3), sh.worldPoly(p).slice(0, 3)));
  const ids = new Set(comp.map((p) => p.id));
  this.rebuildKeep(() => {
    for (const p of comp) this.comp.piece(p.solidId).verts = r.closed.get(p).map((v) => v.clone());
    this.comp.seams = this.comp.seams.filter(([a, b]) => !ids.has(a.split('#')[0]) && !ids.has(b.split('#')[0]));
  }, { after: () => {
    for (const p of sh.panels) if (poses.has(p.id)) p.M.copy(poses.get(p.id));
    for (const id of ids) sh.bases.delete(id);
    sh.bases.add(r.root.id);
  } });
  return { ok: true, type: r.type };
};

// Arrange. Shape: everything flat on the surface, pieces side by side.
// Solid: every object set down on the surface as it is, turned however
// you left it, moved straight down (or up) until its lowest point touches.
W.arrangeAll = function () {
  if (this.comp.isEmpty()) { this.app.toast('Nothing to arrange yet.'); return; }
  this.tools.finishAll(); this.placing = null; this.hidePlacePreview(); this.clearDetach();
  if (this.state.mode === 'solid') { this.setDownAll(); return; }
  this.layFlat({ arrange: true });
};

W.setDownAll = function () {
  const sh = this.shell;
  const before = this.snapshot();
  const tol = this.edgeLen * 1e-6;
  // Lowest first, so that what sits low is set down before what is above it.
  const objs = sh.pieces().map((c) => ({ ids: c.map((p) => p.id), low: this.lowestY(c) })).sort((a, b) => a.low - b.low);
  let moved = 0;
  const stuck = [];
  for (const o of objs) {
    if (Math.abs(o.low) < tol) continue;
    const comp = o.ids.map((id) => sh.panelById.get(id)).filter(Boolean);
    if (!comp.length) continue;
    const T = new THREE.Matrix4().makeTranslation(0, -o.low, 0);
    const job = this.moveStart(comp, new THREE.Vector3());
    const bad = this.snapProblem(job, T);
    if (bad) { stuck.push(bad.replace(/^it /, '')); continue; }
    this.transformComponent(comp, T);
    moved++;
  }
  if (moved) this.pushHistory(before);
  const tail = stuck.length ? ` ${stuck.length} object${stuck.length === 1 ? ' stays where it is: it' : 's stay where they are: they'} ${stuck[0]}.` : '';
  this.app.toast(moved ? `Set ${moved} object${moved === 1 ? '' : 's'} down on the surface, turned as ${moved === 1 ? 'it was' : 'they were'}: moved straight down until the lowest point touches.${tail}` : `Everything already rests on the surface.${tail}`, 5000);
  this.app.notify?.();
};

// Alternate: another net for the same solid. It works on the selected
// object (or the only one, or the largest), including a net built by hand
// from shapes that folds into a known solid. Each press shows another
// layout that is genuinely different (not the same shape turned or
// mirrored), flat and free of overlaps, and folds back into the same solid.
// If no single-piece net is found, the one needing the fewest extra cuts is
// used and the cuts and pieces are reported. If nothing valid is found, the
// layout stays as it is. Undo brings back the previous layout.
W.alternateNet = function (opts = {}) {
  if (this.comp.isEmpty()) { this.app.toast('Nothing to rearrange yet.'); return; }
  this.tools.finishAll(); this.stopAnim(); this.placing = null; this.hidePlacePreview(); this.clearDetach(false);
  const sh = this.shell;
  const objs = sh.pieces();
  // The selected object, if the selection is of faces that still exist.
  const selP = this.selComp && this.selComp.size ? [...this.selComp].find((p) => sh.panelById.get(p.id) === p) : null;
  let comp = selP ? this.componentOf(selP) : null;
  if (!comp || !comp.length) comp = objs.slice().sort((a, b) => b.length - a.length)[0];
  if (comp.length < 2) { this.app.toast('Alternate needs a net of at least two faces.'); return; }
  const t0 = performance.now();
  const r = this.findAlternate(comp, opts);
  if (r.error) { this.app.toast(r.error, 6500); return; }
  const before = this.snapshot();
  const ids = new Set(comp.map((p) => p.id));
  // Check the new layout where it will lie, then go back and show the
  // change: the current layout folds up into the solid, then the solid
  // opens out into the new net (in Solid too, so the net can be seen).
  const ok = this.applyAlternate(comp, r);
  if (!ok.ok) { this.restoreSnapshot(before); this.app.toast(`No other layout could be placed: ${ok.why}. Your layout stays as it is.`, 6000); return; }
  const finalMs = new Map(sh.panels.filter((p) => ids.has(p.id)).map((p) => [p.id, p.M.clone()]));
  this.restoreSnapshot(before);
  this.pushHistory(before);
  this.netCycle = null;
  const ch = r.choice;
  const which = r.options.length > 1 ? ` ${r.index + 1} of ${r.options.length}${r.exhaustive ? '' : '+'}` : '';
  const how = ch.cuts ? `${ch.pieces} pieces (${ch.cuts} extra cut${ch.cuts === 1 ? '' : 's'} to avoid overlaps)` : 'one piece';
  const msg = `Alternate net${which} · ${r.name} · ${how}. Refold folds it back; Undo restores your layout.`;
  this.altTiming = Math.round(performance.now() - t0);
  this.startAlternateAnim(ids, r, finalMs, msg);
  this.app.notify?.();
};

// The two halves of Alternate's animation. First the current layout folds
// up (about its own hinges) into the closed solid, around its base face;
// then, with the new hinges, the solid opens out into the new net.
W.startAlternateAnim = function (ids, r, finalMs, msg) {
  const sh = this.shell;
  const comp = sh.panels.filter((p) => ids.has(p.id));
  const F = sh.forest();
  const closedOf = (p) => (r.closed && r.closed.get(p.id)) || p.verts;
  const R = new Map(comp.map((p) => [p, rigidFrom(p.verts.slice(0, 3), closedOf(p).slice(0, 3))]));
  const roots = F.roots.filter((x) => ids.has(x.id));
  const base = roots.slice().sort((x, y) => sh.hingeComponent(y).size - sh.hingeComponent(x).size)[0] || comp[0];
  const A = base.M.clone().multiply(R.get(base).clone().invert());
  const target = new Map(comp.map((p) => [p, A.clone().multiply(R.get(p))]));
  const st = { ids, r, finalMs, msg, A };
  const same = (m, n) => m.elements.every((v, i) => Math.abs(v - n.elements[i]) < 1e-9);
  if (comp.every((p) => same(p.M, target.get(p)))) { this.alternateOpen(st, true); return; }
  const from = sh.forestAngles(F);
  const saved = comp.map((p) => p.M.clone());
  for (const p of comp) p.M.copy(target.get(p));
  const ta = sh.forestAngles(F);
  comp.forEach((p, i) => p.M.copy(saved[i]));
  const to = new Map(from);
  for (const p of comp) if (F.parent.has(p)) to.set(p, from.get(p) + wrapAngle(ta.get(p) - from.get(p)));
  const rootsMap = new Map(roots.map((x) => [x, { from: x.M.clone(), to: target.get(x).clone() }]));
  this.anim = { kind: 'forest', F, from, to, roots: rootsMap, t: 0, dur: 0.85, label: 'alt-fold', final: target, alt: st };
};

// Second half: the new hinges, and the solid opening into the new net.
// (Straight to the result when the animation was cut short.)
W.alternateOpen = function (st, animate) {
  const sh = this.shell;
  const comp = sh.panels.filter((p) => st.ids.has(p.id));
  const ok = this.applyAlternate(comp, st.r, { Ms: st.finalMs });
  if (!ok.ok) { this.app.toast(`The alternate net could not be placed: ${ok.why}. Undo restores your layout.`, 6000); this.app.notify?.(); return; }
  const mine = sh.panels.filter((p) => st.ids.has(p.id));
  const finals = new Map(mine.map((p) => [p, p.M.clone()]));
  const done = () => {
    for (const [p, m] of finals) p.M.copy(m);
    this.updateMatrices();
    this.afterMotion(false);
    this.checkOverlaps?.();
    this.refreshStyles();
    this.frameView?.(true);
    this.app.toast(st.msg, 6000);
    this.app.notify?.();
  };
  if (!animate) { done(); return; }
  const F = sh.forest();
  const to = sh.forestAngles(F);
  for (const p of mine) p.M.copy(st.A);
  const from = sh.forestAngles(F);
  for (const [p, v] of from) to.set(p, st.ids.has(p.id) ? v + wrapAngle(to.get(p) - v) : v);
  const roots = F.roots.filter((x) => st.ids.has(x.id));
  this.updateMatrices();
  this.anim = { kind: 'forest', F, from, to, roots: new Map(roots.map((x) => [x, { from: st.A.clone(), to: finals.get(x).clone() }])), t: 0, dur: 1.1, label: 'alt-open', final: finals, done };
};

// A fingerprint of a flat layout that is the same for the same layout
// turned, moved or mirrored, and differs for different layouts: for every
// face its number of corners and its distances to every other face.
W.layoutSig = function (polys) {
  const cs = polys.map((w) => w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length));
  const r = (x) => Math.round(x * 2e4);
  return cs.map((c, i) => `${polys[i].length}:${cs.map((d, j) => (i === j ? null : r(c.distanceTo(d)))).filter((x) => x !== null).sort((a, b) => a - b).join(',')}`).sort().join('|');
};

// Search other layouts of the object's solid, in a separate shell holding
// only this object in its closed form.
W.findAlternate = function (comp, opts = {}) {
  const sh = this.shell;
  const ids = new Set(comp.map((p) => p.id));
  let closed = null, name = 'form';
  if (this.restFlat(comp)) {
    if (sh.hingeComponent(comp[0]).size !== comp.length) return { error: 'Alternate needs the whole net joined by hinges. Some faces here are only held by cut edges; join them with Edit (tap the edge) first.' };
    const m = matchClosure(comp, CLOSE_TYPES, (p) => sh.worldPoly(p));
    if (m.reason) return { error: `Alternate looks for other nets of the solid a net folds into, and this net does not fold into a known solid (cube, tetrahedron, octahedron, cuboctahedron): ${m.reason.charAt(0).toLowerCase() + m.reason.slice(1)} Your layout stays as it is.` };
    closed = new Map(comp.map((p) => [p.id, m.closed.get(p)]));
    name = TEMPLATES[m.type].name.toLowerCase();
  } else if (!this.restClosed(comp)) {
    return { error: 'Alternate works on nets of closed solids. This form has an opening, so it keeps its layout.' };
  } else {
    const pcs = this.objectPieces(comp);
    const kinds = new Set(pcs.map((pc) => pc.kind).filter(Boolean));
    if (kinds.size === 1 && new Set(pcs.map((pc) => pc.origin)).size === 1) name = TEMPLATES[[...kinds][0]].name.toLowerCase();
    else {
      // A form closed from shapes: name it by its faces when it is one of the solids.
      const t = pcs.filter((pc) => pc.verts.length === 3).length, q = pcs.filter((pc) => pc.verts.length === 4).length;
      const same = pcs.every((pc) => pc.verts.every((v, i) => Math.abs(v.distanceTo(pc.verts[(i + 1) % pc.verts.length]) - pcs[0].verts[0].distanceTo(pcs[0].verts[1])) < 1e-6));
      const known = { '0,6': 'cube', '4,0': 'tetrahedron', '8,0': 'octahedron', '8,6': 'cuboctahedron' }[`${t},${q}`];
      name = same && known && t + q === pcs.length ? known : 'form';
    }
  }
  const tc = new Composition();
  let maxId = 0;
  for (const pc of this.objectPieces(comp)) {
    const verts = (closed && closed.get(`${pc.id}:0`)) || pc.verts;
    tc.pieces.push({ id: pc.id, n: verts.length, kind: pc.kind, origin: pc.origin, verts: verts.map((v) => v.clone()) });
    maxId = Math.max(maxId, pc.id);
  }
  tc.nextId = maxId + 1;
  const sub = new Shell();
  sub.build(tc);
  const keyOf = (h) => [...h].map(pairKey).sort().join(';');
  const curKeys = new Set(sh.edges.filter((e) => e.uses.length === 2 && e.type === 'hinge' && e.uses.every((u) => ids.has(u.panel.id))).map(pairKey));
  const flatPose = (h) => {
    sub.setLayout(h);
    for (const p of sub.panels) p.M.identity();
    const F = sub.forest();
    sub.applyForest(F, sub.flatAngles(F));
    return F;
  };
  const sigOf = (h) => { flatPose(h); return this.layoutSig(sub.panels.map((p) => sub.worldPoly(p))); };
  const curSet = new Set(sub.edges.filter((e) => curKeys.has(pairKey(e))));
  const curSig = sigOf(curSet);
  const options = [];
  const found = sub.findNets(opts.want || 30, opts.budgetMs || 1500, opts.seed || 11);
  if (!opts.forceRepair) {
    for (const h of found.nets) {
      if (keyOf(h) === keyOf(curSet)) continue;
      const sig = sigOf(h);
      if (sig === curSig || options.some((o) => o.sig === sig)) continue;
      options.push({ hinges: h, sig, cuts: 0, pieces: 1 });
    }
  }
  if (!options.length) {
    // Overlap repair: the trees that overlap least, each split with the
    // fewest extra cuts that separate every overlapping pair; then the
    // fewest cuts overall, and the largest smallest piece.
    const edges = sub.sharedEdges();
    let seed = (opts.seed || 11) * 7919;
    const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const trees = [];
    for (let k = 0; k < 120; k++) {
      const t = sub.randomTree(edges, rng);
      if (keyOf(t) === keyOf(curSet) || trees.some((x) => x.key === keyOf(t))) continue;
      sub.setLayout(t);
      const ov = sub.flatOverlaps();
      if (ov.loops) continue;
      trees.push({ t, key: keyOf(t), score: ov.pairs });
    }
    trees.sort((a, b) => a.score - b.score);
    let best = null;
    for (const tr of trees.filter((x) => !opts.forceRepair || x.score > 0).slice(0, 4)) {
      flatPose(tr.t);
      const res = resolveNow(sub, { budgetMs: 600, keep: 4 });
      const top = (res.suggestions || []).find((x) => x.valid);
      if (!top) continue;
      const small = Math.min(...top.pieceSizes);
      if (!best || top.cuts.length < best.cuts || (top.cuts.length === best.cuts && small > best.small)) {
        best = { hinges: new Set(top.hinges), Ms: new Map(sub.panels.map((p, i) => [p.id, top.Ms[i].clone()])), cuts: top.cuts.length, pieces: top.pieces, small, sig: `repair:${keyOf(top.hinges)}` };
      }
    }
    if (best) options.push(best);
  }
  if (!options.length) return { error: `No other overlap-free layout of this ${name} was found (${found.tries} layouts tried in ${found.ms} ms). Your layout stays as it is.` };
  // Each press shows the next layout not yet shown for this object.
  const objKey = [...ids].sort().join(',');
  if (!this.altState || this.altState.objKey !== objKey) this.altState = { objKey, shown: [] };
  let index = options.findIndex((o) => !this.altState.shown.includes(o.sig));
  if (index < 0) { this.altState.shown = []; index = 0; }
  const choice = options[index];
  this.altState.shown.push(choice.sig, curSig);
  // Its poses: flat, lying face down on the surface.
  if (!choice.Ms) {
    flatPose(choice.hinges);
    choice.Ms = new Map(sub.panels.map((p) => [p.id, p.M.clone()]));
  }
  const root = sub.forest().roots[0];
  return { sub, choice, options, index, name, closed, root: root ? root.id : null, exhaustive: found.nets.length < (opts.want || 30) };
};

// Put the chosen layout in place of the object's: same solid, the new
// hinges, lying flat on the surface where the old layout was (beside it if
// that would overlap something). In Solid the solid stays closed.
W.applyAlternate = function (comp, r, opts = {}) {
  const sh = this.shell;
  const ids = new Set(comp.map((p) => p.id));
  const keys = [...r.choice.hinges].map(pairKey);
  // Lay the layout down: its faces turned face down, on the surface, centred
  // where the old layout (or the solid) was.
  const Ms = new Map();
  if (opts.Ms) for (const [id, m] of opts.Ms) Ms.set(id, m.clone());
  else {
    const sub = r.sub;
    const anyId = [...r.choice.Ms.keys()][0];
    const P = sub.panelById.get(anyId);
    const M = r.choice.Ms.get(anyId);
    const n = P.normal.clone().transformDirection(M).normalize();
    const w = P.verts.map((v) => v.clone().applyMatrix4(M));
    const c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length);
    const L = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, -1, 0))))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    const box = new THREE.Box3();
    for (const [id, m] of r.choice.Ms) { const Q = sub.panelById.get(id); for (const v of Q.verts) box.expandByPoint(v.clone().applyMatrix4(m).applyMatrix4(L)); }
    const old = new THREE.Box3();
    for (const p of comp) for (const v of sh.worldPoly(p)) old.expandByPoint(v);
    const oc = old.getCenter(new THREE.Vector3()), nc = box.getCenter(new THREE.Vector3());
    const faces = (C) => [...r.choice.Ms].map(([id, m]) => { const Q = sub.panelById.get(id); const k = C.clone().multiply(L).multiply(m); return { verts: Q.verts.map((v) => v.clone().applyMatrix4(k)), normal: Q.normal.clone().transformDirection(k) }; });
    let C = null;
    const width = box.max.x - box.min.x;
    for (let k = 0; k < 8 && !C; k++) {
      const T = new THREE.Matrix4().makeTranslation(oc.x - nc.x + (k ? (width + this.edgeLen * 0.5) * k : 0), -box.min.y, oc.z - nc.z);
      if (!sh.meets(faces(T), (p) => ids.has(p.id))) C = T;
    }
    if (!C) return { ok: false, why: 'there is no free room beside the other objects' };
    for (const [id, m] of r.choice.Ms) Ms.set(id, C.clone().multiply(L).multiply(m));
  }
  this.rebuildKeep((st) => {
    if (r.closed) {
      for (const p of comp) { const pc = this.comp.piece(p.solidId); if (pc && r.closed.get(p.id)) pc.verts = r.closed.get(p.id).map((v) => v.clone()); }
      this.comp.seams = this.comp.seams.filter(([a, b]) => !ids.has(a.slice(0, a.lastIndexOf('#'))) && !ids.has(b.slice(0, b.lastIndexOf('#'))));
    }
    for (const k of [...st.edges.keys()]) if (k.split('|').some((u) => ids.has(u.slice(0, u.lastIndexOf('#'))))) st.edges.delete(k);
    for (const [id, m] of Ms) st.M.set(id, isIdentity(m) ? new THREE.Matrix4() : m);
    st.bases = st.bases.filter((id) => !ids.has(id));
    if (r.root) st.bases.push(r.root);
  }, { hinges: keys });
  // Check: every face of the object flat on the surface (or closed in
  // Solid), no overlaps inside it or with anything else.
  const mine = sh.panels.filter((p) => ids.has(p.id));
  if (mine.length !== comp.length) return { ok: false, why: 'the faces did not match up' };
  const inside = sh.overlaps().pairs.filter(([a, b]) => ids.has(a.id) || ids.has(b.id));
  if (inside.length) return { ok: false, why: `faces P${inside[0][0].no} and P${inside[0][1].no} would overlap` };
  if (!mine.every((p) => sh.worldNormal(p).y < -1 + 1e-6 && sh.worldPoly(p).every((v) => Math.abs(v.y) < 1e-6))) return { ok: false, why: 'the layout would not lie flat' };
  return { ok: true };
};

// --------------------------------------------------------------- toolbars

W.setModeTool = function (key) {
  const tools = MODE_TOOLS[this.state.mode];
  const t = tools.find((x) => x.key === key);
  if (!t) return;
  if (t.later) { this.app.toast(t.tip); return; }
  // The preview is a view toggle: it changes no tool, tab, pose or history.
  if (key === 'preview') { this.togglePreview(); return; }
  this.tools.finishAll();
  this.placing = null;
  this.hidePlacePreview();
  this.showPlaceZone(false);
  this.modHover = null; this.modHoverKey = ''; this.showModDot(null);
  this.clearDetach(false);
  this.holdKeys = null;
  if (this.state.mtool === key) { this.state.mtool = null; this.state.tool = 'select'; this.app.toast(`${t.name} off.`); this.refreshStyles(); this.app.notify?.(); return; }
  this.state.mtool = key;
  const internal = { fold: 'open', cut: 'scissors', modify: 'modify2d', remove: 'remove', move: 'move', rotate: 'rotate' }[key];
  if (internal === 'open') {
    this.setTool(internal);
    this.state.openMode = 'group';
  } else {
    this.state.tool = internal;
    this.sel.panel = this.sel.hinge = null;
  }
  this.app.toast(`${t.name}: ${t.tip}.`, 4000);
  this.refreshStyles();
  this.app.notify?.();
};

// The left picker and the right tools: one action active at a time.
// Placement stays on after each piece is added; it ends when the picker is
// tapped again, another tool is chosen, Esc, or a tap outside the work
// surface (its outline shows while placing, also when the table is hidden).
W.startPlacing = function () {
  this.tools.finishAll();
  if (this.placing) { this.cancelPlacing(); return; }
  if (this.state.mtool) {
    this.state.mtool = null;
    this.state.tool = 'select';
    this.modHover = null; this.modHoverKey = ''; this.showModDot(null);
    this.clearDetach(false);
    this.holdKeys = null;
    this.refreshStyles();
  }
  const kind = this.state.mode;
  const name = kind === 'shape' ? shapeByKey(this.state.shapeType).name : TEMPLATES[this.state.solidType].name;
  this.placing = { kind };
  this.showPlaceZone(true);
  this.app.toast(kind === 'shape'
    ? `Placing ${name.toLowerCase()}s: tap inside the outlined area, or near a free edge of a shape to attach one there. Tap outside the outline, or the picker, to stop.`
    : `Placing ${TEMPLATES[this.state.solidType].plural}: tap inside the outlined area, or a matching face of a solid. Tap outside the outline, or the picker, to stop.`, 6000);
  this.app.notify?.();
};

W.cancelPlacing = function (why = '') {
  if (!this.placing) return false;
  this.placing = null;
  this.hidePlacePreview();
  this.showPlaceZone(false);
  this.app.toast(`Placement off${why}.`);
  this.app.notify?.();
  return true;
};

// The placement area, in the work surface's frame: the work so far with
// room around it (an edge length and a quarter), kept on the table top. An
// empty workspace gets an area around the centre. It is outlined while
// placing, also when the table is hidden.
W.surfaceRect = function () {
  const surf = this.app.surface;
  const t = this.app.tableSize || { tw: 1, td: 0.7 };
  const box = new THREE.Box3();
  if (surf && this.shell.panels.length) {
    this.shellGroup.updateWorldMatrix(true, false);
    surf.updateWorldMatrix(true, false);
    const inv = surf.matrixWorld.clone().invert();
    for (const p of this.shell.panels) for (const v of this.shell.worldPoly(p)) box.expandByPoint(this.shellGroup.localToWorld(v).applyMatrix4(inv));
  }
  const m = EDGE * 1.25;
  let x0, x1, z0, z1;
  if (box.isEmpty()) {
    // Nothing yet: around where the workspace's origin sits on the surface.
    let o = new THREE.Vector3();
    if (surf) { this.shellGroup.updateWorldMatrix(true, false); surf.updateWorldMatrix(true, false); o = surf.worldToLocal(this.shellGroup.localToWorld(new THREE.Vector3())); }
    x0 = o.x - EDGE * 2; x1 = o.x + EDGE * 2; z0 = o.z - EDGE * 2; z1 = o.z + EDGE * 2;
  } else { x0 = box.min.x - m; x1 = box.max.x + m; z0 = box.min.z - m; z1 = box.max.z + m; }
  // Edges on whole centimetres (the mat's grid), inside the table top.
  const cm = (v, f) => f(v * 100 - 1e-6) / 100;
  const hx = Math.floor((t.tw / 2 - 0.01) * 100) / 100, hz = Math.floor((t.td / 2 - 0.01) * 100) / 100;
  x0 = Math.max(cm(x0, Math.floor), -hx); x1 = Math.min(Math.ceil(x1 * 100 - 1e-6) / 100, hx);
  z0 = Math.max(cm(z0, Math.floor), -hz); z1 = Math.min(Math.ceil(z1 * 100 - 1e-6) / 100, hz);
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hw: Math.max(0.01, (x1 - x0) / 2), hd: Math.max(0.01, (z1 - z0) / 2) };
};

W.inPlaceZone = function (local) {
  if (!local) return false;
  const surf = this.app.surface;
  if (!surf) return true;
  this.shellGroup.updateWorldMatrix(true, false);
  surf.updateWorldMatrix(true, false);
  const p = surf.worldToLocal(this.shellGroup.localToWorld(local.clone()));
  const r = this.placeRect || this.surfaceRect();
  return Math.abs(p.x - r.cx) <= r.hw + 1e-6 && Math.abs(p.z - r.cz) <= r.hd + 1e-6;
};

// The surface style changed while placing: show the boundary the new way.
W.refreshPlaceZone = function () {
  if (this.placing) this.showPlaceZone(true);
};

W.showPlaceZone = function (on) {
  const surf = this.app.surface;
  if (!surf) return;
  if (!on) { this.placeRect = null; this.app.setMatArea?.(null); if (this.placeZone) this.placeZone.visible = false; return; }
  const r = this.placeRect = this.surfaceRect();
  // On the cutting mat the mat's own edges are the boundary (no outline);
  // on the table or without one, the dashed outline.
  if (this.app.mat && this.app.mat.visible) {
    this.app.setMatArea?.({ cx: r.cx, cz: r.cz, w: 2 * r.hw, d: 2 * r.hd });
    if (this.placeZone) this.placeZone.visible = false;
    return;
  }
  this.app.setMatArea?.(null);
  if (!this.placeZone) {
    this.placeZone = new THREE.Group();
    this.placeZone.userData.ui = true;
    this.placeZone.name = 'place-zone';
    // Dashes are flat strips (lines draw one pixel wide on most devices).
    const dash = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#f0b44c', transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    dash.renderOrder = 7;
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: '#f0b44c', transparent: true, opacity: 0.1, depthWrite: false }));
    fill.rotation.x = -Math.PI / 2;
    fill.renderOrder = 6;
    this.placeZone.add(fill, dash);
    this.placeZone.dash = dash;
    this.placeZone.fill = fill;
    surf.add(this.placeZone);
  }
  const W2 = 0.005, D = 0.024, G = 0.014;
  const pos = [];
  const strip = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / len, uz = (z1 - z0) / len, nx = -uz * W2 / 2, nz = ux * W2 / 2;
    for (let t = 0; t < len; t += D + G) {
      const t1 = Math.min(len, t + D);
      const ax = x0 + ux * t, az = z0 + uz * t, bx = x0 + ux * t1, bz = z0 + uz * t1;
      pos.push(ax - nx, 0, az - nz, bx - nx, 0, bz - nz, bx + nx, 0, bz + nz, ax - nx, 0, az - nz, bx + nx, 0, bz + nz, ax + nx, 0, az + nz);
    }
  };
  strip(-r.hw, -r.hd, r.hw, -r.hd); strip(r.hw, -r.hd, r.hw, r.hd); strip(r.hw, r.hd, -r.hw, r.hd); strip(-r.hw, r.hd, -r.hw, -r.hd);
  const g = this.placeZone.dash.geometry;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  this.placeZone.fill.scale.set(r.hw, r.hd, 1);
  this.placeZone.position.set(r.cx, 0.003, r.cz);
  this.placeZone.visible = true;
};

// A tap (or trigger) while placing: on a shape or solid, attach there; on
// the work surface, place there; outside it, stop placing.
W.placeTap = function (ptr) {
  const hit = ptr.pick();
  if (!(hit && hit.panel) && !this.inPlaceZone(this.surfaceAt(ptr))) { this.cancelPlacing(' (tapped outside the placement area)'); return false; }
  const ok = this.placeAt(ptr);
  if (this.placing) this.showPlaceZone(true);
  return ok;
};

W.setPickerType = function (key) {
  if (this.state.mode === 'shape') this.state.shapeType = key; else this.state.solidType = key;
  this.placing = null;
  this.startPlacing();
};

// A tap that no drag took: placement, Remove, selecting an object, or
// (outside every object) clearing the selection.
W.tap = function (ptr) {
  if (this.anim) return;
  if (this.placing) { this.placeTap(ptr); return; }
  const hit = ptr.pick();
  if (!hit || !hit.panel) {
    if (this.detach) this.clearDetach();
    if (this.selComp) { this.selComp = null; this.refreshStyles(); this.app.notify?.(); }
    return;
  }
  if (this.state.tool === 'remove') { this.removeAt(hit); return; }
  if (this.state.tool === 'select') this.selectObject(hit.panel);
};

W.selectObject = function (P) {
  const comp = this.componentOf(P);
  this.selComp = new Set(comp);
  this.refreshStyles();
  this.app.toast(`Selected: ${this.objectText(comp)} (${comp.length} face${comp.length === 1 ? '' : 's'}). Choose a tool on the right, or tap outside to clear.`);
  this.app.notify?.();
};

// Where a pointer meets the work surface (shell frame).
W.surfaceAt = function (ptr) {
  const o = this.toLocal(ptr.ray.origin);
  const dir = this.toLocal(ptr.ray.origin.clone().add(ptr.ray.direction)).sub(o).normalize();
  return new THREE.Ray(o, dir).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
};

// The free edge of a shape lying on the surface that a tap on the empty
// surface, just outside it, points at: within half the edge's length of the
// edge, on its outer side, nearest first (the same edge a tap just inside
// the shape would choose).
W.freeEdgeOutside = function (pt) {
  const sh = this.shell;
  let best = null;
  for (const P of sh.panels) {
    if (!this.lyingFlat(P)) continue;
    const w = sh.worldPoly(P), n = w.length;
    const c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(n);
    for (let i = 0; i < n; i++) {
      if (P.edges[i].uses.length !== 1 || this.isSeamed(P, i)) continue;
      const a = w[i], b = w[(i + 1) % n];
      const ab = new THREE.Vector3(b.x - a.x, 0, b.z - a.z), L = ab.length();
      if (L < 1e-9) continue;
      const t = ((pt.x - a.x) * ab.x + (pt.z - a.z) * ab.z) / (L * L);
      const tc = THREE.MathUtils.clamp(t, 0, 1);
      const d = Math.hypot(pt.x - (a.x + ab.x * tc), pt.z - (a.z + ab.z * tc));
      // Outer side: the tap and the shape's centre lie on opposite sides of the edge.
      const side = (v) => ab.x * (v.z - a.z) - ab.z * (v.x - a.x);
      if (side(pt) * side(c) >= 0) continue;
      if (d > L * 0.5) continue;
      if (!best || d < best.d) best = { P, i, d };
    }
  }
  return best;
};

W.freeEdgeNear = function (P, local, frac = 0.45) {
  let best = null, bd = this.edgeLen * frac;
  const n = P.verts.length;
  for (let i = 0; i < n; i++) {
    const e = P.edges[i];
    if (e.uses.length !== 1 || this.isSeamed(P, i)) continue;
    const d = segDist(local, P.verts[i], P.verts[(i + 1) % n]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

// What a placement tap would do (also drawn as a preview while hovering).
W.planPlacement = function (ptr, hit) {
  if (!this.placing) return null;
  if (this.placing.kind === 'shape') {
    const shp = shapeByKey(this.state.shapeType);
    if (hit && hit.panel) {
      const i = this.freeEdgeNear(hit.panel, hit.local);
      if (i === null) return { error: 'Tap near a free edge of a shape to attach there, or on the empty surface to place a new one.' };
      const P = hit.panel, n = P.verts.length;
      const verts = attachedPolygon(shp.n, P.verts[i], P.verts[(i + 1) % n], P.normal);
      return { kind: 'shape', shp, verts, M: P.M.clone(), target: { P, i } };
    }
    const pt = this.surfaceAt(ptr);
    if (!pt) return { error: 'Point at the work surface.' };
    // Just outside the outer edge of a net lying on the surface: that edge.
    // (A free square centred there would lie over the net, so this is what
    // the tap means.)
    const out = this.freeEdgeOutside(pt);
    if (out) {
      const P = out.P, n = P.verts.length;
      const verts = attachedPolygon(shp.n, P.verts[out.i], P.verts[(out.i + 1) % n], P.normal);
      return { kind: 'shape', shp, verts, M: P.M.clone(), target: { P, i: out.i } };
    }
    return { kind: 'shape', shp, verts: regularPolygon(shp.n, EDGE, pt, 0), M: new THREE.Matrix4(), target: null };
  }
  const type = this.state.solidType;
  const name = TEMPLATES[type].name.toLowerCase();
  if (hit && hit.panel) {
    // On a face of a closed form (a solid placed here, or a net that has
    // closed): the new solid sits flush on that face.
    const P = hit.panel;
    const comp = this.componentOf(P);
    if (!this.restClosed(comp)) return { error: `Solids attach to faces of closed forms; ${this.restFlat(comp) ? 'this one is a net that has not closed. Fold it closed in Shape' : 'this one has an opening'}, or tap the empty surface.` };
    if (!comp.every((p) => isIdentity(p.M))) return { error: 'This form is unfolded. Fold it closed (Refold) before attaching a solid to it.' };
    const w = this.shell.worldPoly(P);
    const n = this.shell.worldNormal(P).normalize();
    if (n.y < -0.999 && Math.abs(w[0].y - this.lowestY(comp)) < this.edgeLen * 1e-4) return { error: 'That face rests on the surface. Turn the form (Rotate) to bring it up, then attach to it.' };
    const tf = { verts: w, normal: n, centroid: w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length), sides: w.length };
    const L = w[0].distanceTo(w[1]);
    const tm = template(type);
    let pose = null;
    for (let fi = 0; fi < tm.faces.length && !pose; fi++) {
      if (tm.faces[fi].sides !== tf.sides) continue;
      for (let j = 0; j < tf.verts.length && !pose; j++) pose = alignFace(tm, fi, L, tf, j);
    }
    if (!pose) return { error: `A ${name} has no face that matches this ${shapeName(w.length).toLowerCase()} face${tm.faces.some((f) => f.sides === w.length) ? ' (it is not regular any more)' : ''}.` };
    const faces = this.solidFacesFor(type, L, pose.position, pose.quaternion);
    const bad = this.solidProblem(faces);
    if (bad) return { error: `A ${name} there would pass through face P${bad.panel.no}.`, blockPanel: bad.panel };
    return { kind: 'solid', type, edge: L, position: pose.position, quaternion: pose.quaternion, faces, target: P };
  }
  const pt = this.surfaceAt(ptr);
  if (!pt) return { error: 'Point at the work surface.' };
  const position = new THREE.Vector3(pt.x, restHeight(type, EDGE), pt.z);
  const quaternion = template(type).rest.clone();
  const faces = this.solidFacesFor(type, EDGE, position, quaternion);
  const bad = this.solidProblem(faces);
  if (bad) return { error: `That ${name} would overlap face P${bad.panel.no}. Tap an empty part of the surface.`, blockPanel: bad.panel };
  return { kind: 'solid', type, edge: EDGE, position, quaternion, faces };
};

W.placeAt = function (ptr) {
  const hit = ptr.pick();
  const plan = this.planPlacement(ptr, hit);
  if (!plan) return false;
  if (plan.error) { if (plan.blockPanel) this.flashPanel(plan.blockPanel); this.app.toast(plan.error, 4500); return false; }
  if (this.comp.isEdited() || this.comp.isShaped()) { this.app.toast('Reset edits before adding pieces.'); return false; }
  const before = this.snapshot();
  let label;
  if (plan.kind === 'shape') {
    let pid = null;
    this.rebuildKeep(() => { const pc = this.comp.addPiece(plan.shp.n, plan.verts); pid = `${pc.id}:0`; }, {
      after: () => {
        const P = this.shell.panelById.get(pid);
        if (!P) return;
        P.M.copy(plan.M);
        // Attached: the shared edge is a hinge. Other edges that happen to
        // meet an edge stay open (cut) for you to decide.
        if (plan.target && P.edges[0].uses.length === 2) P.edges[0].type = 'hinge';
      },
    });
    const P = this.shell.panelById.get(pid);
    const bad = P && this.overlapsWith(new Set([P]));
    if (!P || bad) {
      this.restoreSnapshot(before);
      const pb = bad && this.shell.panelById.get(bad.id);
      if (pb) this.flashPanel(pb);
      this.app.toast(plan.target
        ? `A ${plan.shp.name.toLowerCase()} on that edge of P${plan.target.P.no} would overlap ${bad ? `face P${bad.no}` : 'another face'}, so nothing was placed.`
        : `That ${plan.shp.name.toLowerCase()} would overlap ${bad ? `face P${bad.no}` : 'another face'}. Nothing was placed.`, 4500);
      return false;
    }
    label = plan.target ? `${plan.shp.name} attached to the edge of P${plan.target.P.no}, ${Math.round(plan.verts[0].distanceTo(plan.verts[1]) * 1000)} mm sides` : `${plan.shp.name} placed (${Math.round(EDGE * 1000)} mm sides)`;
  } else {
    // The new solid is stored as pieces (one per face), so Shape tools work
    // on it too. Where it joins a form, that form gets a fresh default net.
    let origin = null, joined = null;
    const mineOf = () => this.shell.panels.filter((p) => this.comp.piece(p.solidId)?.origin === origin);
    this.rebuildKeep(() => { origin = this.addSolidPieces(plan.type, plan.faces); }, {
      defaultNet: true,
      skip: (e) => {
        if (!joined) { joined = new Set(); const p0 = mineOf()[0]; if (p0) for (const q of this.componentOf(p0)) joined.add(q); }
        return e.uses.some((u) => joined.has(u.panel));
      },
    });
    const mine = new Set(mineOf());
    const bad = this.overlapsWith(mine);
    if (!mine.size || bad) {
      this.restoreSnapshot(before);
      this.app.toast(`That ${TEMPLATES[plan.type].name.toLowerCase()} would overlap face P${bad ? bad.no : '?'}. Nothing was placed.`, 4500);
      return false;
    }
    // A solid attached low on a turned form may reach below the surface:
    // the whole form then rests on the surface.
    const obj = this.componentOf([...mine][0]);
    const low = this.lowestY(obj);
    if (low < -this.edgeLen * 1e-6) this.transformComponent(obj, new THREE.Matrix4().makeTranslation(0, -low, 0));
    label = plan.target ? `${TEMPLATES[plan.type].name} attached to face P${plan.target.no}` : `${TEMPLATES[plan.type].name} placed`;
  }
  this.pushHistory(before);
  this.hidePlacePreview();
  this.app.toast(`${label}. Tap again to add another; tap outside the outline, or the picker, to stop.`, 4000);
  this.app.notify?.();
  return true;
};

// A panel of `group` that overlaps (or passes through) a panel outside it.
W.overlapsWith = function (group) {
  const res = this.shell.overlaps();
  for (const [a, b] of res.pairs) {
    if (group.has(a) && !group.has(b)) return b;
    if (group.has(b) && !group.has(a)) return a;
  }
  return null;
};

W.hidePlacePreview = function () {
  // Placement ended (any way): its outline goes too.
  if (!this.placing) this.showPlaceZone(false);
  if (this.placePreview) { this.shellGroup.remove(this.placePreview); this.placePreview.geometry.dispose(); this.placePreview = null; }
  if (this.ghost && this.ghost.visible && this.ghostForPlace) { this.ghost.visible = false; this.ghostForPlace = false; }
};

W.previewPlacement = function (ptr, hit) {
  const plan = ptr ? this.planPlacement(ptr, hit) : null;
  if (!plan || plan.error) { this.hidePlacePreview(); return; }
  if (plan.kind === 'shape') {
    const pts = plan.verts.map((v) => v.clone().applyMatrix4(plan.M));
    const g = new THREE.BufferGeometry();
    const pos = [];
    for (let i = 1; i < pts.length - 1; i++) for (const v of [pts[0], pts[i], pts[i + 1]]) pos.push(v.x, v.y, v.z);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (!this.placeMat) this.placeMat = new THREE.MeshBasicMaterial({ color: '#36d98a', transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    if (this.placePreview) { this.placePreview.geometry.dispose(); this.placePreview.geometry = g; } else {
      this.placePreview = new THREE.Mesh(g, this.placeMat);
      this.placePreview.renderOrder = 10;
      this.placePreview.userData.ui = true;
      this.shellGroup.add(this.placePreview);
    }
    this.placePreview.position.set(0, this.edgeLen * 0.004, 0);
  } else {
    this.showGhost(plan.type, plan.edge, plan.position, plan.quaternion, 'snap');
    this.ghostForPlace = true;
  }
};

// ------------------------------------------------------- folding, seams

W.isSeamed = function (P, i) { const k = `${P.id}#${i}`; return this.comp.seams.some(([a, b]) => a === k || b === k); };

// Free edges of the moving side that can meet free edges of the rest of
// the object by turning the hinge: the turn that makes them meet, if it is
// close to the current one.
W.findFoldSnap = function (plan) {
  const sh = this.shell;
  const moving = new Set(plan.moving);
  const comp = this.componentOf(plan.P);
  const mov = [], fix = [];
  for (const p of comp) {
    p.edges.forEach((e, i) => {
      if (e.uses.length !== 1 || this.isSeamed(p, i)) return;
      (moving.has(p) ? mov : fix).push({ p, i });
    });
  }
  if (!mov.length || !fix.length) return null;
  const { a, u } = sh.axis(plan.e, plan.P);
  const A = a.clone().applyMatrix4(plan.Q.M), U = u.clone().transformDirection(plan.Q.M).normalize();
  const L = this.edgeLen, tol = L * 1e-5;
  const ends = (x) => { const w = sh.worldPoly(x.p); return [w[x.i], w[(x.i + 1) % w.length]]; };
  const turn = (X, Y) => {
    const rx = X.clone().sub(A), ry = Y.clone().sub(A);
    const hx = rx.dot(U), hy = ry.dot(U);
    if (Math.abs(hx - hy) > tol) return null;
    rx.addScaledVector(U, -hx); ry.addScaledVector(U, -hy);
    const lx = rx.length(), ly = ry.length();
    if (Math.abs(lx - ly) > tol) return null;
    if (lx < tol) return 'any';
    return Math.atan2(new THREE.Vector3().crossVectors(rx, ry).dot(U), rx.dot(ry));
  };
  let best = null;
  for (const m of mov) {
    const [m0, m1] = ends(m);
    for (const f of fix) {
      const [f0, f1] = ends(f);
      if (Math.abs(m0.distanceTo(m1) - f0.distanceTo(f1)) > tol) continue;
      const d1 = turn(m0, f1), d2 = turn(m1, f0);
      if (d1 === null || d2 === null || (d1 === 'any' && d2 === 'any')) continue;
      const d = d1 === 'any' ? d2 : d1;
      if (d1 !== 'any' && d2 !== 'any' && Math.abs(wrapAngle(d1 - d2)) > 1e-6) continue;
      if (Math.abs(d) > rad(15)) continue;
      if (!best || Math.abs(d) < Math.abs(best.delta)) best = { delta: d };
    }
  }
  return best;
};

// Free edges of the moving side lying exactly on free edges of the rest.
W.meetingEdges = function (plan) {
  const sh = this.shell;
  const moving = new Set(plan.moving);
  const comp = this.componentOf(plan.P);
  const mov = [], fix = [];
  for (const p of comp) p.edges.forEach((e, i) => { if (e.uses.length === 1 && !this.isSeamed(p, i)) (moving.has(p) ? mov : fix).push({ p, i }); });
  const tol = this.edgeLen * 1e-6;
  const out = [];
  for (const m of mov) {
    const wm = sh.worldPoly(m.p), m0 = wm[m.i], m1 = wm[(m.i + 1) % wm.length];
    for (const f of fix) {
      const wf = sh.worldPoly(f.p), f0 = wf[f.i], f1 = wf[(f.i + 1) % wf.length];
      if (m0.distanceTo(f1) < tol && m1.distanceTo(f0) < tol) out.push([m, f]);
    }
  }
  return out;
};

// Free edges of the moving side and of the rest of the object that are the
// same length, with their ends `reach` or closer (the pairs that could
// meet), nearest first.
W.approachingEdges = function (plan, reach) {
  const sh = this.shell;
  const moving = new Set(plan.moving);
  const comp = this.componentOf(plan.P);
  const mov = [], fix = [];
  for (const p of comp) p.edges.forEach((e, i) => { if (e.uses.length === 1 && !this.isSeamed(p, i)) (moving.has(p) ? mov : fix).push({ p, i }); });
  const L = this.edgeLen;
  const out = [];
  for (const m of mov) {
    const wm = sh.worldPoly(m.p), m0 = wm[m.i], m1 = wm[(m.i + 1) % wm.length];
    for (const f of fix) {
      const wf = sh.worldPoly(f.p), f0 = wf[f.i], f1 = wf[(f.i + 1) % wf.length];
      if (Math.abs(m0.distanceTo(m1) - f0.distanceTo(f1)) > L * 1e-4) continue;
      const d = Math.max(m0.distanceTo(f1), m1.distanceTo(f0));
      if (d <= reach) out.push({ m, f, d });
    }
  }
  return out.sort((a, b) => a.d - b.d);
};

// The neighbouring panel's own hinge, if turning it moves only that panel's
// side (not the panel being folded, not what it hangs from, nothing glued).
W.partnerPlan = function (B, plan) {
  const sh = this.shell;
  const moving = new Set(plan.moving);
  let best = null;
  for (const e of B.edges) {
    if (e.type !== 'hinge' || !e.shared) continue;
    const pl = sh.plan(B, e, 'group');
    if (pl.error || pl.moving.some((p) => moving.has(p) || p === plan.Q)) continue;
    const ids = new Set(pl.moving.map((p) => p.id));
    if (this.comp.seams.some(([a, b]) => ids.has(a.split('#')[0]) !== ids.has(b.split('#')[0]))) continue;
    if (!best || pl.moving.length < best.moving.length) best = pl;
  }
  return best;
};

// Two panels closing on each other (two roof panels, say): turn the
// folded panel and its neighbour's hinge together so their edges meet.
W.findPairSnap = function (plan) {
  const sh = this.shell;
  const L = this.edgeLen;
  const cands = this.approachingEdges(plan, L * 0.75);
  const a0 = sh.angle(plan.e, plan.P, plan.Q);
  for (const { m, f } of cands.slice(0, 4)) {
    const pB = this.partnerPlan(f.p, plan);
    if (!pB) continue;
    const b0 = sh.angle(pB.e, pB.P, pB.Q);
    const pose = (x) => { sh.setAngle(plan, x[0]); sh.setAngle(pB, x[1]); };
    const resid = () => {
      const wm = sh.worldPoly(m.p), wf = sh.worldPoly(f.p);
      const d0 = wm[m.i].clone().sub(wf[(f.i + 1) % wf.length]).divideScalar(L), d1 = wm[(m.i + 1) % wm.length].clone().sub(wf[f.i]).divideScalar(L);
      return [d0.x, d0.y, d0.z, d1.x, d1.y, d1.z];
    };
    const jac = () => {
      const r0 = resid(), x = [sh.angle(plan.e, plan.P, plan.Q), sh.angle(pB.e, pB.P, pB.Q)], J = [];
      for (let k = 0; k < 2; k++) { const xk = x.slice(); xk[k] += 1e-7; pose(xk); J.push(resid().map((v, i) => (v - r0[i]) / 1e-7)); pose(x); }
      return J;
    };
    const r = solveAngles([a0, b0], pose, resid, jac, { iters: 40, tol: 1e-11 });
    // Close enough: this fold is within 12° of where the edges meet (the
    // neighbour may turn further to meet it).
    const ok = r.err < 1e-8 && Math.abs(wrapAngle(r.x[0] - a0)) < rad(12) && Math.abs(wrapAngle(r.x[1] - b0)) < rad(60);
    if (ok) {
      const group = new Set(this.componentOf(plan.P));
      if (!sh.overlaps((x, y) => group.has(x) && group.has(y)).pairs.length) return { plan: pB, orig: b0, a: r.x[0], b: r.x[1] };
    }
    pose([a0, b0]);
  }
  return null;
};

// Called after each step of a fold drag (Fold tool): edges that come close
// light up; close enough, they snap together (turning this hinge alone,
// or with the neighbour's hinge when two panels close on each other).
W.foldSnapStep = function (s) {
  if (!s || !s.plan) return;
  const sh = this.shell;
  // The neighbour turned in the last step goes back first.
  if (this.partner) { if (this.partner.of === s.plan) sh.setAngle(this.partner.plan, this.partner.orig); this.partner = null; this.updateMatrices(); }
  let snap = this.findFoldSnap(s.plan);
  if (snap) sh.setAngle(s.plan, sh.angle(s.plan.e, s.plan.P, s.plan.Q) + snap.delta);
  else {
    const two = this.findPairSnap(s.plan);
    if (two) { this.partner = { of: s.plan, plan: two.plan, orig: two.orig }; snap = two; }
  }
  if (snap) { this.updateMatrices(); this.checkOverlaps(); }
  const meet = snap ? this.meetingEdges(s.plan) : [];
  if (!meet.length && this.partner) { sh.setAngle(this.partner.plan, this.partner.orig); this.partner = null; this.updateMatrices(); this.checkOverlaps(); }
  this.foldSnap = meet.length ? { plan: s.plan, pairs: meet, partner: this.partner } : null;
  this.snapEdges = new Set(meet.flatMap(([m, f]) => [m.p.edges[m.i], f.p.edges[f.i]]));
  this.nearEdges = meet.length ? null : new Set(this.approachingEdges(s.plan, this.edgeLen * 0.75).flatMap(({ m, f }) => [m.p.edges[m.i], f.p.edges[f.i]]));
  if (this.nearEdges && !this.nearEdges.size) this.nearEdges = null;
  this.refreshStyles();
  if (meet.length) {
    const at = s.plan.P.centroid.clone().applyMatrix4(s.plan.P.M);
    this.setTag(`${meet.length} edge${meet.length === 1 ? ' meets' : 's meet'}${this.partner ? ` (P${this.partner.plan.P.no} turns to meet it)` : ''} · release to join`, this.shellGroup.localToWorld(at));
  } else if (this.nearEdges) this.setTag('Edges coming together: keep folding to meet');
};

W.recordSeams = function (pairs) {
  for (const [m, f] of pairs) {
    const a = `${m.p.id}#${m.i}`, b = `${f.p.id}#${f.i}`;
    if (!this.comp.seams.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) this.comp.seams.push([a, b]);
  }
};

// Has an object of pieces closed up? Every edge joined: hinges and cuts
// meeting, free edges glued. Then its folded form becomes its rest form.
W.checkClosure = function (P) {
  const sh = this.shell;
  const comp = this.componentOf(P);
  if (!comp.every((p) => this.isPiecePanel(p))) return false;
  if (this.restClosed(comp)) return false;
  for (const p of comp) {
    for (let i = 0; i < p.edges.length; i++) {
      const e = p.edges[i];
      if (e.uses.length >= 2) { if (!sh.intact(e)) return false; } else if (!this.isSeamed(p, i)) return false;
    }
  }
  const group = new Set(comp);
  const inside = sh.overlaps().pairs.find(([a, b]) => group.has(a) && group.has(b));
  if (inside) { this.app.toast(`The form closes, but faces P${inside[0].no} and P${inside[1].no} pass through each other, so it is not a valid solid.`, 6000); return false; }
  let vol = 0;
  for (const p of comp) {
    const w = sh.worldPoly(p);
    for (let i = 1; i < w.length - 1; i++) vol += w[0].dot(w[i].clone().cross(w[i + 1])) / 6;
  }
  if (vol <= 0) { this.app.toast('The form closes inside out (folded the other way), so it is not used as a solid. Unfold and fold the flaps up.', 6000); return false; }
  const ids = new Set(comp.map((p) => p.id));
  const world = new Map(comp.map((p) => [p.id, sh.worldPoly(p)]));
  this.rebuildKeep(() => {
    for (const p of comp) this.comp.piece(p.solidId).verts = world.get(p.id);
    this.comp.seams = this.comp.seams.filter(([a, b]) => !ids.has(a.split('#')[0]) && !ids.has(b.split('#')[0]));
  }, { after: () => { for (const p of sh.panels) if (ids.has(p.id)) p.M.identity(); } });
  this.app.toast(`Closed: ${comp.length} faces fold into a closed form (${(vol * 1e6).toFixed(0)} cm³ inside). Solid (3D) works with it as a solid; Unfold opens it again.`, 7000);
  return true;
};

// ------------------------------------------- Refold: join edges as they meet
//
// Folding an object built from shapes, Refold looks for free edges that
// come together: two free edges of the same length that start at the same
// corner of the surface, where the faces around that corner add up to less
// than a full turn, are zipped together (their far ends meet), and the
// hinge angles that make every zipped pair meet are solved for with the
// faces kept rigid. A pair is kept only when the faces can really bring it
// together without passing through each other; whatever cannot meet stays
// open, with the reason. Two orders are tried (smallest corner first, then
// largest); the one that joins more edges is used.

// Least squares over hinge angles (Levenberg-Marquardt). `pose(x)` poses
// the panels; `resid()` gives the residual vector at the current pose.
function solveAngles(x0, pose, resid, jac, { iters = 80, tol = 1e-10, maxStep = Infinity } = {}) {
  const n = x0.length;
  let x = x0.slice();
  pose(x);
  let r = resid();
  const sq = (v) => v.reduce((a, b) => a + b * b, 0);
  let f = sq(r), lam = 1e-3, stall = 0;
  for (let it = 0; it < iters && n; it++) {
    if (Math.max(...r.map(Math.abs)) < tol) break;
    pose(x);
    const J = jac();
    const A = J.map((a) => J.map((b) => a.reduce((s2, v, m) => s2 + v * b[m], 0)));
    const g = J.map((a) => a.reduce((s2, v, m) => s2 + v * r[m], 0));
    let improved = false;
    for (let t = 0; t < 12; t++) {
      const M = A.map((row, i) => row.map((v, j) => (i === j ? v + lam * (v + 1e-6) : v)));
      const d = gaussSolve(M, g.map((v) => -v));
      if (!d) { lam *= 4; continue; }
      // Small steps, so the folds follow on from where they start (and do
      // not jump through flat to the mirror-image solution).
      const big = Math.max(...d.map(Math.abs));
      if (big > maxStep) for (let k = 0; k < d.length; k++) d[k] *= maxStep / big;
      const xn = x.map((v, k) => v + d[k]);
      pose(xn);
      const rn = resid(), fn = sq(rn);
      if (fn < f) {
        // Stuck well away from meeting: give up early.
        stall = fn > f * 0.98 && fn > 1e-6 ? stall + 1 : 0;
        x = xn; r = rn; f = fn; lam = Math.max(lam / 3, 1e-12); improved = true; break;
      }
      lam *= 4;
    }
    if (!improved || stall > 6) break;
  }
  pose(x);
  return { x, err: Math.max(0, ...resid().map(Math.abs)) };
}

function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

W.cornerAngle = function (p, j) {
  const n = p.verts.length;
  const a = p.verts[(j + n - 1) % n].clone().sub(p.verts[j]), b = p.verts[(j + 1) % n].clone().sub(p.verts[j]);
  return a.angleTo(b);
};

// Fold one hinge-connected object, joining edges that meet. `rest`: start
// from its 3D rest form (root back in place) rather than its current pose.
// Returns { pairs, x (angles by panel), rootTo, open, tried } or a reason.
W.zipFold = function (comp, F, { rest = false } = {}) {
  const sh = this.shell;
  const L = this.edgeLen;
  if (sh.hingeComponent(comp[0]).size !== comp.length) return { reason: 'some of its pieces are joined to the rest only by cut edges, not hinges' };
  const inComp = new Set(comp);
  const root = comp.find((p) => !F.parent.has(p));
  const order = F.order.filter((p) => inComp.has(p) && F.parent.has(p));
  const cur = sh.forestAngles(F);
  const rootM0 = root.M.clone();
  const rootTo = rest ? new THREE.Matrix4() : root.M.clone();
  const savedM = comp.map((p) => p.M.clone());
  const flatRest = new Set(order.filter((p) => { const l = F.parent.get(p); return Math.abs(sh.interior(l.e, p, l.parent) - Math.PI) < 1e-6; }));
  const start = new Map(order.map((p) => [p, rest ? 0 : cur.get(p)]));
  // vertex correspondences
  const vmatch = (A, ia, B, ib) => { const out = []; for (const a of [ia, (ia + 1) % A.verts.length]) for (const b of [ib, (ib + 1) % B.verts.length]) if (A.vid[a] === B.vid[b]) out.push([A, a, B, b]); return out; };
  const glueCons = (h1, h2) => [[h1.p, h1.i, h2.p, (h2.i + 1) % h2.p.verts.length], [h1.p, (h1.i + 1) % h1.p.verts.length, h2.p, h2.i]];
  const baseCons = [];
  for (const e of F.loops) { const [u, w] = e.uses; if (inComp.has(u.panel)) baseCons.push(...vmatch(u.panel, u.i, w.panel, w.i)); }
  const byId = new Map(comp.map((p) => [p.id, p]));
  const seamHalf = [];
  for (const [a, b] of this.comp.seams) {
    const [pa, ia] = a.split('#'), [pb, ib] = b.split('#');
    const A = byId.get(pa), B = byId.get(pb);
    if (A && B) { const h1 = { p: A, i: +ia }, h2 = { p: B, i: +ib }; baseCons.push(...glueCons(h1, h2)); seamHalf.push([h1, h2]); }
  }
  // tree path between two panels: the hinge angles that move one relative to the other
  const chain = (p) => { const c = []; for (let q = p; q; q = F.parent.get(q)?.parent) c.push(q); return c; };
  const pathVars = (A, B) => { const ca = chain(A), cb = new Set(chain(B)); const lca = ca.find((q) => cb.has(q)); const out = new Set(); for (const c of [chain(A), chain(B)]) for (const q of c) { if (q === lca) break; out.add(q); } return out; };
  const varsFor = (cons) => { const s2 = new Set(); for (const [A, , B] of cons) for (const q of pathVars(A, B)) s2.add(q); return order.filter((q) => s2.has(q)); };
  const chains = new Map(comp.map((p) => [p, new Set(chain(p))]));
  // d(residual)/d(angle): turning a hinge turns everything beyond it about
  // the hinge line as it is posed now.
  const jacOf = (cons, vars) => () => {
    const ax = vars.map((q) => { const l = F.parent.get(q); const { a, u } = sh.axis(l.e, q); return { A: a.clone().applyMatrix4(l.parent.M), U: u.clone().transformDirection(l.parent.M) }; });
    const J = vars.map(() => []);
    const d = new THREE.Vector3(), t = new THREE.Vector3();
    for (const [A, a, B, b] of cons) {
      const wA = A.verts[a].clone().applyMatrix4(A.M), wB = B.verts[b].clone().applyMatrix4(B.M);
      const ca = chains.get(A), cb = chains.get(B);
      vars.forEach((q, k) => {
        d.set(0, 0, 0);
        if (ca.has(q)) d.add(t.copy(ax[k].U).cross(wA.clone().sub(ax[k].A)));
        if (cb.has(q)) d.sub(t.copy(ax[k].U).cross(wB.clone().sub(ax[k].A)));
        d.divideScalar(L);
        J[k].push(d.x, d.y, d.z);
      });
    }
    return J;
  };
  const ang = new Map(start);
  const pose = () => { root.M.copy(rootTo); for (const p of order) { const l = F.parent.get(p); p.M.multiplyMatrices(l.parent.M, sh.restRotation(l.e, p, ang.get(p))); } };
  const residOf = (cons) => () => { const out = []; for (const [A, a, B, b] of cons) { const d = A.verts[a].clone().applyMatrix4(A.M).sub(B.verts[b].clone().applyMatrix4(B.M)).divideScalar(L); out.push(d.x, d.y, d.z); } return out; };
  const overlapIn = () => sh.overlaps((a, b) => inComp.has(a) && inComp.has(b)).pairs[0] || null;
  // try to meet `cons` starting from the accepted angles `base`
  const attempt = (cons, base) => {
    const vars = varsFor(cons);
    const kicks = [-0.5, -1.2, 0, -2, 0.5];
    let last = null;
    for (const k of kicks) {
      for (const [p, v] of base) ang.set(p, v);
      const kicked = new Set(k ? vars.filter((p) => flatRest.has(p) && Math.abs(base.get(p)) < 0.03) : []);
      const x0 = vars.map((p) => (kicked.has(p) ? k : base.get(p)));
      const r = solveAngles(x0, (x) => { vars.forEach((p, i) => ang.set(p, x[i])); pose(); }, residOf(cons), jacOf(cons, vars), { maxStep: 0.35, iters: 120 });
      if (r.err > 1e-6) { if (!last || last.why === 'far') last = { why: 'far', gap: r.err * L }; continue; }
      // A fold bent one way that ends up bent the other way went through flat.
      if (vars.some((p, i) => kicked.has(p) && r.x[i] * k < 0 && Math.abs(r.x[i]) > 0.05)) { if (!last) last = { why: 'far', gap: 0 }; continue; }
      vars.forEach((p, i) => ang.set(p, wrapAngle(r.x[i])));
      pose();
      const fp = vars.find((p) => Math.abs(ang.get(p)) > Math.PI - 0.02);
      if (fp) { last = { why: 'flat', fp: [fp.id, F.parent.get(fp).parent.id] }; continue; }
      const o = overlapIn();
      if (o) { last = { why: 'overlap', o }; continue; }
      return { ok: true, ang: new Map(ang) };
    }
    return { ok: false, ...last };
  };
  const pid = (h1, h2) => [`${h1.p.id}#${h1.i}`, `${h2.p.id}#${h2.i}`].sort().join('|');
  const run = (largestFirst, forbid = new Set()) => {
    // corner classes
    const par = new Map();
    const key = (p, j) => `${p.id}:${(j + p.verts.length) % p.verts.length}`;
    const find = (k) => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra, rb); };
    for (const p of comp) for (let j = 0; j < p.verts.length; j++) par.set(key(p, j), key(p, j));
    for (const p of comp) p.edges.forEach((e, i) => { if (e.type === 'hinge' && e.uses.length === 2) { const u = e.uses.find((x) => x.panel !== p); for (const [A, a, B, b] of vmatch(p, i, u.panel, u.i)) union(key(A, a), key(B, b)); } });
    for (const [h1, h2] of seamHalf) for (const [A, a, B, b] of glueCons(h1, h2)) union(key(A, a), key(B, b));
    const half = [];
    for (const p of comp) p.edges.forEach((e, i) => {
      if (this.isSeamed(p, i)) return;
      if (e.uses.length === 1 || (e.uses.length === 2 && e.type !== 'hinge')) half.push({ p, i, len: p.verts[i].distanceTo(p.verts[(i + 1) % p.verts.length]), cut: e.uses.length === 2 ? e : null, done: false });
    });
    const cons = baseCons.slice();
    let acc = new Map(start);
    const pairs = [], tried = new Map();
    for (let guard = 0; guard < 400; guard++) {
      const info = new Map();
      const at = (k) => { const r = find(k); if (!info.has(r)) info.set(r, { sum: 0, count: 0, ins: [], outs: [], panels: new Set() }); return info.get(r); };
      for (const p of comp) for (let j = 0; j < p.verts.length; j++) { const c = at(key(p, j)); c.sum += this.cornerAngle(p, j); c.count++; c.panels.add(p.id); }
      for (const h of half) if (!h.done) { at(key(h.p, h.i + 1)).ins.push(h); at(key(h.p, h.i)).outs.push(h); }
      let best = null;
      // Two sides of a cut edge: they belong together.
      for (const h of half) {
        if (h.done || !h.cut) continue;
        const o = half.find((x) => x !== h && !x.done && x.cut === h.cut);
        if (o && !tried.has(pid(h, o))) {
          if (forbid.has(pid(h, o))) { tried.set(pid(h, o), { h1: h, h2: o, why: 'blocks' }); continue; }
          best = { h1: h, h2: o, cut: true }; break;
        }
      }
      if (!best) {
        for (const c of info.values()) {
          if (c.ins.length !== 1 || c.outs.length !== 1) continue;
          const h1 = c.ins[0], h2 = c.outs[0];
          if (h1 === h2 || h1.p === h2.p || tried.has(pid(h1, h2))) continue;
          if (forbid.has(pid(h1, h2))) { tried.set(pid(h1, h2), { h1, h2, why: 'blocks' }); continue; }
          if (Math.abs(h1.len - h2.len) > L * 1e-4) { tried.set(pid(h1, h2), { h1, h2, why: 'length', a: h1.len, b: h2.len }); continue; }
          if (c.count < 3) continue;
          if (c.sum > 2 * Math.PI + 1e-4) { tried.set(pid(h1, h2), { h1, h2, why: 'full', sum: c.sum, count: c.count, corner: [...c.panels] }); continue; }
          const better = !best || (largestFirst ? c.sum > best.sum + 1e-9 : c.sum < best.sum - 1e-9) || (Math.abs(c.sum - best.sum) <= 1e-9 && c.count > best.count);
          if (better) best = { h1, h2, sum: c.sum, count: c.count };
        }
      }
      if (!best) break;
      const { h1, h2 } = best;
      const test = best.cut ? [...cons, ...vmatch(h1.p, h1.i, h2.p, h2.i)] : [...cons, ...glueCons(h1, h2)];
      const r = attempt(test, acc);
      if (!r.ok) { tried.set(pid(h1, h2), { h1, h2, why: r.why, gap: r.gap, o: r.o, fp: r.fp, sum: best.sum, path: [h1.p.id, ...[...pathVars(h1.p, h2.p)].map((q) => q.id), h2.p.id] }); continue; }
      acc = r.ang;
      cons.length = 0; cons.push(...test);
      h1.done = h2.done = true;
      pairs.push([h1, h2]);
      if (best.cut) for (const [A, a, B, b] of vmatch(h1.p, h1.i, h2.p, h2.i)) union(key(A, a), key(B, b));
      else for (const [A, a, B, b] of glueCons(h1, h2)) union(key(A, a), key(B, b));
    }
    return { pairs, ang: acc, open: half.filter((h) => !h.done), tried, forbid, largestFirst };
  };
  // Greedy zipping can join a pair early that keeps more edges from
  // meeting later. Try both orders, then (briefly) leaving out each joined
  // pair in turn, and keep whatever joins the most edges.
  const t0 = performance.now();
  const a = run(false);
  const b = a.open.length ? run(true) : null;
  let best = b && b.pairs.length > a.pairs.length ? b : a;
  for (let round = 0; round < 4 && best.open.length; round++) {
    let better = null;
    for (const [h1, h2] of best.pairs) {
      if (performance.now() - t0 > 900) break;
      const r = run(best.largestFirst, new Set([...best.forbid, pid(h1, h2)]));
      if (r.pairs.length > (better || best).pairs.length) better = r;
      if (better && !better.open.length) break;
    }
    if (!better) break;
    best = better;
  }
  const txt = (r) => r && r.pairs.map(([h1, h2]) => `P${h1.p.no}#${h1.i}-P${h2.p.no}#${h2.i}`).join(' ');
  this.zipDebug = { small: txt(a), large: txt(b), best: txt(best), ms: Math.round(performance.now() - t0) };
  // Hinges no joined edge depends on keep their angle.
  const used = new Set(varsFor(best.pairs.flatMap(([h1, h2]) => (h1.cut ? vmatch(h1.p, h1.i, h2.p, h2.i) : glueCons(h1, h2))).concat(baseCons)));
  const x = new Map();
  for (const p of order) x.set(p, used.has(p) ? best.ang.get(p) : start.get(p));
  comp.forEach((p, i) => p.M.copy(savedM[i]));
  root.M.copy(rootM0);
  return { pairs: best.pairs, x, rootTo, rest, open: best.open, tried: best.tried };
};

// The edges left open, one row each: why, the edges Refold tried to join,
// and the faces that stopped them meeting.
W.zipRows = function (z) {
  const mm = (v) => `${(v * 1000).toFixed(0)} mm`;
  const said = new Set(), rows = [];
  const edge = (h) => [h.p.id, h.i];
  for (const t of z.tried.values()) {
    if (!z.open.includes(t.h1) && !z.open.includes(t.h2)) continue;
    const k = [t.h1, t.h2].map((h) => `${h.p.id}#${h.i}`).sort().join('|');
    if (said.has(k)) continue;
    said.add(k);
    const pair = `P${t.h1.p.no} and P${t.h2.p.no}`;
    let text, blockers = [];
    if (t.why === 'length') text = `${pair}: the edges that would meet are different lengths (${mm(t.a)} and ${mm(t.b)})`;
    else if (t.why === 'full') { text = `${pair}: the faces around that corner already add up to more than a full turn (${t.count} faces, ${Math.round(deg(t.sum))}°)`; blockers = t.corner || []; }
    else if (t.why === 'overlap') { text = `${pair}: to meet, faces P${t.o[0].no} and P${t.o[1].no} would pass through each other`; blockers = [t.o[0].id, t.o[1].id]; }
    else if (t.why === 'flat') { text = `${pair}: to meet, a face would have to fold flat onto its neighbour`; blockers = t.fp || []; }
    else if (t.why === 'blocks') text = `${pair}: left open because joining them stops more edges meeting elsewhere`;
    else { text = `${pair}: the rigid faces between them cannot bring these edges together${t.gap ? ` (they stay ${mm(t.gap)} apart)` : ''}`; blockers = t.path || []; }
    rows.push({ text, edges: [edge(t.h1), edge(t.h2)], blockers: [...new Set(blockers)] });
    for (const h of [t.h1, t.h2]) said.add(`${h.p.id}#${h.i}`);
  }
  const rest = z.open.filter((h) => !said.has(`${h.p.id}#${h.i}`));
  for (const h of rest) rows.push({ text: `P${h.p.no}: no free edge of the same length comes to meet this edge`, edges: [edge(h)], blockers: [] });
  return rows;
};

// ------------------------------------------------------- rotate and move

// Move or turn a whole object: its rest form and its pose together, so
// hinge angles and connections stay as they are.
W.transformComponent = function (comp, R, pieces = null) {
  const ids = new Set(comp.map((p) => p.id));
  const solidIds = new Set(comp.filter((p) => !this.isPiecePanel(p)).map((p) => p.solidId));
  const pcs = pieces || this.objectPieces(comp);
  const Rinv = R.clone().invert();
  const q = new THREE.Quaternion().setFromRotationMatrix(R);
  this.rebuildKeep((st) => {
    for (const s of this.comp.solids) if (solidIds.has(s.id)) { s.position.applyMatrix4(R); s.quaternion.premultiply(q).normalize(); }
    for (const pc of pcs) for (const v of pc.verts) v.applyMatrix4(R);
    // A closed (identity) pose stays exactly closed.
    for (const [id, m] of st.M) if (ids.has(id)) st.M.set(id, isIdentity(m) ? new THREE.Matrix4() : R.clone().multiply(m).multiply(Rinv));
  });
};

// Move a whole object into another frame: its rest form by R, its pose so
// that it ends up moved by T in the world (M' = T·M·R⁻¹). With R = T this is
// transformComponent; a different R puts the object into the rest frame of
// a panel it joins.
W.reframeComponent = function (comp, R, T, opts = {}) {
  const ids = new Set(comp.map((p) => p.id));
  const pcs = opts.pieces || this.objectPieces(comp);
  const Rinv = R.clone().invert();
  this.rebuildKeep((st) => {
    for (const pc of pcs) for (const v of pc.verts) v.applyMatrix4(R);
    for (const [id, m] of st.M) {
      if (!ids.has(id)) continue;
      const n = T.clone().multiply(m).multiply(Rinv);
      st.M.set(id, isIdentity(n) ? new THREE.Matrix4() : n);
    }
  }, opts);
};

// ---------------------------------------------- Move: snapping and joining

// The pointer's ray in the shell frame.
W.localRay = function (ptr) {
  if (!ptr || !ptr.ray) return null;
  const o = this.toLocal(ptr.ray.origin);
  const d = this.toLocal(ptr.ray.origin.clone().add(ptr.ray.direction)).sub(o).normalize();
  return new THREE.Ray(o, d);
};

// Where a ray meets panel P, if inside P grown by `margin` (shell frame).
W.rayOnPanel = function (ray, P, margin = 0) {
  const sh = this.shell;
  const w = sh.worldPoly(P);
  const n = sh.worldNormal(P).normalize();
  const x = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, w[0]), new THREE.Vector3());
  if (!x) return null;
  const c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length);
  for (let i = 0; i < w.length; i++) {
    const a = w[i], b = w[(i + 1) % w.length];
    const inward = new THREE.Vector3().crossVectors(n, b.clone().sub(a)).normalize();
    if (inward.dot(c.clone().sub(a)) < 0) inward.negate();
    if (x.clone().sub(a).dot(inward) < -margin) return null;
  }
  return { point: x, t: ray.origin.distanceTo(x) };
};

// The nearest panel a ray meets, skipping some.
W.rayPanel = function (ray, skip) {
  let best = null;
  for (const p of this.shell.panels) {
    if (skip(p)) continue;
    const r = this.rayOnPanel(ray, p);
    if (r && (!best || r.t < best.t)) best = { panel: p, ...r };
  }
  return best;
};

// What a Move drag needs, taken when it starts.
W.moveStart = function (comp, grab, det = null) {
  const sh = this.shell;
  const moving = new Set(comp);
  const M0 = new Map(comp.map((p) => [p, p.M.clone()]));
  const start = new Map(comp.map((p) => [p, sh.worldPoly(p)]));
  const startN = new Map(comp.map((p) => [p, sh.worldNormal(p).normalize()]));
  // A solid coming away from a join: its face at the join is hidden now but
  // is part of it (it can attach elsewhere); the face it leaves is hidden
  // too and will be exposed, so nothing may end up inside it.
  let extras = null;
  if (det && det.kind === 'solid') {
    for (const pc of det.hidden) {
      const face = { id: `inside:${pc.id}`, edges: [] };
      start.set(face, pc.verts.map((v) => v.clone()));
      startN.set(face, polyNormal(pc.verts));
    }
    extras = det.partners.map((pc) => ({ verts: pc.verts.map((v) => v.clone()), normal: polyNormal(pc.verts) }));
  }
  // Free edges of the moving panels that lie flat on the surface (Shape).
  const movEdges = [];
  for (const p of comp) {
    if (startN.get(p).y > -0.9999) continue;
    p.edges.forEach((e, i) => {
      if (e.uses.length === 1 && !this.isSeamed(p, i)) movEdges.push({ p, i });
      else if (e.uses.length === 2 && e.type !== 'hinge' && !moving.has(sh.other(e, p)) && !sh.intact(e)) movEdges.push({ p, i, rejoin: e });
    });
  }
  return { comp, moving, ids: new Set(comp.map((p) => p.id)), M0, start, startN, movEdges, grab: grab.clone(), det, extras,
    pieces: det ? det.pcs : null,
    canFace: this.restClosed(comp) && comp.every((p) => isIdentity(p.M)) };
};

// Would the moving object, moved by T, overlap or pass through anything
// (whole-face contact and shared edges are fine), or go below the surface?
W.snapProblem = function (job, T, { below = true } = {}) {
  job.blocker = null;
  const faces = [];
  for (const [p, w] of job.start) faces.push({ verts: w.map((v) => v.clone().applyMatrix4(T)), normal: job.startN.get(p).clone().transformDirection(T) });
  let low = Infinity;
  for (const f of faces) for (const v of f.verts) low = Math.min(low, v.y);
  if (below && low < -this.edgeLen * 1e-4) return 'it would go below the work surface';
  if (job.extras && job.extras.length) {
    const inside = Shell.prototype.meets.call({ panels: job.extras, edgeLen: this.edgeLen, worldPoly: (p) => p.verts.map((v) => v.clone()), worldNormal: (p) => p.normal.clone() }, faces);
    if (inside) return 'it would pass through the face it comes away from';
  }
  const hit = this.shell.meets(faces, (p) => job.moving.has(p));
  if (!hit) return null;
  job.blocker = hit;
  return this.state.mode === 'solid' ? `it would pass through face P${hit.no} (outlined in red)` : `it would overlap face P${hit.no} (outlined in red)`;
};

// Solid: the face under the pointer (of another closed form), and the pose
// that sets a matching face of the moving solid flush against it. The snap
// holds while the pointer stays over that face, give or take a quarter of
// an edge; a gentle pull further away lets it go.
W.faceSnapAt = function (ray, job, prev) {
  if (!ray || !job.canFace) return null;
  const hit = this.rayPanel(ray, (p) => job.moving.has(p));
  // The face under the pointer wins; just off the snapped face (and over
  // no other) the snap holds, until a gentle pull further away.
  if (prev && prev.B && (!hit || hit.panel === prev.B) && this.rayOnPanel(ray, prev.B, this.edgeLen * 0.25)) return prev;
  // A target shown lifted (for a join that rests on the surface) is judged
  // where it really is.
  if (this.liftSaved) {
    this.liftPreview(null);
    return this.faceSnapAt(ray, job, null);
  }
  if (!hit) return null;
  const B = hit.panel;
  if (prev && prev.B === B) return prev;
  // The object it joins: B's, without the part being moved (cutting a part
  // off and attaching it to another face of the same assembly is one move).
  const whole = this.componentOf(B);
  const comp = whole.filter((p) => !job.moving.has(p));
  const same = comp.length !== whole.length;
  if (!comp.every((p) => isIdentity(p.M)) || (!same && !this.restClosed(comp))) return { B, why: 'solids attach to faces of closed forms' };
  const wB = this.shell.worldPoly(B), n = wB.length;
  const tol = this.edgeLen * 1e-4;
  let best = null;
  for (const [A, wA] of job.start) {
    if (wA.length !== n) continue;
    for (let j = 0; j < n; j++) {
      // A's corners in order onto B's corners the other way round: the faces meet front to front.
      const to = (k) => wB[((j - k) % n + n) % n];
      const T = rigidFrom([wA[0], wA[1], wA[2]], [to(0), to(1), to(2)]);
      if (!wA.every((v, k) => v.clone().applyMatrix4(T).distanceTo(to(k)) < tol)) continue;
      const q = new THREE.Quaternion().setFromRotationMatrix(T);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      // Least turning first; then the face nearest where you hold it.
      const score = ang * 10 + job.grab.clone().applyMatrix4(T).distanceTo(hit.point);
      if (!best || score < best.score - 1e-9) best = { A, T, score };
    }
  }
  if (!best) return { B, why: `no face of this solid matches face P${B.no}` };
  // A join that would reach below the surface lifts the whole result so it
  // rests on the surface (as when placing a solid on a low face).
  let low = this.lowestY(comp);
  for (const w of job.start.values()) for (const v of w) low = Math.min(low, v.clone().applyMatrix4(best.T).y);
  const lift = low < -this.edgeLen * 1e-6 ? -low : 0;
  const bad = this.snapProblem(job, best.T, { below: false });
  return { B, A: best.A, T: best.T, lift, targetIds: new Set(comp.map((p) => p.id)), bad, blocker: bad ? job.blocker : null };
};

// While a join that lifts the result is previewed, the object it joins is
// shown lifted too.
W.liftPreview = function (snap) {
  if (this.liftSaved) { for (const [p, m] of this.liftSaved) p.M.copy(m); this.liftSaved = null; }
  if (!snap || !snap.lift || snap.bad) return;
  this.liftSaved = new Map();
  const L = new THREE.Matrix4().makeTranslation(0, snap.lift, 0);
  for (const p of this.shell.panels) if (snap.targetIds.has(p.id) && !this.liftSaved.has(p)) { this.liftSaved.set(p, p.M.clone()); p.M.premultiply(L); }
};

// Shape: a free edge of the moving object near a free edge of another of
// the same length (both lying flat). It snaps when the edges come within
// about a third of their length and holds until they are more than half
// their length apart (a gentle pull).
W.edgeSnapAt = function (job, prev, D) {
  if (!job.movEdges.length) return null;
  const sh = this.shell;
  const fix = [];
  for (const p of sh.panels) {
    if (job.moving.has(p) || sh.worldNormal(p).normalize().y > -0.9999) continue;
    p.edges.forEach((e, i) => {
      if (e.uses.length === 1 && !this.isSeamed(p, i)) fix.push({ p, i });
      // The other side of a cut the moving part came away from (or of the
      // hinge it is being cut from): it can go back. (Not judged by the
      // current preview pose, which may already be snapped.)
      else if (e.uses.length === 2 && (e.type !== 'hinge' || e === job.backEdge) && job.moving.has(sh.other(e, p))) fix.push({ p, i, rejoin: e });
    });
  }
  let best = null;
  for (const m of job.movEdges) {
    const w = job.start.get(m.p), nm = w.length;
    const a0 = w[m.i].clone().add(D), a1 = w[(m.i + 1) % nm].clone().add(D);
    const la = a0.distanceTo(a1);
    const am = a0.clone().add(a1).multiplyScalar(0.5);
    for (const f of fix) {
      if ((m.rejoin || null) !== (f.rejoin || null)) continue;
      const wf = sh.worldPoly(f.p), nf = wf.length;
      const b0 = wf[f.i], b1 = wf[(f.i + 1) % nf];
      if (Math.abs(b0.distanceTo(b1) - la) > la * 1e-6 || Math.abs(b0.y - a0.y) > la * 1e-4) continue;
      const dm = am.distanceTo(b0.clone().add(b1).multiplyScalar(0.5));
      const ang = Math.abs(wrapAngle(Math.atan2(b0.z - b1.z, b0.x - b1.x) - Math.atan2(a1.z - a0.z, a1.x - a0.x)));
      const held = prev && prev.m.p === m.p && prev.m.i === m.i && prev.f.p === f.p && prev.f.i === f.i;
      if (dm > (held ? 0.55 : 0.35) * la || ang > rad(75)) continue;
      const score = dm + ang * la * 0.3 - (held ? la : 0);
      if (!best || score < best.score) best = { m, f, score };
    }
  }
  if (!best) return null;
  const w = job.start.get(best.m.p);
  const a0 = w[best.m.i], a1 = w[(best.m.i + 1) % w.length];
  const wf = sh.worldPoly(best.f.p);
  const b0 = wf[best.f.i], b1 = wf[(best.f.i + 1) % wf.length];
  const up = new THREE.Vector3(0, 1, 0);
  const T = rigidFrom([a0, a1, a0.clone().add(up)], [b1, b0, b1.clone().add(up)]);
  const bad = this.snapProblem(job, T);
  return { m: best.m, f: best.f, T, rejoin: best.m.rejoin || null, bad, blocker: bad ? job.blocker : null };
};

// Highlights for a snap: the two meeting edges (Shape) or the two faces and
// their rims (Solid), green when it can join, red when it cannot.
W.showSnap = function (snap) {
  const key = snap && snap.T ? `${snap.m ? `${snap.m.p.id}#${snap.m.i}>${snap.f.p.id}#${snap.f.i}` : `${snap.A.id}>${snap.B.id}`}|${!!snap.bad}|${snap.blocker ? snap.blocker.id : ''}` : '';
  if (key === (this.snapKey || '')) return;
  this.snapKey = key;
  // A join that something is in the way of: that face shows red, with its number.
  const blocker = snap && snap.T && snap.bad && snap.blocker ? snap.blocker : null;
  if (blocker || this.blockShown) { this.showIdLabels(blocker ? [blocker] : []); this.blockShown = !!blocker; }
  this.blockPanels = blocker ? new Set([blocker]) : null;
  // Faces that meet are hidden between the two solids, so their rims are
  // drawn too: a green (or red) ring where the solids join.
  this.snapEdges = !(snap && snap.T) ? null : snap.m ? new Set([snap.m.p.edges[snap.m.i], snap.f.p.edges[snap.f.i]]) : new Set([...snap.A.edges, ...snap.B.edges]);
  this.snapPanels = snap && snap.T && snap.A ? new Set([snap.A, snap.B]) : null;
  this.snapBad = !!(snap && snap.bad);
  this.refreshStyles();
};

// Release over a valid target: move and attach as one undoable step.
W.commitSnap = function (job, snap, before, prefix = '') {
  const sh = this.shell;
  const ids = job.ids;
  if (snap.A) {
    const targetIds = snap.targetIds;
    const Bno = snap.B.no;
    const former = job.det ? job.det.wholeIds : new Set();
    this.transformComponent(job.comp, snap.T, job.pieces);
    let joined = null;
    this.rebuildKeep(() => {}, {
      defaultNet: true,
      skip: (e) => {
        if (!joined) { joined = new Set(); const p0 = sh.panels.find((p) => ids.has(p.id)); if (p0) for (const q of this.componentOf(p0)) joined.add(q); }
        return e.uses.some((u) => joined.has(u.panel) || former.has(u.panel.id));
      },
      after: () => this.tidyBases(ids),
    });
    let mine = new Set(sh.panels.filter((p) => ids.has(p.id)));
    if (mine.size) {
      const joinedNow = this.componentOf([...mine][0]);
      const low = this.lowestY(joinedNow);
      if (low < -this.edgeLen * 1e-6) { this.transformComponent(joinedNow, new THREE.Matrix4().makeTranslation(0, -low, 0)); mine = new Set(sh.panels.filter((p) => ids.has(p.id))); }
    }
    const bad = this.overlapsWith(mine);
    const together = mine.size && this.componentOf([...mine][0]).some((p) => targetIds.has(p.id));
    if (bad || !together) {
      this.restoreSnapshot(before);
      this.app.toast(bad ? `Not attached: it would pass through face P${bad.no}. It stays where it was.` : 'Not attached: the faces did not join. It stays where it was.', 5000);
      return false;
    }
    this.pushHistory(before);
    this.detach = null;
    this.selComp = new Set(this.componentOf([...mine][0]));
    this.refreshStyles();
    this.app.toast(`${prefix}${job.det ? 'Cut off and attached' : 'Attached'} to face P${Bno}: ${this.objectText([...this.selComp])} are one object now (the faces that meet are inside it). Undo separates them.`, 5000);
    return true;
  }
  // Shape, back to the edge it was cut from: put it there and hinge it.
  if (snap.rejoin) {
    const e = snap.rejoin;
    for (const [p, m0] of job.M0) p.M.copy(snap.T.clone().multiply(m0));
    this.updateMatrices();
    if (!sh.intact(e)) { this.restoreSnapshot(before); this.app.toast('Not joined: the edges did not meet exactly. It stays where it was.', 5000); return false; }
    e.type = 'hinge';
    const mine = new Set(job.comp);
    const bad = this.overlapsWith(mine);
    if (bad) { this.restoreSnapshot(before); this.app.toast(`Not joined: it would overlap face P${bad.no}. It stays where it was.`, 5000); return false; }
    this.shell.classify();
    this.checkOverlaps();
    this.pushHistory(before);
    this.detach = null;
    this.refreshStyles();
    this.app.toast(`${prefix}Joined: back on its edge, and edge ${e.no} is a hinge again. Undo separates them.`, 5000);
    return true;
  }
  // Shape: join the two edges with a hinge. The moving object goes into the
  // rest frame of the panel it joins, so the hinge is a real fold line.
  const Mm = job.M0.get(snap.m.p), MP = snap.f.p.M.clone();
  const R = MP.clone().invert().multiply(snap.T).multiply(Mm);
  const key = [`${snap.m.p.id}#${snap.m.i}`, `${snap.f.p.id}#${snap.f.i}`].sort().join('|');
  const fno = snap.f.p.no, name = shapeName(snap.m.p.verts.length).toLowerCase();
  const many = job.comp.length > 1;
  this.reframeComponent(job.comp, R, snap.T, {
    pieces: job.pieces || undefined,
    hinges: [key],
    after: () => this.tidyBases(ids),
  });
  const e = sh.edges.find((x) => x.uses.length === 2 && pairKey(x) === key);
  const mine = new Set(sh.panels.filter((p) => ids.has(p.id)));
  const bad = this.overlapsWith(mine);
  if (!e || e.type !== 'hinge' || bad) {
    this.restoreSnapshot(before);
    this.app.toast(bad ? `Not joined: it would overlap face P${bad.no}. It stays where it was.` : 'Not joined: the edges did not meet exactly. It stays where it was.', 5000);
    return false;
  }
  this.pushHistory(before);
  this.detach = null;
  this.selComp = new Set(this.componentOf([...mine][0]));
  this.refreshStyles();
  this.app.toast(`${prefix}Joined: the ${many ? 'net piece' : name} is hinged to the edge of P${fno}. Fold it with Fold; Undo separates them.`, 5000);
  return true;
};

// One base (the panel a net opens around) per object: the moving one's
// bases go when it joins another object; objects without one get one.
W.tidyBases = function (drop = new Set()) {
  const sh = this.shell;
  for (const id of drop) sh.bases.delete(id);
  for (const c of sh.pieces()) {
    const bs = c.filter((p) => sh.bases.has(p.id));
    if (!bs.length) sh.chooseBasesFor(c);
    else for (const p of bs.slice(1)) sh.bases.delete(p.id);
  }
};

// ---------------------------------------------- detaching a joined part

// What comes away if you pull at P after a join. Solid: the solid P belongs
// to (one placed polyhedron, or the form built from shapes), at every face
// where it meets the others. Shape: the part hinged to P, along the cut
// (dashed) edges that hold it to the rest. Null when nothing can come away.
W.detachFor = function (P) {
  const sh = this.shell;
  const comp = this.componentOf(P);
  if (this.state.mode === 'solid') {
    const unit = this.solidUnit(P);
    const own = new Set(unit.map((pc) => pc.id));
    const part = comp.filter((p) => own.has(p.solidId));
    if (!part.length || part.length === comp.length) return null;
    const partIds = new Set(part.map((p) => p.id));
    const ringKeys = new Set();
    for (const p of part) for (const e of p.edges) if (e.uses.length === 2 && e.uses.some((u) => !partIds.has(u.panel.id))) ringKeys.add(pairKey(e));
    const hidden = [], partners = [];
    for (const it of sh.internal) {
      const a = this.comp.piece(Number(String(it.a).split(':')[0])), b = this.comp.piece(Number(String(it.b).split(':')[0]));
      if (!a || !b) continue;
      if (own.has(a.id) && !own.has(b.id)) { hidden.push(a); partners.push(b); } else if (own.has(b.id) && !own.has(a.id)) { hidden.push(b); partners.push(a); }
    }
    const pc0 = unit[0];
    const name = pc0.origin != null ? (TEMPLATES[pc0.kind]?.name || 'solid').toLowerCase() : 'form';
    return { kind: 'solid', partIds, pcs: unit, ringKeys, hidden, partners, name, wholeIds: new Set(comp.map((p) => p.id)) };
  }
  const sec = [...sh.hingeComponent(P)];
  if (sec.length === comp.length) return null;
  const partIds = new Set(sec.map((p) => p.id));
  const ringKeys = new Set();
  for (const p of sec) for (const e of p.edges) if (e.uses.length === 2 && e.uses.some((u) => !partIds.has(u.panel.id))) ringKeys.add(pairKey(e));
  const pcs = sec.map((p) => this.comp.piece(p.solidId)).filter(Boolean);
  return { kind: 'shape', partIds, pcs, ringKeys, wholeIds: new Set(comp.map((p) => p.id)), name: sec.length === 1 ? shapeName(sec[0].verts.length).toLowerCase() : `section of ${sec.length} faces` };
};

W.clearDetach = function (redraw = true) {
  if (!this.detach) return;
  this.detach = null;
  if (redraw) this.refreshStyles();
};

// Faces drawn on their own while a joined solid is pulled away (the faces
// at the join are hidden inside until the move is done).
W.tempFaces = function (pcs, state) {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const origins = [];
  for (const pc of this.comp.pieces) { const o = pc.origin ?? pc.id; if (!origins.includes(o)) origins.push(o); }
  for (const pc of pcs) {
    const n = polyNormal(pc.verts);
    const pos = [], nrm = [], idx = [];
    for (const v of pc.verts) { pos.push(v.x, v.y, v.z); nrm.push(n.x, n.y, n.z); }
    for (let i = 1; i < pc.verts.length - 1; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setIndex(idx);
    const parity = origins.indexOf(pc.origin ?? pc.id) % 2;
    group.add(new THREE.Mesh(g, this.material('out', parity, state, pc.kind || 'piece')), new THREE.Mesh(g, this.material('in', parity, 'none', pc.kind || 'piece')));
  }
  this.shellGroup.add(group);
  return group;
};

W.dropTempFaces = function (group) {
  if (!group) return;
  this.shellGroup.remove(group);
  group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
};

// Release of a part pulled away from a join (Solid), not on a snap.
W.commitDetach = function (job, T, before) {
  const det = job.det;
  const sh = this.shell;
  const own = new Set(det.pcs.map((pc) => pc.id));
  this.transformComponent(job.comp, T, det.pcs);
  this.rebuildKeep(() => {}, { defaultNet: true, skip: (e) => e.uses.some((u) => det.wholeIds.has(u.panel.id) || own.has(u.panel.solidId)), after: () => this.tidyBases() });
  const mine = new Set(sh.panels.filter((p) => own.has(p.solidId)));
  const bad = this.overlapsWith(mine);
  if (bad) { this.restoreSnapshot(before); this.app.toast(`Not detached: it would overlap face P${bad.no}. It stays joined.`, 5000); return false; }
  this.pushHistory(before);
  this.detach = null;
  this.selComp = new Set(this.componentOf([...mine][0]));
  this.refreshStyles();
  const high = this.lowestY([...this.selComp]) > this.edgeLen * 1e-4;
  this.app.toast(`Detached the ${det.name} and moved it ${Math.round(new THREE.Vector3().setFromMatrixPosition(T).length() * 1000)} mm; the rest keeps its other joins.${high ? ' It is above the surface: Arrange sets it down.' : ''} Undo joins it again.`, 6000);
  return true;
};

W.objectCentre = function (comp) {
  const box = new THREE.Box3();
  for (const p of comp) for (const v of this.shell.worldPoly(p)) box.expandByPoint(v);
  return box.getCenter(new THREE.Vector3());
};

// ----------------------------------------------------------------- remove

W.removeAt = function (hit) {
  const P = hit.panel;
  if (!P) return;
  const before = this.snapshot();
  if (this.state.mode === 'solid') {
    if (this.isPiecePanel(P)) {
      // The solid under the tap: one placed polyhedron, or the form built
      // from shapes. What it was joined to stays, with a fresh default net.
      const unit = this.solidUnit(P);
      const ids = new Set(unit.map((pc) => pc.id));
      const was = new Set(this.componentOf(P).map((p) => p.id));
      const pc0 = unit[0];
      const name = pc0 && pc0.origin != null ? (TEMPLATES[pc0.kind]?.name || 'Solid') : `A form of ${unit.length} face${unit.length === 1 ? '' : 's'}`;
      this.rebuildKeep(() => { for (const id of ids) this.comp.removePiece(id); }, { defaultNet: true, skip: (e) => e.uses.some((u) => was.has(u.panel.id)) });
      this.pushHistory(before);
      this.app.toast(`${name} removed. Undo brings it back.`);
      return;
    }
    const s = this.comp.get(P.solidId);
    if (!s) return;
    const comp = this.componentOf(P);
    this.rebuildKeep(() => { this.comp.remove(s.id); }, { defaultNet: true, skip: (e) => e.uses.some((u) => comp.some((q) => q.solidId === u.panel.solidId)) });
    this.pushHistory(before);
    this.app.toast(`${TEMPLATES[s.type].name} removed. Undo brings it back.`);
    return;
  }
  // Shape: an edge between two faces merges them; a face is removed.
  const e = this.edgeNear(P, hit.local, 0.16);
  if (e && e.shared && e.uses.length === 2) {
    if (e.uses.every((u) => this.isPiecePanel(u.panel))) this.mergePieces(e);
    else this.mergeEdge(e, { ghost: false });
    return;
  }
  if (!this.isPiecePanel(P)) { this.app.toast('Faces of a solid are removed with the solid (Solid mode, Remove). Removing one face of a solid comes in the next stage.', 5000); return; }
  this.rebuildKeep(() => { this.comp.removePiece(P.solidId); });
  this.pushHistory(before);
  this.app.toast(`${shapeName(P.verts.length)} removed${this.shell.panels.length ? '; any opening it leaves stays open' : ''}. Undo brings it back.`);
};

// --------------------------------------------------------- merge (Remove)

// Two pieces that lie flat together become one piece (Remove on the edge
// between them). Cuts, hinges and glued edges around them carry over.
W.mergePieces = function (e) {
  const sh = this.shell;
  const [u, w] = e.uses;
  const P = u.panel, Q = w.panel, i = u.i, j = w.i;
  const nP = P.verts.length, nQ = Q.verts.length;
  const n = P.normal.clone().normalize();
  const tol = this.edgeLen * 1e-6;
  const coplanar = n.dot(Q.normal.clone().normalize()) > 1 - 1e-9 && Q.verts.every((v) => Math.abs(v.clone().sub(P.verts[0]).dot(n)) < tol);
  if (!coplanar) {
    const ang = 180 - deg(Math.acos(THREE.MathUtils.clamp(n.dot(Q.normal.clone().normalize()), -1, 1)));
    this.flashEdge(e);
    this.app.toast(`Faces P${P.no} and P${Q.no} meet at ${ang.toFixed(1)}° in the form, not flat, so they cannot be one face.`, 5000);
    return false;
  }
  if (!sh.intact(e) || sh.worldNormal(P).normalize().dot(sh.worldNormal(Q).normalize()) < 1 - 1e-9) {
    this.flashEdge(e);
    this.app.toast(`Faces P${P.no} and P${Q.no} are folded apart along that edge. Unfold it flat (Fold) before merging them.`, 5000);
    return false;
  }
  const loop = [];
  for (let k = 0; k < nP; k++) loop.push(P.verts[(i + 1 + k) % nP].clone());
  for (let k = 0; k < nQ - 2; k++) loop.push(Q.verts[(j + 2 + k) % nQ].clone());
  if (!isConvexLoop(loop, n)) {
    this.flashEdge(e);
    this.app.toast(`Together, P${P.no} and P${Q.no} would not be convex (a corner would point inward), so they stay two faces.`, 5000);
    return false;
  }
  // A hinge path between them would close a loop of hinges: one hinge on
  // it becomes a cut.
  let note = '';
  const path = this.hingePath(P, Q, e);
  if (path) {
    const h = path.slice().reverse().find((x) => !x.userLock);
    if (!h) { this.app.toast(`P${P.no} and P${Q.no} are joined through locked hinges; merging would close a loop of hinges.`, 5000); return false; }
    const [a, b] = h.uses.map((x) => x.panel);
    h.type = 'cut';
    note = ` To keep the hinges free of loops, the hinge between P${a.no} and P${b.no} is now a cut.`;
  }
  const map = new Map();
  for (let k = 0; k < nP - 1; k++) map.set(`${P.id}#${(i + 1 + k) % nP}`, `${P.id}#${k}`);
  for (let k = 0; k < nQ - 1; k++) map.set(`${Q.id}#${(j + 1 + k) % nQ}`, `${P.id}#${nP - 1 + k}`);
  const re = (k) => map.get(k) || k;
  const gone = pairKey(e);
  const pcP = this.comp.piece(P.solidId), pcQ = this.comp.piece(Q.solidId);
  const before = this.snapshot();
  const straight = loop.some((v, k) => { const a = loop[(k + loop.length - 1) % loop.length], c = loop[(k + 1) % loop.length]; return v.clone().sub(a).normalize().dot(c.clone().sub(v).normalize()) > 1 - 1e-9; });
  this.rebuildKeep((st) => {
    st.edges = new Map([...st.edges].filter(([k]) => k !== gone).map(([k, v]) => [k.split('|').map(re).sort().join('|'), v]));
    st.M.delete(Q.id);
    st.bases = st.bases.map((id) => (id === Q.id ? P.id : id));
    this.comp.seams = this.comp.seams.map(([a, b]) => [re(a), re(b)]);
    pcP.verts = loop;
    pcP.n = loop.length;
    this.comp.removePiece(pcQ.id);
  });
  this.pushHistory(before);
  const np = this.shell.panelById.get(P.id);
  this.app.toast(`Merged into one face${np ? ` (P${np.no}, ${loop.length} corners${straight ? ', some of them straight where edges of neighbours meet' : ''})` : ''}.${note} Undo splits it again.`, 6000);
  this.app.notify?.();
  return true;
};

// ------------------------------------------------ modify (both modes)

// What a press on a face grabs: a corner (with its two edges) or an edge.
W.modifyGrab = function (P, local) {
  const n = P.verts.length;
  let best = null, bd = this.edgeLen * 0.2;
  P.verts.forEach((v, k) => { const d = v.distanceTo(local); if (d < bd) { bd = d; best = { kind: 'corner', verts: [k], edges: [(k + n - 1) % n, k] }; } });
  if (best) return best;
  const e = this.edgeNear(P, local, 0.2);
  const i = e ? P.edges.indexOf(e) : -1;
  return i >= 0 ? { kind: 'edge', verts: [i, (i + 1) % n], edges: [i] } : null;
};

// Everything a reshape needs, taken when the drag starts: the object's
// corners (shared corners move as one, hidden faces included), its faces,
// its hinge angles, which hinges lie flat, and how its roots rest.
W.modifyStart = function (P, grab) {
  const sh = this.shell;
  const comp = this.componentOf(P);
  const pcs = this.objectPieces(comp);
  const tol = this.edgeLen * 1e-5;
  const pts = [];
  const keyOf = (v) => { for (let k = 0; k < pts.length; k++) if (pts[k].distanceTo(v) < tol) return k; pts.push(v.clone()); return pts.length - 1; };
  const faces = [], refs = [], edges = new Map();
  for (const pc of pcs) {
    const ks = pc.verts.map(keyOf);
    pc.verts.forEach((v, i) => refs.push({ pc, i, key: ks[i] }));
    const panel = sh.panelById.get(`${pc.id}:0`);
    faces.push({ id: panel ? `P${panel.no}` : 'inside', keys: ks, planar: ks.length > 3, hidden: !panel });
    if (panel) ks.forEach((a, i) => { const b = ks[(i + 1) % ks.length]; const k = a < b ? `${a}|${b}` : `${b}|${a}`; if (!edges.has(k)) edges.set(k, [a, b]); });
  }
  const start = new Map(pts.map((v, k) => [k, v]));
  const pcP = this.comp.piece(P.solidId);
  const keyAt = (i) => refs.find((r) => r.pc === pcP && r.i === i).key;
  const moving = [...new Set(grab.verts.map(keyAt))];
  // The rest of the grabbed face holds still; other faces follow to stay flat.
  const pins = new Set(pcP.verts.map((v, i) => keyAt(i)).filter((k) => !moving.includes(k)));
  const F = sh.forest();
  const ang = new Map(), flat = new Map();
  for (const [c, { parent, e }] of F.parent) { ang.set(c.id, sh.angle(e, c, parent)); flat.set(c.id, sh.flatAngle(e, c, parent)); }
  const lie = new Map();
  for (const r of F.roots) if (comp.includes(r) && sh.worldNormal(r).normalize().y < -0.9999) lie.set(r.id, sh.worldPoly(r)[0].y);
  // Is the whole object lying flat (a net, all faces in one plane)?
  const n0 = sh.worldNormal(comp[0]).normalize(), o0 = sh.worldPoly(comp[0])[0];
  const allFlat = comp.every((p) => sh.worldNormal(p).normalize().dot(n0) > 1 - 1e-9 && sh.worldPoly(p).every((v) => Math.abs(v.clone().sub(o0).dot(n0)) < this.edgeLen * 1e-6));
  const ids = new Set(comp.map((p) => p.id));
  const key2 = (a, b) => [a.id, b.id].sort().join('|');
  const overl0 = new Set(sh.overlaps().pairs.filter(([a, b]) => ids.has(a.id) || ids.has(b.id)).map(([a, b]) => key2(a, b)));
  return { pid: P.id, pc: pcP, grab, model: { pos: start, faces, edges: [...edges.values()], open: !this.restClosed(comp) }, start, refs, moving, pins,
    st: this.stateById(), ang, flat, lie, allFlat, ids, overl0, key2, low0: this.lowestY(comp), closed: comp.every((p) => isIdentity(p.M)) };
};

// Corners at new places: rebuild, and pose the object again with the same
// hinge angles (hinges that lay flat stay flat, closed ones stay closed,
// roots that rested face down on the surface keep resting there).
W.modifySet = function (job, P) {
  for (const r of job.refs) r.pc.verts[r.i].copy(P.get(r.key));
  const sh = this.shell;
  sh.build(this.comp);
  this.restoreById(job.st);
  const F = sh.forest();
  const angles = new Map();
  for (const [c, { parent, e }] of F.parent) {
    const a0 = job.ang.get(c.id), f0 = job.flat.get(c.id);
    // A hinge between faces that are flat together at rest is both closed
    // and flat (angle 0): in a net lying flat it stays flat, otherwise closed.
    if (a0 === undefined) angles.set(c, sh.angle(e, c, parent));
    else if (Math.abs(a0 - f0) < 1e-6 && (job.allFlat || Math.abs(a0) > 1e-9)) angles.set(c, sh.flatAngle(e, c, parent));
    else angles.set(c, a0);
  }
  const roots = new Map();
  for (const r of F.roots) {
    const m0 = job.st.M.get(r.id);
    if (!m0) continue;
    const M = m0.clone();
    if (job.lie.has(r.id)) {
      const nrm = r.normal.clone().transformDirection(M).normalize();
      const w = r.verts.map((v) => v.clone().applyMatrix4(M));
      const c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length);
      const q = new THREE.Quaternion().setFromUnitVectors(nrm, new THREE.Vector3(0, -1, 0));
      M.premultiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)));
      const y = r.verts[0].clone().applyMatrix4(M).y;
      M.premultiply(new THREE.Matrix4().makeTranslation(0, job.lie.get(r.id) - y, 0));
    }
    roots.set(r, M);
  }
  sh.applyForest(F, angles, roots);
};

// Is the posed object still valid? Edges glued while folding still meet,
// and no faces overlap that did not overlap before.
W.modifyPosedProblem = function (job) {
  const sh = this.shell;
  const tol = this.edgeLen * 1e-5;
  for (const [a, b] of this.comp.seams) {
    const ha = a.lastIndexOf('#'), hb = b.lastIndexOf('#');
    const A = sh.panelById.get(a.slice(0, ha)), B = sh.panelById.get(b.slice(0, hb));
    if (!A || !B || (!job.ids.has(A.id) && !job.ids.has(B.id))) continue;
    const i = +a.slice(ha + 1), j = +b.slice(hb + 1);
    const wa = sh.worldPoly(A), wb = sh.worldPoly(B);
    if (!(wa[i].distanceTo(wb[(j + 1) % wb.length]) < tol && wa[(i + 1) % wa.length].distanceTo(wb[j]) < tol)) return 'it would pull apart edges that were joined while folding';
  }
  for (const [a, b] of sh.overlaps().pairs) {
    if (!job.ids.has(a.id) && !job.ids.has(b.id)) continue;
    if (!job.overl0.has(job.key2(a, b))) return `faces P${a.no} and P${b.no} would overlap`;
  }
  return null;
};

// Move the grabbed corners by `delta` (rest frame of the object), or as
// far as stays valid.
W.modifyTo = function (job, delta) {
  const attempt = (t) => {
    const targets = new Map(job.moving.map((k) => [k, job.start.get(k).clone().addScaledVector(delta, t)]));
    const s = solvePlanar(job.model, job.start, job.pins, targets);
    if (s.dev > 1e-6) return { ok: false, reason: `face ${s.face} would bend out of plane` };
    const why = checkForm(job.model, s.P);
    if (why) return { ok: false, reason: why };
    this.modifySet(job, s.P);
    const pw = this.modifyPosedProblem(job);
    return { ok: !pw, reason: pw, P: s.P };
  };
  const full = attempt(1);
  let best = full.ok ? full : null, t = 1;
  if (!full.ok) {
    let lo = 0, hi = 1;
    for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; const m = attempt(mid); if (m.ok) { lo = mid; best = m; } else hi = mid; }
    t = lo;
  }
  this.modifySet(job, best ? best.P : job.start);
  this.refreshAll();
  return { t, reason: full.ok ? null : full.reason };
};

// After a reshape: a closed form that rested on the surface rests there again.
W.modifyFinish = function (job) {
  const P = this.shell.panelById.get(job.pid);
  if (!P || !job.closed || job.low0 > this.edgeLen * 1e-3) return;
  const comp = this.componentOf(P);
  const dy = job.low0 - this.lowestY(comp);
  if (Math.abs(dy) > 1e-9) this.transformComponent(comp, new THREE.Matrix4().makeTranslation(0, dy, 0));
};

// Lengths along the grabbed corner or edge, for the tag.
W.modifyText = function (job) {
  const v = job.pc.verts, n = v.length;
  const len = (i) => Math.round(v[i].distanceTo(v[(i + 1) % n]) * 1000);
  const k = job.grab.verts[0];
  const moved = Math.round(v[k].distanceTo(job.start.get(job.moving[0])) * 1000);
  if (job.grab.kind === 'corner') return `Corner +${moved} mm · ${len(job.grab.edges[0])} / ${len(job.grab.edges[1])} mm`;
  const i = job.grab.edges[0];
  return `Edge +${moved} mm · ${len((i + n - 1) % n)} / ${len((i + 1) % n)} mm`;
};

// A dot on the corner being reshaped (or about to be), in the shell frame.
W.showModDot = function (at) {
  if (!at) { if (this.modDot) this.modDot.visible = false; return; }
  if (!this.modDot) {
    this.modDot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: '#f28c28', depthTest: false, transparent: true, opacity: 0.95 }));
    this.modDot.renderOrder = 12;
    this.modDot.userData.ui = true;
    this.shellGroup.add(this.modDot);
  }
  this.modDot.scale.setScalar(this.edgeLen * 0.045);
  this.modDot.position.copy(at);
  this.modDot.visible = true;
};

W.modifyWorld = function (job) {
  const P = this.shell.panelById.get(job.pid);
  if (!P) return null;
  const c = job.grab.verts.map((i) => job.pc.verts[i]).reduce((a, x) => a.add(x), new THREE.Vector3()).divideScalar(job.grab.verts.length);
  // The tag floats a little above the grabbed edge, so it does not hide it.
  return this.shellGroup.localToWorld(c.applyMatrix4(P.M).add(new THREE.Vector3(0, this.edgeLen * 0.45, 0)));
};

// ------------------------------------------------------------ info, errors

W.infoCounts = function () {
  const sh = this.shell;
  const verts = new Set(sh.panels.flatMap((p) => p.vid));
  // Closed forms count as solids (one per placed polyhedron, one per form
  // built from shapes); the faces of open nets count as shapes.
  let solids = this.comp.solids.length, shapes = 0;
  for (const comp of sh.pieces()) {
    if (this.restClosed(comp)) solids += new Set(this.objectPieces(comp).map((pc) => pc.origin ?? 'own')).size;
    else shapes += comp.length;
  }
  return { solids, shapes, faces: sh.panels.length, edges: sh.edges.length, vertices: verts.size,
    hinges: sh.edges.filter((e) => e.shared && e.type === 'hinge').length, objects: sh.pieces().length };
};

// One line per object for the Info panel: what it is, its connections,
// and the form it is in now.
W.infoObjects = function () {
  const sh = this.shell;
  return sh.pieces().map((c, k) => {
    const ids = new Set(c.map((p) => p.id));
    const mine = sh.edges.filter((e) => ids.has(e.uses[0].panel.id));
    const hinges = mine.filter((e) => e.uses.length === 2 && e.type === 'hinge').length;
    const cuts = mine.filter((e) => e.uses.length === 2 && e.type !== 'hinge').length;
    const freeE = mine.filter((e) => e.uses.length === 1);
    const seamed = freeE.filter((e) => this.isSeamed(e.uses[0].panel, e.uses[0].i)).length;
    const free = freeE.length - seamed;
    const atRest = c.every((p) => isIdentity(p.M));
    const flat = c.every((p) => this.lyingFlat(p));
    const state = flat ? 'lying flat' : atRest ? (this.restClosed(c) ? 'folded closed' : 'in its 3D form, with an opening') : 'partly folded';
    return `Object ${k + 1}: ${this.objectText(c)} · ${c.length} face${c.length === 1 ? '' : 's'} · ${hinges} hinge${hinges === 1 ? '' : 's'} · ${cuts} cut edge${cuts === 1 ? '' : 's'}${seamed ? ` · ${seamed / 2} seam${seamed === 2 ? '' : 's'} (joined while folding)` : ''}${free ? ` · ${free} free edge${free === 1 ? '' : 's'}` : ''} · ${state}`;
  });
};

W.infoText = function () {
  const c = this.infoCounts();
  const parts = [];
  if (c.solids) parts.push(`${c.solids} solid${c.solids === 1 ? '' : 's'}`);
  if (c.shapes) parts.push(`${c.shapes} shape${c.shapes === 1 ? '' : 's'}`);
  if (!parts.length) return 'Empty workspace';
  return `${parts.join(' · ')} · ${c.faces} faces · ${c.edges} edges · ${c.vertices} vertices · ${c.hinges} hinges`;
};

W.errorList = function () {
  const out = [];
  for (const m of this.modeIssues) out.push({ text: m.text, ids: m.ids });
  const res = this.shell.overlaps();
  const solidMode = this.state.mode === 'solid';
  for (const [a, b] of res.pairs.slice(0, 12)) {
    const sameObj = this.componentOf(a).includes(b);
    if (solidMode && !sameObj && a.solidId !== b.solidId) out.push({ text: `Solids intersect: faces P${a.no} and P${b.no}.`, ids: [a.id, b.id] });
    else out.push({ text: `Faces P${a.no} and P${b.no} overlap${sameObj ? ' in the same net' : ''}.`, ids: [a.id, b.id] });
  }
  return out;
};

W.focusIds = function (ids) {
  const set = new Set(ids);
  const panels = this.shell.panels.filter((p) => set.has(p.id));
  this.flashPanels = new Set(panels);
  this.refreshStyles();
  clearTimeout(this.flashPanelsTimer);
  this.flashPanelsTimer = setTimeout(() => { this.flashPanels = null; this.refreshStyles(); }, 1800);
  const box = new THREE.Box3();
  for (const p of panels) for (const v of this.shell.worldPoly(p)) box.expandByPoint(v);
  if (!box.isEmpty()) this.app.focusBox?.(this.worldBox(box));
};

// --------------------------------------------------------- empty and new

W.newEmpty = function () {
  this.showPlaceZone(false);
  this.lastRefold = null;
  this.selComp = null;
  this.newProject('empty');
  this.state.mode = 'shape';
  this.state.mtool = null;
  this.state.tool = 'select';
  this.placing = null;
  this.modeIssues = [];
  this.app.fitCamera?.();
  this.app.notify?.();
};

// ------------------------------------------------------ the tool gestures

const down0 = T.down;
T.down = function (ptr, override) {
  const ws = this.ws;
  if (this.active.has(ptr.id)) return false;
  // Placement happens on a tap: on a screen it is recognised on release
  // (so a pinch or an orbit never places anything); a controller or hand
  // places on release of the trigger or pinch.
  if (ws.placing) {
    if (ptr.kind === 'screen') return false;
    this.active.set(ptr.id, { move: () => {}, end: () => ws.placeTap(ptr) });
    return true;
  }
  const tool = ws.state.tool;
  if (['select', 'remove'].includes(tool)) {
    // Taps: recognised on release on a screen (drags orbit the view).
    if (ptr.kind === 'screen') return false;
    this.active.set(ptr.id, { move: () => {}, end: () => ws.tap(ptr) });
    return true;
  }
  if (['rotate', 'move', 'modify2d', 'scissors'].includes(tool)) {
    const hit = ptr.pick();
    if (!hit || !hit.panel) return false;
    const g = tool === 'rotate' ? (ws.state.mode === 'solid' ? this.beginSolidTurn(ptr, hit) : this.beginObjectTurn(ptr, hit))
      : tool === 'move' ? this.beginObjectMove(ptr, hit)
        : tool === 'scissors' ? this.beginScissors(ptr, hit)
          : this.beginModify(ptr, hit);
    if (!g) return false;
    this.active.set(ptr.id, g);
    return true;
  }
  return down0.call(this, ptr, override);
};

// Drag a whole object around the vertical through its middle.
T.beginObjectTurn = function (ptr, hit) {
  const ws = this.ws;
  if (ws.comp.isEdited() || ws.comp.isShaped()) { ws.app.toast('Reset edits before turning objects.'); return null; }
  const comp = ws.componentOf(hit.panel);
  const c = ws.objectCentre(comp);
  const ref = { dist: hit.distance, stick: true };
  const p0 = this.surfacePoint(ptr, ref);
  if (!p0) return null;
  const a0 = Math.atan2(p0.z - c.z, p0.x - c.x);
  const M0 = new Map(comp.map((p) => [p, p.M.clone()]));
  let ang = 0, started = false;
  const moved = this.dragDetector(ptr, hit);
  const R = (a) => new THREE.Matrix4().makeTranslation(c.x, 0, c.z).multiply(new THREE.Matrix4().makeRotationY(a)).multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
  ws.selComp = new Set(comp);
  ws.refreshStyles();
  return {
    move: (p) => {
      if (!started && !moved(p)) return;
      started = true;
      const q = this.surfacePoint(p, ref);
      if (!q) return;
      ang = -wrapAngle(Math.atan2(q.z - c.z, q.x - c.x) - a0);
      const m = R(ang);
      for (const [pp, m0] of M0) pp.M.copy(m.clone().multiply(m0));
      ws.updateMatrices();
      ws.setTag(`Turn ${Math.round(deg(-ang))}°`, ws.shellGroup.localToWorld(c.clone()));
    },
    end: () => {
      ws.hideTag();
      if (!started || Math.abs(ang) < 1e-4) { for (const [pp, m0] of M0) pp.M.copy(m0); ws.updateMatrices(); if (!started) ws.app.toast('Drag the object sideways around its middle to turn it.'); return; }
      for (const [pp, m0] of M0) pp.M.copy(m0);
      const before = ws.snapshot();
      ws.transformComponent(comp, R(ang));
      ws.pushHistory(before);
      ws.selComp = new Set(ws.componentOf(ws.shell.panelById.get(comp[0].id)) || []);
      ws.refreshStyles();
      ws.app.toast(`Turned ${Math.round(Math.abs(deg(ang)))}°; its connections and fold angles are unchanged.`);
    },
    cancel: () => { ws.hideTag(); for (const [pp, m0] of M0) pp.M.copy(m0); ws.updateMatrices(); },
  };
};

// Move: drag a whole object across the work surface. In Solid, over a
// matching face of another solid it snaps flush against it (both faces
// green; red if it cannot go there); in Shape, a free edge near a matching
// free edge of another piece snaps to it (both edges green). A gentle pull
// away lets the snap go. Releasing on a snap moves and joins in one step;
// releasing elsewhere moves it, unless it would overlap something.
T.beginObjectMove = function (ptr, hit) {
  const ws = this.ws;
  if (ws.comp.isEdited() || ws.comp.isShaped()) { ws.app.toast('Reset edits before moving objects.'); return null; }
  const solid = ws.state.mode === 'solid';
  // Move takes the whole object (a joined group, a whole net). Pulling one
  // part out of it is Scissors.
  ws.clearDetach(false);
  const comp = ws.componentOf(hit.panel);
  const det = null;
  const ref = { dist: hit.distance, stick: true };
  const p0 = this.surfacePoint(ptr, ref);
  if (!p0) return null;
  const job = ws.moveStart(comp, ws.toLocal(hit.point), det);
  let temp = null;
  let d = new THREE.Vector3(), started = false, snap = null, good = null;
  const moved = this.dragDetector(ptr, hit);
  const before = ws.snapshot();
  ws.selComp = new Set(comp);
  ws.refreshStyles();
  const pose = (T) => {
    for (const [pp, m0] of job.M0) pp.M.copy(T.clone().multiply(m0));
    if (temp) temp.moving.matrix.copy(T);
    ws.updateMatrices(); ws.checkOverlaps(); ws.refreshMaterials();
  };
  const reset = () => {
    ws.hideTag(); ws.showSnap(null); ws.liftPreview(null);
    if (temp) { ws.dropTempFaces(temp.moving); ws.dropTempFaces(temp.still); temp = null; }
    for (const [pp, m0] of job.M0) pp.M.copy(m0);
    ws.updateMatrices(); ws.checkOverlaps(); ws.refreshMaterials();
  };
  return {
    move: (p) => {
      if (!started && !moved(p)) return;
      if (!started && det && det.kind === 'solid' && det.hidden.length) temp = { moving: ws.tempFaces(det.hidden, 'detach'), still: ws.tempFaces(det.partners, 'none') };
      started = true;
      const q = this.surfacePoint(p, ref);
      if (q) { d = q.clone().sub(p0); d.y = 0; }
      snap = solid ? ws.faceSnapAt(ws.localRay(p), job, snap) : ws.edgeSnapAt(job, snap, d);
      const on = snap && snap.T ? snap : null;
      if (on && !on.bad) good = { snap: on, t: performance.now() };
      ws.showSnap(on);
      ws.liftPreview(on);
      pose(on ? (on.lift && !on.bad ? new THREE.Matrix4().makeTranslation(0, on.lift, 0).multiply(on.T) : on.T) : new THREE.Matrix4().makeTranslation(d.x, 0, d.z));
      if (on) {
        const at = solid ? on.B.centroid.clone() : on.f.p.verts[on.f.i].clone().add(on.f.p.verts[(on.f.i + 1) % on.f.p.verts.length]).multiplyScalar(0.5).applyMatrix4(on.f.p.M);
        at.y += ws.edgeLen * 0.5;
        ws.setTag(on.bad ? `Not here: ${on.bad}` : solid ? `Attach to face P${on.B.no} · release` : 'Edges meet · release to join', ws.shellGroup.localToWorld(at));
      } else if (snap && snap.why) ws.setTag(`No snap: ${snap.why}`, ws.shellGroup.localToWorld(snap.B.centroid.clone().add(new THREE.Vector3(0, ws.edgeLen * 0.5, 0))));
      else ws.hideTag();
    },
    end: () => {
      let on = snap && snap.T ? snap : null;
      if (!on && good && performance.now() - good.t < 400 && (d.length() < 1e-5 || ws.snapProblem(job, new THREE.Matrix4().makeTranslation(d.x, 0, d.z)))) on = good.snap;
      reset();
      if (!started) {
        ws.app.toast(solid
          ? 'Drag the solid to move it (with everything joined to it); over a matching face of another solid it snaps on. To pull one solid out of a group, use Cut & Join.'
          : 'Drag to move it with everything joined to it; near a matching free edge of another piece it snaps on. To pull a part away, use Cut & Join.', 5000);
        return;
      }
      if (!solid) ws.clearDetach(false);
      if (on) {
        if (on.bad) { ws.app.toast(`Not ${solid ? 'attached' : 'joined'}: ${on.bad}. It stays where it was.`, 5000); ws.refreshStyles(); return; }
        ws.commitSnap(job, on, before);
        ws.app.notify?.();
        return;
      }
      if (d.length() < 1e-5) { ws.refreshStyles(); return; }
      const Tm = new THREE.Matrix4().makeTranslation(d.x, 0, d.z);
      const bad = ws.snapProblem(job, Tm);
      if (bad) { ws.app.toast(`Not moved: ${bad}. It stays where it was.`, 5000); ws.refreshStyles(); return; }
      if (det && det.kind === 'solid') { ws.commitDetach(job, Tm, before); ws.app.notify?.(); return; }
      ws.transformComponent(comp, Tm, job.pieces);
      ws.pushHistory(before);
      ws.selComp = new Set(ws.componentOf(ws.shell.panelById.get(comp[0].id)) || []);
      ws.refreshStyles();
      ws.app.toast(det ? `The ${det.name} came away along the dashed edges and moved ${Math.round(d.length() * 1000)} mm. Undo puts it back.` : `Moved ${Math.round(d.length() * 1000)} mm.`, det ? 5000 : 3000);
      ws.app.notify?.();
    },
    cancel: () => { reset(); if (!solid) ws.clearDetach(); },
  };
};

// Solid → Rotate: turn the object freely, like a model in the hand. Dragging
// across it turns it about the axis at right angles to the drag (as seen
// from where you are), any amount and in any direction. Its lowest point
// stays where it was, and on release a face that is nearly face down
// settles flat on the surface.
T.beginSolidTurn = function (ptr, hit) {
  const ws = this.ws;
  const comp = ws.componentOf(hit.panel);
  const c = ws.objectCentre(comp);
  let r = 0;
  for (const p of comp) for (const v of ws.shell.worldPoly(p)) r = Math.max(r, v.distanceTo(c));
  if (r < 1e-6) return null;
  const M0 = new Map(comp.map((p) => [p, p.M.clone()]));
  const low0 = ws.lowestY(comp);
  const eyeW = ptr.kind === 'screen' || !ws.app.viewerPosition ? ws.app.camera.getWorldPosition(new THREE.Vector3()) : ws.app.viewerPosition();
  const b = ws.toLocal(eyeW).sub(c).normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(b, c);
  const stick = ptr.kind !== 'screen' && ptr.grabPoint ? ptr.grabPoint(hit).stick : false;
  const at = (p) => {
    if (p.kind === 'screen' || (stick && p.ray)) {
      const o = ws.toLocal(p.ray.origin);
      const d = ws.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
      return new THREE.Ray(o, d).intersectPlane(plane, new THREE.Vector3());
    }
    return plane.projectPoint(ws.toLocal(p.grabPoint(null, hit.distance, stick).point), new THREE.Vector3());
  };
  let prev = at(ptr), started = false;
  const Q = new THREE.Quaternion();
  const moved = this.dragDetector(ptr, hit);
  const turnOf = () => deg(2 * Math.acos(Math.min(1, Math.abs(Q.w))));
  const pose = () => {
    const m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(Q)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    let low = Infinity;
    const v = new THREE.Vector3();
    for (const [pp, m0] of M0) for (const x of pp.verts) low = Math.min(low, v.copy(x).applyMatrix4(m0).applyMatrix4(m).y);
    return new THREE.Matrix4().makeTranslation(0, low0 - low, 0).multiply(m);
  };
  const reset = () => { for (const [pp, m0] of M0) pp.M.copy(m0); ws.updateMatrices(); };
  ws.selComp = new Set(comp);
  ws.refreshStyles();
  return {
    move: (p) => {
      if (!started && !moved(p)) return;
      started = true;
      const q = at(p);
      if (!q) return;
      if (!prev) { prev = q; return; }
      const d = q.clone().sub(prev);
      const len = d.length();
      if (len < 1e-7) return;
      const axis = new THREE.Vector3().crossVectors(b, d).normalize();
      Q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, (len / r) * 1.25)).normalize();
      prev = q;
      const R = pose();
      for (const [pp, m0] of M0) pp.M.copy(R.clone().multiply(m0));
      ws.updateMatrices();
      ws.setTag(`Turn ${Math.round(turnOf())}°`, ws.shellGroup.localToWorld(c.clone()));
    },
    end: () => {
      ws.hideTag();
      reset();
      if (!started || turnOf() < 0.05) { if (!started) ws.app.toast('Drag across the solid to turn it in any direction.'); return; }
      // Nearly face down: settle flat on that face.
      const down = new THREE.Vector3(0, -1, 0);
      let best = null, bd = -2;
      for (const p of comp) { const n = ws.shell.worldNormal(p).normalize().applyQuaternion(Q); if (-n.y > bd) { bd = -n.y; best = n; } }
      if (best && best.angleTo(down) < rad(10)) Q.premultiply(new THREE.Quaternion().setFromUnitVectors(best, down)).normalize();
      const R = pose();
      const before = ws.snapshot();
      ws.transformComponent(comp, R);
      ws.pushHistory(before);
      ws.selComp = new Set(ws.componentOf(ws.shell.panelById.get(comp[0].id)) || []);
      ws.refreshStyles();
      ws.app.toast(`Turned ${Math.round(turnOf())}°; its size, connections and fold angles are unchanged. Faces that were hidden can be built on now (picker, then tap the face).`, 5000);
    },
    cancel: () => { ws.hideTag(); reset(); },
  };
};

// Modify: drag a corner or an edge to reshape. In Shape it moves within the
// plane of the face you grab, whatever pose the net is in; in Solid it moves
// with the pointer in space. Shared corners move as one, other faces follow
// to stay flat, and the move stops at the last valid position.
T.beginModify = function (ptr, hit) {
  const ws = this.ws;
  const P = hit.panel;
  if (!ws.isPiecePanel(P)) { ws.app.toast('This face cannot be reshaped.'); return null; }
  const grab = ws.modifyGrab(P, hit.local);
  if (!grab) return { move: () => {}, end: () => ws.app.toast('Drag a corner or an edge of a face to reshape it.'), cancel: () => {} };
  const solid = ws.state.mode === 'solid';
  const normal = solid ? (ptr.ray ? ptr.ray.direction.clone().negate() : ws.app.camera.getWorldDirection(new THREE.Vector3()).negate()) : hit.normal.clone();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), hit.point);
  const stick = ptr.kind !== 'screen' && ptr.grabPoint ? ptr.grabPoint(hit).stick : false;
  const onPlane = (p) => {
    if (p.kind === 'screen' || (stick && p.ray)) return p.ray.intersectPlane(plane, new THREE.Vector3());
    const g = p.grabPoint(null, hit.distance, stick).point;
    return solid ? g.clone() : plane.projectPoint(g, new THREE.Vector3());
  };
  const inv = P.M.clone().invert();
  const restOf = (w) => ws.toLocal(w).applyMatrix4(inv);
  const r0 = restOf(hit.point);
  // Shape: an edge moves straight out from the face or back in (the face
  // gets deeper or narrower, the edge keeps its length and direction).
  let across = null;
  if (!solid && grab.kind === 'edge') {
    const a = P.verts[grab.verts[0]], b = P.verts[grab.verts[1]];
    across = new THREE.Vector3().crossVectors(P.normal, b.clone().sub(a)).normalize();
  }
  const before = ws.snapshot();
  const moved = this.dragDetector(ptr, hit);
  let job = null, res = null;
  ws.modHot = { pid: P.id, idx: grab.edges };
  ws.refreshStyles();
  if (grab.kind === 'corner') ws.showModDot(P.verts[grab.verts[0]].clone().applyMatrix4(P.M));
  const clear = () => { ws.hideTag(); ws.modHot = null; ws.showModDot(null); };
  return {
    move: (p) => {
      if (!job && !moved(p)) return;
      if (!job) { ws.stopAnim(); job = ws.modifyStart(P, grab); }
      const w = onPlane(p);
      if (!w) return;
      const delta = restOf(w).sub(r0);
      if (across) { const k = delta.dot(across); delta.copy(across).multiplyScalar(k); }
      res = ws.modifyTo(job, delta);
      const at = ws.modifyWorld(job) || hit.point;
      ws.setTag(res.reason ? `Stopped: ${res.reason}` : ws.modifyText(job), at);
      if (grab.kind === 'corner') { const Q = ws.shell.panelById.get(job.pid); if (Q) ws.showModDot(job.pc.verts[grab.verts[0]].clone().applyMatrix4(Q.M)); }
    },
    end: () => {
      clear();
      if (!job) {
        ws.refreshStyles();
        // A tap. In Shape, on an edge between two faces: hinge <-> cut, with
        // both faces staying where they are.
        if (!solid && grab.kind === 'edge') {
          const e = P.edges[grab.edges[0]];
          if (e && e.uses.length === 2) { ws.toggleEdge(e); return; }
          ws.app.toast('That is a free edge: drag it to make the face deeper or narrower. A tap switches an edge between two faces from hinge to cut.', 5000);
          return;
        }
        ws.app.toast(grab.kind === 'corner' ? 'Drag the corner to change its angle and the lengths of its two edges.' : 'Drag the edge to reshape.');
        return;
      }
      ws.modifyFinish(job);
      ws.pushHistory(before);
      ws.refreshStyles();
      const what = job.grab.kind === 'corner' ? 'corner' : 'edge';
      ws.app.toast(res && res.reason ? `Stopped at the last valid position: ${res.reason}.` : `Reshaped: ${what} moved ${ws.modifyText(job).replace(/^\S+ \+/, '').replace(' · ', ', neighbouring edges now ')}. Faces stay flat; joined edges keep matching lengths.`, 5000);
      ws.app.notify?.();
    },
    cancel: () => { clear(); if (job) ws.restoreSnapshot(before); else ws.refreshStyles(); },
  };
};

// Cut & Join. Pull an attached part away to cut its join; drag a loose
// part (or the part you are pulling off) to a matching target to join it.
// Solid: the solid you grab comes away from every face where it joins the
// others; over a matching face of another solid it snaps on. Shape: the
// hinge on the side you pull from is cut and the face comes away with
// everything hinged to it on its other sides; a free edge near a matching
// free edge snaps on and joins with a hinge. The cut and the join show
// while you drag (orange: what comes away; green: where it joins) and are
// one Undo step. A tap on an edge between two faces switches it between
// hinge and cut.
T.beginScissors = function (ptr, hit) {
  return this.ws.state.mode === 'solid' ? this.beginCutJoinSolid(ptr, hit) : this.beginCutJoinShape(ptr, hit);
};

T.beginCutJoinSolid = function (ptr, hit) {
  const ws = this.ws;
  const det = ws.detachFor(hit.panel);
  const ref = { dist: hit.distance, stick: true };
  const p0 = this.surfacePoint(ptr, ref);
  if (!p0) return null;
  const comp = det ? ws.shell.panels.filter((p) => det.partIds.has(p.id)) : ws.componentOf(hit.panel);
  if (det) { ws.detach = det; ws.refreshStyles(); }
  const job = ws.moveStart(comp, ws.toLocal(hit.point), det);
  const before = ws.snapshot();
  const moved = this.dragDetector(ptr, hit);
  let temp = null, d = new THREE.Vector3(), started = false, snap = null, good = null;
  const name = det ? det.name : ws.objectText(comp);
  const pose = (T) => {
    for (const [pp, m0] of job.M0) pp.M.copy(T.clone().multiply(m0));
    if (temp) temp.moving.matrix.copy(T);
    ws.updateMatrices(); ws.checkOverlaps(); ws.refreshMaterials();
  };
  const reset = () => {
    ws.hideTag(); ws.showSnap(null); ws.liftPreview(null);
    if (temp) { ws.dropTempFaces(temp.moving); ws.dropTempFaces(temp.still); temp = null; }
    for (const [pp, m0] of job.M0) pp.M.copy(m0);
    ws.updateMatrices(); ws.checkOverlaps(); ws.refreshMaterials();
  };
  return {
    move: (p) => {
      if (!started && !moved(p)) return;
      if (!started && det && det.hidden.length) temp = { moving: ws.tempFaces(det.hidden, 'detach'), still: ws.tempFaces(det.partners, 'none') };
      started = true;
      const q = this.surfacePoint(p, ref);
      if (q) { d = q.clone().sub(p0); d.y = 0; }
      snap = ws.faceSnapAt(ws.localRay(p), job, snap);
      const on = snap && snap.T ? snap : null;
      if (on && !on.bad) good = { snap: on, t: performance.now() };
      ws.showSnap(on);
      ws.liftPreview(on);
      const T = on ? (on.lift && !on.bad ? new THREE.Matrix4().makeTranslation(0, on.lift, 0).multiply(on.T) : on.T) : new THREE.Matrix4().makeTranslation(d.x, 0, d.z);
      pose(T);
      if (on) ws.setTag(on.bad ? `Not here: ${on.bad}` : `${det ? 'Cut off and attach' : 'Attach'} to face P${on.B.no} · release`);
      else if (snap && snap.why) ws.setTag(`No join here: ${snap.why}`);
      else ws.setTag(det ? `Cut: the ${det.name} comes away · release` : 'Drag it onto a matching face of another solid to join');
    },
    end: () => {
      let on = snap && snap.T ? snap : null;
      // A finger lifting drifts: a join shown valid a moment ago holds when
      // the drop where it lifted would be refused.
      if (!on && good && performance.now() - good.t < 400 && (d.length() < 1e-5 || ws.snapProblem(job, new THREE.Matrix4().makeTranslation(d.x, 0, d.z)))) on = good.snap;
      reset();
      if (!started) {
        ws.app.toast(det ? `This ${det.name} will come away (orange) at the join outlined in orange: pull it away to cut it off, or onto another face to join it there. Tap elsewhere to cancel.` : 'This solid is not joined to another: drag it onto a matching face of another solid to join them.', 5500);
        return;
      }
      if (on) {
        if (on.bad) { ws.clearDetach(); ws.app.toast(`Not joined: ${on.bad}. It stays where it was.`, 5000); return; }
        ws.commitSnap(job, on, before);
        ws.app.notify?.();
        return;
      }
      if (d.length() < 1e-5) { ws.clearDetach(); return; }
      const T = new THREE.Matrix4().makeTranslation(d.x, 0, d.z);
      const bad = ws.snapProblem(job, T);
      if (bad) { ws.clearDetach(); ws.app.toast(`${det ? 'Not cut off' : 'Not moved'}: ${bad}. It stays where it was.`, 5000); return; }
      if (det) { ws.commitDetach(job, T, before); ws.app.notify?.(); return; }
      ws.transformComponent(comp, T);
      ws.pushHistory(before);
      ws.app.toast(`Moved the ${name} ${Math.round(d.length() * 1000)} mm; drop it on a matching face of another solid to join them.`, 4500);
      ws.app.notify?.();
    },
    cancel: () => { reset(); ws.clearDetach(); },
  };
};

T.beginCutJoinShape = function (ptr, hit) {
  const ws = this.ws, sh = ws.shell;
  const P = hit.panel;
  const comp = ws.componentOf(P);
  const ref = { dist: hit.distance, stick: true };
  const p0 = this.surfacePoint(ptr, ref);
  if (!p0) return null;
  const M0 = new Map(comp.map((p) => [p, p.M.clone()]));
  const wP = sh.worldPoly(P);
  const nW = sh.worldNormal(P).normalize();
  const cW = wP.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(wP.length);
  const before = ws.snapshot();
  const moved = this.dragDetector(ptr, hit);
  let plan = null, job = null, snap = null, d = new THREE.Vector3(), started = false, locked = false;
  const seamSide = (k) => k.slice(0, k.lastIndexOf('#'));
  // What a pull in direction `dir` does: cut the hinge of P on the side the
  // pull comes from (within 70° of straight behind it) and take what comes
  // away; or, with no such hinge, take the whole object (a loose piece or a
  // net) to join it somewhere.
  const planFor = (dir) => {
    const dd = dir.clone().addScaledVector(nW, -dir.dot(nW));
    if (dd.length() < 1e-9) return null;
    dd.normalize();
    // Pulled back toward an edge it was cut from: the part goes back whole
    // (bringing a part back never cuts its other hinges).
    const mineH = sh.hingeComponent(P);
    const homeward = P.edges.some((x, i) => {
      const home = x.uses.length === 1 && ws.cutHomes && ws.cutHomes.has(`${P.id}#${i}`);
      // (or a cut edge to a part not hinged to this one, such as the anchor it was cut from)
      if (!home && (!x.shared || x.type === 'hinge' || x.uses.length !== 2 || mineH.has(sh.other(x, P)))) return false;
      const out = wP[i].clone().add(wP[(i + 1) % wP.length]).multiplyScalar(0.5).sub(cW);
      return out.addScaledVector(nW, -out.dot(nW)).normalize().dot(dd) > 0.7;
    });
    let e = null, bd = homeward ? -Infinity : -0.34;
    P.edges.forEach((x, i) => {
      if (!x.shared || x.type !== 'hinge') return;
      const out = wP[i].clone().add(wP[(i + 1) % wP.length]).multiplyScalar(0.5).sub(cW);
      out.addScaledVector(nW, -out.dot(nW)).normalize();
      const dot = out.dot(dd);
      if (dot < bd) { bd = dot; e = x; }
    });
    const part = e ? [...sh.hingeComponent(P, e)] : [...sh.hingeComponent(P)];
    const whole = !e && part.length === comp.length;
    const use = whole ? comp : part;
    const partIds = new Set(use.map((p) => p.id));
    const hold = new Set();
    if (e) {
      const Q = sh.other(e, P);
      if (partIds.has(Q.id)) for (const h of ws.hingePath(P, Q, e) || []) hold.add(pairKey(h));
    }
    const glued = whole ? [] : ws.comp.seams.filter(([a, b]) => partIds.has(seamSide(a)) !== partIds.has(seamSide(b)));
    const ringKeys = new Set();
    if (!whole) for (const p of use) for (const x of p.edges) if (x.uses.length === 2 && x.uses.some((u) => !partIds.has(u.panel.id))) ringKeys.add(pairKey(x));
    const name = use.length === 1 ? shapeName(use[0].verts.length).toLowerCase() : whole ? `net of ${use.length} faces` : `part of ${use.length} faces`;
    return { e, whole, part: use, partIds, ringKeys, hold, glued, held: hold.size > 0 || glued.length > 0, name, key: `${e ? pairKey(e) : '-'}|${use.length}` };
  };
  const resetPose = () => { for (const [pp, m0] of M0) pp.M.copy(m0); };
  const show = (pl) => {
    ws.detach = pl && !pl.whole ? { kind: 'shape', partIds: pl.partIds, ringKeys: pl.ringKeys, name: pl.name } : null;
    ws.holdKeys = pl && pl.hold && pl.hold.size ? pl.hold : null;
    ws.refreshStyles();
  };
  const finish = () => { ws.hideTag(); ws.showSnap(null); resetPose(); ws.updateMatrices(); ws.detach = null; ws.holdKeys = null; ws.checkOverlaps(); ws.refreshStyles(); };
  return {
    move: (p) => {
      if (!started && !moved(p)) return;
      started = true;
      const q = this.surfacePoint(p, ref);
      if (q) { d = q.clone().sub(p0); d.y = 0; }
      // The seam is chosen by the first part of the pull and then kept for
      // the rest of the drag: pulling back the other way brings the part
      // back; it never cuts the hinge on the other side (that takes a new
      // drag).
      const next = locked ? plan : planFor(d);
      if (!next) return;
      if (!plan || next.key !== plan.key) {
        resetPose();
        ws.showSnap(null);
        plan = next;
        snap = null;
        job = plan.held ? null : ws.moveStart(plan.part, ws.toLocal(hit.point));
        if (job && !plan.whole) job.pieces = plan.part.map((x) => ws.comp.piece(x.solidId)).filter(Boolean);
        if (job && plan.e) {
          // Back onto the hinge it is being cut from: it snaps there, and
          // releasing there changes nothing.
          const side = plan.e.uses.find((u) => plan.partIds.has(u.panel.id));
          if (side) { job.movEdges.push({ p: side.panel, i: side.i, rejoin: plan.e }); job.backEdge = plan.e; }
        }
        show(plan);
      }
      if (!locked && d.length() > ws.edgeLen * 0.12) locked = true;
      if (plan.held) {
        ws.updateMatrices();
        ws.setTag(`Still held by ${plan.hold.size ? `${plan.hold.size} other hinge${plan.hold.size === 1 ? '' : 's'}` : ''}${plan.hold.size && plan.glued.length ? ' and ' : ''}${plan.glued.length ? `${plan.glued.length} glued edge${plan.glued.length === 1 ? '' : 's'}` : ''}`);
        return;
      }
      snap = ws.edgeSnapAt(job, snap, d);
      const on = snap && snap.T ? snap : null;
      ws.showSnap(on);
      const T = on ? on.T : new THREE.Matrix4().makeTranslation(d.x, 0, d.z);
      for (const pp of plan.part) pp.M.copy(T.clone().multiply(M0.get(pp)));
      ws.updateMatrices(); ws.checkOverlaps(); ws.refreshMaterials();
      const cutText = plan.e ? `Cut hinge ${plan.e.no}` : plan.whole ? '' : 'Comes away along the dashed edges';
      if (on && plan.e && on.rejoin === plan.e) ws.setTag('Back on its edge · release to keep it');
      else if (on) ws.setTag(on.bad ? `Not here: ${on.bad}` : `${cutText ? `${cutText} and join` : 'Edges meet: join'} · release`);
      else ws.setTag(plan.whole ? 'Drag it to a matching free edge to join' : `${cutText} · release`);
    },
    end: () => {
      const pl = plan, on = snap && snap.T ? snap : null, jb = job;
      finish();
      if (!started) {
        const e = ws.edgeNear(P, hit.local, 0.2);
        if (e && e.uses.length === 2) ws.toggleEdge(e);
        else ws.app.toast('Pull a face away from a hinge to cut it (pulling right cuts the hinge on its left); drag a loose piece to a matching free edge to join it. A tap on a hinge cuts it.', 5500);
        return;
      }
      if (!pl) return;
      if (pl.held) {
        ws.app.toast(`Nothing was cut: the ${pl.name} is still held by ${pl.hold.size ? `${pl.hold.size} other hinge${pl.hold.size === 1 ? '' : 's'}` : ''}${pl.hold.size && pl.glued.length ? ' and ' : ''}${pl.glued.length ? `${pl.glued.length} edge${pl.glued.length === 1 ? '' : 's'} glued while folding` : ''} (shown red while you pull). Cut ${pl.hold.size + pl.glued.length === 1 ? 'it' : 'one of those'} too, then pull again.`, 6000);
        return;
      }
      const no = pl.e ? pl.e.no : null;
      if ((on && pl.e && on.rejoin === pl.e) || (pl.e && !on && d.length() < ws.edgeLen * 0.04)) {
        ws.app.toast(`Put back on its edge: hinge ${no} stays, nothing was cut.`, 4000);
        return;
      }
      if (on) {
        if (on.bad) { ws.app.toast(`Not joined: ${on.bad}. Everything stays as it was.`, 5000); return; }
        if (pl.e) pl.e.type = 'cut';
        ws.commitSnap(jb, on, before, no ? `Cut hinge ${no}. ` : '');
        ws.app.notify?.();
        return;
      }
      if (d.length() < 1e-5) return;
      const T = new THREE.Matrix4().makeTranslation(d.x, 0, d.z);
      const part = pl.part.map((x) => sh.panelById.get(x.id)).filter(Boolean);
      const bad = ws.snapProblem(ws.moveStart(part, ws.toLocal(hit.point)), T);
      if (bad) { ws.app.toast(`${pl.whole ? 'Not moved' : 'Not cut'}: pulled there, ${bad}. Everything stays as it was.`, 5000); return; }
      if (pl.e) {
        pl.e.type = 'cut';
        // Remember where the part came from: pulled back toward that edge
        // later, it goes back whole (its other hinges are never cut then).
        const mine = pl.e.uses.find((u) => pl.partIds.has(u.panel.id)), theirs = pl.e.uses.find((u) => u !== mine);
        if (mine && theirs) { ws.cutHomes = ws.cutHomes || new Map(); ws.cutHomes.set(`${mine.panel.id}#${mine.i}`, `${theirs.panel.id}#${theirs.i}`); }
      }
      ws.transformComponent(part, T, pl.whole ? null : part.map((x) => ws.comp.piece(x.solidId)).filter(Boolean));
      ws.pushHistory(before);
      ws.selComp = null;
      ws.refreshStyles();
      ws.app.toast(pl.whole ? `Moved the ${pl.name} ${Math.round(d.length() * 1000)} mm; drop it with a free edge on a matching free edge to join them.`
        : `${no ? `Cut hinge ${no} and pulled` : 'Pulled'} the ${pl.name} away ${Math.round(d.length() * 1000)} mm${pl.part.length > 1 ? '; its other hinges stay' : ''}. Undo puts it back.`, 5000);
      ws.app.notify?.();
    },
    cancel: () => finish(),
  };
};

// Fold tool: snapping during the swing, seams on release, closure check.
const swingTo0 = T.swingTo;
T.swingTo = function (s, p) {
  swingTo0.call(this, s, p);
  if (this.ws.state.mode === 'shape') this.ws.foldSnapStep(s);
};

const endTurn0 = W.endTurn;
W.endTurn = function (plan, snap = true) {
  const fs = this.foldSnap && this.foldSnap.plan === plan ? this.foldSnap : null;
  this.foldSnap = null;
  this.snapEdges = null;
  this.nearEdges = null;
  this.partner = null;
  if (!fs) { endTurn0.call(this, plan, snap); return; }
  this.recordSeams(fs.pairs);
  endTurn0.call(this, plan, false);
  this.hideTag();
  const P = plan.P;
  if (!this.checkClosure(P)) this.app.toast(`${fs.pairs.length} edge${fs.pairs.length === 1 ? '' : 's'} joined. ${this.componentOf(P).some((p) => p.edges.some((e, i) => e.uses.length === 1 && !this.isSeamed(p, i))) ? 'Keep folding to close the form.' : ''}`.trim());
};

// A glued (seamed) panel only moves together with what it is glued to.
const beginTurn0 = W.beginTurn;
W.beginTurn = function () {
  const plan = this.plan();
  if (!plan.error && this.comp.seams.length) {
    const moving = new Set(plan.moving.map((p) => p.id));
    for (const [a, b] of this.comp.seams) {
      const pa = a.split('#')[0], pb = b.split('#')[0];
      if (moving.has(pa) !== moving.has(pb)) {
        this.app.toast('That panel is glued along an edge that met while folding. Cut that edge (Cut tool) to free it.', 5000);
        return null;
      }
    }
  }
  return beginTurn0.call(this);
};

// Cut tool on a glued edge: unglue it.
const toggleEdge0 = W.toggleEdge;
W.toggleEdge = function (e) {
  if (e && e.uses.length === 1) {
    const u = e.uses[0];
    const k = `${u.panel.id}#${u.i}`;
    const n0 = this.comp.seams.length;
    if (n0) {
      const before = this.snapshot();
      this.comp.seams = this.comp.seams.filter(([a, b]) => a !== k && b !== k);
      if (this.comp.seams.length !== n0) { this.pushHistory(before); this.refreshStyles(); this.app.toast('Edges unglued: they can be folded apart again.'); this.app.notify?.(); return; }
    }
    this.app.toast('That is a free edge: nothing to cut.');
    return;
  }
  toggleEdge0.call(this, e);
};

// Styles: glued edges, snapping edges, selection, flashed issues.
const edgeStyle0 = W.edgeStyle;
W.edgeStyle = function (p, e, okEdges) {
  if (this.snapEdges && this.snapEdges.has(e)) return { color: this.snapBad ? '#e0452b' : '#36d98a', w: this.edgeLen * 0.022 * 2.6 };
  // Fold: free edges coming together.
  if (this.nearEdges && this.nearEdges.has(e)) return { color: '#f0b44c', w: this.edgeLen * 0.022 * 2.2 };
  // Info → Last Refold: the edges a row names.
  if (this.refoldEdges && this.refoldEdges.has(e)) return { color: '#ff8a1f', w: this.edgeLen * 0.022 * 3 };
  // Move: the join where the chosen part comes away.
  if (this.holdKeys && !this.clean && e.uses.length === 2 && this.holdKeys.has(pairKey(e))) return { color: '#e0452b', w: this.edgeLen * 0.022 * 2.8 };
  if (this.detach && !this.clean && ['move', 'scissors'].includes(this.state.tool) && e.uses.length === 2 && this.detach.ringKeys.has(pairKey(e))) return { color: '#ff8a1f', w: this.edgeLen * 0.022 * 2.8, dashed: e.type === 'cut' && this.state.mode === 'shape' };
  // Modify: the edge (or the two edges at the corner) you are reshaping.
  const hot = this.modHot || this.modHover;
  if (hot && !this.clean && e.uses.some((u) => u.panel.id === hot.pid && hot.idx.includes(u.i))) return { color: '#f28c28', w: this.edgeLen * 0.022 * (this.modHot ? 3 : 2.2) };
  if (e.uses.length === 1 && !this.clean) {
    const w = this.edgeLen * 0.022;
    return this.isSeamed(p, e.uses[0].i) ? { color: '#3a78e0', w: w * 1.4 } : { color: '#5a5f73', w };
  }
  return edgeStyle0.call(this, p, e, okEdges);
};

const panelState0 = W.panelState;
W.panelState = function (p) {
  if (this.flashPanels && this.flashPanels.has(p)) return 'issue';
  if (this.snapPanels && this.snapPanels.has(p)) return this.snapBad ? 'overlap' : 'snap';
  if (this.blockPanels && this.blockPanels.has(p)) return 'overlap';
  if (this.detach && ['move', 'scissors'].includes(this.state.tool) && this.detach.partIds.has(p.id)) return 'detach';
  if (this.selComp && this.selComp.has(p) && ['select', 'rotate', 'move', 'remove', 'modify2d', 'scissors'].includes(this.state.tool)) return this.overlapSet.has(p) ? 'overlap' : 'selected';
  if (['select', 'rotate', 'move', 'remove', 'modify2d', 'scissors'].includes(this.state.tool)) {
    if (this.overlapSet.has(p)) return 'overlap';
    return this.hoverPanel === p ? 'hover' : 'none';
  }
  return panelState0.call(this, p);
};

// Hover: placement preview, or the panel under the pointer.
const setHover0 = W.setHover;
W.setHover = function (hit, ptr) {
  if (this.placing) { this.previewPlacement(ptr, hit); return; }
  if (['select', 'rotate', 'move', 'remove', 'modify2d', 'scissors'].includes(this.state.tool)) {
    const panel = hit && hit.panel ? hit.panel : null;
    if (panel !== this.hoverPanel) { this.hoverPanel = panel; this.refreshMaterials(); }
    if (this.state.tool === 'modify2d' && !this.modHot) {
      const g = panel ? this.modifyGrab(panel, hit.local) : null;
      const key = g ? `${panel.id}/${g.edges.join(',')}` : '';
      if (key !== (this.modHoverKey || '')) {
        this.modHoverKey = key;
        this.modHover = g ? { pid: panel.id, idx: g.edges } : null;
        this.showModDot(g && g.kind === 'corner' ? panel.verts[g.verts[0]].clone().applyMatrix4(panel.M) : null);
        this.refreshStyles();
      }
    }
    return;
  }
  setHover0.call(this, hit, ptr);
};

// VR panel: the same structure as the screen. Tabs, the picker (place, and
// the next shape or polyhedron in place of the catalogue arrow), the mode's tools, the net tools, Undo / Redo, Info / Error,
// and the view row.
W.panelRows = function (row, B, M, Wd, y0) {
  const a = this, s = this.state;
  const mode = s.mode;
  row(y0, 72, [
    { label: 'Shape (2D)', action: () => a.setMode('shape'), active: mode === 'shape' },
    { label: 'Solid (3D)', action: () => a.setMode('solid'), active: mode === 'solid' },
  ], 8);
  const name = mode === 'solid' ? TEMPLATES[s.solidType].name : shapeByKey(s.shapeType).name;
  const pickRow = [{ label: a.placing ? `Placing ${name.toLowerCase()}…` : `Place ${name.toLowerCase()}`, w: 1.8, action: () => a.startPlacing(), active: !!a.placing }];
  if (mode === 'solid') pickRow.push({ label: 'Next polyhedron', w: 1.4, action: () => { const i = POLYHEDRA.indexOf(s.solidType); a.setPickerType(POLYHEDRA[(i + 1) % POLYHEDRA.length]); } });
  else pickRow.push({ label: 'Next shape', w: 1.4, action: () => { const i = SHAPES.findIndex((x) => x.key === s.shapeType); a.setPickerType(SHAPES[(i + 1) % SHAPES.length].key); } });
  pickRow.push({ label: 'From Gallery', w: 1.2, action: () => a.app.toast('From Gallery comes in the next stage.'), disabled: true });
  row(y0 + 82, 62, pickRow, 6);
  row(y0 + 152, 62, MODE_TOOLS[mode].map((t) => ({ label: t.name, action: () => a.setModeTool(t.key), active: t.key === 'preview' ? !!(a.previewOn && a.previewOn[mode]) : s.mtool === t.key, disabled: !!t.later })), 6);
  row(y0 + 222, 62, [
    { label: 'Unfold', action: () => a.topUnfold() },
    { label: 'Refold', action: () => a.topRefold() },
    { label: 'Arrange', action: () => a.arrangeAll() },
    { label: 'Alternate', action: () => a.alternateNet() },
  ], 6);
  const errs = a.errorList();
  row(y0 + 370, 70, [
    { label: 'Undo', action: () => a.undo(), disabled: !a.history.length },
    { label: 'Redo', action: () => a.redo(), disabled: !a.canRedo() },
    { label: 'Info', action: () => a.app.toast(a.infoText(), 8000) },
    { label: errs.length ? `Error ${errs.length}` : 'No errors', w: 1.2, action: () => a.app.toast(errs.length ? errs.map((e) => e.text).join(' · ') : 'No issues.', 9000) },
  ], 8);
  row(y0 + 460, 70, [
    { label: 'Turn view', w: 1.1, action: () => a.setNavTurn(), active: a.navTurn },
    { label: 'Closer', w: 0.9, action: () => { a.bringCloser(); a.app.toast('Brought closer. Fit all puts it back on the table.'); } },
    { label: 'Zoom −', w: 0.85, action: () => a.zoomView(1 / 1.25) },
    { label: 'Zoom +', w: 0.85, action: () => a.zoomView(1.25) },
    { label: 'Fit all', w: 0.85, action: () => a.fitAll() },
    { label: 'Reset view', w: 1.2, action: () => a.resetView() },
  ], 6);
};

// The old 'move the whole form' puck: the Move tool moves objects now.
W.liftWanted = function () { return false; };

// Mode animation end: exact poses and a message.
const finishAnim0 = W.finishAnim;
W.finishAnim = function (a) {
  if (a.label === 'alt-fold') {
    for (const [p, m] of a.final) p.M.copy(m);
    this.updateMatrices();
    this.alternateOpen(a.alt, a.t >= 1);
    return;
  }
  if (a.label === 'alt-open') { a.done(); return; }
  if (a.label !== 'mode') { finishAnim0.call(this, a); return; }
  if (a.final) for (const [p, m] of a.final) p.M.copy(m);
  this.updateMatrices();
  this.afterMotion(false);
  this.shell.classify();
  let msg = a.msg;
  if (a.check && a.check.kind === 'zip') {
    // Join the edges that came together; close the form if nothing is left open.
    for (const z of a.check.zips) this.recordSeams(z.pairs.filter(([m, f]) => m.p.edges[m.i].uses.length === 1 && f.p.edges[f.i].uses.length === 1));
    let joined = 0, open = 0, notClosed = 0;
    const sections = [];
    for (const z of a.check.zips) {
      const P = this.shell.panelById.get(z.id);
      const seams = z.pairs.map(([m, f]) => `P${m.p.no}–P${f.p.no}`);
      const quiet = this.app.toast;
      let why = '';
      this.app.toast = (m) => { why = m; };
      let closed = false;
      const inside = P && !z.open ? this.shell.overlaps((x, y) => x.solidId !== undefined && this.componentOf(P).includes(x) && this.componentOf(P).includes(y)).pairs : [];
      try { closed = !!(P && !z.open && this.checkClosure(P)); } finally { this.app.toast = quiet; }
      joined += seams.length; open += z.open;
      const rows = [{ text: `Joined ${seams.length} pair${seams.length === 1 ? '' : 's'} of edges: ${seams.join(', ')}`, edges: z.pairs.flat().map((h) => [h.p.id, h.i]), blockers: [] }, ...z.rows];
      let title;
      if (closed) title = `${z.n} faces · closed: it is a solid now`;
      else if (!z.open) {
        notClosed++;
        title = `${z.n} faces · every edge met, but it is not used as a solid`;
        rows.push({ text: why || 'The form did not close.', edges: [], blockers: inside.flat().map((x) => x.id) });
      } else title = `${z.n} faces · partly folded · ${seams.length} seam${seams.length === 1 ? '' : 's'} joined · ${z.open} edge${z.open === 1 ? '' : 's'} open`;
      sections.push({ title, rows });
    }
    const summary = open ? `Partly folded · ${joined} seam${joined === 1 ? '' : 's'} joined · ${open} edge${open === 1 ? '' : 's'} open`
      : notClosed ? `Folded · ${joined} seam${joined === 1 ? '' : 's'} joined · not closed`
      : `Folded closed · ${joined} seam${joined === 1 ? '' : 's'} joined`;
    this.setRefoldReport({ summary, sections, issues: a.check.issues || [] });
    this.lastZip = sections.map((x) => x.title);
    this.refreshStyles();
    msg = `${a.msg.replace(/^(Solid \(3D\)\. )?Folded \d+ objects?\.\s*/, '$1')}${summary}${open || notClosed || (a.check.issues || []).length ? ' · details in Info' : '.'}`;
  } else if (a.check) {
    const ps = this.shell.panels.filter((p) => a.check.ids.has(p.id));
    const off = a.check.kind === 'flat' ? ps.filter((p) => !this.lyingFlat(p)) : ps.filter((p) => !isIdentity(p.M));
    if (off.length) msg += ` But ${off.length} face${off.length === 1 ? ' is' : 's are'} still not ${a.check.kind === 'flat' ? 'lying flat' : 'in place'} (${off.slice(0, 4).map((p) => `P${p.no}`).join(', ')}).`;
  }
  // A folded object left hanging above the surface (or reaching into it)
  // is set down so its lowest point touches, as it was turned.
  if (a.check && a.check.kind !== 'flat') {
    const ids = new Set(a.check.ids);
    for (const z of a.check.zips || []) ids.add(z.id);
    for (const id of ids) {
      const P = this.shell.panelById.get(id);
      if (!P) continue;
      const comp = this.componentOf(P);
      const low = this.lowestY(comp);
      if (Math.abs(low) < this.edgeLen * 1e-5) continue;
      const T = new THREE.Matrix4().makeTranslation(0, -low, 0);
      if (this.snapProblem(this.moveStart(comp, new THREE.Vector3()), T, { below: false })) continue;
      this.transformComponent(comp, T);
      for (const p of comp) ids.delete(p.id);
    }
  }
  this.app.toast(msg, 5000);
  this.app.notify?.();
};

// ---------------------------------------------------------------- helpers

function segDist(p, a, b) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

export { SHAPES, shapeByKey, EDGE as UNIT };

// Undo, Redo and loading replace the geometry: a part chosen to come away
// no longer applies.
const restoreSnapshot0 = W.restoreSnapshot;
W.restoreSnapshot = function (snap) {
  this.detach = null;
  restoreSnapshot0.call(this, snap);
};

// Feedback while dragging goes to a strip at the top of the screen, outside
// the working area, instead of floating over the model. (In a headset it
// stays beside the model, where the panel cannot be.) The fold tool's
// running angle badge is not shown: the hinge it turns about stays
// highlighted.
const setTag0 = W.setTag, hideTag0 = W.hideTag;
W.setTag = function (text, world) {
  if (/^Fold · /.test(text)) return;
  this.tagText = text;
  if (this.app.renderer?.xr?.isPresenting) { if (world) setTag0.call(this, text, world); return; }
  const el = typeof document !== 'undefined' && document.getElementById('wsHint');
  if (el) { el.textContent = text; el.hidden = false; }
};
W.hideTag = function () {
  this.tagText = '';
  hideTag0.call(this);
  const el = typeof document !== 'undefined' && document.getElementById('wsHint');
  if (el) el.hidden = true;
};

// Tapping an issue (Error list): the faces it names show red and carry
// their numbers, on the faces themselves.
const focusIds0 = W.focusIds;
W.focusIds = function (ids) {
  focusIds0.call(this, ids);
  // The red highlight stays as long as the numbers do.
  clearTimeout(this.flashPanelsTimer);
  this.flashPanelsTimer = setTimeout(() => { this.flashPanels = null; this.refreshStyles(); }, 8000);
  this.showIdLabels(this.shell.panels.filter((p) => ids.includes(p.id)));
};

W.showIdLabels = function (panels) {
  if (this.idLabels) { for (const s of this.idLabels) { this.shellGroup.remove(s); s.material.map.dispose(); s.material.dispose(); } }
  this.idLabels = [];
  clearTimeout(this.idLabelTimer);
  if (typeof document === 'undefined') return;
  // Where each number goes: on its face; numbers that would sit on top of
  // each other (faces lying over one another) are spread side by side.
  const spots = panels.map((p) => {
    const w = this.shell.worldPoly(p);
    return w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length).addScaledVector(this.shell.worldNormal(p).normalize(), -this.edgeLen * 0.08);
  });
  this.shellGroup.updateWorldMatrix(true, false);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.app.camera.getWorldQuaternion(new THREE.Quaternion()))
    .applyQuaternion(this.shellGroup.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
  const near = spots.map((a, i) => spots.filter((b, j) => j !== i && b.distanceTo(a) < this.edgeLen * 0.5).length);
  if (near.some((n) => n > 0)) spots.forEach((v, i) => v.addScaledVector(right, (i - (spots.length - 1) / 2) * this.edgeLen * 0.62));
  panels.forEach((p, k) => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#d8452f';
    g.beginPath(); g.roundRect(4, 4, 120, 56, 26); g.fill();
    g.fillStyle = '#ffffff';
    g.font = '700 38px "Zen Kaku Gothic New", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(`P${p.no}`, 64, 34);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    spr.position.copy(spots[k]);
    const h = this.edgeLen * 0.28;
    spr.scale.set(h * 2, h, 1);
    spr.renderOrder = 20;
    spr.userData.ui = true;
    spr.userData.text = `P${p.no}`;
    this.shellGroup.add(spr);
    this.idLabels.push(spr);
  });
  this.idLabelTimer = setTimeout(() => this.showIdLabels([]), 8000);
};
