import * as THREE from 'three';
import { flatTargets, netPoses } from './layout.js';
import { editModel, editTo, editPath, scalePath, groupPlane, faceShapes, changes, editsFrom } from './vertexedit.js';
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
  hover: '#ffe08a', pin: '#2f7bff', change: '#ff6a00', handle: '#f0b44c', sel: '#ffb300',
  ghostEdge: '#2b3150', ghostVert: '#2b3150', dot: '#ffffff', anchor: '#7fb2ff', fold: '#17a45f',
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
    // Two modes. Resize: stretch a box on its net (sizes change, angles stay).
    // Edit: move vertices and edges of the assembled form freely; the net
    // is regenerated from it.
    this.mode = 'resize';
    this.pins = new Set(); // vertex keys pinned in Edit
    this.hoverE = null;
    this.editDrag = null;
    this.focusKey = null;
    this.frozen = null;
    this.lastChange = null;
    this.selected = new Set(); // vertex keys selected as a group in Edit
    this.tapMode = 'pin'; // what a tap does in Edit: 'pin' or 'select'
  }

  get shell() { return this.ws.shell; }

  supported() { return resizable(this.ws.comp); }

  // ----------------------------------------------------------- lifecycle

  // Back to Reshape from Arrange: everything (pins, selection, mode, the
  // ghost) is kept; only a net that is no longer flat is laid flat again.
  resume() {
    const ws = this.ws;
    this.active = true;
    this.hover = null;
    this.hoverE = null;
    if (ws.anim) ws.stopAnim();
    if (!this.shell.flatReport().ok) ws.layFlat({ record: false, prefix: 'The net is laid on the surface for reshaping.' });
    this.placeGhost(this.netBox());
    if (this.mode === 'edit') this.frozen = this.ghostOffset();
    this.refresh();
    return true;
  }

  enter({ quiet = false } = {}) {
    const ws = this.ws;
    this.active = true;
    this.pin = null;
    this.hover = null;
    this.hoverE = null;
    this.pins = new Set();
    this.lastChange = null;
    this.frozen = null;
    this.selected = new Set();
    this.tapMode = 'pin';
    // Edit vertices is the main mode; Resize (boxes) is one tap away.
    this.mode = 'edit';
    const sh = this.shell;
    let box;
    if (!sh.flatReport().ok) {
      // Where the net will lie once laid flat, so the ghost can be placed now.
      const t = flatTargets(sh, { keepFlat: true });
      const saved = sh.panels.map((p) => p.M.clone());
      sh.applyForest(t.F, t.angles, t.roots);
      box = this.netBox();
      sh.panels.forEach((p, i) => p.M.copy(saved[i]));
      // Laying the net out for editing is not an edit, so it is not an undo
      // step. (Entering Arrange already started laying it flat.)
      if (!(quiet && ws.anim)) ws.layFlat({ record: false, prefix: quiet ? '' : 'Shape: the net is laid on the surface; the assembled form floats above it.' });
    } else box = this.netBox();
    this.placeGhost(box);
    // Drawing scale for Edit: steady while edges get shorter or longer.
    this.L0 = Math.max(sh.edgeLen, 0.05);
    if (this.mode === 'edit') this.frozen = this.ghostOffset();
    this.refresh();
    return true;
  }

  exit() {
    this.active = false;
    this.pin = null;
    this.hover = null;
    this.hoverE = null;
    this.drag = null;
    this.editDrag = null;
    this.frozen = null;
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
    this.ghostOrigin.set(c.x, 0.12, netBox.min.z + depth * 0.2);
  }

  // Ghost content sits with its bottom centre on ghostOrigin. While editing
  // vertices the offset is frozen, so pinned vertices stay put in space.
  ghostOffset() {
    if (this.frozen) return this.frozen.clone();
    const b = this.closedBox();
    const c = b.getCenter(new THREE.Vector3());
    return new THREE.Vector3(this.ghostOrigin.x - c.x, this.ghostOrigin.y - b.min.y, this.ghostOrigin.z - c.z);
  }

  // Ghost box in the shell frame (for framing the view).
  // Box (shell frame) around ghost corners given by vertex key.
  keysBox(keys) {
    const m = editModel(this.shell);
    const off = this.ghostOffset();
    const b = new THREE.Box3();
    for (const k of keys) if (m.pos.has(k)) b.expandByPoint(m.pos.get(k).clone().add(off));
    return b;
  }

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
    if (this.mode === 'edit') { this.refreshEdit(); return; }
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
    this.faceMesh = null;
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
    this.badge(off, 'Resize (box)');

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
    const ring = this.ringWorld();
    if (ring) {
      const P = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(ring.n, ring.c), new THREE.Vector3());
      if (P) {
        const t = P.distanceTo(ray.origin);
        if (Math.abs(P.distanceTo(ring.c) - ring.R) < Math.max(0.008, t * 0.015)) return { panel: null, ghost: { kind: 'ring' }, point: P, distance: t, normal: ray.direction.clone().negate() };
      }
    }
    const { verts, edges } = this.ghostParts();
    // The first ghost face the ray meets hides corners and edges behind it.
    let faceHit = null;
    if (this.mode === 'edit' && this.faceMesh) {
      this.faceMesh.updateMatrixWorld(true);
      faceHit = new THREE.Raycaster(ray.origin, ray.direction, 0, 20).intersectObject(this.faceMesh, false)[0] || null;
    }
    const front = (t, tol) => !faceHit || t <= faceHit.distance + tol;
    let best = null;
    const tolAt = (t) => Math.max(0.006, t * 0.014);
    for (const [vid, v] of verts) {
      const t = v.clone().sub(ray.origin).dot(ray.direction);
      if (t <= 0 || !front(t, tolAt(t))) continue;
      const d = ray.distanceToPoint(v);
      // The grab point is on the ray, so a still press never counts as a drag.
      if (d < tolAt(t) * 1.3 && (!best || d / tolAt(t) < best.score)) best = { score: d / tolAt(t) * 0.8, ghost: { kind: 'vertex', vid }, point: ray.at(t, new THREE.Vector3()), distance: t };
    }
    // A corner within reach always wins over the edges that meet there.
    for (const { e, a, b } of best ? [] : edges) {
      const pOnRay = new THREE.Vector3(), pOnSeg = new THREE.Vector3();
      const d2 = ray.distanceSqToSegment(a, b, pOnRay, pOnSeg);
      const t = pOnRay.clone().sub(ray.origin).length();
      const d = Math.sqrt(d2);
      if (!front(t, tolAt(t))) continue;
      if (d < tolAt(t) && (!best || d / tolAt(t) < best.score)) best = { score: d / tolAt(t), ghost: { kind: 'edge', edge: e }, point: pOnRay.clone(), distance: t };
    }
    if (!best && faceHit) return { panel: null, ghost: { kind: 'face', panel: this.faceTriPanel[faceHit.faceIndex] }, point: faceHit.point.clone(), distance: faceHit.distance, normal: ray.direction.clone().negate() };
    if (!best) return null;
    return { panel: null, ghost: best.ghost, point: best.point, distance: best.distance, normal: ray.direction.clone().negate() };
  }

  // Ghost corner or edge near a point (hands).
  nearGhost(point, maxDist) {
    if (!this.active) return null;
    this.ws.root.updateMatrixWorld(true);
    const ring = this.ringWorld();
    if (ring) {
      const off = point.clone().sub(ring.c);
      const h = off.dot(ring.n);
      const inPlane = off.addScaledVector(ring.n, -h).length();
      if (Math.abs(h) < Math.max(maxDist, 0.02) && Math.abs(inPlane - ring.R) < Math.max(maxDist, 0.02)) return { panel: null, ghost: { kind: 'ring' }, point: point.clone(), distance: Math.abs(h), normal: ring.n.clone(), near: true };
    }
    const { verts, edges } = this.ghostParts();
    const tol = Math.max(maxDist, 0.02);
    let best = null;
    for (const [vid, v] of verts) {
      const d = v.distanceTo(point);
      if (d < tol * 1.2 && (!best || d * 0.8 < best.d)) best = { d: d * 0.8, ghost: { kind: 'vertex', vid }, point: v.clone() };
    }
    for (const { e, a, b } of best ? [] : edges) {
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
    if (this.mode === 'edit') {
      const sel = this.selection(hit, ptr);
      const k = (x) => (x ? `${x.kind}:${x.keys.join(';')}` : '');
      if (k(sel) === k(this.hoverE)) return;
      this.hoverE = sel;
      // The corner you last pointed at is the one Triangulate acts on.
      if (sel && sel.kind === 'vertex') this.focusKey = sel.keys[0];
      this.refresh();
      return;
    }
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
    if (ws.comp.isEdited()) { ws.app.toast('This form has free-form edits. Resize works on the unedited box: Reset edits first, or switch to Edit.', 5000); return null; }
    if (!this.supported()) { ws.app.toast('Resize drags work on boxes (cubes). For these solids use Edit vertices, or type sizes.', 5000); return null; }
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

  // =============================================================== Edit
  // Free-form editing of the assembled form (the ghost). Pinned vertices
  // never move; dragged ones follow the pointer; faces with four or more
  // corners stay planar, and neighbours that must move for that are shown
  // in orange in both views. The net is regenerated on every move.

  setMode(m) {
    const ws = this.ws;
    if (!this.active || m === this.mode) return;
    if (m === 'resize' && ws.comp.isEdited()) {
      ws.app.toast('This form has free-form edits. Resize works on the unedited box: Reset edits first, or keep editing.', 5000);
      return;
    }
    this.mode = m;
    this.hover = this.hoverE = null;
    this.pin = null;
    this.selected = new Set();
    this.frozen = null;
    if (m === 'edit') this.frozen = this.ghostOffset();
    this.refresh();
    ws.app.toast(m === 'edit'
      ? 'Edit vertices: drag a corner or edge of the floating form (left/right and up/down; hold Shift to slide it level). Tap one to pin it; Pin base pins the bottom. Faces stay flat: corners that must follow turn orange. The net below is redrawn as you go.'
      : 'Resize: drag a side or corner of the net to change the box sizes; angles stay square.', 7000);
    ws.app.notify?.();
  }

  keyOf(vid) { return this.shell.vkeys[vid]; }

  edgeKeys(e) {
    const u = e.uses[0];
    const p = u.panel, n = p.vid.length;
    return [this.keyOf(p.vid[u.i]), this.keyOf(p.vid[(u.i + 1) % n])];
  }

  pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

  // Vertex keys picked by a hit on the ghost (corner, edge, face) or the net (corner, side).
  selection(hit, ptr) {
    if (!hit) return null;
    if (hit.ghost) {
      const g = hit.ghost;
      if (g.kind === 'ring') return { kind: 'ring', keys: [...this.selected], onGhost: true };
      if (g.kind === 'vertex') return { kind: 'vertex', keys: [this.keyOf(g.vid)], onGhost: true };
      if (g.kind === 'edge') return { kind: 'edge', keys: this.edgeKeys(g.edge), onGhost: true };
      if (g.kind === 'face' && g.panel) return { kind: 'face', keys: g.panel.vid.map((v) => this.keyOf(v)), onGhost: true };
      return null;
    }
    if (hit.panel) {
      const el = this.netElement(hit.panel, hit.local, ptr && ptr.kind === 'ray' && !hit.near);
      if (!el) return null;
      const p = this.shell.panelById.get(el.pid);
      if (el.kind === 'corner') return { kind: 'vertex', keys: [this.keyOf(p.vid[el.i])], onGhost: false };
      return { kind: 'edge', keys: [this.keyOf(p.vid[el.i]), this.keyOf(p.vid[(el.i + 1) % p.vid.length])], onGhost: false };
    }
    return null;
  }

  // Lengths (mm) of the edges at a vertex, from closed-form positions.
  edgesAt(key) {
    const sh = this.shell;
    const out = [];
    for (const e of sh.edges) {
      const [a, b] = this.edgeKeys(e);
      if (a === key || b === key) out.push({ e, len: e.a.distanceTo(e.b) });
    }
    return out;
  }

  refreshEdit() {
    const sh = this.shell;
    const L = this.L0 || 0.12;
    this.clear(this.ghost);
    this.ghost.visible = true;
    const off = this.ghostOffset();
    // Faces (kept for picking), translucent.
    const pos = [];
    this.faceTriPanel = [];
    for (const p of sh.panels) {
      for (let i = 1; i < p.verts.length - 1; i++) {
        for (const v of [p.verts[0], p.verts[i], p.verts[i + 1]]) pos.push(v.x + off.x, v.y + off.y, v.z + off.z);
        this.faceTriPanel.push(p);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    if (!this.faceMat) this.faceMat = new THREE.MeshStandardMaterial({ color: '#c9d6ea', transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, roughness: 0.7 });
    const faces = new THREE.Mesh(g, this.faceMat);
    faces.renderOrder = 1;
    this.ghost.add(faces);
    this.faceMesh = faces;

    const hov = this.hoverE;
    const hovKeys = new Set(hov ? hov.keys : []);
    const hovEdge = hov && hov.kind === 'edge' ? this.pairKey(...hov.keys) : null;
    const drag = new Set(this.editDrag ? this.editDrag.keys : []);
    const ch = this.lastChange || { moved: [], edges: [] };
    const moved = new Set(ch.moved);
    const chEdges = new Set(ch.edges.map(([a, b]) => this.pairKey(a, b)));
    const colourOfEdge = (e) => {
      const [a, b] = this.edgeKeys(e);
      const pk = this.pairKey(a, b);
      if (pk === hovEdge) return [COL.hover, 2.6];
      if (drag.has(a) && drag.has(b)) return [COL.handle, 2.2];
      if (this.pins.has(a) && this.pins.has(b)) return [COL.pin, 1.8];
      if (this.selected.has(a) && this.selected.has(b)) return [COL.sel, 1.8];
      if (chEdges.has(pk)) return [COL.change, 1.6];
      if (e.diagonal) return [COL.fold, 1.5];
      return null;
    };
    const colourOfVert = (k) => {
      if (drag.has(k)) return [COL.handle, 4.6];
      if (hovKeys.has(k) && hov.kind === 'vertex') return [COL.hover, 5];
      if (this.pins.has(k)) return [COL.pin, 4];
      if (moved.has(k)) return [COL.change, 4.2];
      if (this.selected.has(k)) return [COL.sel, 4.2];
      if (hovKeys.has(k)) return [COL.hover, 3.2];
      return null;
    };

    // Ghost edges and corners.
    for (const e of sh.edges) {
      const c = colourOfEdge(e);
      this.rod(this.ghost, e.a.clone().add(off), e.b.clone().add(off), L * 0.011 * (c ? c[1] : 1), c ? c[0] : COL.ghostEdge);
    }
    const vpos = new Map();
    for (const p of sh.panels) p.vid.forEach((id, i) => { const k = this.keyOf(id); if (!vpos.has(k)) vpos.set(k, p.verts[i]); });
    for (const [k, v] of vpos) {
      const c = colourOfVert(k);
      this.dot(this.ghost, v.clone().add(off), L * 0.022 * (c ? c[1] / 2 : 1), c ? c[0] : COL.ghostVert);
      if (this.pins.has(k)) this.pinGlyph(this.ghost, v.clone().add(off), L * 0.028);
    }
    // Lengths of the edges at the vertex in focus.
    const fk = (this.editDrag && this.editDrag.keys.length === 1 ? this.editDrag.keys[0] : null)
      || (hov && hov.kind === 'vertex' ? hov.keys[0] : null) || this.focusKey;
    if (fk && typeof document !== 'undefined') {
      for (const { e, len } of this.edgesAt(fk)) {
        const s = new THREE.Sprite(this.labelMat(`${(len * 1000).toFixed(0)} mm`, chEdges.has(this.pairKey(...this.edgeKeys(e)))));
        s.position.copy(e.a).add(e.b).multiplyScalar(0.5).add(off);
        const h = L * 0.17;
        s.scale.set(h * s.material.userData.aspect, h, 1);
        s.renderOrder = 4;
        this.ghost.add(s);
      }
    }

    // Scale ring around a selected group, in the group's plane.
    const ring = this.ringInfo();
    if (ring) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(ring.R, L * 0.016, 8, 64), this.mat(this.editDrag && this.editDrag.scale ? COL.handle : COL.sel, { opacity: 0.85 }));
      t.position.copy(ring.c).add(off);
      t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ring.n);
      t.renderOrder = 3;
      this.ghost.add(t);
    }
    this.badge(off, 'Edit vertices');

    // The same things in the net, in every copy.
    this.clear(this.marks);
    const lift = new THREE.Vector3(0, L * 0.012, 0);
    for (const p of sh.panels) {
      const w = sh.worldPoly(p).map((v) => v.add(lift));
      const n = w.length;
      for (let i = 0; i < n; i++) {
        const c = colourOfEdge(p.edges[i]);
        if (c) this.rod(this.marks, w[i], w[(i + 1) % n], L * 0.012 * c[1], c[0]);
        const cv = colourOfVert(this.keyOf(p.vid[i]));
        this.dot(this.marks, w[i], L * (cv ? 0.022 * cv[1] / 2 : 0.018), cv ? cv[0] : COL.dot, cv ? 1 : 0.7);
      }
    }
  }

  // Cuts, hinges, bases and piece poses of the net, to carry across a rebuild.
  netState() {
    const sh = this.shell;
    return {
      types: Object.fromEntries(sh.edges.filter((e) => e.shared).map((e) => [e.key, e.type])),
      bases: [...sh.bases],
      poses: netPoses(sh),
    };
  }

  startEdit(sel) {
    const ws = this.ws;
    if (!sel.onGhost) { ws.app.toast('Drag corners and edges on the floating form above; the net below follows. Tapping here pins.'); return null; }
    if (sel.kind === 'face') { ws.app.toast('Drag a corner or an edge. Tap a face to pin all its corners.'); return null; }
    const group = sel.keys.some((k) => this.selected.has(k)) ? [...new Set([...this.selected, ...sel.keys])] : sel.keys;
    const free = group.filter((k) => !this.pins.has(k));
    if (!free.length) { ws.app.toast('That is pinned. Tap it to unpin, or drag another corner or edge.'); return null; }
    ws.stopAnim();
    const model = editModel(ws.shell);
    ws.pushHistory();
    const d = { keys: free, model, start: model.pos, pins: new Set(this.pins), prev: this.netState(), before: ws.history[ws.history.length - 1], t: 1, reason: null, P: null };
    this.editDrag = d;
    this.focusKey = free[0];
    this.lastChange = null;
    this.refresh();
    return d;
  }

  // Move the dragged vertices by `delta` (shell frame) from where they started.
  moveEdit(d, delta) { this.moveEditAt(d, (k, t) => d.start.get(k).clone().addScaledVector(delta, t)); }

  // Scale the dragged group by `s` about its centre, within its plane.
  moveScale(d, s) {
    d.s = s;
    this.moveEditAt(d, scalePath(d.start, d.keys, s));
  }

  moveEditAt(d, at) {
    const ws = this.ws;
    const r = editPath(d.model, d.start, d.pins, d.keys, at);
    d.t = r.t; d.reason = r.reason; d.P = r.P;
    ws.comp.edits = editsFrom(d.model, r.P);
    this.lastChange = changes(d.model, d.start, r.P, d.keys);
    ws.reshapeEdit(d.prev);
    const k = d.keys[0];
    const lens = [...d.model.nbr.get(k)].map((j) => (r.P.get(k).distanceTo(r.P.get(j)) * 1000).toFixed(0));
    const where = r.P.get(k).clone().add(this.ghostOffset());
    const what = d.scale ? `Scale · ${Math.round((1 + (d.s - 1) * r.t) * 100)}%` : `Edit · edges ${lens.join(' / ')} mm`;
    ws.setTag(r.t < 1 ? `Edit · stopped: ${r.reason}` : what, ws.shellGroup.localToWorld(where));
  }

  // Start scaling the selected group (ring drag or a step button).
  startScale() {
    const ws = this.ws;
    const keys = [...this.selected].filter((k) => !this.pins.has(k));
    if (keys.length < 2) { ws.app.toast('Select at least two corners first (tap a face or its corners), then scale them.'); return null; }
    ws.stopAnim();
    const model = editModel(ws.shell);
    ws.pushHistory();
    const d = { keys, model, start: model.pos, pins: new Set(this.pins), prev: this.netState(), before: ws.history[ws.history.length - 1], t: 1, reason: null, P: null, scale: true, s: 1 };
    this.editDrag = d;
    this.lastChange = null;
    this.refresh();
    return d;
  }

  // Buttons: scale the selection by a step (one undo step each).
  stepScale(factor) {
    const d = this.startScale();
    if (!d) return;
    this.moveScale(d, factor);
    this.endEdit(d);
  }

  // Centre, normal and radius of the scale ring (shell frame), or null.
  ringInfo() {
    if (this.mode !== 'edit' || this.selected.size < 2) return null;
    const m = editModel(this.shell);
    const keys = [...this.selected].filter((k) => m.pos.has(k));
    if (keys.length < 2) return null;
    const { c, n } = groupPlane(m.pos, keys);
    let R = 0;
    for (const k of keys) { const v = m.pos.get(k).clone().sub(c); R = Math.max(R, v.addScaledVector(n, -v.dot(n)).length()); }
    return { c, n, R: R * 1.18 + (this.L0 || 0.12) * 0.08 };
  }

  ringWorld() {
    const r = this.ringInfo();
    if (!r) return null;
    const M = this.ws.shellGroup.matrixWorld;
    return { c: r.c.clone().add(this.ghostOffset()).applyMatrix4(M), n: r.n.clone().transformDirection(M), R: r.R * new THREE.Vector3().setFromMatrixScale(M).x };
  }

  // Small floating label naming the Shape mode, above the ghost.
  badge(off, text) {
    if (typeof document === 'undefined') return;
    const b = this.closedBox().translate(off);
    const L = this.L0 || this.shell.edgeLen;
    // In Arrange the ghost is only shown; editing happens in Reshape.
    if (this.ws.state.tool !== 'shape') text = 'Assembled form · edit in Surface Modeling';
    const base = this.labelMat(text, text.startsWith('Edit'));
    // On a screen the label keeps a constant size however close you zoom;
    // in VR it stays a real-size label beside the form.
    const vr = this.ws.app.renderer?.xr?.isPresenting;
    let mat = base;
    if (!vr) {
      this._badgeMats = this._badgeMats || new Map();
      if (!this._badgeMats.has(base)) { const m = base.clone(); m.sizeAttenuation = false; m.userData = { ...base.userData }; this._badgeMats.set(base, m); }
      mat = this._badgeMats.get(base);
    }
    const sp = new THREE.Sprite(mat);
    sp.position.set((b.min.x + b.max.x) / 2, b.max.y + L * 0.3, (b.min.z + b.max.z) / 2);
    const h = vr ? L * 0.2 : (typeof window !== 'undefined' && window.innerWidth < 640 ? 0.022 : 0.03);
    sp.scale.set(h * base.userData.aspect, h, 1);
    sp.renderOrder = 4;
    this.ghost.add(sp);
  }

  setTapMode(m) {
    this.tapMode = m;
    this.ws.app.toast(m === 'select'
      ? 'Tap selects: tap corners, edges or a face to add them to the group (amber). Drag one of them to move the group; drag the ring to scale it in its plane.'
      : 'Tap pins: tap corners, edges or a face to pin them (blue); pinned corners never move.');
    this.ws.app.notify?.();
  }

  toggleSelect(sel) {
    const ws = this.ws;
    const all = sel.keys.every((k) => this.selected.has(k));
    for (const k of sel.keys) { if (all) this.selected.delete(k); else this.selected.add(k); }
    ws.app.toast(this.selected.size
      ? `${this.selected.size} corner${this.selected.size > 1 ? 's' : ''} selected (amber). Drag one to move them together${this.selected.size > 1 ? ', or drag the ring (or Shrink / Grow) to scale them in their plane' : ''}.`
      : 'Nothing selected.');
    ws.app.haptic?.();
    this.refresh();
    ws.app.notify?.();
  }

  clearSelection() {
    this.selected.clear();
    this.ws.app.toast('Selection cleared.');
    this.refresh();
    this.ws.app.notify?.();
  }

  endEdit(d) {
    const ws = this.ws;
    this.editDrag = null;
    ws.hideTag();
    const ch = d.P ? changes(d.model, d.start, d.P, []) : { moved: [] };
    if (!d.P || !ch.moved.length) {
      ws.history.pop();
      this.refresh();
      ws.app.toast(d.reason ? `Nothing moved: ${d.reason}.` : 'Nothing moved.', 5000);
      return;
    }
    const sh = ws.shell;
    // Keep the net valid: if it now overlaps itself, choose its cuts again.
    let netMsg = '';
    if (sh.overlapReport().within) {
      const prev = this.netState();
      const r = sh.defaultNet(700);
      ws.relayNet(prev.poses);
      netMsg = r.ok ? ' The net overlapped itself after this change, so its cuts were chosen again (verified).' : ' The net now overlaps itself and the search found no overlap-free net; see Layout → Other nets.';
    }
    const others = this.lastChange ? this.lastChange.moved.length : 0;
    const edges = this.lastChange ? this.lastChange.edges.length : 0;
    const closed = sh.edges.every((e) => e.uses.length === 2);
    const planar = sh.planarity() < 1e-6;
    const seams = sh.edges.every((e) => {
      if (e.uses.length < 2) return false;
      const len = e.uses.map((u) => { const w = sh.worldPoly(u.panel); return w[u.i].distanceTo(w[(u.i + 1) % w.length]); });
      return Math.abs(len[0] - len[1]) < 1e-9;
    });
    const stop = d.t < 1 ? `Stopped at the valid limit (${Math.round(d.t * 100)}% of the move): ${d.reason}. ` : '';
    const scaled = d.scale ? `Scaled ${d.keys.length} corners to ${Math.round((1 + (d.s - 1) * d.t) * 100)}% in their plane. ` : '';
    const shapes = faceShapes(editModel(sh), editModel(sh).pos);
    ws.app.toast(`${stop}${scaled}Faces: ${shapes}. ${edges} edge${edges === 1 ? '' : 's'} changed length; ${others ? `${others} other corner${others === 1 ? '' : 's'} moved to keep faces flat (orange)` : 'no other corner had to move'}. Closed ${closed ? '✓' : '✗'} · faces planar ${planar ? '✓' : '✗'} · seams match ${seams ? '✓' : '✗'} · no self-intersection ✓.${netMsg} One step: Undo puts it back.`, 8000);
    this.refresh();
    ws.app.notify?.();
  }

  cancelEdit(d) {
    const ws = this.ws;
    this.editDrag = null;
    ws.hideTag();
    ws.history.pop();
    ws.restoreSnapshot(d.before);
  }

  togglePins(sel) {
    const ws = this.ws;
    const all = sel.keys.every((k) => this.pins.has(k));
    for (const k of sel.keys) { if (all) this.pins.delete(k); else this.pins.add(k); }
    if (sel.kind === 'vertex') this.focusKey = sel.keys[0];
    const what = { vertex: 'corner', edge: 'edge (both ends)', face: `face (${sel.keys.length} corners)` }[sel.kind];
    ws.app.toast(all ? `Unpinned that ${what}.` : `Pinned that ${what}: it will not move. ${this.pins.size} corner${this.pins.size === 1 ? '' : 's'} pinned.`);
    ws.app.haptic?.();
    this.refresh();
    ws.app.notify?.();
  }

  pinBase() {
    const m = editModel(this.shell);
    let minY = Infinity;
    for (const v of m.pos.values()) minY = Math.min(minY, v.y);
    let n = 0;
    for (const [k, v] of m.pos) if (v.y < minY + 0.001) { this.pins.add(k); n++; }
    this.ws.app.toast(`Pinned the ${n} corners of the base. Drag another corner or edge of the floating form.`);
    this.refresh();
    this.ws.app.notify?.();
  }

  clearPins() {
    this.pins.clear();
    this.ws.app.toast('No corners pinned.');
    this.refresh();
    this.ws.app.notify?.();
  }

  // Split the four-or-more-sided faces at a corner into triangles, along
  // the diagonal that avoids that corner: new panel divisions and fold
  // edges, so the corner can move without bending those faces.
  triangulateAt(key = this.focusKey) {
    const ws = this.ws;
    if (!key) { ws.app.toast('Touch or drag a corner first, then Triangulate at corner.'); return; }
    const sh = this.shell;
    const add = [];
    for (const p of sh.panels) {
      if (p.sub != null || p.vid.length < 4) continue;
      const i = p.vid.findIndex((id) => this.keyOf(id) === key);
      if (i < 0) continue;
      const n = p.vid.length;
      add.push([p.id, [(i + 1) % n, (i + n - 1) % n]]);
    }
    if (!add.length) { ws.app.toast('No four-sided faces meet at that corner: its faces are already triangles.'); return; }
    ws.pushHistory();
    const prev = this.netState();
    for (const [id, d] of add) ws.comp.tri.set(id, d);
    ws.reshapeEdit(prev);
    this.focusKey = key;
    ws.app.toast(`Triangulated ${add.length} face${add.length > 1 ? 's' : ''} at that corner: ${add.length} new fold line${add.length > 1 ? 's' : ''} (green) divide them, in the form and in the net. That corner can now move without bending them. Undo removes the triangulation.`, 7000);
  }

  resetEdits() {
    const ws = this.ws;
    if (!ws.comp.isEdited()) { ws.app.toast('No free-form edits to reset.'); return; }
    ws.pushHistory();
    const prev = this.netState();
    ws.comp.edits = new Map();
    ws.comp.tri = new Map();
    ws.comp.merge = [];
    this.lastChange = null;
    ws.reshapeEdit(prev);
    ws.app.toast('Edits reset: back to the regular solids (no free-form edits, triangulation or merged panels). Undo brings them back.');
  }
}
