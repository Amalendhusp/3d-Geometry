import * as THREE from 'three';
import { flatTargets } from './layout.js';
import {
  resizable, handleAxes, autoAnchor, lockedAxes, resizePlan, solveShape, captureLayout,
  elPos, elEdge, elVid, edgeAxis, sameEl, AXIS_NAME, AXIS_LETTER,
} from './resize.js';

// Shape tool for box compositions: the flat net on the surface is the thing
// you edit, and a translucent assembled ghost floats above and behind it.
// Both are drawn from the same geometry and update together. Hovering an
// edge or corner in either view lights it in both (a seam edge appears
// twice in the net, a corner up to three times). Tap a net side or corner
// to pin it; drag another side or corner to resize. The pin stays where it
// is on the surface (a pinned side also keeps its length); the edges whose
// length will change are shown in orange in both views. Releasing commits
// one undoable change.

const COL = {
  hover: '#ffe08a', pin: '#2f7bff', change: '#ff8a1f', handle: '#f0b44c',
  ghostEdge: '#2b3150', ghostVert: '#2b3150', dot: '#ffffff', anchor: '#7fb2ff',
};

const CYL = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
const SPH = new THREE.SphereGeometry(1, 16, 12);
const CONE = new THREE.ConeGeometry(1, 2.4, 14);
const UPY = new THREE.Vector3(0, 1, 0);

export class ShapeEditor {
  constructor(ws) {
    this.ws = ws;
    this.active = false;
    this.pin = null;
    this.hover = null;
    this.drag = null;
    this.mats = new Map();
    this.labelMats = new Map();
    this.ghost = new THREE.Group();
    this.ghost.name = 'shape-ghost';
    this.ghost.userData.ui = false;
    this.ghost.visible = false;
    this.marks = new THREE.Group();
    this.marks.name = 'shape-marks';
    this.marks.userData.ui = true;
    this.ghostOrigin = new THREE.Vector3();
    ws.shellGroup.add(this.ghost, this.marks);
  }

  get shell() { return this.ws.shell; }

  supported() { return resizable(this.ws.comp); }

  // ----------------------------------------------------------- lifecycle

  enter() {
    const ws = this.ws;
    if (!this.supported()) { this.exit(); return false; }
    this.active = true;
    this.pin = null;
    this.hover = null;
    const sh = this.shell;
    let box;
    if (!sh.flatReport().ok) {
      // Where the net will lie once laid flat, so the ghost can be placed now.
      const t = flatTargets(sh, { keepFlat: true });
      const saved = sh.panels.map((p) => p.M.clone());
      sh.applyForest(t.F, t.angles, t.roots);
      box = this.netBox();
      sh.panels.forEach((p, i) => p.M.copy(saved[i]));
      // Laying the net out for editing is not an edit, so it is not an undo step.
      ws.layFlat({ record: false, prefix: 'Shape: the net is laid on the surface; the assembled form floats above it.' });
    } else box = this.netBox();
    this.placeGhost(box);
    this.refresh();
    return true;
  }

  exit() {
    this.active = false;
    this.pin = null;
    this.hover = null;
    this.drag = null;
    this.ghost.visible = false;
    this.clear(this.marks);
  }

  netBox() {
    const b = new THREE.Box3();
    for (const p of this.shell.panels) for (const v of this.shell.worldPoly(p)) b.expandByPoint(v);
    return b;
  }

  closedBox() {
    const b = new THREE.Box3();
    for (const p of this.shell.panels) for (const v of p.verts) b.expandByPoint(v);
    return b;
  }

  // Floating over the far part of the net, fixed while you work so it
  // never jumps; translucent, so the net shows through.
  placeGhost(netBox) {
    const c = netBox.getCenter(new THREE.Vector3());
    const depth = netBox.max.z - netBox.min.z;
    this.ghostOrigin.set(c.x, 0.09, netBox.min.z + depth * 0.2);
  }

  // Ghost content sits with its bottom centre on ghostOrigin.
  ghostOffset() {
    const b = this.closedBox();
    const c = b.getCenter(new THREE.Vector3());
    return new THREE.Vector3(this.ghostOrigin.x - c.x, this.ghostOrigin.y - b.min.y, this.ghostOrigin.z - c.z);
  }

  // Ghost box in the shell frame (for framing the view).
  ghostBox() {
    const b = this.closedBox();
    return b.translate(this.ghostOffset());
  }

  // ------------------------------------------------------------- drawing

  mat(color, opts = {}) {
    const key = `${color}|${opts.opacity || 1}`;
    if (!this.mats.has(key)) {
      this.mats.set(key, new THREE.MeshBasicMaterial({ color, transparent: (opts.opacity || 1) < 1, opacity: opts.opacity || 1, depthWrite: (opts.opacity || 1) >= 1 }));
    }
    return this.mats.get(key);
  }

  clear(g) {
    for (const c of [...g.children]) { g.remove(c); if (c.geometry && c.geometry !== CYL && c.geometry !== SPH && c.geometry !== CONE) c.geometry.dispose(); }
  }

  rod(group, a, b, r, color, opacity) {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-9) return;
    const m = new THREE.Mesh(CYL, this.mat(color, { opacity }));
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UPY, d.divideScalar(len));
    m.scale.set(r, len, r);
    m.renderOrder = 3;
    group.add(m);
  }

  dot(group, p, r, color, opacity) {
    const m = new THREE.Mesh(SPH, this.mat(color, { opacity }));
    m.position.copy(p);
    m.scale.setScalar(r);
    m.renderOrder = 3;
    group.add(m);
  }

  pinGlyph(group, p, r) {
    const m = new THREE.Mesh(CONE, this.mat(COL.pin));
    m.position.copy(p).add(new THREE.Vector3(0, r * 2.6, 0));
    m.rotation.x = Math.PI; // point down onto the element
    m.scale.setScalar(r);
    group.add(m);
    this.dot(group, p.clone().add(new THREE.Vector3(0, r * 5.2, 0)), r * 1.3, COL.pin);
  }

  // What is lit up: the focused 3D edge or vertex, the pinned element, and
  // the axes whose edges will change length.
  focus() {
    const sh = this.shell;
    const f = { edge: null, vid: null, axes: [], handle: null };
    const src = this.drag ? { net: this.drag.el } : this.hover;
    if (src && src.net) {
      f.edge = elEdge(sh, src.net);
      f.vid = elVid(sh, src.net);
      f.handle = src.net;
      const locked = lockedAxes(sh, this.pin);
      f.axes = this.drag ? this.drag.plan.axes : (sameEl(src.net, this.pin) ? [] : handleAxes(sh, src.net).filter((k) => !locked.includes(k)));
    } else if (src && src.ghost) {
      f.edge = src.ghost.edge || null;
      f.vid = src.ghost.vid ?? null;
    }
    return f;
  }

  refresh() {
    if (!this.active) { this.ghost.visible = false; this.clear(this.marks); return; }
    const sh = this.shell;
    const L = sh.edgeLen;
    const f = this.focus();
    const pinEdge = this.pin ? elEdge(sh, this.pin) : null;
    const pinVid = this.pin ? elVid(sh, this.pin) : null;

    // Ghost: translucent faces, edges, corners and size labels.
    this.clear(this.ghost);
    this.ghost.visible = true;
    const off = this.ghostOffset();
    const pos = [];
    for (const p of sh.panels) {
      for (let i = 1; i < p.verts.length - 1; i++) {
        for (const v of [p.verts[0], p.verts[i], p.verts[i + 1]]) pos.push(v.x + off.x, v.y + off.y, v.z + off.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    if (!this.faceMat) this.faceMat = new THREE.MeshStandardMaterial({ color: '#c9d6ea', transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, roughness: 0.7 });
    const faces = new THREE.Mesh(g, this.faceMat);
    faces.renderOrder = 1;
    this.ghost.add(faces);
    const vpos = new Map();
    for (const p of sh.panels) p.vid.forEach((id, i) => { if (!vpos.has(id)) vpos.set(id, p.verts[i]); });
    for (const e of sh.edges) {
      const a = e.a.clone().add(off), b = e.b.clone().add(off);
      const ax = edgeAxis(e);
      let color = COL.ghostEdge, r = L * 0.012;
      if (f.axes.includes(ax)) { color = COL.change; r = L * 0.018; }
      if (pinEdge === e) { color = COL.pin; r = L * 0.024; }
      if (f.edge === e) { color = COL.hover; r = L * 0.03; }
      this.rod(this.ghost, a, b, r, color);
    }
    for (const [id, v] of vpos) {
      let color = COL.ghostVert, r = L * 0.022;
      if (pinVid === id) { color = COL.pin; r = L * 0.04; }
      if (f.vid === id) { color = COL.hover; r = L * 0.065; }
      this.dot(this.ghost, v.clone().add(off), r, color);
    }
    this.sizeLabels(off, f.axes);

    // Net marks: handles at corners, the focused element in all its
    // copies, the pin, the edges that will change, the anchor while dragging.
    this.clear(this.marks);
    const lift = new THREE.Vector3(0, L * 0.012, 0);
    for (const p of sh.panels) {
      const w = sh.worldPoly(p).map((v) => v.add(lift));
      const n = w.length;
      for (let i = 0; i < n; i++) {
        const e = p.edges[i];
        const a = w[i], b = w[(i + 1) % n];
        const isPin = this.pin && this.pin.kind === 'side' && this.pin.pid === p.id && this.pin.i === i;
        const isHandle = f.handle && f.handle.kind === 'side' && f.handle.pid === p.id && f.handle.i === i;
        if (isPin) this.rod(this.marks, a, b, L * 0.03, COL.pin);
        else if (isHandle) this.rod(this.marks, a, b, L * 0.034, COL.handle);
        else if (f.edge === e) this.rod(this.marks, a, b, L * 0.026, COL.hover);
        else if (f.axes.includes(edgeAxis(e))) this.rod(this.marks, a, b, L * 0.016, COL.change);
        // A grip mark at every side's middle says "drag me".
        if (!isPin && !isHandle && f.edge !== e) {
          const m = a.clone().lerp(b, 0.5), half = b.clone().sub(a).multiplyScalar(0.1);
          this.rod(this.marks, m.clone().sub(half), m.clone().add(half), L * 0.014, COL.dot, 0.8);
        }
        let color = COL.dot, r = L * 0.03, op = 0.9;
        const isPinC = this.pin && this.pin.kind === 'corner' && this.pin.pid === p.id && this.pin.i === i;
        const isHandleC = f.handle && f.handle.kind === 'corner' && f.handle.pid === p.id && f.handle.i === i;
        if (f.vid === p.vid[i]) { color = COL.hover; r = L * 0.055; op = 1; }
        if (isHandleC) { color = COL.handle; r = L * 0.05; op = 1; }
        if (isPinC) { color = COL.pin; r = L * 0.045; op = 1; }
        this.dot(this.marks, a, r, color, op);
      }
    }
    if (this.pin) this.pinGlyph(this.marks, elPos(sh, this.pin).add(lift), L * 0.035);
    if (this.drag && this.drag.auto) this.dot(this.marks, elPos(sh, this.drag.anchor).add(lift), L * 0.045, COL.anchor);
  }

  sizeLabels(off, axes) {
    if (typeof document === 'undefined') return;
    const b = this.closedBox().translate(off);
    const size = b.getSize(new THREE.Vector3());
    const L = this.shell.edgeLen;
    const spots = [
      new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y - L * 0.12, b.max.z),
      new THREE.Vector3(b.min.x - L * 0.12, (b.min.y + b.max.y) / 2, b.max.z),
      new THREE.Vector3(b.max.x + L * 0.12, b.min.y - L * 0.05, (b.min.z + b.max.z) / 2),
    ];
    [size.x, size.y, size.z].forEach((v, k) => {
      const text = `${AXIS_LETTER[k]} ${(v * 1000).toFixed(0)} mm`;
      const s = new THREE.Sprite(this.labelMat(text, axes.includes(k)));
      s.position.copy(spots[k]);
      const h = L * 0.22;
      s.scale.set(h * s.material.userData.aspect, h, 1);
      s.renderOrder = 4;
      this.ghost.add(s);
    });
  }

  labelMat(text, hot) {
    const key = `${text}|${hot}`;
    if (this.labelMats.has(key)) return this.labelMats.get(key);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = '700 40px "Zen Kaku Gothic New", system-ui, sans-serif';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width + 28);
    c.width = w; c.height = 60;
    ctx.font = font;
    ctx.fillStyle = hot ? '#ff8a1f' : 'rgba(24,28,56,0.85)';
    ctx.beginPath(); ctx.roundRect(0, 0, w, 60, 14); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    m.userData.aspect = w / 60;
    if (this.labelMats.size > 80) this.labelMats.clear();
    this.labelMats.set(key, m);
    return m;
  }

  // ------------------------------------------------------------- picking

  // A net side or corner near a point on a panel (panel rest frame).
  netElement(panel, local, wide = false) {
    if (!panel || !local) return null;
    const L = this.shell.edgeLen;
    const n = panel.verts.length;
    let best = null, bd = L * (wide ? 0.2 : 0.15);
    for (let i = 0; i < n; i++) {
      const d = panel.verts[i].distanceTo(local);
      if (d < bd) { bd = d; best = { kind: 'corner', pid: panel.id, i }; }
    }
    if (best) return best;
    bd = L * (wide ? 0.17 : 0.13);
    for (let i = 0; i < n; i++) {
      const a = panel.verts[i], b = panel.verts[(i + 1) % n];
      const ab = b.clone().sub(a);
      const t = THREE.MathUtils.clamp(local.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
      const d = local.distanceTo(a.clone().addScaledVector(ab, t));
      if (d < bd) { bd = d; best = { kind: 'side', pid: panel.id, i }; }
    }
    return best;
  }

  ghostParts() {
    const sh = this.shell;
    this.ghost.updateMatrixWorld(true);
    const M = this.ghost.matrixWorld;
    const off = this.ghostOffset();
    const verts = new Map();
    for (const p of sh.panels) p.vid.forEach((id, i) => { if (!verts.has(id)) verts.set(id, p.verts[i].clone().add(off).applyMatrix4(this.ws.shellGroup.matrixWorld)); });
    const edges = sh.edges.map((e) => ({ e, a: e.a.clone().add(off).applyMatrix4(this.ws.shellGroup.matrixWorld), b: e.b.clone().add(off).applyMatrix4(this.ws.shellGroup.matrixWorld) }));
    return { verts, edges, M };
  }

  // Ghost corner or edge under a ray (world).
  pickGhost(ray) {
    if (!this.active) return null;
    this.ws.root.updateMatrixWorld(true);
    const { verts, edges } = this.ghostParts();
    let best = null;
    const tolAt = (t) => Math.max(0.006, t * 0.014);
    for (const [vid, v] of verts) {
      const t = v.clone().sub(ray.origin).dot(ray.direction);
      if (t <= 0) continue;
      const d = ray.distanceToPoint(v);
      if (d < tolAt(t) * 1.3 && (!best || d / tolAt(t) < best.score)) best = { score: d / tolAt(t) * 0.8, ghost: { kind: 'vertex', vid }, point: v.clone(), distance: t };
    }
    for (const { e, a, b } of edges) {
      const pOnRay = new THREE.Vector3(), pOnSeg = new THREE.Vector3();
      const d2 = ray.distanceSqToSegment(a, b, pOnRay, pOnSeg);
      const t = pOnRay.clone().sub(ray.origin).length();
      const d = Math.sqrt(d2);
      if (d < tolAt(t) && (!best || d / tolAt(t) < best.score)) best = { score: d / tolAt(t), ghost: { kind: 'edge', edge: e }, point: pOnSeg.clone(), distance: t };
    }
    if (!best) return null;
    return { panel: null, ghost: best.ghost, point: best.point, distance: best.distance, normal: ray.direction.clone().negate() };
  }

  // Ghost corner or edge near a point (hands).
  nearGhost(point, maxDist) {
    if (!this.active) return null;
    this.ws.root.updateMatrixWorld(true);
    const { verts, edges } = this.ghostParts();
    const tol = Math.max(maxDist, 0.02);
    let best = null;
    for (const [vid, v] of verts) {
      const d = v.distanceTo(point);
      if (d < tol * 1.2 && (!best || d * 0.8 < best.d)) best = { d: d * 0.8, ghost: { kind: 'vertex', vid }, point: v.clone() };
    }
    for (const { e, a, b } of edges) {
      const ab = b.clone().sub(a);
      const t = THREE.MathUtils.clamp(point.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
      const q = a.clone().addScaledVector(ab, t);
      const d = q.distanceTo(point);
      if (d < tol && (!best || d < best.d)) best = { d, ghost: { kind: 'edge', edge: e }, point: q };
    }
    if (!best) return null;
    return { panel: null, ghost: best.ghost, point: best.point, distance: best.d, normal: new THREE.Vector3(0, 1, 0), near: true };
  }

  // --------------------------------------------------------------- hover

  setHover(hit, ptr) {
    let h = null;
    if (hit && hit.ghost) h = { ghost: hit.ghost };
    else if (hit && hit.panel) {
      const el = this.netElement(hit.panel, hit.local, ptr && ptr.kind === 'ray' && !hit.near);
      if (el) h = { net: el };
    }
    const same = (a, b) => (!a && !b) || (a && b && ((a.net && b.net && sameEl(a.net, b.net))
      || (a.ghost && b.ghost && a.ghost.kind === b.ghost.kind && a.ghost.edge === b.ghost.edge && a.ghost.vid === b.ghost.vid)));
    if (same(h, this.hover)) return;
    this.hover = h;
    this.refresh();
  }

  // Words for the element in focus.
  describe(el) {
    const sh = this.shell;
    if (el.kind === 'side') {
      const e = elEdge(sh, el);
      const copies = sh.panels.reduce((s, p) => s + p.edges.filter((x) => x === e).length, 0);
      const k = edgeAxis(e);
      return `edge ${e.no} (${k >= 0 ? `along ${AXIS_LETTER[k]}, ` : ''}${(e.a.distanceTo(e.b) * 1000).toFixed(0)} mm${copies > 1 && e.type !== 'hinge' ? ', a seam shown twice in the net' : ''})`;
    }
    const vid = elVid(sh, el);
    const copies = sh.panels.reduce((s, p) => s + p.vid.filter((x) => x === vid).length, 0);
    return `corner${copies > 1 ? ` (shown ${copies} times in the net)` : ''}`;
  }

  togglePin(el) {
    const ws = this.ws;
    if (sameEl(this.pin, el)) {
      this.pin = null;
      ws.app.toast('Pin removed. Without a pin, the side or corner opposite the one you drag stays put.');
    } else {
      this.pin = el;
      const locked = lockedAxes(this.shell, el);
      ws.app.toast(`Pinned ${this.describe(el)}: it stays where it is${locked.length ? ` and keeps its length, so the ${AXIS_NAME[locked[0]]} stays ${(this.size().getComponent(locked[0]) * 1000).toFixed(0)} mm` : ''}. Now drag another side or corner.`, 6000);
    }
    ws.app.haptic?.();
    this.refresh();
    ws.app.notify?.();
  }

  size() { return this.closedBox().getSize(new THREE.Vector3()); }

  sizeText(s = this.size()) { return `${(s.x * 1000).toFixed(0)} × ${(s.y * 1000).toFixed(0)} × ${(s.z * 1000).toFixed(0)} mm`; }

  // --------------------------------------------------------------- drag

  // Start resizing from a net element; returns the drag state or null.
  startResize(el) {
    const ws = this.ws;
    const sh = this.shell;
    if (!sh.flatReport().ok) { ws.app.toast('Wait for the net to lie flat, then drag a side or corner.'); return null; }
    if (sameEl(el, this.pin)) { ws.app.toast('That one is pinned. Drag a different side or corner, or tap it to unpin.'); return null; }
    const anchor = this.pin || autoAnchor(sh, el);
    const locked = lockedAxes(sh, this.pin);
    const plan = resizePlan(ws.comp, sh, el, anchor, locked);
    if (!plan.axes.length) {
      const why = handleAxes(sh, el).every((k) => locked.includes(k))
        ? `the pinned edge keeps the ${AXIS_NAME[locked[0]]} fixed`
        : 'with this pin, that side does not move';
      ws.app.toast(`Can't resize from there: ${why}. Drag a side across a different direction, or move the pin.`, 5000);
      return null;
    }
    ws.pushHistory();
    const d = { el, anchor, auto: !this.pin, plan, A0: elPos(sh, anchor), H0: elPos(sh, el), before: ws.history[ws.history.length - 1], size0: this.size() };
    this.drag = d;
    this.refresh();
    return d;
  }

  // Pointer at a surface point (shell frame).
  dragTo(d, P0, P) {
    const ws = this.ws;
    const dd = new THREE.Vector2(P.x - P0.x, P.z - P0.z);
    let shape = solveShape(d.plan, dd);
    shape = this.clampShape(shape);
    if (!shape) return;
    if (shape.distanceTo(ws.comp.shape) < 1e-7) return;
    ws.comp.shape.copy(shape);
    ws.reshapeNet(d.plan.layout, d.anchor, d.A0);
    const s = this.size();
    const parts = d.plan.axes.map((k) => `${AXIS_NAME[k]} ${(s.getComponent(k) * 1000).toFixed(0)} mm`);
    ws.setTag(`Resize · ${parts.join(' · ')}`, ws.shellGroup.localToWorld(elPos(this.shell, d.el)));
  }

  // Keep sizes within the shape limits; null if no valid size is near.
  clampShape(shape) {
    const ws = this.ws;
    const s = shape.clone();
    const base = ws.shapeSize(new THREE.Vector3(1, 1, 1));
    const edge = this.shell.edgeLen / Math.min(ws.comp.shape.x, ws.comp.shape.y, ws.comp.shape.z);
    for (let k = 0; k < 3; k++) {
      const lo = Math.max(0.2, 0.0101 / edge);
      const hi = Math.min(5, 0.899 / base.getComponent(k));
      s.setComponent(k, THREE.MathUtils.clamp(s.getComponent(k), lo, hi));
    }
    return ws.shapeProblem(s) ? null : s;
  }

  endResize(d) {
    const ws = this.ws;
    this.drag = null;
    ws.hideTag();
    const s = this.size();
    if (s.distanceTo(d.size0) < 1e-6) {
      ws.history.pop();
      this.refresh();
      ws.app.toast('Size unchanged.');
      return;
    }
    const sh = this.shell;
    const closed = sh.edges.every((e) => e.uses.length === 2);
    const planar = sh.planarity() < 1e-9;
    const seams = sh.edges.every((e) => {
      if (e.uses.length < 2) return false;
      const L = e.uses.map((u) => { const w = sh.worldPoly(u.panel); return w[u.i].distanceTo(w[(u.i + 1) % w.length]); });
      return Math.abs(L[0] - L[1]) < 1e-9;
    });
    this.refresh();
    ws.app.toast(`Resized to ${this.sizeText(s)} (width × height × depth). Closed ${closed ? '✓' : '✗'} · faces planar ${planar ? '✓' : '✗'} · seam lengths match ${seams ? '✓' : '✗'} · ${ws.foldText()}. One step: Undo puts it back.`, 7000);
    ws.app.notify?.();
  }

  cancelResize(d) {
    const ws = this.ws;
    this.drag = null;
    ws.hideTag();
    ws.history.pop();
    ws.restoreSnapshot(d.before);
  }
}
