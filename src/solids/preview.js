import * as THREE from 'three';
import { SolidsWorkspace } from './workspace.js';
import { matchClosure } from './pieces.js';

// Linked previews: in Shape, the right-toolbar 3D toggle shows a translucent
// copy of the net's folded form beside it; in Solid, the 2D toggle shows the
// solid's net beside it. Both are built from the geometry being worked on and
// rebuilt when it changes. They are read-only: nothing is added to the
// picking list, the model's pose and history are never touched.

const W = SolidsWorkspace.prototype;
const CLOSE_TYPES = ['cube', 'tetra', 'octa', 'cubocta'];
const rnd = (x) => Math.round(x * 1e6);

W.previewKindNow = function () { return this.state.mode === 'shape' ? '3d' : '2d'; };
W.previewIsOn = function () { return !!(this.previewOn && this.previewOn[this.state.mode]); };

// What the counterpart of an object depends on (not on where it lies).
W.previewKey = function (comp, kind) {
  const sh = this.shell;
  const ids = new Set(comp.map((p) => p.id));
  const geo = comp.map((p) => `${p.id}:${p.verts.map((v) => `${rnd(v.x)},${rnd(v.y)},${rnd(v.z)}`).join(';')}`).join('|');
  const hs = sh.edges.filter((e) => e.shared && e.uses.every((u) => ids.has(u.panel.id))).map((e) => `${e.key}${e.type[0]}`).sort().join(',');
  const sm = this.comp.seams.filter(([a, b]) => ids.has(a.slice(0, a.lastIndexOf('#'))) || ids.has(b.slice(0, b.lastIndexOf('#')))).map((x) => x.join('~')).sort().join(',');
  return `${kind}|${geo}|${hs}|${sm}`;
};

const signedVolume = (polys) => {
  let vol = 0;
  for (const w of polys) for (let i = 1; i < w.length - 1; i++) vol += w[0].dot(w[i].clone().cross(w[i + 1])) / 6;
  return vol;
};

// The folded form of an object: where its faces are when it is closed.
W.previewFolded = function (comp) {
  const sh = this.shell;
  if (comp.length < 3) return { ok: false, reason: `${comp.length === 1 ? 'a single shape does' : 'two shapes do'} not fold into a solid` };
  if (this.restClosed(comp) || !this.restFlat(comp)) {
    const polys = comp.map((p) => ({ id: p.id, verts: p.verts.map((v) => v.clone()) }));
    return { ok: true, groups: [polys], open: !this.restClosed(comp) };
  }
  if (sh.hingeComponent(comp[0]).size !== comp.length) return { ok: false, reason: 'some pieces are joined to the rest only by cut edges, not hinges' };
  const m = matchClosure(comp, CLOSE_TYPES, (p) => sh.worldPoly(p));
  if (!m.reason) return { ok: true, groups: [comp.map((p) => ({ id: p.id, verts: m.closed.get(p).map((v) => v.clone()) }))] };
  // Not a known solid: fold it, joining the edges that meet.
  const F = sh.forest();
  const z = this.zipFold(comp, F, { rest: false });
  if (z.reason) return { ok: false, reason: z.reason };
  if (!z.pairs.length) return { ok: false, reason: 'no edges can be brought together to close it' };
  if (z.open.length) return { ok: false, reason: `it only partly folds (${z.open.length} edge${z.open.length === 1 ? '' : 's'} stay open; see Info → Last Refold after Refold)` };
  const saved = sh.panels.map((p) => p.M.clone());
  const ang = sh.forestAngles(F);
  for (const [p, v] of z.x) ang.set(p, v);
  const root = comp.find((p) => !F.parent.has(p));
  sh.applyForest(F, ang, new Map([[root, z.rootTo]]));
  const polys = comp.map((p) => ({ id: p.id, verts: sh.worldPoly(p) }));
  const inside = sh.overlaps((a, b) => comp.includes(a) && comp.includes(b)).pairs[0];
  sh.panels.forEach((p, i) => p.M.copy(saved[i]));
  if (inside) return { ok: false, reason: `faces P${inside[0].no} and P${inside[1].no} would pass through each other` };
  if (signedVolume(polys.map((q) => q.verts)) <= 0) return { ok: false, reason: 'it would close inside out' };
  return { ok: true, groups: [polys] };
};

// The net of an object: its faces laid flat along its current hinges, one
// group per hinge-connected piece.
W.previewNet = function (comp) {
  const sh = this.shell;
  const F = sh.forest();
  const mine = new Set(comp);
  const loop = F.loops.find((e) => mine.has(e.uses[0].panel));
  if (loop) return { ok: false, reason: `hinges form a closed loop (edge ${loop.no}), so it cannot lie flat` };
  const saved = sh.panels.map((p) => p.M.clone());
  const flat = sh.flatAngles(F);
  const rootOf = sh.pieceRoots(F);
  const roots = [...new Set(comp.map((p) => rootOf.get(p)))];
  const down = new THREE.Vector3(0, -1, 0);
  const rootMs = new Map();
  for (const r of roots) rootMs.set(r, new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(r.normal.clone().normalize(), down)));
  const ang = new Map();
  for (const p of comp) if (F.parent.has(p)) ang.set(p, flat.get(p));
  for (const [p, v] of sh.forestAngles(F)) if (!ang.has(p)) ang.set(p, v);
  sh.applyForest(F, ang, rootMs);
  const groups = [];
  let bad = null;
  for (const r of roots) {
    const piece = comp.filter((p) => rootOf.get(p) === r);
    const set = new Set(piece);
    const o = sh.overlaps((a, b) => set.has(a) && set.has(b)).pairs[0];
    if (o && !bad) bad = o;
    groups.push(piece.map((p) => ({ id: p.id, verts: sh.worldPoly(p) })));
  }
  sh.panels.forEach((p, i) => p.M.copy(saved[i]));
  if (bad) return { ok: false, reason: `its net would overlap itself (faces P${bad[0].no} and P${bad[1].no})` };
  return { ok: true, groups };
};

W.previewCache = new Map();

// Every object's counterpart, placed in a row to the right of everything on
// the surface (a form rests on it, a net lies on it).
W.previewLayout = function () {
  const sh = this.shell;
  const kind = this.previewKindNow();
  const comps = sh.pieces();
  const box = new THREE.Box3();
  for (const p of sh.panels) for (const v of sh.worldPoly(p)) box.expandByPoint(v);
  const gap = this.edgeLen * 0.6;
  let cursor = box.max.x + gap;
  const items = [], notes = [];
  const seen = new Set();
  comps.forEach((comp, k) => {
    const key = this.previewKey(comp, kind);
    seen.add(key);
    let f = this.previewCache.get(key);
    if (!f) { f = kind === '3d' ? this.previewFolded(comp) : this.previewNet(comp); this.previewCache.set(key, f); }
    if (!f.ok) { notes.push({ k, reason: f.reason }); return; }
    const cb = new THREE.Box3();
    for (const p of comp) for (const v of sh.worldPoly(p)) cb.expandByPoint(v);
    const zc = (cb.min.z + cb.max.z) / 2;
    for (const g of f.groups) {
      const gb = new THREE.Box3();
      for (const q of g) for (const v of q.verts) gb.expandByPoint(v);
      const d = new THREE.Vector3(cursor - gb.min.x, -gb.min.y, zc - (gb.min.z + gb.max.z) / 2);
      items.push({ k, open: !!f.open, polys: g.map((q) => q.verts.map((v) => v.clone().add(d))) });
      cursor += gb.max.x - gb.min.x + gap;
    }
  });
  for (const key of [...this.previewCache.keys()]) if (!seen.has(key) && this.previewCache.size > 24) this.previewCache.delete(key);
  return { items, notes, objects: comps.length };
};

W.previewClear = function () {
  if (this.pvGroup) {
    this.shellGroup.remove(this.pvGroup);
    this.pvGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.pvGroup = null;
  }
  this.pvItems = null;
  this.pvSig = '';
};

W.previewBuild = function (items) {
  this.previewClear();
  if (!items.length) return;
  const g = new THREE.Group();
  g.name = 'preview';
  g.userData.ui = true;
  const pos = [], idx = [], line = [];
  let n = 0;
  for (const it of items) {
    for (const w of it.polys) {
      for (const v of w) pos.push(v.x, v.y, v.z);
      for (let i = 1; i < w.length - 1; i++) idx.push(n, n + i, n + i + 1);
      for (let i = 0; i < w.length; i++) { const a = w[i], b = w[(i + 1) % w.length]; line.push(a.x, a.y, a.z, b.x, b.y, b.z); }
      n += w.length;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const fill = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#8fc7ff', transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, roughness: 0.7 }));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
  const edges = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#e6f3ff', transparent: true, opacity: 0.9 }));
  for (const o of [fill, edges]) { o.raycast = () => {}; o.renderOrder = 4; o.userData.ui = true; g.add(o); }
  g.raycast = () => {};
  this.shellGroup.add(g);
  this.pvGroup = g;
  this.pvItems = items;
};

// Rebuild the preview when what it shows changed. Returns the notes (objects
// that have no counterpart, and why).
W.previewRefresh = function () {
  if (!this.previewIsOn()) { this.previewHide(); return null; }
  const L = this.previewLayout();
  const sig = `${this.previewKindNow()}|${L.items.map((it) => it.polys.map((w) => w.map((v) => `${rnd(v.x)},${rnd(v.y)},${rnd(v.z)}`).join(';')).join('|')).join('#')}`;
  if (sig !== this.pvSig) {
    const had = !!(this.pvItems && this.pvItems.length);
    this.previewBuild(L.items);
    this.pvSig = sig;
    // The table and the camera frame follow what is shown.
    if (had || L.items.length) this.app.layoutTable?.();
  }
  const nk = L.notes.map((x) => `${x.k}:${x.reason}`).join('|');
  const changed = nk !== (this.pvNotes ?? '');
  this.pvNotes = nk;
  return { ...L, changed };
};

W.previewHide = function () {
  if (this.pvItems || this.pvGroup) { this.previewClear(); this.app.layoutTable?.(); }
  this.pvNotes = '';
};

W.previewSay = function (L, announce) {
  const kind = this.previewKindNow();
  const what = kind === '3d' ? 'folded form' : 'net';
  const name = kind === '3d' ? '3D' : '2D';
  if (!L.objects) { this.app.toast('Nothing to preview yet.', 3000); return; }
  const shown = L.objects - L.notes.length;
  if (!L.notes.length) {
    if (announce) this.app.toast(`${name} preview: the ${what} shows beside your model (translucent, read-only). It follows your edits.`, 4500);
    return;
  }
  const why = L.notes.slice(0, 2).map((x) => `${L.objects > 1 ? `object ${x.k + 1}: ` : ''}${x.reason}`).join('; ');
  this.app.toast(shown ? `${name} preview shown for ${shown} of ${L.objects} objects. No ${what} for ${why}.` : `No ${what} to show: ${why}. Your model stays as it is.`, 6000);
};

W.togglePreview = function () {
  this.previewOn = this.previewOn || { shape: false, solid: false };
  const m = this.state.mode;
  this.previewOn[m] = !this.previewOn[m];
  if (!this.previewOn[m]) {
    this.previewHide();
    this.app.toast(`${m === 'shape' ? '3D' : '2D'} preview off.`, 2500);
  } else {
    this.pvSig = '';
    const L = this.previewRefresh();
    if (L) { this.previewSay(L, true); if (L.items.length) this.frameView?.(true); }
  }
  this.app.notify?.();
};

const bounds0 = W.bounds;
W.bounds = function () {
  const box = bounds0.call(this);
  if (this.pvItems && this.previewIsOn()) {
    this.inspect.updateMatrix();
    this.shellGroup.updateMatrix();
    const V = this.inspect.matrix.clone().multiply(this.shellGroup.matrix);
    for (const it of this.pvItems) for (const w of it.polys) for (const v of w) box.expandByPoint(v.clone().applyMatrix4(V));
  }
  return box;
};

const update0 = W.update;
W.update = function (dt) {
  update0.call(this, dt);
  if (!this.previewIsOn()) { if (this.pvGroup) this.previewHide(); return; }
  if (this.anim) return;
  this.pvTick = (this.pvTick || 0) + 1;
  if (this.pvTick % 6) return;
  const L = this.previewRefresh();
  // A change of reason (an edit made it invalid, or valid again) is said once.
  if (L && L.changed && L.notes.length) this.previewSay(L, false);
};
