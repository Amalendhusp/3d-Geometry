import * as THREE from 'three';
import { Composition, alignFace } from './composition.js';
import { Shell } from './shell.js';
import { template, TEMPLATES, SOLID_TYPES, restHeight } from './polyhedra.js';
import { makeFrame, angleFromPoint, angleFromRay } from './hinge.js';
import { flatTargets, pieceCentre, planarMove, edgeSnap, layFlatStable } from './layout.js';
import { LabelLayer } from './labels.js';
import { ShapeEditor } from './shapeedit.js';
import { captureLayout, applyLayout, anchorTo, elPos } from './resize.js';

// "Solid → Unfold" workspace: build a composition of solids, then open its
// exterior shell panel by panel along hinges.

const EDGE = 0.12; // edge length of every solid, in metres
const STORE_KEY = 'paper-fold-studio.solids.v1';

// Starting compositions. Cube ones use lattice cells; the others attach
// solids face to face from a first solid resting on the table.
export const PRESETS = {
  one: { label: '1 cube', cells: [[0, 0, 0]] },
  two: { label: '2 cubes', cells: [[0, 0, 0], [1, 0, 0]] },
  row: { label: '3 cubes in a row', cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
  ell: { label: 'L of 3 cubes', cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1]] },
  stack: { label: 'Stack of 2 cubes', cells: [[0, 0, 0], [0, 1, 0]] },
  tetra: { label: '1 tetrahedron', build: (c) => first(c, 'tetra') },
  tetra2: { label: '2 tetrahedra', build: (c) => { const t = first(c, 'tetra'); attachToward(c, t, UP, 'tetra'); } },
  tetra3: { label: '3 tetrahedra', build: (c) => { const t = first(c, 'tetra'); const u = attachToward(c, t, UP, 'tetra'); attachToward(c, u, new THREE.Vector3(1, 0.4, 0.2), 'tetra'); } },
  octa: { label: '1 octahedron', build: (c) => first(c, 'octa') },
  tetraOcta: { label: 'Octahedron + tetrahedron', build: (c) => { const o = first(c, 'octa'); attachToward(c, o, UP, 'tetra'); } },
  bigTetra: { label: 'Big tetrahedron (octa + 4 tetra)', build: (c) => bigTetra(c) },
  cubocta: { label: '1 cuboctahedron', build: (c) => first(c, 'cubocta') },
  cuboOcta: { label: 'Cuboctahedron + octahedron', build: (c) => { const k = first(c, 'cubocta'); attachToward(c, k, new THREE.Vector3(0.6, 0.6, 0.6), 'octa', 3); } },
  cuboOcta2: { label: 'Cuboctahedron + 2 octahedra', build: (c) => { const k = first(c, 'cubocta'); attachToward(c, k, new THREE.Vector3(0.6, 0.6, 0.6), 'octa', 3); attachToward(c, k, new THREE.Vector3(-0.6, 0.6, -0.6), 'octa', 3); } },
  cuboCube: { label: 'Cuboctahedron + cube', build: (c) => { const k = first(c, 'cubocta'); attachToward(c, k, UP, 'cube', 4); } },
  honeycomb: { label: 'Octahedron + 2 cuboctahedra (closed joint)', build: (c) => honeycomb(c) },
  gapDemo: { label: 'Cuboctahedron + cube + octahedron (gap)', build: (c) => gapDemo(c) },
  cuboid: { label: 'Cuboid 180 × 60 × 120 mm (stretched cube)', build: (c) => { first(c, 'cube'); c.shape.set(1.5, 0.5, 1); } },
  longTwo: { label: '2 cubes stretched to 2:1 tall', build: (c) => { c.add('cube', EDGE, new THREE.Vector3(0, EDGE / 2, 0)); c.add('cube', EDGE, new THREE.Vector3(EDGE, EDGE / 2, 0)); c.shape.set(1, 2, 1); } },
  tallTetraOcta: { label: 'Octahedron + tetrahedron, 1.4× taller', build: (c) => { const o = first(c, 'octa'); attachToward(c, o, UP, 'tetra'); c.shape.set(1, 1.4, 1); } },
};

const SHAPE_LIMITS = { factor: [0.2, 5], minEdge: 0.01, maxSize: 0.9, minAngle: 5 };

// Two cuboctahedra on edge-sharing faces of an octahedron: around that
// octahedron edge the three solids close a full turn, and the two
// cuboctahedra also meet square to square.
function honeycomb(c) {
  const o = first(c, 'octa');
  const wf = o.worldFaces();
  const a = wf.findIndex((f) => f.normal.y > 0.3);
  const b = wf.findIndex((f, i) => i !== a && f.normal.y > -0.5 && f.verts.filter((v) => wf[a].verts.some((w) => w.distanceTo(v) < 1e-6)).length === 2);
  c.attachTo(o.id, a, 'cubocta', EDGE);
  c.attachTo(o.id, b, 'cubocta', EDGE);
}

// A cube on a square and an octahedron on the neighbouring triangle of a
// cuboctahedron leave a 35.3° gap along the edge between them.
function gapDemo(c) {
  const k = first(c, 'cubocta');
  const wf = k.worldFaces();
  const sq = wf.findIndex((f) => f.sides === 4 && f.normal.y > 0.9);
  const tri = wf.findIndex((f) => f.sides === 3 && f.verts.filter((v) => wf[sq].verts.some((w) => w.distanceTo(v) < 1e-6)).length === 2);
  c.attachTo(k.id, sq, 'cube', EDGE);
  c.attachTo(k.id, tri, 'octa', EDGE);
}

const UP = new THREE.Vector3(0, 1, 0);

function first(c, type) {
  return c.add(type, EDGE, new THREE.Vector3(0, restHeight(type, EDGE), 0));
}

// Attach a solid to the face of `target` whose normal is closest to `dir`.
function attachToward(c, target, dir, type, sides) {
  const want = sides || template(type).faces[0].sides;
  let best = -1, bd = -Infinity;
  target.worldFaces().forEach((f, i) => {
    if (f.sides !== want) return;
    const d = f.normal.dot(dir.clone().normalize());
    if (d > bd && !c.placementProblem(type, EDGE, ...poseFor(c, target, i, type))) { bd = d; best = i; }
  });
  if (best < 0) return null;
  return c.attachTo(target.id, best, type, EDGE).solid || null;
}

function poseFor(c, target, fi, type) {
  const tf = target.worldFaces()[fi];
  const tm = template(type);
  for (let f = 0; f < tm.faces.length; f++) {
    if (tm.faces[f].sides !== tf.sides) continue;
    const pose = alignFace(tm, f, EDGE, tf, 0);
    if (pose) return [pose.position, pose.quaternion];
  }
  return [new THREE.Vector3(1e3, 1e3, 1e3), new THREE.Quaternion()];
}

// Octahedron with tetrahedra on four alternate faces: a tetrahedron of
// twice the edge length. The face it rests on stays an octahedron face.
function bigTetra(c) {
  const o = first(c, 'octa');
  const T = template('octa');
  const sign = (n) => Math.sign(n.x) * Math.sign(n.y) * Math.sign(n.z);
  const wf = o.worldFaces();
  const bottom = wf.reduce((b, f, i) => (f.normal.y < wf[b].normal.y ? i : b), 0);
  const want = -sign(T.faces[bottom].normal);
  T.faces.forEach((f, i) => { if (sign(f.normal) === want) c.attachTo(o.id, i, 'tetra', EDGE); });
}

const NET_TEXT = {
  verified: 'Net: verified, unfolds flat without overlaps',
  split: 'Flat layout in separate pieces (no overlaps, not one net)',
  overlap: 'Flat layout with overlapping panels: not a valid net',
  unresolved: 'Unresolved: the search found no overlap-free net',
  loops: 'Hinges form a closed loop: cannot unfold',
  unchecked: 'Net not checked',
};

const COLORS = {
  inside: '#8ea4c2',
  hinge: '#1e9a5f',
  cut: '#d4462a',
  locked: '#7a4bb3',
  option: '#2fe08f',
  chosen: '#f0b44c',
  loop: '#ff7a1a',
};

const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;

export class SolidsWorkspace {
  constructor(app) {
    this.app = app;
    this.root = new THREE.Group();
    this.root.name = 'solids-root';
    // root (on the table) → inspect (view turn, never geometry) → shell.
    this.inspect = new THREE.Group();
    this.inspect.name = 'solids-inspect';
    this.root.add(this.inspect);
    this.shellGroup = new THREE.Group();
    this.inspect.add(this.shellGroup);
    this.view = { q: new THREE.Quaternion(), target: null, lift: 0 };
    this.pivot = new THREE.Vector3();
    this.comp = new Composition();
    this.shell = new Shell();
    this.labels = new LabelLayer(this);
    this.shapeEdit = new ShapeEditor(this);
    this.hoverFlap = new Set();
    this.initLift();
    this.initTag();
    this.initHingeLine();
    this.state = { tool: 'open', openMode: 'group', showLabels: true, showIds: false };
    this.sel = { panel: null, hinge: null, solidId: null, fi: null, piece: null };
    this.inspectHover = false;
    this.loopEdges = new Set();
    this.hoverPanel = null;
    this.hoverEdge = null;
    this.overlapSet = new Set();
    this.moving = new Set();
    this.history = [];
    this.anim = null;
    this.meshes = new Map();
    this.matCache = new Map();
    this.ghost = null;
    this.tools = new SolidsTools(this);
    this.raycaster = new THREE.Raycaster();
    this.ready = false;
    this.preset('one', false);
    this.ready = true;
  }

  get edgeLen() { return this.shell.edgeLen || EDGE; }

  // ----------------------------------------------------------- building

  preset(name, record = true) {
    if (record) this.pushHistory();
    const p = PRESETS[name];
    this.comp = new Composition();
    if (p.cells) for (const [x, y, z] of p.cells) this.comp.add('cube', EDGE, new THREE.Vector3(x * EDGE, y * EDGE + EDGE / 2, z * EDGE));
    else p.build(this.comp);
    this.centre();
    this.rebuild();
    if (record) {
      this.frameView();
      const jt = this.jointText();
      this.app.toast(`${p.label}: ${this.describe()}.${jt ? ` Joints: ${jt}.` : ''} ${this.netSentence()}`, jt ? 6000 : undefined);
    }
  }

  // Centre the composition on the table and rest it on the surface.
  centre() {
    const box = new THREE.Box3();
    for (const s of this.comp.solids) for (const v of s.worldVerts()) box.expandByPoint(v);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    for (const s of this.comp.solids) { s.position.x -= c.x; s.position.z -= c.z; s.position.y -= box.min.y; }
  }

  // New shell from the composition with the default net, closed.
  rebuild(shellState = null) {
    this.comp.settle();
    this.shell.build(this.comp);
    if (shellState) this.shell.restore(shellState);
    else this.shell.defaultNet();
    this.sel = { panel: null, hinge: null, solidId: null, fi: null, piece: null };
    this.loopEdges.clear();
    this.moving.clear();
    this.netCycle = null;
    this.updatePivot();
    this.buildMeshes();
    this.applyView();
    this.checkOverlaps();
    this.syncShapeEdit();
    if (this.ready) { this.app.layoutTable(); this.app.notify(); }
  }

  // "2 cubes · 1 octahedron"
  solidsText() {
    const counts = new Map();
    for (const s of this.comp.solids) counts.set(s.type, (counts.get(s.type) || 0) + 1);
    return [...counts].map(([t, n]) => `${n} ${n === 1 ? TEMPLATES[t].name.toLowerCase() : TEMPLATES[t].plural}`).join(' · ') || 'no solids';
  }

  describe() {
    const s = this.shell.stats();
    return `${this.solidsText()} · ${s.panels} panels · ${s.removed} internal faces removed`;
  }

  netText() { return NET_TEXT[this.shell.net?.status || 'unchecked']; }

  // "2 joints close a full turn; 4 leave a 35.3° gap"
  jointText() {
    const j = this.comp.solids.length > 1 ? this.comp.jointReport() : null;
    if (!j || (!j.closed && !j.gaps.length)) return '';
    const parts = [];
    if (j.closed) parts.push(`${j.closed} edge${j.closed > 1 ? 's' : ''} where the solids close a full turn`);
    for (const g of j.gaps) parts.push(`${g.count} edge${g.count > 1 ? 's' : ''} with a ${g.angle}° gap no solid can fill`);
    return parts.join('; ');
  }

  // Briefly show a solid in red (the one in the way of a placement).
  flashSolid(id) {
    if (id == null) return;
    this.flash = { id, until: performance.now() + 1600 };
    this.refreshMaterials();
  }

  netSentence() {
    const n = this.shell.net || { status: 'unchecked' };
    if (n.status === 'verified') return 'Default net verified: unfolds flat with no overlaps.';
    if (n.status === 'unresolved') return `No overlap-free net found; the layout shown overlaps in ${n.overlaps} place${n.overlaps === 1 ? '' : 's'} when flat. It is not a valid net.`;
    if (n.status === 'overlap') return `This layout overlaps in ${n.overlaps} place${n.overlaps === 1 ? '' : 's'} when flat: not a valid net.`;
    if (n.status === 'split') return `This layout unfolds into ${n.pieces} separate pieces without overlaps.`;
    if (n.status === 'loops') return 'The hinges form a closed loop, so it cannot unfold.';
    return '';
  }

  // ------------------------------------------------------------ history

  snapshot() {
    return { comp: this.comp.serialize(), shell: this.shell.serialize() };
  }

  restoreSnapshot(snap) {
    this.comp.restore(snap.comp);
    this.shell.build(this.comp);
    this.shell.restore(snap.shell);
    this.sel = { panel: null, hinge: null, solidId: null, fi: null, piece: null };
    this.loopEdges.clear();
    this.moving.clear();
    this.netCycle = null;
    this.updatePivot();
    this.buildMeshes();
    this.applyView();
    this.checkOverlaps();
    this.syncShapeEdit();
    if (this.ready) { this.app.layoutTable(); this.app.notify(); }
  }

  // After the composition changes under the Shape tool: keep the net and
  // ghost in step, or leave direct editing if the solids are not boxes.
  syncShapeEdit() {
    if (!this.shapeEdit || !this.shapeEdit.active) return;
    if (this.shapeEdit.mode === 'resize' && this.comp.isEdited()) this.shapeEdit.mode = 'edit';
    // In Shape the net always lies flat (an undo may bring back a closed form).
    if (!this.anim && !this.shell.flatReport().ok) {
      const t = flatTargets(this.shell, { keepFlat: true });
      this.shell.applyForest(t.F, t.angles, t.roots);
      this.updateMatrices();
      this.checkOverlaps();
    }
    this.shapeEdit.refresh();
  }

  // Rebuild the shell for the current shape, keep the net's cuts, hinges
  // and root poses, lie flat, and keep `anchor` where it was.
  reshapeNet(layout, anchor, A0) {
    this.shell.build(this.comp);
    applyLayout(this.shell, layout);
    if (anchor) anchorTo(this.shell, anchor, A0);
    this.shell.classify();
    this.updatePivot();
    this.buildMeshes();
    this.applyView();
    this.checkOverlaps();
    this.shapeEdit.refresh();
    this.app.notify?.();
  }

  // Rebuild after a free-form edit: same cuts and hinges (edge keys name
  // the unedited vertices), new fold lines are hinges, the net laid flat
  // again with each piece's root where it was.
  reshapeEdit(prev) {
    this.shell.build(this.comp);
    for (const e of this.shell.edges) {
      if (!e.shared || e.locked) continue;
      e.type = prev.types[e.key] || (e.diagonal ? 'hinge' : 'cut');
    }
    const ids = prev.bases.filter((id) => this.shell.panelById.has(id));
    if (ids.length) this.shell.bases = new Set(ids);
    for (const comp of this.shell.pieces()) if (!comp.some((p) => this.shell.bases.has(p.id))) this.shell.chooseBasesFor(comp);
    layFlatStable(this.shell, prev.poses);
    this.shell.classify();
    this.updatePivot();
    this.buildMeshes();
    this.applyView();
    this.checkOverlaps();
    this.shapeEdit.refresh();
    this.app.notify?.();
  }

  // Lay the net flat again after its cuts changed.
  relayNet(poses) {
    layFlatStable(this.shell, poses);
    this.shell.classify();
    this.updateMatrices();
    this.checkOverlaps();
    this.refreshStyles();
    this.shapeEdit.refresh();
  }

  pushHistory() {
    this.history.push(this.snapshot());
    if (this.history.length > 80) this.history.shift();
    this.app.notify?.();
  }

  undo() {
    this.tools.finishAll();
    this.stopAnim();
    const s = this.history.pop();
    if (!s) { this.app.toast('Nothing to undo.'); return; }
    this.restoreSnapshot(s);
    this.app.toast('Undone.');
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 3, ...this.fullSnapshot() }));
      this.app.toast(`Saved: ${this.describe()}.`);
    } catch {
      this.app.toast('Saving is blocked in this browser view.');
    }
  }

  load() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { data = null; }
    if (!data) { this.app.toast('Nothing saved yet.'); return; }
    this.loadData(data, 'Loaded');
  }

  // Works for saves from earlier versions too (cube-only, no net status).
  loadData(data, verb = 'Loaded') {
    if (!data || !data.comp || !Array.isArray(data.comp.solids)) { this.app.toast('That file is not a saved composition.'); return false; }
    this.pushHistory();
    this.restoreSnapshot(data);
    // The view turn is saved with the composition but is not part of undo.
    this.view.target = null;
    if (Array.isArray(data.view) && data.view.length === 4) this.view.q.fromArray(data.view).normalize();
    else this.view.q.identity();
    this.applyView();
    this.frameView();
    const pieces = this.shell.hingePieces().length;
    const extra = [];
    if (this.comp.isShaped()) extra.push(`shape changed to ${this.sizeText()}`);
    if (this.isTurned()) extra.push(`turned ${Math.round(this.viewTurnDegrees())}° for viewing`);
    if (!this.shell.isClosed() && this.shell.flatReport().ok) extra.push(`laid flat in ${pieces} piece${pieces > 1 ? 's' : ''}`);
    this.app.toast(`${verb}: ${this.describe()}${extra.length ? ` (${extra.join(', ')})` : ''}. ${this.netSentence()}`, 5000);
    return true;
  }

  // Undo history holds geometry and layout; saved files also hold the view.
  fullSnapshot() { return { ...this.snapshot(), view: this.view.q.toArray().map((v) => Math.round(v * 1e9) / 1e9) }; }

  // A file you can keep or share (download), and read back with Import.
  exportText() { return JSON.stringify({ v: 3, app: 'paper-fold-studio', ...this.fullSnapshot() }, null, 1); }

  // ---------------------------------------------------------- rendering

  material(side, parity, state, type = 'cube') {
    const key = `${side}|${type}|${parity}|${state}`;
    if (this.matCache.has(key)) return this.matCache.get(key);
    const tint = { none: null, selected: '#f0b44c', moving: '#ffd27a', overlap: '#ff2a12', solid: '#4a8cff', face: '#f0b44c', hover: '#5aa0ff' }[state];
    const strength = { none: 0, selected: 0.38, moving: 0.18, overlap: 0.55, solid: 0.25, face: 0.45, hover: 0.22 }[state];
    const m = new THREE.MeshStandardMaterial({
      color: side === 'out' ? TEMPLATES[type].colors[parity] : COLORS.inside,
      roughness: 0.85,
      metalness: 0,
      side: side === 'out' ? THREE.FrontSide : THREE.BackSide,
      emissive: new THREE.Color(tint || '#000000'),
      emissiveIntensity: strength,
    });
    this.matCache.set(key, m);
    return m;
  }

  buildMeshes() {
    this.hoverPanel = this.hoverEdge = this.hoverHinge = null;
    this.labels.reset();
    for (const m of this.meshes.values()) {
      this.shellGroup.remove(m.group);
      m.geometry.dispose();
      if (m.ribbon) m.ribbon.geometry.dispose();
    }
    this.meshes.clear();
    this.pickables = [];
    const order = new Map(this.comp.solids.map((s, i) => [s.id, i]));
    for (const p of this.shell.panels) {
      const n = p.verts.length;
      const pos = [], nrm = [], idx = [];
      for (const v of p.verts) { pos.push(v.x, v.y, v.z); nrm.push(p.normal.x, p.normal.y, p.normal.z); }
      for (let i = 1; i < n - 1; i++) idx.push(0, i, i + 1);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      const parity = (order.get(p.solidId) ?? 0) % 2;
      const out = new THREE.Mesh(g, this.material('out', parity, 'none', p.type));
      const inn = new THREE.Mesh(g, this.material('in', parity, 'none', p.type));
      for (const m of [out, inn]) { m.castShadow = true; m.userData.panel = p; group.add(m); }
      this.shellGroup.add(group);
      this.meshes.set(p, { group, out, inn, geometry: g, parity, type: p.type, ribbon: null, ribbonBack: null });
      this.pickables.push(out, inn);
    }
    this.updateMatrices();
    this.refreshStyles();
  }

  updateMatrices() {
    for (const [p, m] of this.meshes) {
      m.group.matrix.copy(p.M);
      m.group.matrixWorldNeedsUpdate = true;
    }
  }

  panelState(p) {
    const tool = this.state.tool;
    if (this.clean) return 'none';
    if (this.overlapSet.has(p)) return 'overlap';
    if (this.flash && this.flash.id === p.solidId) return 'overlap';
    if (tool === 'inspect') return this.inspectHover || this.tools.inspecting() ? 'hover' : 'none';
    if (tool === 'layout') {
      if (this.sel.piece && this.sel.piece.has(p)) return 'selected';
      if (this.moving.has(p)) return 'moving';
      return this.hoverPanel === p ? 'hover' : 'none';
    }
    if (tool === 'build') {
      if (this.sel.solidId === p.solidId) return p.fi === this.sel.fi ? 'face' : 'solid';
      return this.hoverPanel === p ? 'hover' : 'none';
    }
    if (this.sel.panel === p) return 'selected';
    if (this.moving.has(p)) return 'moving';
    if (this.hoverPanel === p || this.hoverFlap.has(p)) return 'hover';
    return 'none';
  }

  refreshStyles() {
    const options = this.sel.panel && this.state.tool === 'open' && !this.clean ? this.hingeOptions() : [];
    const okEdges = new Set(options.filter((o) => o.ok).map((o) => o.e));
    for (const [p, m] of this.meshes) {
      const st = this.panelState(p);
      m.out.material = this.material('out', m.parity, st, m.type);
      m.inn.material = this.material('in', m.parity, st, m.type);
      this.buildRibbon(p, m, okEdges);
    }
    this.labels.refresh();
  }

  // Materials only (cheap; used every frame while a panel swings).
  refreshMaterials() {
    for (const [p, m] of this.meshes) {
      const st = this.panelState(p);
      m.out.material = this.material('out', m.parity, st, m.type);
      m.inn.material = this.material('in', m.parity, st, m.type);
    }
  }

  edgeStyle(p, e, okEdges) {
    const w = this.edgeLen * 0.022;
    if (this.clean) {
      if (!e.shared || e.locked) return { color: COLORS.locked, w, dashed: true };
      return e.type === 'hinge' ? { color: COLORS.hinge, w } : { color: COLORS.cut, w, dashed: true };
    }
    if (this.hoverEdge === e) return { color: '#ffffff', w: w * 2.6 };
    if (this.hoverPanel === p && this.hoverHinge === e && this.sel.panel !== p) return { color: '#5aa0ff', w: w * 2.2 };
    if (this.sel.panel === p && this.sel.hinge === e && this.state.tool === 'open') return { color: COLORS.chosen, w: w * 2.4 };
    if (this.loopEdges.has(e)) return { color: COLORS.loop, w: w * 2 };
    if (this.sel.panel === p && okEdges.has(e)) return { color: COLORS.option, w: w * 1.9 };
    if (!e.shared || e.locked) return { color: COLORS.locked, w, dashed: true };
    if (e.type === 'hinge') return { color: COLORS.hinge, w };
    return { color: COLORS.cut, w, dashed: true };
  }

  buildRibbon(p, m, okEdges) {
    if (m.ribbon) {
      m.group.remove(m.ribbon, m.ribbonBack);
      m.ribbon.geometry.dispose();
    }
    const pos = [], col = [], idx = [];
    const c = new THREE.Color();
    const n = p.verts.length;
    for (let i = 0; i < n; i++) {
      const e = p.edges[i];
      const st = this.edgeStyle(p, e, okEdges);
      c.set(st.color);
      const a = p.verts[i], b = p.verts[(i + 1) % n];
      const dir = b.clone().sub(a);
      const inward = new THREE.Vector3().crossVectors(p.normal, dir).normalize();
      if (inward.dot(p.centroid.clone().sub(a)) < 0) inward.negate();
      const spans = st.dashed ? dashes(7) : [[0, 1]];
      for (const [s0, s1] of spans) {
        const A = a.clone().addScaledVector(dir, s0), B = a.clone().addScaledVector(dir, s1);
        const B2 = B.clone().addScaledVector(inward, st.w), A2 = A.clone().addScaledVector(inward, st.w);
        const base = pos.length / 3;
        for (const v of [A, B, B2, A2]) { pos.push(v.x, v.y, v.z); col.push(c.r, c.g, c.b); }
        const cross = new THREE.Vector3().crossVectors(B.clone().sub(A), inward).dot(p.normal);
        if (cross > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    if (!this.ribbonMats) {
      const mk = (side) => new THREE.MeshBasicMaterial({ vertexColors: true, side, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      this.ribbonMats = [mk(THREE.FrontSide), mk(THREE.BackSide)];
    }
    const off = this.edgeLen * 0.003;
    const front = new THREE.Mesh(g, this.ribbonMats[0]);
    front.position.copy(p.normal).multiplyScalar(off);
    const back = new THREE.Mesh(g, this.ribbonMats[1]);
    back.position.copy(p.normal).multiplyScalar(-off);
    m.group.add(front, back);
    m.ribbon = front;
    m.ribbonBack = back;
  }

  checkOverlaps() {
    const res = this.shell.overlaps();
    this.overlapSet = res.panels;
    this.overlapPairs = res.pairs.length;
    return res;
  }

  // ------------------------------------------------------------- picking

  pick(ray) {
    if (!this.root.visible) return null;
    this.root.updateMatrixWorld(true);
    this.raycaster.set(ray.origin, ray.direction);
    this.raycaster.far = 20;
    const hits = this.raycaster.intersectObjects(this.pickables || [], false);
    const lift = this.liftHit(ray);
    if (lift && (!hits.length || lift.distance < hits[0].distance)) return lift;
    if (this.shapeEdit.active) {
      const g = this.shapeEdit.pickGhost(ray);
      if (g && (!hits.length || g.distance < hits[0].distance)) return g;
    }
    if (!hits.length) {
      if (this.state.tool !== 'inspect') return null;
      const f = this.formSphere();
      const pt = ray.intersectSphere(new THREE.Sphere(f.centre, f.radius), new THREE.Vector3());
      if (!pt) return null;
      return { panel: null, form: true, point: pt, distance: pt.distanceTo(ray.origin), normal: pt.clone().sub(f.centre).normalize() };
    }
    return this.hitFromWorld(hits[0].object.userData.panel, hits[0].point, hits[0].distance, ray.direction);
  }

  hitFromWorld(panel, point, distance, viewDir) {
    const m = this.meshes.get(panel);
    const local = point.clone().applyMatrix4(m.group.matrixWorld.clone().invert());
    const normal = panel.normal.clone().transformDirection(m.group.matrixWorld);
    if (viewDir && normal.dot(viewDir) > 0) normal.negate();
    return { panel, point: point.clone(), distance, local, normal };
  }

  // Preview what a press would do: the panel (and the hinge it would swing
  // on) in Open, the edge in Edges, the face in Build.
  setHover(hit, ptr) {
    const lh = !!(hit && hit.lift);
    if (lh !== this.liftHover) { this.liftHover = lh; this.styleLift(); }
    if (lh) hit = null;
    if (this.state.tool === 'shape' && this.shapeEdit.active) { this.shapeEdit.setHover(hit, ptr); return; }
    if (this.state.tool === 'inspect') {
      const h = !!hit;
      if (h !== this.inspectHover) { this.inspectHover = h; this.refreshMaterials(); }
      return;
    }
    let panel = null, edge = null, hinge = null;
    if (hit && hit.panel) {
      panel = hit.panel;
      if (this.state.tool === 'edges') {
        edge = this.edgeNear(panel, hit.local, ptr && ptr.kind === 'ray' && !hit.near ? 0.32 : 0.25);
        panel = null;
      } else if (this.state.tool === 'layout') {
        edge = this.edgeNear(panel, hit.local, ptr && ptr.kind === 'ray' && !hit.near ? 0.2 : 0.14);
      } else if (this.state.tool === 'open') {
        hinge = this.touchHinge(panel, hit.local);
      }
    }
    if (panel === this.hoverPanel && edge === this.hoverEdge && hinge === this.hoverHinge) return;
    this.hoverPanel = panel;
    this.hoverEdge = edge;
    this.hoverHinge = hinge;
    // Fold preview: the flap that would swing, and its hinge line.
    this.hoverFlap = new Set();
    if (this.state.tool === 'open' && panel && hinge && !this.tools.isBusy()) {
      const plan = this.shell.plan(panel, hinge, this.state.openMode);
      if (!plan.error) this.hoverFlap = new Set(plan.moving);
    }
    this.showHingeLine(this.state.tool === 'open' && panel && hinge && !this.tools.isBusy() ? { P: panel, e: hinge, color: '#4f8fff' } : null);
    this.refreshStyles();
  }

  // The hinge a touch near panel P would fold about. Touching a usable
  // hinge picks it; touching a free edge picks the usable hinge farthest
  // from it (you lift a flap by its free edge); otherwise the default.
  touchHinge(P, local) {
    const opts = this.shell.hingeOptions(P, this.state.openMode).filter((o) => o.ok);
    if (!opts.length) return null;
    if (!local) return this.defaultHinge(P);
    const near = this.edgeNear(P, local, 0.3);
    if (near && opts.some((o) => o.e === near)) return near;
    if (near) {
      let best = null, bd = -1;
      for (const o of opts) {
        const d = segDist3(local, o.e.a, o.e.b);
        if (d > bd) { bd = d; best = o.e; }
      }
      return best;
    }
    return this.defaultHinge(P);
  }

  // Nearest panel surface to a world point (fingertips, pinches).
  nearest(point, maxDist) {
    if (!this.root.visible) return null;
    this.root.updateMatrixWorld(true);
    const lift = this.liftNear(point, maxDist);
    if (lift) return lift;
    if (this.shapeEdit.active) {
      const g = this.shapeEdit.nearGhost(point, maxDist);
      if (g) return g;
    }
    if (this.state.tool === 'inspect') {
      const f = this.formSphere();
      const d = point.distanceTo(f.centre);
      if (d > f.radius + maxDist) return null;
      return { panel: null, form: true, point: point.clone(), distance: Math.max(0, d - f.radius), normal: point.clone().sub(f.centre).normalize() };
    }
    // Prefer a panel the point is outside of (the side you can see); only
    // when it is behind every nearby panel (a hand inside an opened shell)
    // take the nearest from behind. Near sharp corners a point just outside
    // one face can be closer to a neighbouring face's plane from inside.
    let out = null, back = null;
    const slack = this.edgeLen * 0.01;
    for (const [p, m] of this.meshes) {
      const inv = m.group.matrixWorld.clone().invert();
      const q = point.clone().applyMatrix4(inv);
      const d = q.clone().sub(p.verts[0]).dot(p.normal);
      if (Math.abs(d) > maxDist) continue;
      const onPlane = q.clone().addScaledVector(p.normal, -d);
      if (!insidePoly(p.verts, p.normal, onPlane)) continue;
      if (d >= -slack) { if (!out || d < out.d) out = { p, d, onPlane }; }
      else if (!back || -d < -back.d) back = { p, d, onPlane };
    }
    const best = out || back;
    if (!best) return null;
    const m = this.meshes.get(best.p);
    const world = best.onPlane.clone().applyMatrix4(m.group.matrixWorld);
    const normal = best.p.normal.clone().transformDirection(m.group.matrixWorld);
    if (best.d < 0) normal.negate();
    return { panel: best.p, point: world, distance: Math.abs(best.d), local: best.onPlane, normal };
  }

  // Edge of a panel close to a point given in the panel's rest frame.
  edgeNear(p, local, frac = 0.22) {
    let best = null, bd = this.edgeLen * frac;
    const n = p.verts.length;
    for (let i = 0; i < n; i++) {
      const d = segDist3(local, p.verts[i], p.verts[(i + 1) % n]);
      if (d < bd) { bd = d; best = p.edges[i]; }
    }
    return best;
  }

  toLocal(world) {
    this.shellGroup.updateWorldMatrix(true, false);
    return this.shellGroup.worldToLocal(world.clone());
  }

  // ------------------------------------------------- move puck, tag, hinge
  // Moving the whole form has its own grab target, a blue puck beside it,
  // so it is never confused with holding a flap to fold it.

  initLift() {
    const g = new THREE.Group();
    g.name = 'solids-move-puck';
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.012, 32), new THREE.MeshStandardMaterial({ color: '#2f7bff', roughness: 0.45, emissive: new THREE.Color('#2f7bff'), emissiveIntensity: 0.15 }));
    body.position.y = 0.006;
    g.add(body);
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff';
      x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#2f7bff'; x.lineWidth = 9; x.lineCap = 'round'; x.lineJoin = 'round';
      for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const dx = Math.cos(a), dy = Math.sin(a);
        x.beginPath(); x.moveTo(64 + dx * 12, 64 + dy * 12); x.lineTo(64 + dx * 46, 64 + dy * 46); x.stroke();
        x.beginPath(); x.moveTo(64 + dx * 46 - dy * 12 - dx * 12, 64 + dy * 46 + dx * 12 - dy * 12); x.lineTo(64 + dx * 46, 64 + dy * 46); x.lineTo(64 + dx * 46 + dy * 12 - dx * 12, 64 + dy * 46 - dx * 12 - dy * 12); x.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const top = new THREE.Mesh(new THREE.CircleGeometry(0.018, 32), new THREE.MeshBasicMaterial({ map: tex }));
      top.rotation.x = -Math.PI / 2;
      top.position.y = 0.0122;
      g.add(top);
    }
    // Generous invisible target.
    const target = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    target.position.y = 0.01;
    g.add(target);
    g.userData = { body, target, ui: true };
    this.lift = g;
    this.liftHover = false;
    this.liftTick = 0;
    this.root.add(g);
  }

  liftWanted() { return ['inspect', 'build', 'open', 'edges'].includes(this.state.tool) && this.root.visible; }

  updateLift() {
    if (!this.lift) return;
    this.lift.visible = this.liftWanted();
    if (!this.lift.visible) return;
    const b = this.bounds();
    if (b.isEmpty()) return;
    // Beside the form on the right, halfway back: clear of the panels, and
    // on a screen clear of the tool dock.
    this.lift.position.set(b.max.x + 0.05, 0, (b.min.z + b.max.z) / 2);
  }

  styleLift() {
    const body = this.lift.userData.body;
    const on = this.liftHover || this.tools.carrying;
    body.material.emissiveIntensity = on ? 0.75 : 0.15;
    this.lift.scale.setScalar(on ? 1.18 : 1);
    if (this.liftHover && !this.tools.carrying) {
      const w = this.lift.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.05, 0));
      this.setTag('Move the whole form', w);
    } else if (!this.tools.carrying && this.tag.userData.text === 'Move the whole form') this.hideTag();
  }

  liftHit(ray) {
    if (!this.lift || !this.lift.visible) return null;
    this.lift.updateMatrixWorld(true);
    const c = this.lift.userData.target.getWorldPosition(new THREE.Vector3());
    const pt = ray.intersectSphere(new THREE.Sphere(c, 0.032), new THREE.Vector3());
    if (!pt) return null;
    return { panel: null, lift: true, point: pt, distance: pt.distanceTo(ray.origin), normal: pt.clone().sub(c).normalize() };
  }

  liftNear(point, maxDist) {
    if (!this.lift || !this.lift.visible) return null;
    this.lift.updateMatrixWorld(true);
    const c = this.lift.userData.target.getWorldPosition(new THREE.Vector3());
    const d = point.distanceTo(c);
    if (d > 0.032 + maxDist) return null;
    return { panel: null, lift: true, point: point.clone(), distance: Math.max(0, d - 0.032), normal: point.clone().sub(c).normalize(), near: true };
  }

  // Floating tag naming the action in progress (resize, fold, move).
  initTag() {
    const m = new THREE.SpriteMaterial({ depthTest: false, transparent: true });
    this.tag = new THREE.Sprite(m);
    this.tag.visible = false;
    this.tag.renderOrder = 10;
    this.tag.userData = { text: '', ui: true };
    this.root.add(this.tag);
  }

  setTag(text, world) {
    if (typeof document === 'undefined' || !this.tag) return;
    const t = this.tag;
    if (t.userData.text !== text) {
      const c = t.userData.canvas || document.createElement('canvas');
      t.userData.canvas = c;
      const ctx = c.getContext('2d');
      const font = '700 34px "Zen Kaku Gothic New", system-ui, sans-serif';
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(text).width + 36);
      c.width = w; c.height = 56;
      ctx.font = font;
      ctx.fillStyle = /^Resize/.test(text) ? '#ff8a1f' : /^Fold/.test(text) ? '#1e9a5f' : '#2f7bff';
      ctx.beginPath(); ctx.roundRect(0, 0, w, 56, 16); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, 30);
      if (t.material.map) t.material.map.dispose();
      t.material.map = new THREE.CanvasTexture(c);
      t.material.map.colorSpace = THREE.SRGBColorSpace;
      t.material.needsUpdate = true;
      t.userData.text = text;
      t.userData.aspect = w / 56;
    }
    this.root.updateMatrixWorld(true);
    t.position.copy(this.root.worldToLocal(world.clone().add(new THREE.Vector3(0, 0.045, 0))));
    const h = 0.03;
    t.scale.set(h * t.userData.aspect, h, 1);
    t.visible = true;
  }

  hideTag() { if (this.tag) { this.tag.visible = false; this.tag.userData.text = ''; } }

  // Line along a hinge, a little longer than the edge: the axis a flap
  // turns about (blue preview, amber while held).
  initHingeLine() {
    this.hingeLine = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10), new THREE.MeshBasicMaterial({ color: '#4f8fff', depthTest: false, transparent: true, opacity: 0.9 }));
    this.hingeLine.visible = false;
    this.hingeLine.renderOrder = 5;
    this.hingeLine.userData.ui = true;
    this.shellGroup.add(this.hingeLine);
  }

  showHingeLine(h) {
    const m = this.hingeLine;
    if (!m) return;
    if (!h) { m.visible = false; return; }
    const a = h.e.a.clone().applyMatrix4(h.P.M), b = h.e.b.clone().applyMatrix4(h.P.M);
    const d = b.clone().sub(a);
    const len = d.length();
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len));
    const r = this.edgeLen * 0.014;
    m.scale.set(r, len * 1.5, r);
    m.material.color.set(h.color);
    m.visible = true;
  }

  // Hold a panel to fold it about a given hinge (quietly; the hover
  // preview already showed it).
  holdPanel(P, hinge) {
    const opts = this.shell.hingeOptions(P, this.state.openMode);
    this.sel.panel = P;
    this.sel.hinge = hinge && opts.some((o) => o.e === hinge && o.ok) ? hinge : this.defaultHinge(P);
    this.loopEdges.clear();
    this.refreshStyles();
    this.app.notify?.();
  }

  // ---------------------------------------------------------- inspection
  // Inspect turns the whole form freely to look at it. It is a view
  // transform between the table and the shell: the solids, panels, hinges,
  // fold angles and cuts are never touched, and it stays out of undo. The
  // form turns about its centre and keeps resting on the table.

  updatePivot() {
    const box = new THREE.Box3();
    for (const p of this.shell.panels) for (const v of p.verts) box.expandByPoint(v);
    if (box.isEmpty()) this.pivot.set(0, 0, 0); else box.getCenter(this.pivot);
  }

  isTurned() { return 1 - Math.abs(this.view.q.w) > 1e-9; }

  viewTurnDegrees() { return deg(2 * Math.acos(Math.min(1, Math.abs(this.view.q.w)))); }

  applyView() {
    const q = this.view.q, c = this.pivot;
    let lift = 0;
    if (this.isTurned()) {
      let minY = Infinity;
      const v = new THREE.Vector3();
      for (const p of this.shell.panels) for (const r of p.verts) { v.copy(r).applyMatrix4(p.M).sub(c).applyQuaternion(q); minY = Math.min(minY, v.y); }
      if (minY < Infinity) lift = -minY - c.y;
    }
    this.view.lift = lift;
    this.inspect.position.set(c.x, c.y + lift, c.z);
    this.inspect.quaternion.copy(q);
    this.shellGroup.position.set(-c.x, -c.y, -c.z);
    this.inspect.updateMatrix();
    this.shellGroup.updateMatrix();
  }

  // A rotation given in world space, as a turn of the view in the table's frame.
  localTurn(worldDelta) {
    this.root.updateWorldMatrix(true, false);
    const R = this.root.getWorldQuaternion(new THREE.Quaternion());
    return R.clone().invert().multiply(worldDelta).multiply(R);
  }

  // Live turn while dragging: q = delta · q0.
  turnView(worldDelta, q0) {
    this.view.target = null;
    this.view.q.copy(this.localTurn(worldDelta).multiply(q0)).normalize();
    this.applyView();
  }

  // Animated step: a quarter turn about the vertical, or a tip toward you.
  stepView(axis, degrees = 90) {
    let a = new THREE.Vector3(0, 1, 0);
    if (axis === 'tip') {
      const cam = this.app.renderer?.xr?.isPresenting ? null : this.app.camera;
      a = cam ? new THREE.Vector3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()));
      a.y = 0;
      if (a.lengthSq() < 1e-9) a.set(1, 0, 0);
      a.normalize();
    }
    const from = this.view.target || this.view.q;
    const dq = this.localTurn(new THREE.Quaternion().setFromAxisAngle(a, rad(degrees)));
    this.view.target = dq.multiply(from).normalize();
    this.app.notify?.();
  }

  resetOrientation(announce = true) {
    if (!this.isTurned() && !this.view.target) { if (announce) this.app.toast('Already in its resting orientation.'); return; }
    this.view.target = new THREE.Quaternion();
    if (announce) this.app.toast('Back to its resting orientation. Nothing about the shape changed.');
    this.app.notify?.();
  }

  // Bring the whole form into view (screen) or in front of you (VR).
  fitView() {
    if (this.app.renderer?.xr?.isPresenting) { this.app.actions.recenter(); this.app.toast('Placed in front of you.'); return; }
    this.app.fitCamera?.();
    this.app.toast('View fitted to the form.');
  }

  // Centre and radius (world) of everything shown, for Inspect grabs.
  formSphere() {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const p of this.shell.panels) for (const v of this.shell.worldPoly(p)) box.expandByPoint(v);
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    let r = 0;
    for (const p of this.shell.panels) for (const v of this.shell.worldPoly(p)) r = Math.max(r, v.distanceTo(c));
    return { centre: this.shellGroup.localToWorld(c), radius: r * 1.05 + this.edgeLen * 0.1 };
  }

  // ----------------------------------------------------------- selection

  hingeOptions() {
    return this.sel.panel ? this.shell.hingeOptions(this.sel.panel, this.state.openMode) : [];
  }

  // A sensible hinge for a panel: the one that leads toward the base, or
  // in One panel mode the lowest edge that still meets its neighbour.
  defaultHinge(P) {
    const opts = this.shell.hingeOptions(P, this.state.openMode).filter((o) => o.ok);
    if (!opts.length) return null;
    if (this.state.openMode === 'group') return opts[0].e;
    const hinged = opts.find((o) => o.e.type === 'hinge' && !this.shell.plan(P, o.e, 'group').error);
    if (hinged) return hinged.e;
    let best = null, by = Infinity;
    for (const o of opts) {
      const y = o.e.a.clone().add(o.e.b).multiplyScalar(0.5).applyMatrix4(P.M).y;
      if (y < by) { by = y; best = o.e; }
    }
    return best;
  }

  select(P) {
    this.sel.panel = P;
    this.sel.hinge = P ? this.defaultHinge(P) : null;
    this.loopEdges.clear();
    this.refreshStyles();
    this.app.haptic?.();
    if (P) {
      const opts = this.hingeOptions();
      if (!this.sel.hinge) {
        const why = opts.find((o) => o.reason)?.reason
          || (this.state.openMode === 'group' ? 'This panel has no hinge it can swing on. Try One panel, or make an edge a hinge.' : 'No edge can act as a hinge here.');
        this.app.toast(this.shell.isBase(P) ? 'This is the base panel; it stays in place. Pick another panel or set a new base.' : why);
      } else {
        const n = opts.filter((o) => o.ok).length;
        this.app.toast(n > 1
          ? `Panel selected. ${n} hinges available (bright green); tap one to choose it, then drag the panel or use the slider.`
          : 'Panel selected. Drag it to swing it on the yellow hinge, or use the slider.');
      }
    }
    this.app.notify?.();
  }

  chooseHinge(e) {
    const P = this.sel.panel;
    if (!P) return;
    const opt = this.hingeOptions().find((o) => o.e === e);
    if (!opt) { this.app.toast(this.state.openMode === 'group' ? 'That edge is cut. Switch to One panel to hinge on it, or use the Edges tool.' : 'That edge cannot be a hinge.'); return; }
    if (!opt.ok) {
      this.app.toast(opt.reason);
      const plan = this.shell.plan(P, e, this.state.openMode);
      if (plan.loop) { this.loopEdges = new Set(plan.loop); this.refreshStyles(); }
      return;
    }
    this.sel.hinge = e;
    this.loopEdges.clear();
    this.refreshStyles();
    this.app.toast('Hinge chosen. Drag the panel or use the slider to swing it.');
    this.app.notify?.();
  }

  setOpenMode(mode) {
    this.state.openMode = mode;
    if (this.sel.panel) this.sel.hinge = this.defaultHinge(this.sel.panel);
    this.refreshStyles();
    this.app.toast(mode === 'group'
      ? 'Group: the panel swings with every panel hinged beyond it.'
      : 'One panel: the panel keeps only the chosen hinge; its other edges are released.');
    this.app.notify?.();
  }

  setTool(t) {
    this.tools.finishAll();
    const prev = this.state.tool;
    this.state.tool = t;
    this.hoverPanel = this.hoverEdge = this.hoverHinge = null;
    this.inspectHover = false;
    if (t !== 'open') this.sel.panel = this.sel.hinge = null;
    if (t !== 'build') this.sel.solidId = this.sel.fi = null;
    if (t !== 'layout') this.sel.piece = null;
    this.loopEdges.clear();
    this.refreshStyles();
    const hints = {
      inspect: 'Drag the form to turn it and look at it from any side (on a screen, dragging empty space still moves the camera). In VR, grab it with one hand and turn your wrist, or with both hands. Nothing about the shape changes.',
      build: 'Tap a face to pick it, then Add. Drag a solid to move it; it snaps to a matching face.',
      open: 'Fold mode (panels stay rigid): touch or point near an edge to see the flap and its hinge, then pinch, pull the trigger or grip to hold it and lift. To move the whole form, grab the blue Move puck.',
      edges: 'Tap an edge to switch it between hinge (green) and cut (red, dashed).',
      layout: 'Flat layout: drag a piece to move it, turn it with ⟲ ⟳, tap a hinge to cut it apart, tap a cut whose sides meet to join it. Matching numbers mark edges that join.',
      shape: 'Shape: stretch the whole composition along its X (red), Y (green) and Z (blue) axes, or type its width, height and depth. Joined faces stay joined; fold angles and the net are worked out again. Single edges cannot be edited yet.',
    };
    let msg = hints[t];
    // Building and the flat layout work on the form resting on the table.
    if ((t === 'build' || t === 'layout' || t === 'shape') && (this.isTurned() || this.view.target)) {
      this.view.target = new THREE.Quaternion();
      if (t === 'build') msg = `Orientation reset so the solids rest on the table while you build. ${msg}`;
    }
    this.app.toast(msg, t === 'inspect' || t === 'layout' ? 6000 : undefined);
    if (t === 'layout' && prev !== 'layout' && !this.shell.flatReport().ok) this.layFlat({ intro: true });
    if (t === 'shape' && prev !== 'shape') {
      this.shapeEdit.enter();
      msg = this.shapeEdit.mode === 'resize'
        ? 'Shape: the net lies on the surface and the assembled form floats above it. Resize (panel sizes change, angles stay): tap a side or corner of the net to pin it, drag another. Edit vertices: move corners and edges of the floating form freely.'
        : 'Shape → Edit vertices: drag a corner or edge of the floating form; the net below is redrawn as you go. Tap to pin; Pin base pins the bottom. Faces stay flat unless you triangulate.';
      this.app.toast(msg, 8000);
      this.frameView();
    }
    if (t !== 'shape') this.shapeEdit.exit();
    this.updateAxes();
    this.updateLift();
    this.app.notify?.();
  }

  // Current plan for the selected panel and hinge.
  plan() {
    const P = this.sel.panel, e = this.sel.hinge;
    if (!P) return { error: 'Select a panel first.' };
    if (!e) return { error: 'This panel has no usable hinge.' };
    return this.shell.plan(P, e, this.state.openMode);
  }

  selectedAngle() {
    const P = this.sel.panel, e = this.sel.hinge;
    if (!P || !e || !e.shared) return null;
    return deg(this.shell.angle(e, P, this.shell.other(e, P)));
  }

  selectedFlatAngle() {
    const P = this.sel.panel, e = this.sel.hinge;
    if (!P || !e || !e.shared) return null;
    return deg(this.shell.flatAngle(e, P, this.shell.other(e, P)));
  }

  // Prepare to turn the selected panel: records undo, isolates the panel in
  // One panel mode. Returns the plan or null.
  beginTurn() {
    const plan = this.plan();
    if (plan.error) {
      this.app.toast(plan.error);
      if (plan.loop) { this.loopEdges = new Set(plan.loop); this.refreshStyles(); }
      return null;
    }
    this.pushHistory();
    if (plan.mode === 'one') this.shell.isolate(plan.P, plan.e);
    this.moving = new Set(plan.moving);
    this.refreshStyles();
    return plan;
  }

  endTurn(plan, snap = true) {
    if (snap) {
      const a = this.shell.angle(plan.e, plan.P, plan.Q);
      const flat = this.shell.flatAngle(plan.e, plan.P, plan.Q);
      if (Math.abs(a - flat) < rad(7)) this.shell.setAngle(plan, flat);
      else if (Math.abs(a) < rad(7)) this.shell.setAngle(plan, 0);
    }
    this.moving.clear();
    this.updateMatrices();
    this.afterMotion();
  }

  afterMotion(announce = true) {
    this.checkOverlaps();
    this.refreshStyles();
    if (announce) {
      const a = this.selectedAngle();
      const flat = this.selectedFlatAngle();
      let msg = a === null ? '' : `Hinge at ${Math.round(a)}°${flat !== null && Math.abs(a - flat) < 0.5 ? ' (flat)' : Math.abs(a) < 0.5 ? ' (closed)' : ''}.`;
      if (this.overlapPairs) msg += ` ${this.overlapPairs} panel pair${this.overlapPairs > 1 ? 's' : ''} intersect (red).`;
      if (msg) this.app.toast(msg.trim());
    }
    this.app.notify?.();
  }

  // Slider: live angle in degrees; commit on release.
  setAngle(degrees, commit) {
    if (!this.sliderPlan) {
      this.sliderPlan = this.beginTurn();
      if (!this.sliderPlan) return;
    }
    this.shell.setAngle(this.sliderPlan, rad(degrees));
    this.updateMatrices();
    this.checkOverlaps();
    this.refreshMaterials();
    if (commit) {
      const p = this.sliderPlan;
      this.sliderPlan = null;
      this.endTurn(p, false);
    }
  }

  // Animate the selected hinge to an absolute angle (radians).
  turnTo(target) {
    this.stopAnim();
    const plan = this.beginTurn();
    if (!plan) return;
    const from = this.shell.angle(plan.e, plan.P, plan.Q);
    this.anim = { kind: 'hinge', plan, from, to: target, t: 0, dur: 0.45 };
  }

  turnBy(delta) {
    const a = this.selectedAngle();
    if (a === null) { this.app.toast('Select a panel with a hinge first.'); return; }
    this.turnTo(rad(a) + delta);
  }

  openFlat() {
    const flat = this.selectedFlatAngle();
    if (flat === null) { this.app.toast('Select a panel with a hinge first.'); return; }
    this.turnTo(rad(flat));
  }

  close() { if (this.selectedAngle() === null) this.app.toast('Select a panel with a hinge first.'); else this.turnTo(0); }

  setBase() {
    const P = this.sel.panel;
    if (!P) { this.app.toast('Select the panel that should stay on the table.'); return; }
    if (!this.shell.isClosed()) { this.app.toast('Refold all before choosing a new base.'); return; }
    this.pushHistory();
    this.shell.setBase(P);
    this.sel.hinge = this.defaultHinge(P);
    this.refreshStyles();
    this.app.toast('Base set. This panel stays put while the others swing.');
    this.app.notify?.();
  }

  // --------------------------------------------------- whole-net motion

  unfoldAll() {
    this.tools.finishAll();
    this.stopAnim();
    const F = this.shell.forest();
    if (F.loops.length) {
      const P = F.loops[0].uses[0].panel;
      this.loopEdges = new Set(this.shell.loopEdges(P, this.shell.other(F.loops[0], P), F.loops[0]));
      this.refreshStyles();
      this.app.toast(`The hinges form ${F.loops.length} closed loop${F.loops.length > 1 ? 's' : ''} (orange), so this layout cannot unfold. Cut an orange edge with the Edges tool.`);
      return;
    }
    this.pushHistory();
    if (this.isTurned()) this.view.target = new THREE.Quaternion();
    const to = this.shell.flatAngles(F);
    this.anim = { kind: 'forest', F, from: this.shell.forestAngles(F), to, roots: this.centredRoots(F, to), t: 0, dur: 1.2, label: 'unfold' };
  }

  // Root moves that slide the flat layout to the middle of the mat, so a
  // long net does not hang off the table. Refold slides it back.
  centredRoots(F, angles) {
    const saved = this.shell.panels.map((p) => p.M.clone());
    this.shell.applyForest(F, angles, null);
    const box = new THREE.Box3();
    for (const p of this.shell.panels) for (const v of this.shell.worldPoly(p)) box.expandByPoint(v);
    this.shell.panels.forEach((p, i) => p.M.copy(saved[i]));
    const c = box.getCenter(new THREE.Vector3());
    if (box.isEmpty() || Math.hypot(c.x, c.z) < 0.01) return null;
    const T = new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z);
    return new Map(F.roots.map((r) => [r, { from: r.M.clone(), to: T.clone().multiply(r.M) }]));
  }

  refoldAll() {
    this.tools.finishAll();
    this.stopAnim();
    if (this.shell.isClosed()) { this.app.toast('Already closed.'); return; }
    this.pushHistory();
    const F = this.shell.forest();
    const to = new Map([...F.parent.keys()].map((p) => [p, 0]));
    const roots = new Map(F.roots.map((r) => [r, { from: r.M.clone(), to: new THREE.Matrix4() }]));
    this.anim = { kind: 'forest', F, from: this.shell.forestAngles(F), to, roots, t: 0, dur: 1.2, label: 'refold' };
  }

  resetLayout() {
    this.tools.finishAll();
    this.stopAnim();
    this.pushHistory();
    for (const p of this.shell.panels) p.M.identity();
    this.shell.chooseBases();
    const r = this.shell.defaultNet();
    this.sel.panel = this.sel.hinge = null;
    this.loopEdges.clear();
    this.updateMatrices();
    this.checkOverlaps();
    this.refreshStyles();
    this.app.toast(`Closed, with the default cuts and hinges. ${this.netSentence()}`, 5000);
    this.app.notify?.();
  }

  stopAnim() {
    if (!this.anim) return;
    const a = this.anim;
    this.anim = null;
    this.stepAnim(a, 1);
    this.finishAnim(a);
  }

  stepAnim(a, t) {
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    if (a.kind === 'poses') {
      for (const [p, from, to] of a.items) p.M.copy(t >= 1 ? to : lerpMatrix(from, to, e));
    } else if (a.kind === 'hinge') {
      this.shell.setAngle(a.plan, a.from + (a.to - a.from) * e);
    } else {
      const ang = new Map();
      for (const [p, v] of a.from) ang.set(p, v + (a.to.get(p) - v) * e);
      let rootMs = null;
      if (a.roots) {
        rootMs = new Map();
        for (const [r, { from, to }] of a.roots) rootMs.set(r, lerpMatrix(from, to, e));
      }
      this.shell.applyForest(a.F, ang, rootMs);
    }
    this.updateMatrices();
    if (this.shapeEdit && this.shapeEdit.active) this.shapeEdit.refresh();
  }

  finishAnim(a) {
    if (a.kind === 'hinge') { this.endTurn(a.plan, false); return; }
    if (a.label === 'refold') for (const p of this.shell.panels) p.M.identity();
    this.updateMatrices();
    this.afterMotion(false);
    if (a.label === 'layflat') { this.frameView(true); this.reportLayout(a.prefix || 'Laid on the surface.'); return; }
    if (a.label === 'piece') { this.reportLayout(a.prefix || 'Piece moved.'); return; }
    if (a.label === 'unfold') {
      // Report what actually happened, and never call an overlapping layout a net.
      const net = this.shell.classify(this.shell.net && this.shell.net.searched);
      const n = this.overlapPairs;
      let msg;
      if (n) {
        msg = `Unfolded flat, but ${n} panel pair${n > 1 ? 's' : ''} overlap (red): this is not a valid net.`;
        msg += net.status === 'unresolved'
          ? ' The net search did not find an overlap-free layout for this composition. Try Find net again, or change cuts and hinges with the Edges tool.'
          : ' Find net searches for an overlap-free layout; the Edges tool lets you change cuts and hinges.';
      } else if (net.status === 'split') {
        msg = `Unfolded flat into ${net.pieces} separate pieces without overlaps (not a single net).`;
      } else {
        msg = `Unfolded into a verified net: ${this.shell.panels.length} panels, flat, no overlaps.`;
      }
      this.frameView(true);
      this.app.toast(msg, 6000);
      this.app.notify?.();
    } else {
      this.app.toast(`Refolded: ${this.describe()}.`);
    }
  }

  update(dt) {
    if (this.flash && performance.now() > this.flash.until) { this.flash = null; this.refreshMaterials(); }
    if (this.lift && ++this.liftTick % 6 === 0) this.updateLift();
    if (this.view.target) {
      this.view.q.slerp(this.view.target, 1 - Math.exp(-dt * 9));
      if (this.view.q.angleTo(this.view.target) < 2e-3) { this.view.q.copy(this.view.target); this.view.target = null; this.app.notify?.(); }
      this.applyView();
    }
    const a = this.anim;
    if (a) {
      a.t = Math.min(1, a.t + dt / a.dur);
      this.stepAnim(a, a.t);
      if (a.t >= 1) {
        this.anim = null;
        this.finishAnim(a);
      } else if (a.kind === 'hinge') {
        this.app.solidsUI?.syncSolidAngle();
      }
    }
  }

  // --------------------------------------------------------- flat layout
  // The net lies on the work surface as one or more pieces. A piece is a
  // hinge-connected group of panels, so it is rigid and coplanar; pieces
  // move and turn only as wholes, which keeps every panel's size and every
  // edge's number. Refold all returns to the assembled form from any layout.

  // Lay every piece flat (outside down) on the surface. Pieces that already
  // lie flat stay put unless arrange is set; the others are placed clear.
  layFlat({ arrange = false, record = true, prefix = null, intro = false } = {}) {
    this.tools.finishAll();
    this.stopAnim();
    const F = this.shell.forest();
    if (F.loops.length) {
      const P = F.loops[0].uses[0].panel;
      this.loopEdges = new Set(this.shell.loopEdges(P, this.shell.other(F.loops[0], P), F.loops[0]));
      this.refreshStyles();
      this.app.toast(`The hinges form ${F.loops.length} closed loop${F.loops.length > 1 ? 's' : ''} (orange), so the net cannot lie flat. Cut an orange edge first.`);
      return false;
    }
    if (this.isTurned()) this.view.target = new THREE.Quaternion();
    const t = flatTargets(this.shell, { keepFlat: !arrange });
    if (!t.moved && !arrange) { this.reportLayout(prefix || 'Already lying flat.'); return true; }
    if (record) this.pushHistory();
    const roots = new Map([...t.roots].map(([r, M]) => [r, { from: r.M.clone(), to: M }]));
    this.anim = { kind: 'forest', F: t.F, from: this.shell.forestAngles(t.F), to: t.angles, roots, t: 0, dur: intro ? 1.2 : 0.9, label: 'layflat', prefix: prefix || (arrange ? 'Pieces arranged.' : 'Laid on the surface.') };
    return true;
  }

  arrangePieces() { this.layFlat({ arrange: true, prefix: 'Pieces arranged side by side.' }); }

  // Flatness and overlaps of the current layout, in words.
  layoutText() {
    const fr = this.shell.flatReport();
    const ov = this.shell.overlapReport();
    const parts = [`${fr.pieces} piece${fr.pieces > 1 ? 's' : ''}`];
    parts.push(fr.ok ? 'every panel flat on the surface' : 'not lying flat');
    if (ov.within) parts.push(`${ov.within} overlap${ov.within > 1 ? 's' : ''} within a piece`);
    if (ov.between) parts.push(`${ov.between} overlap${ov.between > 1 ? 's' : ''} between pieces`);
    if (!ov.within && !ov.between && fr.ok) parts.push('no overlaps');
    return { text: parts.join(' · '), fr, ov };
  }

  reportLayout(prefix = '') {
    const { fr, ov } = this.layoutText();
    let msg = prefix ? `${prefix} ` : '';
    if (fr.ok) msg += `${fr.pieces} piece${fr.pieces > 1 ? 's' : ''}, ${fr.panels} panels: every panel lies in the surface plane (checked to 1 µm; largest gap ${(fr.maxDev * 1e6).toFixed(3)} µm).`;
    else msg += `Not lying flat yet${fr.tilted ? ` (${fr.tilted} panel${fr.tilted > 1 ? 's' : ''} tilted)` : ''}. Press Lay net on surface.`;
    if (ov.within) msg += ` ${ov.within} panel pair${ov.within > 1 ? 's' : ''} overlap inside a piece (red), so that piece is not a valid net. Press Other nets to look for an overlap-free arrangement first; cutting a hinge to split the piece is the fallback.`;
    if (ov.between) msg += ` ${ov.between} pair${ov.between > 1 ? 's' : ''} overlap between pieces: drag them apart or press Arrange pieces.`;
    if (fr.ok && !ov.within && !ov.between) msg += ' No overlaps within or between pieces.';
    this.app.toast(msg.trim(), 7000);
    this.app.notify?.();
  }

  pieceOf(P) { return this.shell.hingePieces().find((pc) => pc.includes(P)) || [P]; }

  selectPiece(P) {
    const piece = this.pieceOf(P);
    this.sel.piece = new Set(piece);
    this.refreshStyles();
    this.app.haptic?.();
    this.app.toast(`Piece of ${piece.length} panel${piece.length > 1 ? 's' : ''} selected. Drag it to move it, ⟲ ⟳ to turn it, or tap an edge to cut or join.`);
    this.app.notify?.();
  }

  // Animate panels to new matrices.
  animatePoses(items, label, prefix, dur = 0.35) {
    this.stopAnim();
    this.anim = { kind: 'poses', items, t: 0, dur, label, prefix };
  }

  rotatePiece(degrees) {
    this.tools.finishAll();
    this.stopAnim();
    let piece = this.sel.piece ? [...this.sel.piece] : null;
    if (!piece) {
      const all = this.shell.hingePieces();
      if (all.length === 1) piece = all[0];
      else { this.app.toast('Tap a piece first, then turn it.'); return; }
    }
    if (!this.shell.flatReport().ok) { this.app.toast('Lay the net on the surface first, then turn its pieces.'); return; }
    this.pushHistory();
    const m = planarMove(0, 0, rad(degrees), pieceCentre(this.shell, piece));
    this.animatePoses(piece.map((p) => [p, p.M.clone(), m.clone().multiply(p.M)]), 'piece', `Piece turned ${degrees > 0 ? '⟲' : '⟳'} ${Math.abs(degrees)}°.`);
  }

  // Tap on an edge in the flat layout: cut a hinge (and separate the two
  // pieces), or join a cut whose two sides meet.
  layoutEdge(e, P) {
    if (!e.shared || e.locked) { this.app.toast(`Edge ${e.no} joins more than two panels, so it stays cut.`); return; }
    const Q = this.shell.other(e, P);
    if (e.type === 'hinge') { this.cutHinge(e, P, Q); return; }
    if (!this.shell.intact(e)) {
      const rootOf = this.shell.pieceRoots();
      const where = rootOf.get(P) === rootOf.get(Q) ? 'elsewhere on this piece' : 'on another piece';
      this.app.toast(`Edge ${e.no} is cut. Its matching edge, also labelled ${e.no}, is ${where}. Drag a piece so the two ${e.no} edges meet (they snap), then tap to join.`, 6000);
      return;
    }
    const rootOf = this.shell.pieceRoots();
    if (rootOf.get(P) === rootOf.get(Q)) { this.app.toast(`Joining edge ${e.no} would close a loop of hinges inside this piece, so it stays cut.`); return; }
    this.pushHistory();
    e.type = 'hinge';
    this.shell.classify();
    this.netCycle = null;
    this.sel.piece = null;
    this.refreshStyles();
    this.reportLayout(`Joined at edge ${e.no}.`);
  }

  cutHinge(e, P, Q) {
    this.tools.finishAll();
    this.stopAnim();
    this.pushHistory();
    e.type = 'cut';
    this.shell.classify();
    this.netCycle = null;
    const pieces = this.shell.hingePieces();
    this.sel.piece = null;
    this.refreshStyles();
    if (!this.shell.flatReport().ok) {
      this.app.toast(`Cut edge ${e.no}. Lay the net on the surface to separate the pieces.`);
      this.app.notify?.();
      return;
    }
    // Slide the smaller piece straight away from the cut so the split shows.
    const a = pieces.find((pc) => pc.includes(P)), b = pieces.find((pc) => pc.includes(Q));
    const mover = a.length <= b.length ? a : b;
    const mid = e.a.clone().add(e.b).multiplyScalar(0.5).applyMatrix4(P.M);
    const dir = pieceCentre(this.shell, mover).sub(mid);
    dir.y = 0;
    if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
    dir.normalize().multiplyScalar(this.edgeLen * 0.35);
    const m = new THREE.Matrix4().makeTranslation(dir.x, 0, dir.z);
    this.animatePoses(mover.map((p) => [p, p.M.clone(), m.clone().multiply(p.M)]), 'piece', `Cut edge ${e.no}: now ${pieces.length} pieces. The two edges labelled ${e.no} are the ones that join.`);
  }

  // Cycle through different verified nets (alternatives to splitting).
  otherNets() {
    this.tools.finishAll();
    this.stopAnim();
    const keyOf = (h) => [...h].map((e) => e.no).sort((x, y) => x - y).join(',');
    if (!this.netCycle) {
      const r = this.shell.findNets(8, 1500);
      this.netCycle = { nets: r.nets, i: -1, tries: r.tries, ms: r.ms };
    }
    const c = this.netCycle;
    if (!c.nets.length) {
      this.app.toast(`The search tried ${c.tries} cut layouts in ${(c.ms / 1000).toFixed(1)} s and found no overlap-free single net for this composition. That does not prove none exists. You can split the net instead: tap a hinge to cut it, then move the pieces apart.`, 8000);
      return;
    }
    const cur = keyOf(this.shell.hingeSet());
    let next = (c.i + 1) % c.nets.length;
    if (c.nets.length > 1 && keyOf(c.nets[next]) === cur) next = (next + 1) % c.nets.length;
    c.i = next;
    this.pushHistory();
    for (const p of this.shell.panels) p.M.identity();
    this.shell.setLayout(c.nets[c.i]);
    this.shell.classify();
    this.sel.piece = null;
    this.updateMatrices();
    this.refreshStyles();
    const many = c.nets.length >= 8 ? 'the search stopped at 8; there are more' : `the search found ${c.nets.length} in ${c.tries} layouts tried; there may be others`;
    this.layFlat({ arrange: true, record: false, prefix: `Net ${c.i + 1} of ${c.nets.length} overlap-free nets (${many}). Undo brings back your previous cuts.` });
  }

  toggleLabels() {
    this.state.showLabels = !this.state.showLabels;
    this.refreshStyles();
    this.app.toast(this.state.showLabels ? 'Edge numbers shown: the same number marks the two edges that join.' : 'Edge numbers hidden.');
    this.app.notify?.();
  }

  toggleIds() {
    this.state.showIds = !this.state.showIds;
    this.refreshStyles();
    this.app.toast(this.state.showIds ? 'Panel numbers shown.' : 'Panel numbers hidden.');
    this.app.notify?.();
  }

  // ------------------------------------------------------------- edges

  toggleEdge(e) {
    if (!e.shared || e.locked) { this.app.toast('More than two panels meet at this edge, so it stays cut.'); return; }
    if (e.type === 'cut' && !this.shell.intact(e)) { this.app.toast('These panels are apart. Refold them before joining this edge with a hinge.'); return; }
    this.pushHistory();
    e.type = e.type === 'hinge' ? 'cut' : 'hinge';
    this.netCycle = null;
    this.loopEdges.clear();
    // Re-check the layout straight away so its status is always current.
    this.shell.classify();
    const msg = `${e.type === 'hinge' ? 'Edge is now a hinge.' : 'Edge is now a cut.'} ${this.netSentence()}`;
    this.refreshStyles();
    this.app.toast(msg, 4500);
    this.app.notify?.();
  }

  checkNet() {
    this.shell.classify(this.shell.net && this.shell.net.searched);
    this.app.toast(this.netSentence(), 5000);
    this.app.notify?.();
  }

  // Search for an overlap-free net (closes the shell first).
  defaultNet() {
    this.tools.finishAll();
    this.stopAnim();
    this.pushHistory();
    for (const p of this.shell.panels) p.M.identity();
    const r = this.shell.defaultNet(1500);
    this.updateMatrices();
    this.checkOverlaps();
    this.refreshStyles();
    this.app.toast(r.ok ? `Found a verified net (shell closed). ${this.netSentence()}` : this.netSentence(), 5000);
    this.app.notify?.();
  }

  // ------------------------------------------------------------- build

  requireClosed() {
    if (this.comp.isEdited()) {
      this.app.toast('This form has free-form edits. Building works on the regular solids: press Reset edits (Shape → Edit) to add, move, turn or remove solids.', 5000);
      return false;
    }
    if (this.comp.isShaped()) {
      this.app.toast('This composition has a changed shape. Building works on the regular solids: press Reset shape (Shape tool) to add, move, turn or remove solids.', 5000);
      return false;
    }
    if (this.shell.isClosed()) return true;
    this.app.toast('Refold all before changing the solids.');
    return false;
  }

  // ------------------------------------------------------------- shape
  // Controlled shape change: stretch the whole composition along its own
  // X (width), Y (height) and Z (depth) axes. Shared vertices and joined
  // faces stay shared and joined, internal faces stay removed, every panel
  // stays planar, and the fold angles and net are worked out again from the
  // new closed form. Panels stay rigid when folding. Editing single edges
  // needs constraint rules that are not designed yet, so it is not offered.

  // Width, height and depth of the closed form (metres).
  shapeSize(shape = this.comp.shape) {
    const box = new THREE.Box3();
    for (const f of this.comp.shapedFaces(shape)) for (const v of f.verts) box.expandByPoint(v);
    return box.getSize(new THREE.Vector3());
  }

  // Why a shape would be invalid or degenerate, or null.
  shapeProblem(shape) {
    const [lo, hi] = SHAPE_LIMITS.factor;
    for (const k of ['x', 'y', 'z']) {
      const v = shape[k];
      if (!Number.isFinite(v) || v <= 0) return 'Each size must be a positive number.';
    }
    const faces = this.comp.shapedFaces(shape);
    let minEdge = Infinity, minAngle = 180, minArea = Infinity;
    const box = new THREE.Box3();
    for (const f of faces) {
      const n = f.verts.length;
      let area = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const a = f.verts[i], b = f.verts[(i + 1) % n], c = f.verts[(i + 2) % n];
        box.expandByPoint(a);
        minEdge = Math.min(minEdge, a.distanceTo(b));
        const u = a.clone().sub(b).normalize(), w = c.clone().sub(b).normalize();
        minAngle = Math.min(minAngle, deg(Math.acos(THREE.MathUtils.clamp(u.dot(w), -1, 1))));
        area.add(new THREE.Vector3().crossVectors(a, b));
      }
      minArea = Math.min(minArea, area.length() / 2);
    }
    const size = box.getSize(new THREE.Vector3());
    if (minEdge < SHAPE_LIMITS.minEdge) return `That would make an edge ${(minEdge * 1000).toFixed(1)} mm long; edges must be at least ${SHAPE_LIMITS.minEdge * 1000} mm.`;
    if (Math.max(size.x, size.y, size.z) > SHAPE_LIMITS.maxSize) return `That would make the form ${(Math.max(size.x, size.y, size.z) * 1000).toFixed(0)} mm across; it must fit within ${SHAPE_LIMITS.maxSize * 1000} mm.`;
    if (minAngle < SHAPE_LIMITS.minAngle) return `That would squash a face corner to ${minAngle.toFixed(1)}°; corners must stay above ${SHAPE_LIMITS.minAngle}°.`;
    if (minArea < 1e-6) return 'That would flatten a face to almost nothing.';
    for (const k of ['x', 'y', 'z']) {
      const v = shape[k];
      if (v < lo - 1e-9 || v > hi + 1e-9) return `Stretch along ${k.toUpperCase()} must stay between ${lo}× and ${hi}× the regular size.`;
    }
    return null;
  }

  // "fold angles 90° (all 12)" or "fold angles 54.7° to 125.3° (5 values)"
  foldText() {
    const g = this.shell.foldAngles().filter(([a]) => Math.abs(a - 180) > 0.05);
    if (!g.length) return 'no folds';
    const n = g.reduce((s, [, c]) => s + c, 0);
    if (g.length === 1) return `every fold ${g[0][0]}° (${n} edges)`;
    if (g.length <= 4) return `folds ${g.map(([a, c]) => `${a}° ×${c}`).join(', ')}`;
    return `folds from ${g[0][0]}° to ${g[g.length - 1][0]}° (${g.length} different angles over ${n} edges)`;
  }

  sizeText(size = this.shapeSize()) {
    return `${(size.x * 1000).toFixed(1)} × ${(size.y * 1000).toFixed(1)} × ${(size.z * 1000).toFixed(1)} mm (width × height × depth)`;
  }

  setShape(shape, label = 'Shape changed') {
    this.tools.finishAll();
    this.stopAnim();
    if (this.comp.isEdited()) { this.app.toast('This form has free-form edits. Sizes apply to the unedited form: Reset edits first (Shape → Edit).', 5000); return false; }
    if (this.shapeEdit.active && this.shell.flatReport().ok) {
      const problem = this.shapeProblem(shape);
      if (problem) { this.app.toast(`${problem} The shape was not changed.`, 5000); this.app.notify?.(); return false; }
      this.pushHistory();
      const layout = captureLayout(this.shell);
      const base = this.shell.panels.find((p) => this.shell.isBase(p)) || this.shell.panels[0];
      const anchor = this.shapeEdit.pin || { kind: 'corner', pid: base.id, i: 0 };
      const A0 = elPos(this.shell, anchor);
      this.comp.shape.copy(shape);
      this.reshapeNet(layout, anchor, A0);
      this.app.toast(`${label}: ${this.sizeText()}. Net and assembled preview updated; ${this.foldText()}. ${this.netSentence()}`, 6000);
      return true;
    }
    if (!this.shell.isClosed()) { this.app.toast('Refold all before changing the shape; the new fold angles and net come from the closed form.'); return false; }
    const problem = this.shapeProblem(shape);
    if (problem) { this.app.toast(`${problem} The shape was not changed.`, 5000); this.app.notify?.(); return false; }
    const removedBefore = this.shell.internal.length * 2;
    this.pushHistory();
    this.comp.shape.copy(shape);
    this.rebuild();
    const removed = this.shell.internal.length * 2;
    const planar = this.shell.planarity();
    const kept = removed === removedBefore
      ? (removed ? `the ${removed} joined internal faces are still removed` : 'no joined faces')
      : `internal faces ${removedBefore} → ${removed}`;
    this.app.toast(`${label}: ${this.sizeText()}. ${kept}; ${this.foldText()}; ${planar < 1e-9 ? 'every panel planar (checked)' : `panels out of plane by up to ${(planar * 1e6).toFixed(3)} µm`}. ${this.netSentence()}`, 7000);
    this.updateAxes();
    return true;
  }

  // Set width / height / depth in millimetres (any can be omitted).
  setSizeMM(mm) {
    const cur = this.shapeSize();
    const s = this.comp.shape.clone();
    for (const k of ['x', 'y', 'z']) {
      if (mm[k] == null || mm[k] === '') continue;
      const want = Number(mm[k]) / 1000;
      if (!Number.isFinite(want) || want <= 0) { this.app.toast('Sizes must be positive numbers in millimetres.'); return false; }
      s[k] *= want / cur[k];
    }
    return this.setShape(s, 'Resized');
  }

  stretchBy(axis, factor) {
    const s = this.comp.shape.clone();
    s[axis] *= factor;
    return this.setShape(s, `Stretched along ${axis.toUpperCase()}`);
  }

  resetShape() {
    if (!this.comp.isShaped()) { this.app.toast('The solids are already regular.'); return; }
    this.setShape(new THREE.Vector3(1, 1, 1), 'Back to the regular solids');
  }

  // Arrows for the object axes, shown in the Shape tool.
  updateAxes() {
    const show = this.state.tool === 'shape' && !this.shapeEdit.active;
    if (!show) { if (this.axes) this.axes.visible = false; return; }
    if (!this.axes) {
      this.axes = new THREE.Group();
      this.axes.userData.ui = true;
      for (const [dir, color] of [[[1, 0, 0], '#e0452b'], [[0, 1, 0], '#2fa35a'], [[0, 0, 1], '#3a78e0']]) {
        const a = new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(), 0.07, color, 0.018, 0.011);
        this.axes.add(a);
      }
      this.shellGroup.add(this.axes);
    }
    const box = new THREE.Box3();
    for (const p of this.shell.panels) for (const v of p.verts) box.expandByPoint(v);
    this.axes.position.set(box.min.x - 0.02, 0.001, box.max.z + 0.02);
    this.axes.visible = true;
  }

  selectFace(p) {
    this.sel.solidId = p ? p.solidId : null;
    this.sel.fi = p ? p.fi : null;
    this.refreshStyles();
    if (p) {
      const shape = p.verts.length === 3 ? 'triangle' : 'square';
      const fits = SOLID_TYPES.filter((t) => template(t).faces.some((f) => f.sides === p.verts.length)).map((t) => TEMPLATES[t].name.toLowerCase());
      this.app.toast(`${shape[0].toUpperCase() + shape.slice(1)} face picked. It fits a ${fits.join(' or ')}; pick the type and press Add.`);
    }
    this.app.notify?.();
  }

  setAddType(t) {
    this.state.addType = t;
    this.app.toast(`Add puts a ${TEMPLATES[t].name.toLowerCase()} on the picked face.`);
    this.app.notify?.();
  }

  get addType() { return this.state.addType || 'cube'; }

  // Add a solid of the chosen type against the picked face.
  addSolid(type = this.addType) {
    if (!this.requireClosed()) return;
    const name = TEMPLATES[type].name.toLowerCase();
    let target = this.comp.get(this.sel.solidId);
    let fi = this.sel.fi;
    if (!target) {
      // No face picked: the first free face of the newest solid that fits.
      target = this.comp.solids[this.comp.solids.length - 1];
      const faces = target.worldFaces().map((f, i) => [f, i]).sort((a, b) => Math.abs(a[0].normal.y) - Math.abs(b[0].normal.y));
      const hit = faces.find(([, i]) => { const pr = this.probeAttach(target, i, type); return pr && !pr.problem; });
      if (!hit) { this.app.toast(`No free face here fits a ${name}. Pick a face first.`); return; }
      fi = hit[1];
    }
    const probe = this.probeAttach(target, fi, type);
    if (!probe) {
      const sides = target.worldFaces()[fi].sides;
      this.app.toast(`A ${name} has no ${sides === 3 ? 'triangle' : 'square'} face to match this one. Choose a solid that does.`);
      return;
    }
    if (probe.problem) {
      this.flashSolid(probe.problem.solid && probe.problem.solid.id);
      this.app.toast(`${probe.problem.kind === 'overlap' ? `A ${name} there would overlap the solid shown in red.` : probe.problem.message} It was not added.`, 4500);
      return;
    }
    this.pushHistory();
    const s = this.comp.add(type, EDGE, probe.pose.position, probe.pose.quaternion);
    this.rebuild();
    const p = this.shell.panels.find((q) => q.solidId === s.id);
    if (p) this.selectFace(p);
    const jt = this.jointText();
    this.app.toast(`${TEMPLATES[type].name} added. ${this.describe()}.${jt ? ` Joints: ${jt}.` : ''} ${this.netSentence()}`, 6000);
  }

  addCube() { this.addSolid('cube'); }

  // Pose for a solid placed on face fi of a target, and whether it is valid.
  probeAttach(target, fi, type = 'cube') {
    const tf = target.worldFaces()[fi];
    const tm = template(type);
    // Prefer the neighbour's orientation, so face numbering stays consistent.
    let best = null;
    for (let f = 0; f < tm.faces.length; f++) {
      if (tm.faces[f].sides !== tf.sides) continue;
      for (let j = 0; j < tf.verts.length; j++) {
        const pose = alignFace(tm, f, EDGE, tf, j);
        if (!pose) continue;
        const ang = pose.quaternion.angleTo(target.quaternion);
        if (!best || ang < best.ang) best = { pose, ang };
      }
    }
    if (!best) return null;
    return { pose: best.pose, problem: this.comp.placementProblem(type, EDGE, best.pose.position, best.pose.quaternion) };
  }

  duplicate() {
    const s = this.comp.get(this.sel.solidId);
    if (!s) { this.app.toast('Tap a face of the solid to duplicate; the copy goes against that face.'); return; }
    this.addSolid(s.type);
  }

  removeSolid() {
    if (!this.requireClosed()) return;
    const s = this.comp.get(this.sel.solidId);
    if (!s) { this.app.toast('Tap a face of the solid you want to remove.'); return; }
    if (this.comp.solids.length === 1) { this.app.toast('Keep at least one solid.'); return; }
    this.pushHistory();
    this.comp.remove(s.id);
    this.rebuild();
    this.app.toast(`${TEMPLATES[s.type].name} removed. ${this.describe()}. ${this.netSentence()}`, 5000);
  }

  // Turn the whole composition: 'y' a quarter turn about the vertical, or
  // 'x' tip it over onto the next outer face it can rest flat on (a face of
  // its convex hull), whatever the solids are.
  turnAll(axis) {
    if (!this.requireClosed()) return;
    const verts = this.comp.solids.flatMap((s) => s.worldVerts());
    const box = new THREE.Box3().setFromPoints(verts);
    const c = box.getCenter(new THREE.Vector3());
    let q;
    if (axis === 'y') q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    else {
      const tol = this.edgeLen * 1e-4;
      const onHull = (p) => verts.every((v) => v.clone().sub(p.verts[0]).dot(p.normal) <= tol);
      const down = new THREE.Vector3(0, -1, 0);
      const cands = this.shell.panels.filter((p) => p.normal.dot(down) < 0.999 && onHull(p));
      if (!cands.length) { this.app.toast('There is no other face this composition can rest on.'); return; }
      // The smallest tip: the hull face whose normal is closest to straight down.
      cands.sort((a, b) => b.normal.dot(down) - a.normal.dot(down));
      q = new THREE.Quaternion().setFromUnitVectors(cands[0].normal.clone(), down);
    }
    this.pushHistory();
    for (const s of this.comp.solids) {
      s.position.sub(c).applyQuaternion(q).add(c);
      s.quaternion.premultiply(q).normalize();
      roundPose(s);
    }
    this.centre();
    this.rebuild();
    this.app.toast(`${axis === 'y' ? 'Turned a quarter turn.' : 'Tipped over onto another face.'} ${this.netSentence()}`);
  }

  // Rotate the picked solid in place about the vertical axis, by its own
  // symmetry step (90° for a square base, 120° for a triangle), if the new
  // pose is still valid.
  rotateSolid() {
    if (!this.requireClosed()) return;
    const s = this.comp.get(this.sel.solidId);
    if (!s) { this.app.toast('Tap a face of the solid you want to rotate.'); return; }
    const faces = s.worldFaces();
    const bottom = faces.reduce((b, f) => (f.normal.y < b.normal.y ? f : b), faces[0]);
    const step = (2 * Math.PI) / bottom.sides;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), step);
    const c = s.worldVerts().reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(s.template.verts.length);
    const pos = s.position.clone().sub(c).applyQuaternion(q).add(c);
    const quat = s.quaternion.clone().premultiply(q);
    const problem = this.comp.placementProblem(s.type, s.edge, pos, quat, s.id);
    if (problem) { this.app.toast(`Rotating it would collide: ${problem.message}`); return; }
    this.pushHistory();
    s.position.copy(pos);
    s.quaternion.copy(quat);
    roundPose(s);
    this.rebuild();
    this.app.toast(`${TEMPLATES[s.type].name} turned ${Math.round(deg(step))}° in place. ${this.netSentence()}`);
  }

  // Ghost preview for moving a solid.
  showGhost(type, edge, position, quaternion, state) {
    if (this.ghost && this.ghost.userData.type !== type) { this.shellGroup.remove(this.ghost); this.ghost.geometry.dispose(); this.ghost = null; }
    if (!this.ghost) {
      const tm = template(type);
      const pos = [];
      for (const f of tm.faces) {
        for (let i = 1; i < f.idx.length - 1; i++) {
          for (const k of [f.idx[0], f.idx[i], f.idx[i + 1]]) pos.push(tm.verts[k].x, tm.verts[k].y, tm.verts[k].z);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      this.ghost = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.6 }));
      this.ghost.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: '#1d1f2b' })));
      this.ghost.userData.type = type;
      this.shellGroup.add(this.ghost);
    }
    this.ghost.visible = true;
    this.ghost.position.copy(position);
    this.ghost.quaternion.copy(quaternion);
    this.ghost.scale.setScalar(edge);
    this.ghost.material.color.set({ snap: '#2fbf71', free: '#9fb2cc', blocked: '#ff3b1f' }[state]);
  }

  hideGhost() { if (this.ghost) this.ghost.visible = false; }

  // ----------------------------------------------------- status & panel

  statusLine() {
    const s = this.shell.stats();
    const mode = this.state.tool === 'shape' && this.shapeEdit.mode === 'edit' ? 'Edit vertices: lengths and angles change'
      : { shape: 'Resize mode: panel sizes change', open: 'Fold mode: panels stay rigid', layout: 'Layout: pieces move as wholes' }[this.state.tool];
    const parts = [...(mode ? [mode] : []), this.solidsText(), `${s.panels} panels`, `${s.removed} internal faces removed`, `${s.hinges} hinges`, `${s.cuts} cuts`];
    if (s.pieces > 1) parts.push(`${s.pieces} separate shells`);
    if (this.overlapPairs) parts.push(`${this.overlapPairs} intersecting pair${this.overlapPairs > 1 ? 's' : ''} now`);
    if (this.state.tool === 'build') { const jt = this.jointText(); if (jt) parts.push(`Joints: ${jt}`); }
    if (this.state.tool === 'layout') parts.push(`Layout: ${this.layoutText().text}`);
    if (this.state.tool === 'inspect') parts.push(this.isTurned() ? `Turned ${Math.round(this.viewTurnDegrees())}° for viewing` : 'Resting orientation');
    if (this.state.tool === 'shape' || this.comp.isShaped()) parts.push(`${this.comp.isShaped() ? 'Shape changed' : 'Regular solids'}: ${this.sizeText()}`);
    if (this.state.tool === 'shape') parts.push(this.foldText());
    parts.push(this.netText());
    return parts.join(' · ');
  }

  // Rows for the VR control panel.
  panelRows(row, B, M, W, y0) {
    const s = this.state;
    const a = this;
    row(y0, 84, [
      { label: 'Inspect', action: () => a.setTool('inspect'), active: s.tool === 'inspect' },
      { label: 'Build', action: () => a.setTool('build'), active: s.tool === 'build' },
      { label: 'Open', action: () => a.setTool('open'), active: s.tool === 'open' },
      { label: 'Edges', action: () => a.setTool('edges'), active: s.tool === 'edges' },
      { label: 'Layout', action: () => a.setTool('layout'), active: s.tool === 'layout' },
      { label: 'Shape', action: () => a.setTool('shape'), active: s.tool === 'shape' },
    ], 8);
    const y1 = y0 + 100, y2 = y0 + 190;
    if (s.tool === 'inspect') {
      row(y1, 78, [
        { label: 'Reset orientation', w: 1.5, action: () => a.resetOrientation() },
        { label: 'Fit view', action: () => a.fitView() },
        { label: 'Turn 90°', action: () => a.stepView('up', 90) },
        { label: 'Tip 90°', action: () => a.stepView('tip', 90) },
      ], 8);
      B.push({ kind: 'text', x: M, y: y2, w: W, h: 78, label: 'Pinch or pull the trigger on the form and turn your wrist; with both hands, move them around each other. Only the view turns.' });
    } else if (s.tool === 'shape' && a.shapeEdit.mode === 'edit') {
      const ed = a.shapeEdit;
      row(y1, 78, [
        { label: 'Resize', action: () => ed.setMode('resize'), active: false },
        { label: 'Edit vertices', w: 1.3, action: () => ed.setMode('edit'), active: true },
        { label: 'Tap: pin', action: () => ed.setTapMode('pin'), active: ed.tapMode === 'pin' },
        { label: 'Tap: select', action: () => ed.setTapMode('select'), active: ed.tapMode === 'select' },
        { label: 'Pin base', action: () => ed.pinBase() },
        { label: 'Clear pins', action: () => ed.clearPins() },
      ], 6);
      row(y2, 78, [
        { label: 'Shrink 10%', action: () => ed.stepScale(0.9) },
        { label: 'Grow 10%', action: () => ed.stepScale(1.1) },
        { label: 'Clear sel.', action: () => ed.clearSelection() },
        { label: 'Triangulate', action: () => ed.triangulateAt() },
        { label: 'Reset edits', action: () => ed.resetEdits() },
      ], 6);
    } else if (s.tool === 'shape') {
      row(y1, 78, [
        { label: 'Resize', action: () => a.shapeEdit.setMode('resize'), active: true },
        { label: 'Edit', action: () => a.shapeEdit.setMode('edit'), active: false },
        { label: 'X −10%', action: () => a.stretchBy('x', 1 / 1.1) },
        { label: 'X +10%', action: () => a.stretchBy('x', 1.1) },
        { label: 'Y −10%', action: () => a.stretchBy('y', 1 / 1.1) },
        { label: 'Y +10%', action: () => a.stretchBy('y', 1.1) },
        { label: 'Z −10%', action: () => a.stretchBy('z', 1 / 1.1) },
        { label: 'Z +10%', action: () => a.stretchBy('z', 1.1) },
      ], 4);
      row(y2, 78, [
        { label: 'Reset shape', action: () => a.resetShape() },
        { label: 'Unpin', action: () => (a.shapeEdit.pin ? a.shapeEdit.togglePin(a.shapeEdit.pin) : a.app.toast('Nothing is pinned. Tap a side or corner of the net to pin it.')) },
        { label: a.sizeText().replace(' (width × height × depth)', ''), w: 2.2, kind: 'label' },
      ], 8);
    } else if (s.tool === 'layout') {
      row(y1, 78, [
        { label: 'Lay flat', action: () => a.layFlat() },
        { label: 'Arrange', action: () => a.arrangePieces() },
        { label: 'Other nets', action: () => a.otherNets() },
      ], 8);
      row(y2, 78, [
        { label: '⟲ 15°', action: () => a.rotatePiece(15) },
        { label: '⟳ 15°', action: () => a.rotatePiece(-15) },
        { label: 'Numbers', action: () => a.toggleLabels(), active: s.showLabels },
        { label: 'Panel IDs', action: () => a.toggleIds(), active: s.showIds },
      ], 8);
    } else if (s.tool === 'build') {
      const short = { cube: 'Cube', tetra: 'Tetra', octa: 'Octa', cubocta: 'Cubocta' };
      row(y1, 78, SOLID_TYPES.map((t) => ({ label: short[t], action: () => a.setAddType(t), active: a.addType === t })), 10);
      row(y2, 78, [
        { label: `Add ${short[a.addType].toLowerCase()}`, w: 1.2, action: () => a.addSolid() },
        { label: 'Duplicate', action: () => a.duplicate() },
        { label: 'Rotate', action: () => a.rotateSolid() },
        { label: 'Remove', action: () => a.removeSolid() },
        { label: 'Tip over', action: () => a.turnAll('x') },
      ], 8);
    } else if (s.tool === 'open') {
      row(y1, 78, [
        { label: 'Group', action: () => a.setOpenMode('group'), active: s.openMode === 'group' },
        { label: 'One panel', action: () => a.setOpenMode('one'), active: s.openMode === 'one' },
        { label: 'Open flat', action: () => a.openFlat() },
        { label: 'Close', action: () => a.close() },
      ]);
      const ang = this.selectedAngle();
      row(y2, 78, [
        { label: '−15°', action: () => a.turnBy(-rad(15)) },
        { label: ang === null ? 'No panel' : `Hinge ${Math.round(ang)}°`, w: 1.6, kind: 'label' },
        { label: '+15°', action: () => a.turnBy(rad(15)) },
        { label: 'Set base', action: () => a.setBase() },
      ]);
    } else {
      row(y1, 78, [
        { label: 'Find net', action: () => a.defaultNet() },
        { label: 'Check net', action: () => a.checkNet() },
      ]);
      B.push({ kind: 'text', x: M, y: y2, w: W, h: 78, label: 'Point at an edge and pull the trigger (or pinch / touch it) to switch hinge ↔ cut. Green = hinge, red dashed = cut.' });
    }
    row(y0 + 280, 78, [
      { label: 'Undo', action: () => a.undo() },
      { label: 'Unfold all', action: () => a.unfoldAll() },
      { label: 'Refold all', action: () => a.refoldAll() },
      { label: 'Reset', action: () => a.resetLayout() },
    ]);
    if (s.tool === 'build') {
      const keys = Object.keys(PRESETS);
      const k = a.state.presetPick || 'tetra';
      row(y0 + 370, 78, [
        { label: '◀', w: 0.5, action: () => { a.state.presetPick = keys[(keys.indexOf(k) + keys.length - 1) % keys.length]; a.app.notify(); } },
        { label: PRESETS[k].label, w: 2.6, action: () => a.preset(k) },
        { label: '▶', w: 0.5, action: () => { a.state.presetPick = keys[(keys.indexOf(k) + 1) % keys.length]; a.app.notify(); } },
        { label: 'Save', action: () => a.save() },
        { label: 'Load', action: () => a.load() },
      ], 8);
    } else {
      row(y0 + 370, 78, [
        { label: 'Save', action: () => a.save() },
        { label: 'Load', action: () => a.load() },
        { label: 'Recenter', action: () => a.app.actions.recenter() },
      ]);
    }
  }

  // Box around the panels as they are now (folded or flat), in the
  // workspace's own frame.
  bounds() {
    const box = new THREE.Box3();
    this.inspect.updateMatrix();
    this.shellGroup.updateMatrix();
    const V = this.inspect.matrix.clone().multiply(this.shellGroup.matrix);
    if (this.shell && this.shell.panels.length) {
      for (const p of this.shell.panels) for (const v of this.shell.worldPoly(p)) box.expandByPoint(v.applyMatrix4(V));
      if (this.shapeEdit && this.shapeEdit.active) {
        const g = this.shapeEdit.ghostBox();
        box.expandByPoint(g.min.clone().applyMatrix4(V)).expandByPoint(g.max.clone().applyMatrix4(V));
      }
    } else {
      for (const s of this.comp.solids) for (const v of s.worldVerts()) box.expandByPoint(v.applyMatrix4(V));
    }
    return box;
  }

  extent() {
    const box = this.bounds();
    if (box.isEmpty()) return 0.3;
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.z, size.y) + 2 * EDGE;
  }

  // On a screen, bring everything on the table into view (never in VR,
  // where the person moves their head instead). With onlyIfHidden, the
  // camera moves only when part of the shell is off screen.
  frameView(onlyIfHidden = false) {
    const app = this.app;
    if (!app.fitCamera || !app.camera || app.renderer?.xr?.isPresenting || app.space !== 'solids') return;
    if (onlyIfHidden) {
      const box = this.bounds();
      if (box.isEmpty()) return;
      this.root.updateMatrixWorld(true);
      app.camera.updateMatrixWorld(true);
      let hidden = false;
      for (let i = 0; i < 8 && !hidden; i++) {
        const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        const ndc = this.root.localToWorld(v).project(app.camera);
        // Bottom quarter of the screen is under the tool dock.
        hidden = Math.abs(ndc.x) > 0.95 || ndc.y > 0.95 || ndc.y < -0.45 || ndc.z > 1;
      }
      if (!hidden) return;
    }
    app.fitCamera();
  }
}

// ------------------------------------------------------------- gestures

class SolidsTools {
  constructor(ws) {
    this.ws = ws;
    this.active = new Map();
  }

  down(ptr, override) {
    if (this.active.has(ptr.id)) return false;
    const hit = ptr.pick();
    // The Move puck is the only grab target for moving the whole form.
    if (hit && hit.lift) return this.startCarry(ptr, hit);
    const tool = this.ws.state.tool;
    if (override === 'move') {
      // Grip: hold a flap to fold it, just like a pinch or the trigger.
      if (tool === 'open' && hit && hit.panel) {
        const g = this.beginOpen(ptr, hit, true);
        if (g) { this.active.set(ptr.id, g); return true; }
      }
      return false;
    }
    if (!hit) return false;
    if (!hit.panel && tool !== 'inspect' && !(tool === 'shape' && hit.ghost)) return false;
    const g = tool === 'inspect' ? this.beginInspect(ptr, hit)
      : tool === 'build' ? this.beginBuild(ptr, hit)
        : tool === 'edges' ? this.beginEdge(ptr, hit)
          : tool === 'layout' ? this.beginLayout(ptr, hit)
            : tool === 'shape' ? this.beginShape(ptr, hit)
              : this.beginOpen(ptr, hit);
    if (!g) return false;
    this.active.set(ptr.id, g);
    return true;
  }

  move(ptr) { const g = this.active.get(ptr.id); if (g) g.move(ptr); }

  // A hand's pinch has settled: gestures take their starting point again.
  rebase(ptr) { const g = this.active.get(ptr.id); if (g && g.rebase) g.rebase(ptr); }

  up(ptr) {
    const g = this.active.get(ptr.id);
    if (!g) return;
    this.active.delete(ptr.id);
    g.end(ptr);
  }

  cancel(ptr) {
    const g = this.active.get(ptr.id);
    if (!g) return;
    this.active.delete(ptr.id);
    (g.cancel || g.end)(ptr);
  }

  finishAll() {
    for (const [id, g] of [...this.active]) { this.active.delete(id); g.end({}); }
  }

  isBusy() { return this.active.size > 0; }
  clearSelection() {}
  hover(ptr, hit) { this.ws.setHover(hit, ptr); }
  update(dt) { this.ws.update(dt); }

  // A press counts as a drag once the point under it moves a few mm.
  dragDetector(ptr, hit) {
    const ws = this.ws;
    const limit = Math.max(0.004, ws.edgeLen * 0.06);
    if (ptr.kind !== 'screen' && ptr.grabPoint) {
      // A hand or controller may lift straight off the surface: count any
      // movement of the grab point in space.
      const g0 = ptr.grabPoint(hit);
      const dist = hit.distance;
      const fn = (p) => p.grabPoint(null, dist, g0.stick).point.distanceTo(g0.point) > limit;
      fn.rebase = (p) => { g0.point = p.grabPoint(null, dist, g0.stick).point; };
      return fn;
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(hit.normal.clone(), hit.point);
    const start = hit.point.clone();
    return (p) => {
      const w = p.onPlane ? p.onPlane(plane) : null;
      return !!w && w.distanceTo(start) > limit;
    };
  }

  // Where a pointer is on the work surface plane (shell frame).
  surfacePoint(p, ref) {
    const ws = this.ws;
    if (p.kind === 'screen') {
      const o = ws.toLocal(p.ray.origin);
      const dir = ws.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
      return new THREE.Ray(o, dir).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    }
    if (ref.stick && p.ray) {
      // A ray held from afar: where it meets the surface.
      const o = ws.toLocal(p.ray.origin);
      const dir = ws.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
      const hitPt = new THREE.Ray(o, dir).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (hitPt) return hitPt;
    }
    const g = ws.toLocal(p.grabPoint(null, ref.dist, ref.stick).point);
    g.y = 0;
    return g;
  }

  // ------------------------------------------------------------- shape

  // Where a pointer is in space for a 3D drag (world). On a screen: on a
  // plane through the start point that faces you and stands upright (left/
  // right and up/down), or a level plane with Shift. Hands and controllers:
  // where the hand is.
  spacePoint(p, ref) {
    if (p.kind === 'screen') return p.ray.intersectPlane(ref.plane, new THREE.Vector3());
    return p.grabPoint(null, ref.dist, ref.stick).point.clone();
  }

  beginVertexEdit(ptr, hit) {
    const ws = this.ws;
    const ed = ws.shapeEdit;
    const sel = ed.selection(hit, ptr);
    if (!sel) return { move: () => {}, end: () => ws.app.toast('Tap a corner, edge or face of the floating form to pin it; drag a corner or edge to move it.') };
    const moved = this.dragDetector(ptr, hit);
    const ref = { dist: hit.distance, stick: ptr.kind !== 'screen' && ptr.grabPoint ? ptr.grabPoint(hit).stick : false };
    if (ptr.kind === 'screen') {
      const cam = ws.app.camera;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
      const n = ptr.shift ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      ref.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point);
    }
    if (sel.kind === 'ring') {
      // Drag the ring in or out: the selected group scales in its plane.
      const ring = ed.ringWorld();
      if (!ring) return null;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(ring.n, ring.c);
      const onPlane = (p) => (p.kind === 'screen' ? p.ray.intersectPlane(plane, new THREE.Vector3()) : plane.projectPoint(p.grabPoint(null, ref.dist, ref.stick).point, new THREE.Vector3()));
      let P0 = onPlane(ptr);
      let d = null, started = false;
      return {
        rebase: (p) => { if (!started) { moved.rebase?.(p); P0 = onPlane(p) || P0; } },
        move: (p) => {
          if (!started) {
            if (!moved(p)) return;
            started = true;
            d = ed.startScale();
          }
          if (!d || !P0) return;
          const P = onPlane(p);
          const r0 = P0.distanceTo(ring.c);
          if (!P || r0 < 1e-4) return;
          ed.moveScale(d, Math.max(0.05, P.distanceTo(ring.c) / r0));
        },
        end: () => {
          if (!started) { ws.app.toast('Drag the ring inward or outward to scale the selected corners in their plane.'); return; }
          if (d) ed.endEdit(d);
        },
        cancel: () => { if (d) ed.cancelEdit(d); },
      };
    }
    let W0 = this.spacePoint(ptr, ref) || hit.point.clone();
    let d = null, started = false;
    return {
      rebase: (p) => { if (!started) { moved.rebase?.(p); W0 = this.spacePoint(p, ref) || W0; } },
      move: (p) => {
        if (!started) {
          if (!moved(p)) return;
          started = true;
          d = ed.startEdit(sel);
        }
        if (!d) return;
        const W = this.spacePoint(p, ref);
        if (!W) return;
        ws.shellGroup.updateWorldMatrix(true, false);
        const delta = ws.shellGroup.worldToLocal(W.clone()).sub(ws.shellGroup.worldToLocal(W0.clone()));
        ed.moveEdit(d, delta);
      },
      end: () => {
        if (!started) { if (ed.tapMode === 'select') ed.toggleSelect(sel); else ed.togglePins(sel); return; }
        if (d) ed.endEdit(d);
      },
      cancel: () => { if (d) ed.cancelEdit(d); },
    };
  }

  beginShape(ptr, hit) {
    const ws = this.ws;
    const ed = ws.shapeEdit;
    if (!ed.active) return null;
    if (ed.mode === 'edit') return this.beginVertexEdit(ptr, hit);
    if (hit.ghost) {
      const gh = hit.ghost;
      return {
        move: () => {},
        end: () => ws.app.toast(gh.kind === 'edge'
          ? `Edge ${gh.edge.no} (${(gh.edge.a.distanceTo(gh.edge.b) * 1000).toFixed(0)} mm) is lit in the net${gh.edge.type === 'cut' ? ' on both sides of its seam' : ''}. Pin or drag it there.`
          : 'This corner is lit wherever it appears in the net. Pin or drag one of them there.'),
      };
    }
    const el = ed.netElement(hit.panel, hit.local, ptr.kind === 'ray' && !hit.near);
    if (!el) return { move: () => {}, end: () => ws.app.toast('Tap a side or corner of the net to pin it; drag one to resize.') };
    const moved = this.dragDetector(ptr, hit);
    const ref = { dist: hit.distance, stick: ptr.kind !== 'screen' && ptr.grabPoint ? ptr.grabPoint(hit).stick : false };
    let P0 = this.surfacePoint(ptr, ref);
    let d = null, started = false;
    return {
      rebase: (p) => { if (!started) { moved.rebase?.(p); P0 = this.surfacePoint(p, ref); } },
      move: (p) => {
        if (!started) {
          if (!moved(p)) return;
          started = true;
          d = ed.startResize(el);
        }
        if (d && P0) {
          const P = this.surfacePoint(p, ref);
          if (P) ed.dragTo(d, P0, P);
        }
      },
      end: () => {
        if (!started) { ed.togglePin(el); return; }
        if (d) ed.endResize(d);
      },
      cancel: () => { if (d) ed.cancelResize(d); },
    };
  }

  // ------------------------------------------------------------- carry

  startCarry(ptr, hit) {
    const ws = this.ws;
    this.carrying = true;
    ws.styleLift();
    const tagAt = () => ws.setTag('Move the whole form', ws.lift.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.05, 0)));
    if (ptr.kind !== 'screen') {
      this.beginCarry(ptr);
      const g = this.active.get(ptr.id);
      const move = g.move;
      g.move = (p) => { move(p); tagAt(); };
      g.end = () => { this.carrying = false; ws.hideTag(); ws.styleLift(); };
      tagAt();
      return true;
    }
    // Screen: slide the form across the table.
    const root = ws.root;
    root.parent.updateMatrixWorld(true);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
    const start = ptr.ray.intersectPlane(plane, new THREE.Vector3()) || hit.point.clone();
    const startLocal = root.position.clone();
    const inv = root.parent.matrixWorld.clone().invert();
    ws.carried = true;
    this.active.set(ptr.id, {
      move: (p) => {
        const w = p.ray.intersectPlane(plane, new THREE.Vector3());
        if (!w) return;
        const a = start.clone().applyMatrix4(inv), b = w.applyMatrix4(inv);
        root.position.copy(startLocal).add(b.sub(a));
        tagAt();
      },
      end: () => { this.carrying = false; ws.hideTag(); ws.styleLift(); ws.app.toast('Moved. Recenter (or Reset view) puts it back on the table centre.'); },
    });
    tagAt();
    return true;
  }

  beginOpen(ptr, hit, grip = false) {
    const ws = this.ws;
    const P = hit.panel;
    const moved = this.dragDetector(ptr, hit);
    // The hinge is decided where you touch, and kept for the whole grab.
    const hinge = ws.touchHinge(P, hit.local);
    const tapEdge = ws.sel.panel === P ? ws.edgeNear(P, hit.local, 0.2) : null;
    let swing = null, started = false;
    if (ptr.kind !== 'screen' && hinge) ws.showHingeLine({ P, e: hinge, color: '#f0b44c' });
    return {
      rebase: (p) => { if (!started) moved.rebase?.(p); },
      move: (p) => {
        if (!started) {
          if (!moved(p)) return;
          started = true;
          if (ws.sel.panel !== P || (hinge && ws.sel.hinge !== hinge)) ws.holdPanel(P, hinge);
          swing = this.startSwing(ptr, hit);
        }
        if (swing) this.swingTo(swing, p);
      },
      end: () => {
        ws.hideTag();
        if (!started) {
          ws.showHingeLine(null);
          if (grip) return;
          if (tapEdge && tapEdge !== ws.sel.hinge) ws.chooseHinge(tapEdge);
          else if (ws.sel.panel !== P) { ws.select(P); if (hinge && hinge !== ws.sel.hinge) ws.holdPanel(P, hinge); }
          return;
        }
        ws.showHingeLine(null);
        if (swing) ws.endTurn(swing.plan, true);
      },
      cancel: () => {
        // Tracking lost mid-swing: back to how it was before the grab.
        ws.hideTag();
        ws.showHingeLine(null);
        if (!swing) return;
        const snap = ws.history.pop();
        ws.moving.clear();
        if (snap) ws.restoreSnapshot(snap);
      },
    };
  }

  startSwing(ptr, hit) {
    const ws = this.ws;
    const plan = ws.beginTurn();
    if (!plan) return null;
    const { a, u } = ws.shell.axis(plan.e, plan.P);
    const A = a.clone().applyMatrix4(plan.Q.M);
    const U = u.clone().transformDirection(plan.Q.M);
    const G = ws.toLocal(hit.point);
    const frame = makeFrame(A, U, G);
    if (!frame) { ws.endTurn(plan, false); return null; }
    const s = { plan, frame, theta0: ws.shell.angle(plan.e, plan.P, plan.Q), delta: 0, pos: 0, rot: 0, kind: ptr.kind };
    if (ptr.kind !== 'screen') {
      const gp = ptr.grabPoint(hit);
      s.stick = gp.stick;
      s.dist = hit.distance;
      s.offset = hit.point.clone().sub(gp.point);
      s.q0 = this.localQuat(ptr);
    }
    ws.showHingeLine({ P: plan.Q, e: plan.e, color: '#f0b44c' });
    return s;
  }

  // Orientation of a hand or controller in the shell frame.
  localQuat(p) {
    const ws = this.ws;
    ws.shellGroup.updateWorldMatrix(true, false);
    const qs = ws.shellGroup.getWorldQuaternion(new THREE.Quaternion()).invert();
    return qs.multiply(quatOf(p.grabMatrix()));
  }

  swingTo(s, p) {
    const ws = this.ws;
    let d;
    if (p.kind === 'screen') {
      const o = ws.toLocal(p.ray.origin);
      const dir = ws.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
      d = angleFromRay(s.frame, o, dir, s.delta);
    } else {
      // Hand position leads; the palm's turn about the hinge helps, most of
      // all close to the hinge, where position alone says little.
      const gp = p.grabPoint(null, s.dist, s.stick);
      const X = ws.toLocal(gp.point.clone().add(s.offset));
      s.pos = angleFromPoint(s.frame, X, s.pos);
      const rel = this.localQuat(p).multiply(s.q0.clone().invert());
      const tw = 2 * Math.atan2(rel.x * s.frame.U.x + rel.y * s.frame.U.y + rel.z * s.frame.U.z, rel.w);
      s.rot += Math.atan2(Math.sin(tw - s.rot), Math.cos(tw - s.rot));
      const off = X.clone().sub(s.frame.C);
      const r = off.addScaledVector(s.frame.U, -off.dot(s.frame.U)).length();
      const w = THREE.MathUtils.clamp(0.2 + 0.7 * (1 - r / (0.5 * ws.edgeLen)), 0.2, 0.9);
      d = (1 - w) * s.pos + w * s.rot;
    }
    const target = THREE.MathUtils.clamp(s.theta0 + d, -Math.PI, Math.PI);
    s.delta = target - s.theta0;
    ws.shell.setAngle(s.plan, target);
    ws.updateMatrices();
    ws.checkOverlaps();
    ws.refreshMaterials();
    ws.app.solidsUI?.syncSolidAngle();
    const ang = Math.round(deg(ws.shell.angle(s.plan.e, s.plan.P, s.plan.Q)));
    const at = s.plan.P.centroid.clone().applyMatrix4(s.plan.P.M);
    ws.setTag(`Fold · panels rigid · hinge ${ang}°`, ws.shellGroup.localToWorld(at));
  }

  beginEdge(ptr, hit) {
    const ws = this.ws;
    const e = ws.edgeNear(hit.panel, hit.local, ptr.kind === 'ray' && !hit.near ? 0.32 : 0.25);
    return {
      move: () => {},
      end: () => {
        if (e) ws.toggleEdge(e);
        else if (ptr.kind !== 'touch') ws.app.toast('Tap closer to an edge.');
      },
    };
  }

  beginBuild(ptr, hit) {
    const ws = this.ws;
    const P = hit.panel;
    const moved = this.dragDetector(ptr, hit);
    let drag = null, started = false;
    return {
      rebase: (p) => { if (!started) moved.rebase?.(p); },
      move: (p) => {
        if (!started) {
          if (!moved(p)) return;
          started = true;
          drag = this.startSolidDrag(ptr, hit);
        }
        if (drag) this.solidDragTo(drag, p);
      },
      end: () => {
        if (!started) { ws.selectFace(P); return; }
        if (drag) this.endSolidDrag(drag);
      },
      cancel: () => { if (drag) { drag.state = 'blocked'; this.endSolidDrag(drag); } },
    };
  }

  startSolidDrag(ptr, hit) {
    const ws = this.ws;
    if (!ws.requireClosed()) return null;
    const solid = ws.comp.get(hit.panel.solidId);
    if (!solid) return null;
    ws.pushHistory();
    const before = ws.history[ws.history.length - 1];
    ws.comp.remove(solid.id);
    ws.shell.build(ws.comp);
    ws.shell.defaultNet();
    ws.buildMeshes();
    const d = {
      solid, before, kind: ptr.kind,
      pos: solid.position.clone(), quat: solid.quaternion.clone(), state: 'blocked',
      grabStart: ptr.kind === 'screen' ? null : ptr.grabMatrix().clone(),
      startPos: solid.position.clone(), startQuat: solid.quaternion.clone(),
    };
    ws.showGhost(solid.type, solid.edge, d.pos, d.quat, 'free');
    ws.app.toast(`Move the ${TEMPLATES[solid.type].name.toLowerCase()} next to another solid; it snaps when a matching face lines up.`);
    return d;
  }

  solidDragTo(d, p) {
    const ws = this.ws;
    const s = d.solid;
    let pos, quat = d.quat.clone();
    if (p.kind === 'screen') {
      const o = ws.toLocal(p.ray.origin);
      const dir = ws.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
      // Prefer a snap spot near the ray.
      let best = null, bd = s.edge * 0.6;
      for (const c of ws.comp.snapCandidates(s.type, s.edge, d.startQuat)) {
        const t = Math.max(0, c.position.clone().sub(o).dot(dir));
        const dist = c.position.clone().sub(o.clone().addScaledVector(dir, t)).length();
        if (dist < bd) { bd = dist; best = c; }
      }
      if (best) { pos = best.position; quat = best.quaternion; }
      else {
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -restHeight(s.type, s.edge));
        pos = new THREE.Ray(o, dir).intersectPlane(plane, new THREE.Vector3());
        if (!pos) return;
      }
      d.state = best ? 'snap' : 'free';
    } else {
      // Follow the hand, including its rotation.
      ws.shellGroup.updateWorldMatrix(true, false);
      const frame = ws.shellGroup.matrixWorld;
      const D = frame.clone().invert().multiply(p.grabMatrix()).multiply(d.grabStart.clone().invert()).multiply(frame);
      const m = new THREE.Matrix4().compose(d.startPos, d.startQuat, new THREE.Vector3(1, 1, 1)).premultiply(D);
      pos = new THREE.Vector3(); quat = new THREE.Quaternion();
      m.decompose(pos, quat, new THREE.Vector3());
      let best = null, bd = s.edge * 0.5;
      for (const c of ws.comp.snapCandidates(s.type, s.edge, quat)) {
        const dist = c.position.distanceTo(pos);
        if (dist < bd) { bd = dist; best = c; }
      }
      if (best) { pos = best.position; quat = best.quaternion; d.state = 'snap'; } else d.state = 'free';
    }
    const problem = ws.comp.placementProblem(s.type, s.edge, pos, quat);
    if (problem) { d.state = 'blocked'; d.problem = problem; ws.flashSolid(problem.solid && problem.solid.id); } else d.problem = null;
    if (d.state === 'free') {
      // Keep a free solid on or above the table.
      let minY = Infinity;
      const m = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(s.edge, s.edge, s.edge));
      for (const v of template(s.type).verts) minY = Math.min(minY, v.clone().applyMatrix4(m).y);
      if (minY < 0) pos.y -= minY;
    }
    d.pos = pos.clone();
    d.quat = quat.clone();
    ws.showGhost(s.type, s.edge, d.pos, d.quat, d.state);
  }

  endSolidDrag(d) {
    const ws = this.ws;
    ws.hideGhost();
    if (d.state === 'blocked') {
      ws.history.pop();
      ws.restoreSnapshot(d.before);
      ws.app.toast(`${d.problem ? d.problem.message : 'That spot is not valid.'} The ${TEMPLATES[d.solid.type].name.toLowerCase()} went back.`);
      return;
    }
    const s = d.solid;
    s.position.copy(d.pos);
    s.quaternion.copy(d.quat);
    roundPose(s);
    ws.comp.solids.push(s);
    ws.rebuild();
    const p = ws.shell.panels.find((q) => q.solidId === s.id);
    if (p) ws.selectFace(p);
    const jt = ws.jointText();
    ws.app.toast(d.state === 'snap' ? `Snapped face to face. ${ws.describe()}.${jt ? ` Joints: ${jt}.` : ''} ${ws.netSentence()}` : 'Placed on its own. Snap it to a matching face of another solid to merge the shells.', 6000);
  }

  // ------------------------------------------------------------ inspect

  inspecting() { return !!(this.grabs && this.grabs.size); }

  // One pointer turns the form (mouse or finger: drag; controller or hand:
  // turn the wrist). A second hand switches to turning it by the line
  // between the two hands. Only the view turns.
  beginInspect(ptr) {
    if (ptr.kind === 'touch') return null;
    if (!this.grabs) this.grabs = new Map();
    // Each grab keeps the pose from its own latest accepted move, so a hand
    // that is letting go (and no longer moving the form) cannot pull it.
    const g = { ptr, m: ptr.kind === 'screen' ? null : ptr.grabMatrix().clone() };
    this.grabs.set(ptr.id, g);
    this.anchorInspect();
    this.ws.refreshMaterials();
    this.ws.app.haptic?.();
    return {
      // The pinch has settled: take this hand's pose again and re-anchor.
      rebase: (p) => { g.ptr = p; if (p.kind !== 'screen') g.m = p.grabMatrix().clone(); this.anchorInspect(); },
      move: (p) => { g.ptr = p; if (p.kind !== 'screen') g.m = p.grabMatrix().clone(); this.dragInspect(); },
      end: () => {
        // Fingers start opening just before a pinch release registers; drop
        // a small turn made in that last moment.
        if (ptr.isHand && this.trail && this.trail.length) {
          const last = this.trail[this.trail.length - 1].t;
          const before = this.trail.find((x) => x.t >= last - 100);
          if (before && before.q.angleTo(this.ws.view.q) < THREE.MathUtils.degToRad(4)) {
            this.ws.view.q.copy(before.q);
            this.ws.applyView();
          }
        }
        this.grabs.delete(ptr.id);
        this.anchorInspect();
        this.ws.refreshMaterials();
        this.ws.app.notify?.();
      },
    };
  }

  anchorInspect() {
    const ws = this.ws;
    const list = [...this.grabs.values()];
    if (ws.view.target) { ws.view.q.copy(ws.view.target); ws.view.target = null; ws.applyView(); }
    const q0 = ws.view.q.clone();
    this.trail = [];
    if (!list.length) { this.inspectAnchor = null; return; }
    if (list.length === 1) {
      const p = list[0].ptr;
      this.inspectAnchor = p.kind === 'screen'
        ? { mode: 'screen', q0, d0: p.ray.direction.clone() }
        : { mode: 'hand', q0, h0: quatOf(list[0].m) };
    } else {
      const [a, b] = list;
      this.inspectAnchor = { mode: 'two', q0, a, b, v0: posOf(b.m).sub(posOf(a.m)) };
    }
    // Hands settle for a moment as the fingers close: keep re-anchoring
    // until then, so closing the pinch does not turn anything.
    if (list.some((g) => g.ptr.kind !== 'screen')) this.inspectAnchor.settleUntil = performance.now() + 150;
  }

  dragInspect() {
    const ws = this.ws;
    const A = this.inspectAnchor;
    if (!A) return;
    const list = [...this.grabs.values()];
    if (A.settleUntil && performance.now() < A.settleUntil) {
      if (A.mode === 'hand') A.h0 = quatOf(list[0].m);
      else if (A.mode === 'two') A.v0 = posOf(A.b.m).sub(posOf(A.a.m));
      return;
    }
    let dq;
    if (A.mode === 'screen') {
      // Sideways drags turn it about the vertical, up/down tip it toward you.
      const qc = ws.app.camera.getWorldQuaternion(new THREE.Quaternion());
      const inv = qc.clone().invert();
      const d0 = A.d0.clone().applyQuaternion(inv);
      const d1 = list[0].ptr.ray.direction.clone().applyQuaternion(inv);
      const yaw = Math.atan2(d1.x, -d1.z) - Math.atan2(d0.x, -d0.z);
      const pitch = Math.asin(THREE.MathUtils.clamp(d1.y, -1, 1)) - Math.asin(THREE.MathUtils.clamp(d0.y, -1, 1));
      const K = 3.2;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(qc);
      dq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw * K)
        .multiply(new THREE.Quaternion().setFromAxisAngle(right, -pitch * K));
    } else if (A.mode === 'hand') {
      dq = quatOf(list[0].m).multiply(A.h0.clone().invert());
    } else {
      const v1 = posOf(A.b.m).sub(posOf(A.a.m));
      if (v1.lengthSq() < 1e-8 || A.v0.lengthSq() < 1e-8) return;
      dq = new THREE.Quaternion().setFromUnitVectors(A.v0.clone().normalize(), v1.normalize());
    }
    ws.turnView(dq, A.q0);
    const now = performance.now();
    this.trail.push({ t: now, q: ws.view.q.clone() });
    while (this.trail.length && this.trail[0].t < now - 400) this.trail.shift();
  }

  // ------------------------------------------------------------- layout

  beginLayout(ptr, hit) {
    const ws = this.ws;
    const P = hit.panel;
    const moved = this.dragDetector(ptr, hit);
    // A narrower edge band than the Edges tool: a tap in the middle of a
    // panel selects its piece rather than cutting.
    const tapEdge = ws.edgeNear(P, hit.local, ptr.kind === 'ray' && !hit.near ? 0.2 : 0.14);
    let drag = null, started = false;
    return {
      rebase: (p) => { if (!started) moved.rebase?.(p); },
      move: (p) => {
        if (!started) {
          if (!moved(p)) return;
          started = true;
          drag = this.startPieceDrag(ptr, hit);
        }
        if (drag) this.pieceDragTo(drag, p);
      },
      end: () => {
        if (!started) {
          if (tapEdge) ws.layoutEdge(tapEdge, P);
          else ws.selectPiece(P);
          return;
        }
        if (drag) this.endPieceDrag(drag);
      },
      cancel: () => {
        // Tracking lost mid-drag: the piece goes back.
        if (!drag) return;
        drag.piece.forEach((p, i) => p.M.copy(drag.M0[i]));
        ws.history.pop();
        ws.moving.clear();
        ws.updateMatrices();
        ws.afterMotion(false);
      },
    };
  }

  // Heading of a hand or controller about the vertical, in the shell frame.
  handYaw(p) {
    const ws = this.ws;
    const x = new THREE.Vector3().setFromMatrixColumn(p.grabMatrix(), 0);
    ws.shellGroup.updateWorldMatrix(true, false);
    x.transformDirection(ws.shellGroup.matrixWorld.clone().invert());
    return Math.atan2(x.z, x.x);
  }

  startPieceDrag(ptr, hit) {
    const ws = this.ws;
    if (!ws.shell.flatReport().ok) { ws.app.toast('Lay the net on the surface first (Lay net on surface).'); return null; }
    ws.stopAnim();
    const piece = ws.pieceOf(hit.panel);
    ws.pushHistory();
    ws.sel.piece = new Set(piece);
    ws.moving = new Set(piece);
    const start = ws.toLocal(hit.point);
    const d = { piece, M0: piece.map((p) => p.M.clone()), start, kind: ptr.kind };
    if (ptr.kind !== 'screen') {
      const gp = ptr.grabPoint(hit);
      d.stick = gp.stick;
      d.dist = hit.distance;
      d.grab0 = ws.toLocal(gp.point);
      d.yaw0 = this.handYaw(ptr);
    }
    ws.refreshStyles();
    return d;
  }

  pieceDragTo(d, p) {
    const ws = this.ws;
    let m;
    if (p.kind === 'screen') {
      const o = ws.toLocal(p.ray.origin);
      const dir = ws.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
      const pt = new THREE.Ray(o, dir).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -d.start.y), new THREE.Vector3());
      if (!pt) return;
      m = planarMove(pt.x - d.start.x, pt.z - d.start.z, 0, d.start);
    } else {
      // Follow the hand, and turn with it about the vertical.
      const gp = p.grabPoint(null, d.dist, d.stick);
      const g = ws.toLocal(gp.point);
      let yaw = d.yaw0 - this.handYaw(p);
      yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      m = planarMove(g.x - d.grab0.x, g.z - d.grab0.z, yaw, d.grab0);
    }
    d.piece.forEach((pp, i) => pp.M.multiplyMatrices(m, d.M0[i]));
    ws.updateMatrices();
    ws.checkOverlaps();
    ws.refreshMaterials();
  }

  endPieceDrag(d) {
    const ws = this.ws;
    ws.moving.clear();
    const snap = edgeSnap(ws.shell, d.piece);
    let prefix = 'Piece moved.';
    if (snap) {
      for (const p of d.piece) p.M.premultiply(snap.move);
      prefix = `Edge ${snap.e.no} lined up with its matching edge ${snap.e.no}. Tap it to join the pieces there.`;
      ws.app.haptic?.();
    }
    ws.updateMatrices();
    ws.afterMotion(false);
    ws.reportLayout(prefix);
  }

  // Grip / squeeze: carry the whole composition.
  beginCarry(ptr) {
    const root = this.ws.root;
    this.ws.carried = true;
    root.updateMatrixWorld(true);
    let offset = ptr.grabMatrix().clone().invert().multiply(root.matrixWorld);
    this.active.set(ptr.id, {
      rebase: (p) => { root.updateMatrixWorld(true); offset = p.grabMatrix().clone().invert().multiply(root.matrixWorld); },
      move: (p) => {
        const m = p.grabMatrix().clone().multiply(offset);
        root.parent.updateMatrixWorld(true);
        m.premultiply(root.parent.matrixWorld.clone().invert());
        m.decompose(root.position, root.quaternion, new THREE.Vector3());
        root.scale.set(1, 1, 1);
      },
      end: () => {},
    });
    return true;
  }
}

// ---------------------------------------------------------------- helpers

function dashes(k) {
  const out = [];
  for (let i = 0; i < k; i++) out.push([(i + 0.15) / k, (i + 0.75) / k]);
  return out;
}

function segDist3(p, a, b) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function insidePoly(verts, n, q) {
  const k = verts.length;
  for (let i = 0; i < k; i++) {
    const a = verts[i], b = verts[(i + 1) % k];
    const c = new THREE.Vector3().crossVectors(b.clone().sub(a), q.clone().sub(a)).dot(n);
    if (c < -1e-9) return false;
  }
  return true;
}

function quatOf(m) {
  const q = new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q;
}

function posOf(m) { return new THREE.Vector3().setFromMatrixPosition(m); }

function lerpMatrix(a, b, t) {
  const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3();
  const pb = new THREE.Vector3(), qb = new THREE.Quaternion(), sb = new THREE.Vector3();
  a.decompose(pa, qa, sa);
  b.decompose(pb, qb, sb);
  return new THREE.Matrix4().compose(pa.lerp(pb, t), qa.slerp(qb, t), new THREE.Vector3(1, 1, 1));
}

// Remove rounding drift so lattice positions stay exact.
function roundPose(s) {
  const q = 1e6;
  s.position.set(Math.round(s.position.x * q) / q, Math.round(s.position.y * q) / q, Math.round(s.position.z * q) / q);
  const e = new THREE.Euler().setFromQuaternion(s.quaternion);
  const snap = (v) => Math.round(v / (Math.PI / 2)) * (Math.PI / 2);
  if ([e.x, e.y, e.z].every((v) => Math.abs(v - snap(v)) < 1e-4)) {
    s.quaternion.setFromEuler(new THREE.Euler(snap(e.x), snap(e.y), snap(e.z)));
  }
}
