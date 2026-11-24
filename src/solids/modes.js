import * as THREE from 'three';
import { SolidsWorkspace, SolidsTools } from './workspace.js';
import { template, TEMPLATES, restHeight } from './polyhedra.js';
import { SHAPES, shapeByKey, shapeName, regularPolygon, attachedPolygon, rigidFrom, convexIn, matchClosure } from './pieces.js';

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
    { key: 'modify', name: 'Modify', tip: 'Drag a corner or an edge of a flat shape to reshape it; it stops where the shape would stop being valid' },
    { key: 'remove', name: 'Remove', tip: 'Tap a face to remove it, or the edge between two faces to merge them' },
    { key: 'move', name: 'Move', tip: 'Drag a piece to move it on the surface' },
    { key: 'rotate', name: 'Rotate', tip: 'Drag a piece to turn it as a whole; its connections and folds stay' },
    { key: 'fold', name: 'Fold', tip: 'Drag a panel to swing it about its hinge; free edges that meet snap together' },
    { key: 'cut', name: 'Cut', tip: 'Tap a hinge to cut it (dashed); tap it again to make it a hinge' },
    { key: 'mirror', name: 'Mirror', tip: 'Not yet available: needs a decision on how Mirror works for flat shapes', later: true },
    { key: 'preview', name: '3D', tip: 'Not yet available: preview of the folded form (next stage)', later: true },
  ],
  solid: [
    { key: 'modify', name: 'Modify', tip: 'Not yet available: direct editing of solids (next stage)', later: true },
    { key: 'remove', name: 'Remove', tip: 'Tap a solid to remove it' },
    { key: 'move', name: 'Move', tip: 'Drag a solid to move it on the surface' },
    { key: 'rotate', name: 'Rotate', tip: 'Drag a solid to turn it as a whole' },
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

W.isPiecePanel = function (p) { return p.type === 'piece'; };

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
    if (this.restClosed(comp)) continue;
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
      if (!this.restClosed(comp)) continue;
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

// Arrange: everything flat on the surface, pieces side by side.
W.arrangeAll = function () {
  if (this.comp.isEmpty()) { this.app.toast('Nothing to arrange yet.'); return; }
  this.tools.finishAll(); this.placing = null; this.hidePlacePreview();
  this.layFlat({ arrange: true });
};

// Alternate: another valid net for the solids. Nets built by hand keep
// their hinges (they are what you made).
W.alternateNet = function () {
  if (this.comp.pieces.length) { this.app.toast('Alternate switches between nets of solids. Nets you build from shapes keep the hinges you made; use Cut to change them.', 5000); return; }
  if (!this.comp.solids.length) { this.app.toast('Nothing to rearrange yet.'); return; }
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
  const solids = new Set(comp.filter((p) => !this.isPiecePanel(p)).map((p) => p.solidId)).size;
  this.app.toast(`Selected: ${solids ? `${solids} solid${solids === 1 ? '' : 's'}` : `${comp.length} shape${comp.length === 1 ? '' : 's'}`} (${comp.length} face${comp.length === 1 ? '' : 's'}). Choose a tool on the right, or tap outside to clear.`);
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
  if (hit && hit.panel) {
    const P = hit.panel;
    if (this.isPiecePanel(P)) return { error: 'Solids attach to faces of solids. Tap a solid’s face, or the empty surface.' };
    if (!isIdentity(P.M)) return { error: 'That solid is unfolded. Fold it closed (Refold) before attaching another solid.' };
    const target = this.comp.get(P.solidId);
    if (!target) return { error: 'Tap a face of a solid.' };
    const probe = this.probeAttach(target, P.fi, type);
    if (!probe) return { error: `A ${TEMPLATES[type].name.toLowerCase()} has no face of that shape and size.` };
    if (probe.problem) return { error: `${probe.problem.kind === 'overlap' ? `A ${TEMPLATES[type].name.toLowerCase()} there would overlap another solid.` : probe.problem.message}`, blocker: probe.problem.solid };
    return { kind: 'solid', type, edge: target.edge, position: probe.pose.position, quaternion: probe.pose.quaternion };
  }
  const pt = this.surfaceAt(ptr);
  if (!pt) return { error: 'Point at the work surface.' };
  const position = new THREE.Vector3(pt.x, restHeight(type, EDGE), pt.z);
  const quaternion = template(type).rest.clone();
  const problem = this.comp.placementProblem(type, EDGE, position, quaternion);
  if (problem) return { error: 'That would overlap a solid. Tap an empty part of the surface.', blocker: problem.solid };
  return { kind: 'solid', type, edge: EDGE, position, quaternion };
};

W.placeAt = function (ptr) {
  const hit = ptr.pick();
  const plan = this.planPlacement(ptr, hit);
  if (!plan) return false;
  if (plan.error) { if (plan.blocker) this.flashSolid(plan.blocker.id); this.app.toast(plan.error, 4500); return false; }
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
    let sid = null;
    const affected = new Set();
    this.rebuildKeep(() => { sid = this.comp.add(plan.type, plan.edge, plan.position, plan.quaternion).id; }, {
      defaultNet: true,
      skip: (e) => e.uses.some((u) => u.panel.type !== 'piece' && this.solidJoinedTo(u.panel, sid, affected)),
    });
    const mine = new Set(this.shell.panels.filter((p) => p.solidId === sid));
    const bad = this.overlapsWith(mine);
    if (!mine.size || bad) {
      this.restoreSnapshot(before);
      this.app.toast(`That ${TEMPLATES[plan.type].name.toLowerCase()} would overlap face P${bad ? bad.no : '?'}. Nothing was placed.`, 4500);
      return false;
    }
    label = `${TEMPLATES[plan.type].name} placed`;
  }
  this.pushHistory(before);
  this.placing = null;
  this.hidePlacePreview();
  this.app.toast(`${label}. Tap the picker to add another.`, 4000);
  this.app.notify?.();
  return true;
};

// Is panel p in the same object as solid `sid` (cached per placement)?
W.solidJoinedTo = function (p, sid, cache) {
  if (!cache.size) {
    const comp = this.shell.pieces().find((c) => c.some((q) => q.solidId === sid));
    if (comp) for (const q of comp) cache.add(q);
    cache.add(null);
  }
  return cache.has(p);
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
W.transformComponent = function (comp, R) {
  const ids = new Set(comp.map((p) => p.id));
  const solidIds = new Set(comp.filter((p) => !this.isPiecePanel(p)).map((p) => p.solidId));
  const pieceIds = new Set(comp.filter((p) => this.isPiecePanel(p)).map((p) => p.solidId));
  const Rinv = R.clone().invert();
  const q = new THREE.Quaternion().setFromRotationMatrix(R);
  this.rebuildKeep((st) => {
    for (const s of this.comp.solids) if (solidIds.has(s.id)) { s.position.applyMatrix4(R); s.quaternion.premultiply(q).normalize(); }
    for (const pc of this.comp.pieces) if (pieceIds.has(pc.id)) for (const v of pc.verts) v.applyMatrix4(R);
    // A closed (identity) pose stays exactly closed.
    for (const [id, m] of st.M) if (ids.has(id)) st.M.set(id, isIdentity(m) ? new THREE.Matrix4() : R.clone().multiply(m).multiply(Rinv));
  });
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
      const comp = this.componentOf(P);
      const ids = new Set(comp.map((p) => p.solidId));
      this.rebuildKeep(() => { for (const id of ids) this.comp.removePiece(id); });
      this.pushHistory(before);
      this.app.toast(`Removed an object of ${comp.length} face${comp.length === 1 ? '' : 's'}. Undo brings it back.`);
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
    const ok = this.mergeEdge(e, { ghost: false });
    if (ok) return;
    return;
  }
  if (!this.isPiecePanel(P)) { this.app.toast('Faces of a solid are removed with the solid (Solid mode, Remove). Removing one face of a solid comes in the next stage.', 5000); return; }
  this.rebuildKeep(() => { this.comp.removePiece(P.solidId); });
  this.pushHistory(before);
  this.app.toast(`${shapeName(P.verts.length)} removed${this.shell.panels.length ? '; any opening it leaves stays open' : ''}. Undo brings it back.`);
};

// ------------------------------------------------------- modify (Shape)

// Corners of the object that sit where `pts` are (rest form).
W.cornerRefs = function (comp, pts) {
  const tol = this.edgeLen * 1e-6;
  const refs = [];
  for (const p of comp) {
    if (!this.isPiecePanel(p)) continue;
    const pc = this.comp.piece(p.solidId);
    pc.verts.forEach((v, k) => { const j = pts.findIndex((q) => q.distanceTo(v) < tol); if (j >= 0) refs.push({ pc, k, j }); });
  }
  return refs;
};

// Is the object still valid with these corner positions? Each piece convex
// (no edge under 5 mm, no corner under 5°) and no two pieces overlapping.
W.modifyProblem = function (comp, refs, pos) {
  const pcs = [...new Set(comp.map((p) => this.comp.piece(p.solidId)).filter(Boolean))];
  const polys = new Map(pcs.map((pc) => [pc, pc.verts.map((v) => v.clone())]));
  for (const r of refs) polys.get(r.pc)[r.k].copy(pos[r.j]);
  const n = new THREE.Vector3(0, -1, 0);
  for (const [pc, pts] of polys) {
    if (!refs.some((r) => r.pc === pc)) continue;
    if (!convexIn(pts, n, 0.005, 5)) return `${shapeName(pc.n)} would stop being a valid flat face (it must stay convex, edges at least 5 mm, corners at least 5°)`;
  }
  const list = [...polys];
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      if (!refs.some((r) => r.pc === list[a][0] || r.pc === list[b][0])) continue;
      if (overlap2D(list[a][1], list[b][1], this.edgeLen * 1e-4)) return 'two faces would overlap';
    }
  }
  return null;
};

W.applyCorners = function (refs, pos) { for (const r of refs) r.pc.verts[r.k].copy(pos[r.j]); };

// ------------------------------------------------------------ info, errors

W.infoCounts = function () {
  const sh = this.shell;
  const verts = new Set(sh.panels.flatMap((p) => p.vid));
  const st = { solids: this.comp.solids.length, shapes: this.comp.pieces.length, faces: sh.panels.length, edges: sh.edges.length, vertices: verts.size,
    hinges: sh.edges.filter((e) => e.shared && e.type === 'hinge').length, objects: sh.pieces().length };
  return st;
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
    const g = tool === 'rotate' ? this.beginObjectTurn(ptr, hit)
      : tool === 'move' ? this.beginObjectMove(ptr, hit)
        : this.beginModify2D(ptr, hit);
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

// Drag a whole object across the work surface.
T.beginObjectMove = function (ptr, hit) {
  const ws = this.ws;
  if (ws.comp.isEdited() || ws.comp.isShaped()) { ws.app.toast('Reset edits before moving objects.'); return null; }
  const comp = ws.componentOf(hit.panel);
  const ref = { dist: hit.distance, stick: true };
  const p0 = this.surfacePoint(ptr, ref);
  if (!p0) return null;
  const M0 = new Map(comp.map((p) => [p, p.M.clone()]));
  let d = new THREE.Vector3(), started = false;
  const moved = this.dragDetector(ptr, hit);
  ws.selComp = new Set(comp);
  ws.refreshStyles();
  return {
    move: (p) => {
      if (!started && !moved(p)) return;
      started = true;
      const q = this.surfacePoint(p, ref);
      if (!q) return;
      d = q.clone().sub(p0); d.y = 0;
      const m = new THREE.Matrix4().makeTranslation(d.x, 0, d.z);
      for (const [pp, m0] of M0) pp.M.copy(m.clone().multiply(m0));
      ws.updateMatrices();
      ws.checkOverlaps();
      ws.refreshMaterials();
    },
    end: () => {
      for (const [pp, m0] of M0) pp.M.copy(m0);
      if (!started || d.length() < 1e-5) { ws.updateMatrices(); ws.checkOverlaps(); ws.refreshMaterials(); if (!started) ws.app.toast('Drag the object to move it.'); return; }
      const before = ws.snapshot();
      ws.transformComponent(comp, new THREE.Matrix4().makeTranslation(d.x, 0, d.z));
      ws.pushHistory(before);
      const bad = ws.overlapPairs;
      ws.app.toast(`Moved ${Math.round(d.length() * 1000)} mm.${bad ? ` ${bad} face pair${bad === 1 ? '' : 's'} overlap (red): see Error.` : ''}`);
    },
    cancel: () => { for (const [pp, m0] of M0) pp.M.copy(m0); ws.updateMatrices(); ws.checkOverlaps(); ws.refreshMaterials(); },
  };
};

// Drag a corner or an edge of a flat shape within its plane. The move stops
// at the last valid position and says why.
T.beginModify2D = function (ptr, hit) {
  const ws = this.ws;
  const P = hit.panel;
  if (!ws.isPiecePanel(P)) { ws.app.toast('Modify in Shape mode reshapes shapes. Solids are edited in Solid mode (next stage).', 4500); return null; }
  const comp = ws.componentOf(P);
  if (ws.restClosed(comp)) { ws.app.toast('This object has closed into a solid. Reshape it in Solid mode (next stage).', 4500); return null; }
  if (!comp.every((p) => isIdentity(p.M) || p.M.equals(comp[0].M))) { ws.app.toast('Unfold the net flat (Unfold) before reshaping its shapes.', 4500); return null; }
  const n = P.verts.length;
  let grab = null;
  let bv = ws.edgeLen * 0.22;
  P.verts.forEach((v, k) => { const d = v.distanceTo(hit.local); if (d < bv) { bv = d; grab = { kind: 'corner', pts: [v.clone()] }; } });
  if (!grab) {
    const i = ws.edgeNear(P, hit.local, 0.18);
    const k = i ? P.edges.indexOf(i) : -1;
    if (k >= 0) grab = { kind: 'edge', pts: [P.verts[k].clone(), P.verts[(k + 1) % n].clone()] };
  }
  if (!grab) return { move: () => {}, end: () => ws.app.toast('Drag a corner or an edge of the shape to reshape it.') };
  const refs = ws.cornerRefs(comp, grab.pts);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(ws.shell.worldNormal(P).transformDirection(ws.shellGroup.matrixWorld), hit.point);
  const inv = P.M.clone().invert();
  const start = hit.local.clone();
  let cur = grab.pts.map((v) => v.clone());
  let reason = null, started = false;
  const before = ws.snapshot();
  const moved = this.dragDetector(ptr, hit);
  const atLocal = (p) => {
    const w = p.kind === 'screen' ? p.ray.intersectPlane(plane, new THREE.Vector3()) : p.grabPoint(null, hit.distance, true).point;
    return w ? ws.toLocal(w).applyMatrix4(inv) : null;
  };
  const tryPos = (delta) => grab.pts.map((v) => v.clone().add(delta));
  return {
    move: (p) => {
      if (!started && !moved(p)) return;
      started = true;
      const L = atLocal(p);
      if (!L) return;
      const delta = L.sub(start); delta.y = 0;
      let target = tryPos(delta);
      const problem = ws.modifyProblem(comp, refs, target);
      reason = null;
      if (problem) {
        // Furthest valid point on the way from the last valid position.
        let lo = 0, hi = 1;
        const from = cur;
        const lerp = (t) => from.map((v, j) => v.clone().lerp(target[j], t));
        for (let it = 0; it < 18; it++) { const mid = (lo + hi) / 2; if (ws.modifyProblem(comp, refs, lerp(mid))) hi = mid; else lo = mid; }
        target = lerp(lo);
        reason = problem;
      }
      cur = target;
      ws.applyCorners(refs, cur);
      ws.rebuildKeep(() => {});
      ws.setTag(reason ? `Stopped: ${reason}` : 'Reshape', hit.point);
    },
    end: () => {
      ws.hideTag();
      if (!started) { ws.app.toast(grab.kind === 'corner' ? 'Drag the corner to reshape.' : 'Drag the edge to reshape.'); return; }
      ws.pushHistory(before);
      ws.app.toast(reason ? `Stopped at the last valid position: ${reason}.` : `Reshaped. Edges that join keep matching lengths.`, 5000);
    },
    cancel: () => { ws.hideTag(); ws.restoreSnapshot(before); },
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
  if (this.snapEdges && this.snapEdges.has(e)) return { color: '#36d98a', w: this.edgeLen * 0.022 * 2.6 };
  if (e.uses.length === 1 && !this.clean) {
    const w = this.edgeLen * 0.022;
    return this.isSeamed(p, e.uses[0].i) ? { color: '#3a78e0', w: w * 1.4 } : { color: '#5a5f73', w };
  }
  return edgeStyle0.call(this, p, e, okEdges);
};

const panelState0 = W.panelState;
W.panelState = function (p) {
  if (this.flashPanels && this.flashPanels.has(p)) return 'issue';
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
    return;
  }
  setHover0.call(this, hit, ptr);
};

// VR panel: the same structure as the screen. Tabs, the picker (place;
// in Solid the next polyhedron, since a long press is not available with a
// controller), the mode's tools, the net tools, Undo / Redo, Info / Error,
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

// Two flat convex polygons in the same plane (y up) share area?
function overlap2D(A, B, tol) {
  const P = A.map((v) => [v.x, v.z]), Q = B.map((v) => [v.x, v.z]);
  for (const S of [P, Q]) {
    for (let i = 0; i < S.length; i++) {
      const p = S[i], q = S[(i + 1) % S.length];
      let x = -(q[1] - p[1]), y = q[0] - p[0];
      const l = Math.hypot(x, y);
      if (l < 1e-12) continue;
      x /= l; y /= l;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const r of P) { const d = r[0] * x + r[1] * y; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const r of Q) { const d = r[0] * x + r[1] * y; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (Math.min(a1, b1) - Math.max(a0, b0) <= tol) return false;
    }
  }
  return true;
}

export { SHAPES, shapeByKey, EDGE as UNIT };
