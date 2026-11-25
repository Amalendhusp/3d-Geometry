import * as THREE from 'three';
import { SolidsWorkspace, SolidsTools } from './workspace.js';
import { template, TEMPLATES, restHeight } from './polyhedra.js';
import { SHAPES, shapeByKey, shapeName, regularPolygon, attachedPolygon, rigidFrom, matchClosure } from './pieces.js';
import { Solid, alignFace, isConvexLoop, polyNormal } from './composition.js';
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
    { key: 'modify', name: 'Modify', tip: 'Drag a corner or an edge to reshape it, flat or folded; faces stay flat and it stops at the last valid position' },
    { key: 'remove', name: 'Remove', tip: 'Tap a face to remove it, or the edge between two faces to merge them' },
    { key: 'move', name: 'Move', tip: 'Drag a net to move it with everything hinged to it; near a matching free edge it snaps on and joins with a hinge. After Cut, drag the freed part away' },
    { key: 'rotate', name: 'Rotate', tip: 'Drag a piece to turn it as a whole; its connections and folds stay' },
    { key: 'fold', name: 'Fold', tip: 'Drag a panel to swing it about its hinge; free edges that meet snap together' },
    { key: 'cut', name: 'Cut', tip: 'Tap a hinge to cut it (dashed); tap it again to make it a hinge' },
    { key: 'mirror', name: 'Mirror', tip: 'Not yet available: reflect a shape or group across a tapped edge, with a preview first (a later stage)', later: true },
    { key: 'preview', name: '3D', tip: 'Not yet available: preview of the folded form (next stage)', later: true },
  ],
  solid: [
    { key: 'modify', name: 'Modify', tip: 'Drag a corner or an edge of a solid to reshape it; faces stay flat and it stops at the last valid position' },
    { key: 'remove', name: 'Remove', tip: 'Tap a solid to remove it' },
    { key: 'move', name: 'Move', tip: 'Drag a solid to move it; over a matching face of another it snaps on and attaches. Tap one solid of a joined group to detach it, then drag it away' },
    { key: 'rotate', name: 'Rotate', tip: 'Drag a solid to turn it freely in any direction, like turning it in your hand' },
    { key: 'mirror', name: 'Mirror', tip: 'Not yet available: mirror across a face with a preview and a tick to confirm (next stage)', later: true },
    { key: 'preview', name: '2D', tip: 'Not yet available: preview of the net (next stage)', later: true },
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
  this.state.mode = m;
  this.state.mtool = null;
  this.state.tool = 'select';
  this.selComp = null;
  this.detach = null;
  this.modeIssues = [];
  const before = this.snapshot();
  const r = m === 'solid' ? this.foldClosable() : this.unfoldClosed();
  if (r.changed) this.pushHistory(before);
  const tail = this.modeIssues.length ? ` ${this.modeIssues.length} object${this.modeIssues.length === 1 ? '' : 's'} could not ${m === 'solid' ? 'close' : 'unfold'}: see Error.` : '';
  this.app.toast(`${m === 'solid' ? 'Solid (3D)' : 'Shape (2D)'}.${r.msg ? ` ${r.msg}` : ''}${tail}`, 5000);
  this.refreshStyles();
  this.app.notify?.();
};

// Every closable object folds closed: closed solids that are unfolded, and
// nets that match a solid (they get their closed form first).
W.foldClosable = function () {
  const sh = this.shell;
  let converted = 0;
  for (const comp of sh.pieces()) {
    if (!this.restFlat(comp)) continue;
    if (!comp.every((p) => this.isPiecePanel(p))) continue;
    const r = this.closeByLibrary(comp);
    if (r.ok) converted++;
    else this.modeIssues.push({ kind: 'close', text: `A net of ${comp.length} face${comp.length === 1 ? '' : 's'} stays as it is: ${r.reason}`, ids: comp.map((p) => p.id) });
  }
  return this.animateComponents('close', converted);
};

W.unfoldClosed = function () { return this.animateComponents('open', 0); };

// Top toolbar: Unfold lays every object flat (closed solids into their
// nets, partly folded nets back flat); Refold folds every net that can close.
W.topUnfold = function () {
  this.tools.finishAll(); this.stopAnim(); this.placing = null; this.hidePlacePreview();
  this.modeIssues = [];
  const before = this.snapshot();
  const r = this.animateComponents('open', 0, { all: true });
  if (r.changed) this.pushHistory(before);
  else this.app.toast('Everything already lies flat.');
  this.app.notify?.();
};

W.topRefold = function () {
  this.tools.finishAll(); this.stopAnim(); this.placing = null; this.hidePlacePreview();
  this.modeIssues = [];
  const before = this.snapshot();
  const r = this.foldClosable();
  if (r.changed) this.pushHistory(before);
  if (this.modeIssues.length) this.app.toast(`${r.msg ? `${r.msg} ` : ''}${this.modeIssues.length} object${this.modeIssues.length === 1 ? '' : 's'} could not fold closed: see Error.`, 5000);
  else if (!r.changed) this.app.toast(r.msg || 'Nothing to fold closed.');
  this.app.notify?.();
};

W.animateComponents = function (dir, converted, opts = {}) {
  const sh = this.shell;
  const F = sh.forest();
  const from = sh.forestAngles(F);
  const to = new Map(from);
  const roots = new Map();
  const final = new Map();
  const flat = sh.flatAngles(F);
  let n = 0;
  for (const comp of sh.pieces()) {
    if (dir === 'open' && opts.all) {
      // Anything not lying flat: some hinge away from its flat angle.
      if (!comp.some((p) => F.parent.has(p) && Math.abs(from.get(p) - flat.get(p)) > 1e-6)) continue;
    } else {
      if (this.restFlat(comp)) continue;
      const closed = comp.every((p) => isIdentity(p.M));
      if (dir === 'close' && closed) continue;
      if (dir === 'open' && !closed) continue;
    }
    const loop = F.loops.find((e) => comp.includes(e.uses[0].panel));
    if (loop) { this.modeIssues.push({ kind: 'loop', text: `An object's hinges form a closed loop, so it cannot ${dir === 'close' ? 'fold' : 'unfold'}. Cut one hinge of the loop.`, ids: comp.map((p) => p.id) }); continue; }
    n++;
    for (const p of comp) {
      if (F.parent.has(p)) to.set(p, dir === 'close' ? 0 : flat.get(p));
      if (dir === 'close') final.set(p, new THREE.Matrix4());
    }
    const root = F.roots.find((r) => comp.includes(r));
    if (!root) continue;
    if (dir === 'close') { if (!isIdentity(root.M)) roots.set(root, { from: root.M.clone(), to: new THREE.Matrix4() }); } else {
      // The root panel lies face down where it is; the net opens around it.
      const nrm = sh.worldNormal(root).normalize();
      const w = sh.worldPoly(root);
      const c = w.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(w.length);
      const q = new THREE.Quaternion().setFromUnitVectors(nrm, new THREE.Vector3(0, -1, 0));
      const L = new THREE.Matrix4().makeTranslation(c.x, 0, c.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      roots.set(root, { from: root.M.clone(), to: L.multiply(root.M.clone()) });
    }
  }
  if (!n) return { changed: converted > 0, msg: dir === 'close' ? (converted ? '' : 'Nothing to fold closed.') : 'Nothing to unfold.' };
  this.anim = { kind: 'forest', F, from, to, roots: roots.size ? roots : null, t: 0, dur: 1.2, label: 'mode', final: final.size ? final : null,
    msg: dir === 'close' ? `Folded ${n} object${n === 1 ? '' : 's'} closed.` : `Unfolded ${n} solid${n === 1 ? '' : 's'} into ${n === 1 ? 'its net' : 'their nets'}.` };
  return { changed: true, msg: '' };
};

// A net of pieces that matches a solid gets that solid's closed form as its
// rest form, keeping its current pose, so it can fold closed.
W.closeByLibrary = function (comp) {
  const sh = this.shell;
  if (sh.hingeComponent(comp[0]).size !== comp.length) return { reason: 'some of its pieces only touch and are not hinged. Hinge them (Cut tool) or move them apart.' };
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

// Alternate: another valid net for the solids. Nets built by hand keep
// their hinges (they are what you made).
W.alternateNet = function () {
  if (this.comp.isEmpty()) { this.app.toast('Nothing to rearrange yet.'); return; }
  if (this.shell.pieces().some((c) => !this.restClosed(c))) { this.app.toast('Alternate switches between nets of closed forms. A net that has not closed yet keeps the hinges you made (Alternate for those comes in a later stage); use Cut to change them.', 6000); return; }
  this.otherNets();
};

// --------------------------------------------------------------- toolbars

W.setModeTool = function (key) {
  const tools = MODE_TOOLS[this.state.mode];
  const t = tools.find((x) => x.key === key);
  if (!t) return;
  if (t.later) { this.app.toast(t.tip); return; }
  this.tools.finishAll();
  this.placing = null;
  this.hidePlacePreview();
  this.modHover = null; this.modHoverKey = '';
  this.clearDetach(false);
  if (this.state.mtool === key) { this.state.mtool = null; this.state.tool = 'select'; this.app.toast(`${t.name} off.`); this.refreshStyles(); this.app.notify?.(); return; }
  this.state.mtool = key;
  const internal = { fold: 'open', cut: 'edges', modify: 'modify2d', remove: 'remove', move: 'move', rotate: 'rotate' }[key];
  if (internal === 'open' || internal === 'edges') {
    this.setTool(internal);
    if (internal === 'open') this.state.openMode = 'group';
    else this.state.edgeTap = 'switch';
  } else {
    this.state.tool = internal;
    this.sel.panel = this.sel.hinge = null;
  }
  this.app.toast(`${t.name}: ${t.tip}.`, 4000);
  this.refreshStyles();
  this.app.notify?.();
};

W.startPlacing = function () {
  this.tools.finishAll();
  if (this.placing) { this.placing = null; this.hidePlacePreview(); this.app.toast('Placement cancelled.'); this.app.notify?.(); return; }
  const kind = this.state.mode;
  const name = kind === 'shape' ? shapeByKey(this.state.shapeType).name : TEMPLATES[this.state.solidType].name;
  this.placing = { kind };
  this.app.toast(kind === 'shape'
    ? `Place a ${name.toLowerCase()}: tap the empty surface, or near a free edge of a shape to attach it there (it takes that edge's length).`
    : `Place a ${name.toLowerCase()}: tap the empty surface, or a matching face of a solid to attach it.`, 6000);
  this.app.notify?.();
};

W.cancelPlacing = function () {
  if (!this.placing) return false;
  this.placing = null;
  this.hidePlacePreview();
  this.app.toast('Placement cancelled.');
  this.app.notify?.();
  return true;
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
  if (this.placing) { this.placeAt(ptr); return; }
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
      this.app.toast(`That ${plan.shp.name.toLowerCase()} would overlap ${bad ? `face P${bad.no}` : 'another face'}. Nothing was placed.`, 4500);
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
  this.placing = null;
  this.hidePlacePreview();
  this.app.toast(`${label}. Tap the picker to add another.`, 4000);
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

// Called after each step of a fold drag (Fold tool).
W.foldSnapStep = function (s) {
  if (!s || !s.plan) return;
  const snap = this.findFoldSnap(s.plan);
  if (snap) {
    const sh = this.shell;
    sh.setAngle(s.plan, sh.angle(s.plan.e, s.plan.P, s.plan.Q) + snap.delta);
    this.updateMatrices();
    this.checkOverlaps();
  }
  const meet = snap ? this.meetingEdges(s.plan) : [];
  this.foldSnap = meet.length ? { plan: s.plan, pairs: meet } : null;
  this.snapEdges = new Set(meet.flatMap(([m, f]) => [m.p.edges[m.i], f.p.edges[f.i]]));
  this.refreshStyles();
  if (meet.length) {
    const at = s.plan.P.centroid.clone().applyMatrix4(s.plan.P.M);
    this.setTag(`${meet.length} edge${meet.length === 1 ? ' meets' : 's meet'} · release to join`, this.shellGroup.localToWorld(at));
  }
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
    p.edges.forEach((e, i) => { if (e.uses.length === 1 && !this.isSeamed(p, i)) movEdges.push({ p, i }); });
  }
  return { comp, moving, ids: new Set(comp.map((p) => p.id)), M0, start, startN, movEdges, grab: grab.clone(), det, extras,
    pieces: det ? det.pcs : null,
    canFace: this.restClosed(comp) && comp.every((p) => isIdentity(p.M)) };
};

// Would the moving object, moved by T, overlap or pass through anything
// (whole-face contact and shared edges are fine), or go below the surface?
W.snapProblem = function (job, T) {
  const faces = [];
  for (const [p, w] of job.start) faces.push({ verts: w.map((v) => v.clone().applyMatrix4(T)), normal: job.startN.get(p).clone().transformDirection(T) });
  let low = Infinity;
  for (const f of faces) for (const v of f.verts) low = Math.min(low, v.y);
  if (low < -this.edgeLen * 1e-4) return 'it would go below the work surface';
  if (job.extras && job.extras.length) {
    const inside = Shell.prototype.meets.call({ panels: job.extras, edgeLen: this.edgeLen, worldPoly: (p) => p.verts.map((v) => v.clone()), worldNormal: (p) => p.normal.clone() }, faces);
    if (inside) return 'it would pass through the face it comes away from';
  }
  const hit = this.shell.meets(faces, (p) => job.moving.has(p));
  if (!hit) return null;
  return this.state.mode === 'solid' ? `it would pass through face P${hit.no}` : `it would overlap face P${hit.no}`;
};

// Solid: the face under the pointer (of another closed form), and the pose
// that sets a matching face of the moving solid flush against it. The snap
// holds while the pointer stays over that face, give or take a quarter of
// an edge; a gentle pull further away lets it go.
W.faceSnapAt = function (ray, job, prev) {
  if (!ray || !job.canFace) return null;
  if (prev && prev.B && this.rayOnPanel(ray, prev.B, this.edgeLen * 0.25)) return prev;
  const hit = this.rayPanel(ray, (p) => job.moving.has(p));
  if (!hit) return null;
  const B = hit.panel;
  const comp = this.componentOf(B);
  if (!this.restClosed(comp) || !comp.every((p) => isIdentity(p.M))) return { B, why: 'solids attach to faces of closed forms' };
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
  return { B, A: best.A, T: best.T, targetIds: new Set(comp.map((p) => p.id)), bad: this.snapProblem(job, best.T) };
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
    p.edges.forEach((e, i) => { if (e.uses.length === 1 && !this.isSeamed(p, i)) fix.push({ p, i }); });
  }
  let best = null;
  for (const m of job.movEdges) {
    const w = job.start.get(m.p), nm = w.length;
    const a0 = w[m.i].clone().add(D), a1 = w[(m.i + 1) % nm].clone().add(D);
    const la = a0.distanceTo(a1);
    const am = a0.clone().add(a1).multiplyScalar(0.5);
    for (const f of fix) {
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
  return { m: best.m, f: best.f, T, bad: this.snapProblem(job, T) };
};

// Highlights for a snap: the two meeting edges (Shape) or the two faces and
// their rims (Solid), green when it can join, red when it cannot.
W.showSnap = function (snap) {
  const key = snap && snap.T ? `${snap.m ? `${snap.m.p.id}#${snap.m.i}>${snap.f.p.id}#${snap.f.i}` : `${snap.A.id}>${snap.B.id}`}|${!!snap.bad}` : '';
  if (key === (this.snapKey || '')) return;
  this.snapKey = key;
  // Faces that meet are hidden between the two solids, so their rims are
  // drawn too: a green (or red) ring where the solids join.
  this.snapEdges = !(snap && snap.T) ? null : snap.m ? new Set([snap.m.p.edges[snap.m.i], snap.f.p.edges[snap.f.i]]) : new Set([...snap.A.edges, ...snap.B.edges]);
  this.snapPanels = snap && snap.T && snap.A ? new Set([snap.A, snap.B]) : null;
  this.snapBad = !!(snap && snap.bad);
  this.refreshStyles();
};

// Release over a valid target: move and attach as one undoable step.
W.commitSnap = function (job, snap, before) {
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
    const mine = new Set(sh.panels.filter((p) => ids.has(p.id)));
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
    this.app.toast(`${job.det ? 'Detached and attached' : 'Attached'} to face P${Bno}: ${this.objectText([...this.selComp])} are one object now (the faces that meet are inside it). Undo separates them.`, 5000);
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
  this.app.toast(`Joined: the ${many ? 'net piece' : name} is hinged to the edge of P${fno}. Fold it with Fold; Undo separates them.`, 5000);
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

// Move tool, a tap on a face: choose what will come away (or, tapped again,
// keep it joined). The part and the join show in orange.
W.moveTap = function (P) {
  const same = this.detach && this.detach.partIds.has(P.id);
  this.clearDetach();
  const solid = this.state.mode === 'solid';
  if (same) { this.app.toast(solid ? 'Kept joined. Drag to move the whole object.' : 'Drag to move it.'); return; }
  const d = this.detachFor(P);
  if (!d) {
    this.app.toast(solid
      ? 'This solid is not joined to another. Drag it to move it, or onto a matching face of another solid to attach it.'
      : this.componentOf(P).length === 1 ? 'Drag the piece to move it; near a matching free edge of another piece it snaps on.'
        : 'This is held by hinges, so Move takes everything hinged to it. To pull a part away, cut the hinge there first (Cut), then drag that part.', 6000);
    return;
  }
  this.detach = d;
  this.refreshStyles();
  this.app.toast(solid
    ? `This ${d.name} will come away (orange) at the join outlined in orange. Drag it away; tap it again to keep it joined. Dragging any other part moves the whole object.`
    : `This ${d.name} will come away (orange) along the dashed edges outlined in orange. Drag it away.`, 6000);
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
    this.active.set(ptr.id, { move: () => {}, end: () => ws.placeAt(ptr) });
    return true;
  }
  const tool = ws.state.tool;
  if (['select', 'remove'].includes(tool)) {
    // Taps: recognised on release on a screen (drags orbit the view).
    if (ptr.kind === 'screen') return false;
    this.active.set(ptr.id, { move: () => {}, end: () => ws.tap(ptr) });
    return true;
  }
  if (['rotate', 'move', 'modify2d'].includes(tool)) {
    const hit = ptr.pick();
    if (!hit || !hit.panel) return false;
    const g = tool === 'rotate' ? (ws.state.mode === 'solid' ? this.beginSolidTurn(ptr, hit) : this.beginObjectTurn(ptr, hit))
      : tool === 'move' ? this.beginObjectMove(ptr, hit)
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
  // What moves: in Solid the whole object, or the solid chosen to come away
  // (tap first); in Shape everything hinged to the face you grab, so a part
  // cut free (dashed edges) comes away on its own.
  let comp, det = null;
  if (solid && ws.detach && ws.detach.kind === 'solid' && ws.detach.partIds.has(hit.panel.id)) {
    det = ws.detach;
    comp = ws.shell.panels.filter((p) => det.partIds.has(p.id));
  } else if (solid) {
    ws.clearDetach();
    comp = ws.componentOf(hit.panel);
  } else {
    det = ws.detachFor(hit.panel);
    comp = det ? ws.shell.panels.filter((p) => det.partIds.has(p.id)) : ws.componentOf(hit.panel);
    if (det) {
      const glued = ws.comp.seams.some(([a, b]) => det.partIds.has(a.slice(0, a.lastIndexOf('#'))) !== det.partIds.has(b.slice(0, b.lastIndexOf('#'))));
      if (glued) { ws.app.toast('That part is glued to the rest along edges that met while folding. Cut those edges (Cut) to free it.', 5000); return null; }
      ws.detach = det;
    } else ws.clearDetach(false);
  }
  const ref = { dist: hit.distance, stick: true };
  const p0 = this.surfacePoint(ptr, ref);
  if (!p0) return null;
  const job = ws.moveStart(comp, ws.toLocal(hit.point), det);
  let temp = null;
  let d = new THREE.Vector3(), started = false, snap = null;
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
    ws.hideTag(); ws.showSnap(null);
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
      ws.showSnap(on);
      pose(on ? on.T : new THREE.Matrix4().makeTranslation(d.x, 0, d.z));
      if (on) {
        const at = solid ? on.B.centroid.clone() : on.f.p.verts[on.f.i].clone().add(on.f.p.verts[(on.f.i + 1) % on.f.p.verts.length]).multiplyScalar(0.5).applyMatrix4(on.f.p.M);
        at.y += ws.edgeLen * 0.5;
        ws.setTag(on.bad ? `Not here: ${on.bad}` : solid ? `Attach to face P${on.B.no} · release` : 'Edges meet · release to join', ws.shellGroup.localToWorld(at));
      } else if (snap && snap.why) ws.setTag(`No snap: ${snap.why}`, ws.shellGroup.localToWorld(snap.B.centroid.clone().add(new THREE.Vector3(0, ws.edgeLen * 0.5, 0))));
      else ws.hideTag();
    },
    end: () => {
      const on = snap && snap.T ? snap : null;
      reset();
      if (!started) {
        // A tap: choose (or drop) the part that will come away.
        if (solid) ws.moveTap(hit.panel);
        else if (det) ws.app.toast(`This ${det.name} comes away (orange) along the dashed edges outlined in orange: drag it away.`, 5000);
        else ws.moveTap(hit.panel);
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
  const before = ws.snapshot();
  const moved = this.dragDetector(ptr, hit);
  let job = null, res = null;
  ws.modHot = { pid: P.id, idx: grab.edges };
  ws.refreshStyles();
  const clear = () => { ws.hideTag(); ws.modHot = null; };
  return {
    move: (p) => {
      if (!job && !moved(p)) return;
      if (!job) { ws.stopAnim(); job = ws.modifyStart(P, grab); }
      const w = onPlane(p);
      if (!w) return;
      res = ws.modifyTo(job, restOf(w).sub(r0));
      const at = ws.modifyWorld(job) || hit.point;
      ws.setTag(res.reason ? `Stopped: ${res.reason}` : ws.modifyText(job), at);
    },
    end: () => {
      clear();
      if (!job) { ws.refreshStyles(); ws.app.toast(grab.kind === 'corner' ? 'Drag the corner to reshape.' : 'Drag the edge to reshape.'); return; }
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
  // Move: the join where the chosen part comes away.
  if (this.detach && !this.clean && this.state.tool === 'move' && e.uses.length === 2 && this.detach.ringKeys.has(pairKey(e))) return { color: '#ff8a1f', w: this.edgeLen * 0.022 * 2.8, dashed: e.type === 'cut' && this.state.mode === 'shape' };
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
  if (this.detach && this.state.tool === 'move' && this.detach.partIds.has(p.id)) return 'detach';
  if (this.selComp && this.selComp.has(p) && ['select', 'rotate', 'move', 'remove', 'modify2d'].includes(this.state.tool)) return this.overlapSet.has(p) ? 'overlap' : 'selected';
  if (['select', 'rotate', 'move', 'remove', 'modify2d'].includes(this.state.tool)) {
    if (this.overlapSet.has(p)) return 'overlap';
    return this.hoverPanel === p ? 'hover' : 'none';
  }
  return panelState0.call(this, p);
};

// Hover: placement preview, or the panel under the pointer.
const setHover0 = W.setHover;
W.setHover = function (hit, ptr) {
  if (this.placing) { this.previewPlacement(ptr, hit); return; }
  if (['select', 'rotate', 'move', 'remove', 'modify2d'].includes(this.state.tool)) {
    const panel = hit && hit.panel ? hit.panel : null;
    if (panel !== this.hoverPanel) { this.hoverPanel = panel; this.refreshMaterials(); }
    if (this.state.tool === 'modify2d' && !this.modHot) {
      const g = panel ? this.modifyGrab(panel, hit.local) : null;
      const key = g ? `${panel.id}/${g.edges.join(',')}` : '';
      if (key !== (this.modHoverKey || '')) { this.modHoverKey = key; this.modHover = g ? { pid: panel.id, idx: g.edges } : null; this.refreshStyles(); }
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
  row(y0 + 152, 62, MODE_TOOLS[mode].map((t) => ({ label: t.name, action: () => a.setModeTool(t.key), active: s.mtool === t.key, disabled: !!t.later })), 6);
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
  if (a.label !== 'mode') { finishAnim0.call(this, a); return; }
  if (a.final) for (const [p, m] of a.final) p.M.copy(m);
  this.updateMatrices();
  this.afterMotion(false);
  this.shell.classify();
  this.app.toast(a.msg, 4000);
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
