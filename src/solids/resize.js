import * as THREE from 'three';
import { Shell } from './shell.js';

// Direct resizing of a cube composition on its flat net.
//
// The net is the edited representation. A handle is a net element: a panel
// side or a panel corner. Dragging a side changes the size across it (the
// axis of the panel's neighbouring sides); dragging a corner changes both
// sizes of its panel. Sizes are the composition's stretch along X, Y and Z,
// so the solids stay boxes: every face stays planar, the shell stays closed
// and both sides of every seam keep the same length.
//
// An anchor (a pinned element, or by default the opposite side or corner
// of the handle's panel) stays where it is on the surface. Net positions
// are linear in the sizes, so the handle's motion relative to the anchor is
// a fixed matrix times the size change; solving with it makes the handle
// follow the pointer exactly.

// Axis (0 x, 1 y, 2 z) a direction runs along, or -1 if it is not along one.
export function axisOf(dir) {
  const a = [Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)];
  const l = dir.length();
  const k = a.indexOf(Math.max(...a));
  return l > 0 && a[k] > l * (1 - 1e-6) ? k : -1;
}

export const AXIS_NAME = ['width', 'height', 'depth'];
export const AXIS_LETTER = ['X', 'Y', 'Z'];

export function edgeAxis(e) { return axisOf(e.b.clone().sub(e.a)); }

// Direct resizing works on boxes: cubes whose edges run along the axes.
export function resizable(comp) {
  return comp.solids.length > 0 && comp.solids.every((s) => s.type === 'cube' && s.worldFaces().every((f) => axisOf(f.normal) >= 0));
}

export function sameEl(a, b) { return !!a && !!b && a.kind === b.kind && a.pid === b.pid && a.i === b.i; }

function panelOf(shell, el) { return shell.panelById.get(el.pid); }

// Where a net element is now (shell frame).
export function elPos(shell, el) {
  const p = panelOf(shell, el);
  const n = p.verts.length;
  if (el.kind === 'corner') return p.verts[el.i].clone().applyMatrix4(p.M);
  return p.verts[el.i].clone().add(p.verts[(el.i + 1) % n]).multiplyScalar(0.5).applyMatrix4(p.M);
}

// The 3D edge or vertex a net element stands for.
export function elEdge(shell, el) { return el.kind === 'side' ? panelOf(shell, el).edges[el.i] : null; }
export function elVid(shell, el) { return el.kind === 'corner' ? panelOf(shell, el).vid[el.i] : null; }

function sideAxis(p, i) {
  const n = p.verts.length;
  return axisOf(p.verts[(i + 1) % n].clone().sub(p.verts[i]));
}

// Sizes (axes) a handle changes.
export function handleAxes(shell, el) {
  const p = panelOf(shell, el);
  const n = p.verts.length;
  if (el.kind === 'side') { const k = sideAxis(p, (el.i + n - 1) % n); return k >= 0 ? [k] : []; }
  return [...new Set([sideAxis(p, el.i), sideAxis(p, (el.i + n - 1) % n)].filter((k) => k >= 0))];
}

// Sizes a pin holds fixed: a pinned side keeps its length.
export function lockedAxes(shell, pin) {
  if (!pin || pin.kind !== 'side') return [];
  const k = sideAxis(panelOf(shell, pin), pin.i);
  return k >= 0 ? [k] : [];
}

// Default anchor: the opposite side or corner of the handle's panel.
export function autoAnchor(shell, el) {
  const n = panelOf(shell, el).verts.length;
  return { kind: el.kind, pid: el.pid, i: (el.i + Math.floor(n / 2)) % n };
}

// What has to carry over when the shell is rebuilt for a new size: cuts
// and hinges (by panel and side, since edge keys follow coordinates), base
// panels, and the pose of each piece's root panel.
export function captureLayout(shell) {
  const F = shell.forest();
  return {
    types: new Map(shell.panels.map((p) => [p.id, p.edges.map((e) => e.type)])),
    bases: [...shell.bases],
    rootMs: new Map(F.roots.map((r) => [r.id, r.M.clone()])),
  };
}

// Pose a rebuilt shell's net like the captured one: same cuts and hinges,
// same root poses, every hinge flat, all in the surface plane.
export function applyLayout(shell, layout) {
  for (const p of shell.panels) {
    const t = layout.types.get(p.id);
    if (t) p.edges.forEach((e, i) => { if (e.shared && !e.locked && t[i]) e.type = t[i]; });
  }
  const ids = layout.bases.filter((id) => shell.panelById.has(id));
  if (ids.length) {
    shell.bases = new Set(ids);
    for (const comp of shell.pieces()) if (!comp.some((p) => shell.bases.has(p.id))) shell.chooseBasesFor(comp);
  }
  const F = shell.forest();
  const roots = new Map(F.roots.map((r) => {
    const M = (layout.rootMs.get(r.id) || new THREE.Matrix4()).clone();
    // If the root face turned (a stretch tilts slanted faces), turn it back
    // to lie face down; boxes need no correction.
    const n = r.normal.clone().transformDirection(M);
    if (n.y > -1 + 1e-9) {
      const fix = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, -1, 0)));
      const p = r.verts[0].clone().applyMatrix4(M);
      M.premultiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z)).premultiply(fix).premultiply(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
    }
    return [r, M];
  }));
  shell.applyForest(F, shell.flatAngles(F), roots);
  // Back into the surface plane (a root face may have moved with the stretch).
  let y = 0, n = 0;
  for (const p of shell.panels) for (const v of shell.worldPoly(p)) { y += v.y; n++; }
  if (n && Math.abs(y / n) > 1e-12) {
    const T = new THREE.Matrix4().makeTranslation(0, -y / n, 0);
    for (const p of shell.panels) p.M.premultiply(T);
  }
}

// Slide the whole net so that an element is at `target` (x, z only).
export function anchorTo(shell, el, target) {
  const a = elPos(shell, el);
  const T = new THREE.Matrix4().makeTranslation(target.x - a.x, 0, target.z - a.z);
  for (const p of shell.panels) p.M.premultiply(T);
}

// A shell built for another size, laid out like `layout`.
export function shellFor(comp, shape, layout) {
  const keep = comp.shape.clone();
  comp.shape.copy(shape);
  const sh = new Shell();
  sh.build(comp);
  comp.shape.copy(keep);
  applyLayout(sh, layout);
  return sh;
}

// How the handle moves relative to the anchor per unit of each size.
export function resizePlan(comp, shell, handle, anchor, locked = []) {
  const layout = captureLayout(shell);
  const shape0 = comp.shape.clone();
  const rel = (shape) => {
    const sh = shellFor(comp, shape, layout);
    const A = elPos(sh, anchor), H = elPos(sh, handle);
    return new THREE.Vector2(H.x - A.x, H.z - A.z);
  };
  const r0 = rel(shape0);
  const eps = 0.01;
  const axes = [], cols = [];
  for (const k of handleAxes(shell, handle)) {
    if (locked.includes(k)) continue;
    const s = shape0.clone();
    s.setComponent(k, s.getComponent(k) + eps);
    const c = rel(s).sub(r0).divideScalar(eps);
    // A size that does not move the handle relative to the anchor is not
    // something this drag can change.
    if (c.length() > 1e-3) { axes.push(k); cols.push(c); }
  }
  return { layout, shape0, axes, cols, anchor, handle };
}

// Sizes that bring the handle as close as possible to a pointer moved by d
// (surface x, z) from where the drag started.
export function solveShape(plan, d) {
  const s = plan.shape0.clone();
  const { cols, axes } = plan;
  if (cols.length === 1) {
    const c = cols[0];
    s.setComponent(axes[0], s.getComponent(axes[0]) + c.dot(d) / c.lengthSq());
  } else if (cols.length === 2) {
    const [a, b] = cols;
    const m11 = a.dot(a), m12 = a.dot(b), m22 = b.dot(b);
    const det = m11 * m22 - m12 * m12;
    if (Math.abs(det) < 1e-12) {
      s.setComponent(axes[0], s.getComponent(axes[0]) + a.dot(d) / m11);
    } else {
      const r1 = a.dot(d), r2 = b.dot(d);
      s.setComponent(axes[0], s.getComponent(axes[0]) + (m22 * r1 - m12 * r2) / det);
      s.setComponent(axes[1], s.getComponent(axes[1]) + (m11 * r2 - m12 * r1) / det);
    }
  }
  return s;
}
