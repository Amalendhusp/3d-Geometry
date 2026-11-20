import * as THREE from 'three';
import { Composition, alignFace } from './composition.js';
import { Shell } from './shell.js';
import { template } from './polyhedra.js';
import { makeFrame, angleFromPoint, angleFromRay } from './hinge.js';

// "Solid → Unfold" workspace: build a composition of solids, then open its
// exterior shell panel by panel along hinges.

const EDGE = 0.12; // cube edge length in metres
const STORE_KEY = 'paper-fold-studio.solids.v1';

export const PRESETS = {
  one: { label: '1 cube', cells: [[0, 0, 0]] },
  two: { label: '2 cubes', cells: [[0, 0, 0], [1, 0, 0]] },
  row: { label: '3 in a row', cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
  ell: { label: 'L shape', cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1]] },
  stack: { label: 'Stack of 2', cells: [[0, 0, 0], [0, 1, 0]] },
};

const COLORS = {
  outside: ['#f1e6cf', '#e3d3b2'],
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
    this.shellGroup = new THREE.Group();
    this.root.add(this.shellGroup);
    this.comp = new Composition();
    this.shell = new Shell();
    this.state = { tool: 'open', openMode: 'group' };
    this.sel = { panel: null, hinge: null, solidId: null, fi: null };
    this.loopEdges = new Set();
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
    for (const [x, y, z] of p.cells) this.comp.add('cube', EDGE, new THREE.Vector3(x * EDGE, y * EDGE + EDGE / 2, z * EDGE));
    this.centre();
    this.rebuild();
    if (record) this.app.toast(`${p.label}: ${this.describe()}`);
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
    this.sel = { panel: null, hinge: null, solidId: null, fi: null };
    this.loopEdges.clear();
    this.moving.clear();
    this.buildMeshes();
    this.checkOverlaps();
    if (this.ready) { this.app.layoutTable(); this.app.notify(); }
  }

  describe() {
    const s = this.shell.stats();
    const n = this.comp.solids.length;
    return `${n} cube${n === 1 ? '' : 's'} · ${s.panels} panels · ${s.removed} internal faces removed`;
  }

  // ------------------------------------------------------------ history

  snapshot() {
    return { comp: this.comp.serialize(), shell: this.shell.serialize() };
  }

  restoreSnapshot(snap) {
    this.comp.restore(snap.comp);
    this.shell.build(this.comp);
    this.shell.restore(snap.shell);
    this.sel = { panel: null, hinge: null, solidId: null, fi: null };
    this.loopEdges.clear();
    this.moving.clear();
    this.buildMeshes();
    this.checkOverlaps();
    if (this.ready) { this.app.layoutTable(); this.app.notify(); }
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
      localStorage.setItem(STORE_KEY, JSON.stringify(this.snapshot()));
      this.app.toast(`Saved: ${this.describe()}.`);
    } catch {
      this.app.toast('Saving is blocked in this browser view.');
    }
  }

  load() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { data = null; }
    if (!data) { this.app.toast('Nothing saved yet.'); return; }
    this.pushHistory();
    this.restoreSnapshot(data);
    this.app.toast(`Loaded: ${this.describe()}.`);
  }

  // ---------------------------------------------------------- rendering

  material(side, parity, state) {
    const key = `${side}|${parity}|${state}`;
    if (this.matCache.has(key)) return this.matCache.get(key);
    const tint = { none: null, selected: '#f0b44c', moving: '#ffd27a', overlap: '#ff2a12', solid: '#4a8cff', face: '#f0b44c' }[state];
    const strength = { none: 0, selected: 0.38, moving: 0.18, overlap: 0.55, solid: 0.25, face: 0.45 }[state];
    const m = new THREE.MeshStandardMaterial({
      color: side === 'out' ? COLORS.outside[parity] : COLORS.inside,
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
      const out = new THREE.Mesh(g, this.material('out', parity, 'none'));
      const inn = new THREE.Mesh(g, this.material('in', parity, 'none'));
      for (const m of [out, inn]) { m.castShadow = true; m.userData.panel = p; group.add(m); }
      this.shellGroup.add(group);
      this.meshes.set(p, { group, out, inn, geometry: g, parity, ribbon: null, ribbonBack: null });
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
    if (this.overlapSet.has(p)) return 'overlap';
    if (tool === 'build') {
      if (this.sel.solidId === p.solidId) return p.fi === this.sel.fi ? 'face' : 'solid';
      return 'none';
    }
    if (this.sel.panel === p) return 'selected';
    if (this.moving.has(p)) return 'moving';
    return 'none';
  }

  refreshStyles() {
    const options = this.sel.panel && this.state.tool === 'open' ? this.hingeOptions() : [];
    const okEdges = new Set(options.filter((o) => o.ok).map((o) => o.e));
    for (const [p, m] of this.meshes) {
      const st = this.panelState(p);
      m.out.material = this.material('out', m.parity, st);
      m.inn.material = this.material('in', m.parity, st);
      this.buildRibbon(p, m, okEdges);
    }
  }

  // Materials only (cheap; used every frame while a panel swings).
  refreshMaterials() {
    for (const [p, m] of this.meshes) {
      const st = this.panelState(p);
      m.out.material = this.material('out', m.parity, st);
      m.inn.material = this.material('in', m.parity, st);
    }
  }

  edgeStyle(p, e, okEdges) {
    const w = this.edgeLen * 0.022;
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
    if (!hits.length) return null;
    return this.hitFromWorld(hits[0].object.userData.panel, hits[0].point, hits[0].distance, ray.direction);
  }

  hitFromWorld(panel, point, distance, viewDir) {
    const m = this.meshes.get(panel);
    const local = point.clone().applyMatrix4(m.group.matrixWorld.clone().invert());
    const normal = panel.normal.clone().transformDirection(m.group.matrixWorld);
    if (viewDir && normal.dot(viewDir) > 0) normal.negate();
    return { panel, point: point.clone(), distance, local, normal };
  }

  // Nearest panel surface to a world point (fingertips, pinches).
  nearest(point, maxDist) {
    if (!this.root.visible) return null;
    this.root.updateMatrixWorld(true);
    let best = null;
    for (const [p, m] of this.meshes) {
      const inv = m.group.matrixWorld.clone().invert();
      const q = point.clone().applyMatrix4(inv);
      const d = q.clone().sub(p.verts[0]).dot(p.normal);
      if (Math.abs(d) > maxDist) continue;
      const onPlane = q.clone().addScaledVector(p.normal, -d);
      if (!insidePoly(p.verts, p.normal, onPlane)) continue;
      if (!best || Math.abs(d) < best.d) best = { p, d, onPlane };
    }
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

  toLocal(world) { return this.root.worldToLocal(world.clone()); }

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
    this.state.tool = t;
    if (t !== 'open') this.sel.panel = this.sel.hinge = null;
    if (t !== 'build') this.sel.solidId = this.sel.fi = null;
    this.loopEdges.clear();
    this.refreshStyles();
    const hints = {
      build: 'Tap a face to pick it, then Add cube. Drag a cube to move it; it snaps face to face.',
      open: 'Tap a panel to select it and see its hinges. Drag it, or use the slider, to swing it open.',
      edges: 'Tap an edge to switch it between hinge (green) and cut (red, dashed).',
    };
    this.app.toast(hints[t]);
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
    this.anim = { kind: 'forest', F, from: this.shell.forestAngles(F), to: this.shell.flatAngles(F), roots: null, t: 0, dur: 1.2, label: 'unfold' };
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
    this.app.toast(r.ok ? 'Closed, with the default cuts and hinges.' : `Closed. No overlap-free net found; best layout overlaps ${r.overlaps} times.`);
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
    if (a.kind === 'hinge') {
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
  }

  finishAnim(a) {
    if (a.kind === 'hinge') { this.endTurn(a.plan, false); return; }
    if (a.label === 'refold') for (const p of this.shell.panels) p.M.identity();
    this.updateMatrices();
    this.afterMotion(false);
    if (a.label === 'unfold') {
      this.app.toast(this.overlapPairs
        ? `Unfolded flat, but ${this.overlapPairs} panel pair${this.overlapPairs > 1 ? 's' : ''} overlap (red). Change cuts and hinges with the Edges tool.`
        : `Unfolded into a flat net: ${this.shell.panels.length} panels, no overlaps.`);
    } else {
      this.app.toast(`Refolded: ${this.describe()}.`);
    }
  }

  update(dt) {
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

  // ------------------------------------------------------------- edges

  toggleEdge(e) {
    if (!e.shared || e.locked) { this.app.toast('More than two panels meet at this edge, so it stays cut.'); return; }
    if (e.type === 'cut' && !this.shell.intact(e)) { this.app.toast('These panels are apart. Refold them before joining this edge with a hinge.'); return; }
    this.pushHistory();
    e.type = e.type === 'hinge' ? 'cut' : 'hinge';
    this.loopEdges.clear();
    const st = this.shell.stats();
    let msg = e.type === 'hinge' ? 'Edge is now a hinge.' : 'Edge is now a cut.';
    if (st.loops) msg += ` The hinges now form ${st.loops} closed loop${st.loops > 1 ? 's' : ''}; the net cannot unfold until you cut one.`;
    else if (st.groups > st.pieces) msg += ` The shell now opens into ${st.groups} separate pieces.`;
    this.refreshStyles();
    this.app.toast(msg);
    this.app.notify?.();
  }

  checkNet() {
    const r = this.shell.flatOverlaps();
    if (r.loops) this.app.toast(`Hinges form ${r.loops} closed loop${r.loops > 1 ? 's' : ''}: cut one edge in each loop.`);
    else if (r.pairs) this.app.toast(`This layout unfolds into ${r.pieces} piece${r.pieces > 1 ? 's' : ''}, but ${r.pairs} panel pair${r.pairs > 1 ? 's' : ''} would overlap.`);
    else this.app.toast(`This layout unfolds flat into ${r.pieces} piece${r.pieces > 1 ? 's' : ''} with no overlaps.`);
  }

  defaultNet() {
    this.tools.finishAll();
    this.stopAnim();
    this.pushHistory();
    for (const p of this.shell.panels) p.M.identity();
    const r = this.shell.defaultNet();
    this.updateMatrices();
    this.checkOverlaps();
    this.refreshStyles();
    this.app.toast(r.ok ? 'Default cuts and hinges restored (shell closed).' : `No overlap-free net found; best layout overlaps ${r.overlaps} times.`);
    this.app.notify?.();
  }

  // ------------------------------------------------------------- build

  requireClosed() {
    if (this.shell.isClosed()) return true;
    this.app.toast('Refold all before changing the solids.');
    return false;
  }

  selectFace(p) {
    this.sel.solidId = p ? p.solidId : null;
    this.sel.fi = p ? p.fi : null;
    this.refreshStyles();
    if (p) this.app.toast('Face picked. Add cube puts a new cube against it.');
    this.app.notify?.();
  }

  addCube() {
    if (!this.requireClosed()) return;
    let target = this.comp.get(this.sel.solidId);
    let fi = this.sel.fi;
    if (!target) {
      // No face picked: try the free faces of the last cube, +x first.
      target = this.comp.solids[this.comp.solids.length - 1];
      const order = [3, 2, 1, 0, 5];
      fi = order.find((f) => {
        const probe = this.probeAttach(target, f);
        return probe && !probe.blocker;
      });
      if (fi === undefined) { this.app.toast('Pick a free face first.'); return; }
    }
    const probe = this.probeAttach(target, fi);
    if (!probe) { this.app.toast('These faces do not match.'); return; }
    if (probe.blocker) { this.app.toast('Another cube already fills that space.'); return; }
    this.pushHistory();
    const s = this.comp.add('cube', EDGE, probe.pose.position, probe.pose.quaternion);
    this.rebuild();
    const p = this.shell.panels.find((q) => q.solidId === s.id && q.fi === fi);
    if (p) this.selectFace(p);
    this.app.toast(`Cube added. ${this.describe()}.`);
  }

  // Pose for a cube placed on face fi of a target, and what blocks it.
  probeAttach(target, fi) {
    const tf = target.worldFaces()[fi];
    const tm = template('cube');
    // Keep the neighbour's orientation so face numbering stays consistent.
    let best = null;
    for (let f = 0; f < tm.faces.length; f++) {
      for (let j = 0; j < tf.verts.length; j++) {
        const pose = alignFace(tm, f, EDGE, tf, j);
        if (!pose) continue;
        const ang = pose.quaternion.angleTo(target.quaternion);
        if (!best || ang < best.ang) best = { pose, ang };
      }
    }
    if (!best) return null;
    return { pose: best.pose, blocker: this.comp.overlapping('cube', EDGE, best.pose.position, best.pose.quaternion) };
  }

  duplicate() {
    const s = this.comp.get(this.sel.solidId);
    if (!s) { this.app.toast('Tap a cube face to pick the cube to duplicate.'); return; }
    this.addCube();
  }

  removeSolid() {
    if (!this.requireClosed()) return;
    const s = this.comp.get(this.sel.solidId);
    if (!s) { this.app.toast('Tap a face of the cube you want to remove.'); return; }
    if (this.comp.solids.length === 1) { this.app.toast('Keep at least one cube.'); return; }
    this.pushHistory();
    this.comp.remove(s.id);
    this.rebuild();
    this.app.toast(`Cube removed. ${this.describe()}.`);
  }

  // Turn the whole composition 90° about the vertical axis or tip it over.
  turnAll(axis) {
    if (!this.requireClosed()) return;
    this.pushHistory();
    const q = new THREE.Quaternion().setFromAxisAngle(axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const box = new THREE.Box3();
    for (const s of this.comp.solids) for (const v of s.worldVerts()) box.expandByPoint(v);
    const c = box.getCenter(new THREE.Vector3());
    for (const s of this.comp.solids) {
      s.position.sub(c).applyQuaternion(q).add(c);
      s.quaternion.premultiply(q);
      roundPose(s);
    }
    this.centre();
    this.rebuild();
    this.app.toast(axis === 'y' ? 'Turned a quarter turn.' : 'Tipped over: a different panel now rests on the table.');
  }

  // Rotate the picked cube in place (changes which of its faces is where).
  rotateSolid() {
    if (!this.requireClosed()) return;
    const s = this.comp.get(this.sel.solidId);
    if (!s) { this.app.toast('Tap a face of the cube you want to rotate.'); return; }
    this.pushHistory();
    s.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
    roundPose(s);
    this.rebuild();
    this.app.toast('Cube rotated a quarter turn in place. Its faces still match its neighbours, so the shell is unchanged in shape.');
  }

  // Ghost preview for moving a solid.
  showGhost(type, edge, position, quaternion, state) {
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
      this.root.add(this.ghost);
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
    const parts = [`${this.comp.solids.length} cube${this.comp.solids.length === 1 ? '' : 's'}`, `${s.panels} panels`, `${s.removed} internal faces removed`, `${s.hinges} hinges`, `${s.cuts} cuts`];
    if (s.loops) parts.push(`${s.loops} hinge loop${s.loops > 1 ? 's' : ''}`);
    if (this.overlapPairs) parts.push(`${this.overlapPairs} intersecting pair${this.overlapPairs > 1 ? 's' : ''}`);
    return parts.join(' · ');
  }

  // Rows for the VR control panel.
  panelRows(row, B, M, W, y0) {
    const s = this.state;
    const a = this;
    row(y0, 84, [
      { label: 'Build', action: () => a.setTool('build'), active: s.tool === 'build' },
      { label: 'Open', action: () => a.setTool('open'), active: s.tool === 'open' },
      { label: 'Edges', action: () => a.setTool('edges'), active: s.tool === 'edges' },
    ]);
    const y1 = y0 + 100, y2 = y0 + 190;
    if (s.tool === 'build') {
      row(y1, 78, [
        { label: 'Add cube', action: () => a.addCube() },
        { label: 'Duplicate', action: () => a.duplicate() },
        { label: 'Rotate', action: () => a.rotateSolid() },
        { label: 'Remove', action: () => a.removeSolid() },
      ]);
      row(y2, 78, [
        ...Object.entries(PRESETS).map(([k, p]) => ({ label: p.label, action: () => a.preset(k) })),
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
        { label: 'Default net', action: () => a.defaultNet() },
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
    row(y0 + 370, 78, [
      { label: 'Save', action: () => a.save() },
      { label: 'Load', action: () => a.load() },
      { label: 'Recenter', action: () => a.app.actions.recenter() },
    ]);
  }

  extent() {
    const box = new THREE.Box3();
    for (const s of this.comp.solids) for (const v of s.worldVerts()) box.expandByPoint(v);
    if (box.isEmpty()) return 0.3;
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.z, size.y) + 2 * EDGE;
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
    if (override === 'move') return this.beginCarry(ptr);
    const hit = ptr.pick();
    if (!hit) return false;
    const tool = this.ws.state.tool;
    const g = tool === 'build' ? this.beginBuild(ptr, hit)
      : tool === 'edges' ? this.beginEdge(ptr, hit)
        : this.beginOpen(ptr, hit);
    if (!g) return false;
    this.active.set(ptr.id, g);
    return true;
  }

  move(ptr) { const g = this.active.get(ptr.id); if (g) g.move(ptr); }

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
  update(dt) { this.ws.update(dt); }

  // A press counts as a drag once the point under it moves a few mm.
  dragDetector(ptr, hit) {
    const ws = this.ws;
    const n = hit.normal.clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point);
    const start = hit.point.clone();
    return (p) => {
      const w = p.onPlane ? p.onPlane(plane) : null;
      return !!w && w.distanceTo(start) > ws.edgeLen * 0.06;
    };
  }

  beginOpen(ptr, hit) {
    const ws = this.ws;
    const P = hit.panel;
    const moved = this.dragDetector(ptr, hit);
    const tapEdge = ws.sel.panel === P ? ws.edgeNear(P, hit.local, 0.2) : null;
    let swing = null, started = false;
    return {
      move: (p) => {
        if (!started) {
          if (!moved(p)) return;
          started = true;
          if (ws.sel.panel !== P) ws.select(P);
          swing = this.startSwing(ptr, hit);
        }
        if (swing) this.swingTo(swing, p);
      },
      end: () => {
        if (!started) {
          if (tapEdge && tapEdge !== ws.sel.hinge) ws.chooseHinge(tapEdge);
          else if (ws.sel.panel !== P) ws.select(P);
          return;
        }
        if (swing) ws.endTurn(swing.plan, true);
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
    const s = { plan, frame, theta0: ws.shell.angle(plan.e, plan.P, plan.Q), delta: 0, kind: ptr.kind };
    if (ptr.kind !== 'screen') {
      const gp = ptr.grabPoint(hit);
      s.stick = gp.stick;
      s.dist = hit.distance;
      s.offset = hit.point.clone().sub(gp.point);
    }
    return s;
  }

  swingTo(s, p) {
    const ws = this.ws;
    let d;
    if (p.kind === 'screen') {
      const o = ws.toLocal(p.ray.origin);
      const dir = ws.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
      d = angleFromRay(s.frame, o, dir, s.delta);
    } else {
      const gp = p.grabPoint(null, s.dist, s.stick);
      d = angleFromPoint(s.frame, ws.toLocal(gp.point.clone().add(s.offset)), s.delta);
    }
    const target = THREE.MathUtils.clamp(s.theta0 + d, -Math.PI, Math.PI);
    s.delta = target - s.theta0;
    ws.shell.setAngle(s.plan, target);
    ws.updateMatrices();
    ws.checkOverlaps();
    ws.refreshMaterials();
    ws.app.solidsUI?.syncSolidAngle();
  }

  beginEdge(ptr, hit) {
    const ws = this.ws;
    const e = ws.edgeNear(hit.panel, hit.local, 0.25);
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
    ws.app.toast('Move the cube next to another; it snaps when a face lines up.');
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
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -s.edge / 2);
        pos = new THREE.Ray(o, dir).intersectPlane(plane, new THREE.Vector3());
        if (!pos) return;
      }
      d.state = best ? 'snap' : 'free';
    } else {
      // Follow the hand, including its rotation.
      const local = ws.root.matrixWorld.clone().invert();
      const D = local.clone().multiply(p.grabMatrix()).multiply(d.grabStart.clone().invert()).multiply(ws.root.matrixWorld);
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
    if (ws.comp.overlapping(s.type, s.edge, pos, quat)) d.state = 'blocked';
    if (d.state === 'free' && pos.y < s.edge / 2 - 1e-4) pos.y = s.edge / 2;
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
      ws.app.toast('That spot overlaps another cube. The cube went back.');
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
    ws.app.toast(d.state === 'snap' ? `Snapped face to face. ${ws.describe()}.` : 'Placed on its own. Snap it to another cube to merge the shells.');
  }

  // Grip / squeeze: carry the whole composition.
  beginCarry(ptr) {
    const root = this.ws.root;
    this.ws.carried = true;
    root.updateMatrixWorld(true);
    const offset = ptr.grabMatrix().clone().invert().multiply(root.matrixWorld);
    this.active.set(ptr.id, {
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
