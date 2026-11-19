import * as THREE from 'three';

// Tool logic shared by every input: mouse/touch on screen, XR controller rays,
// hand pinch rays and fingertip touch. A pointer object provides:
//   id, kind ('screen' | 'ray' | 'touch')
//   pick()            -> paper hit (see Paper.hitInfo) or null
//   onPlane(plane)    -> world point on a plane or null
//   ray               -> THREE.Ray in world space (screen and ray pointers)
//   grabPoint()       -> world point that drags a flap (XR pointers)
//   grabMatrix()      -> world matrix used to carry the paper (XR pointers)

const _inv = new THREE.Matrix4();

export class Tools {
  constructor(app) {
    this.app = app;
    this.active = new Map(); // pointer id -> gesture
    this.session = null; // currently selected fold
    this.anim = null;
  }

  get paper() { return this.app.paper; }
  get state() { return this.app.state; }

  toLocal(p) { return this.paper.root.worldToLocal(p.clone()); }

  viewerLocal() { return this.toLocal(this.app.viewerPosition()); }

  // ------------------------------------------------------------ dispatch

  down(ptr, toolOverride) {
    const tool = toolOverride || this.state.tool;
    if (this.active.has(ptr.id)) return false;
    if (tool === 'move') return this.beginMove(ptr);
    const hit = ptr.pick();
    if (!hit) return false;
    let g = null;
    if (tool === 'paint') g = this.beginPaint(ptr, hit);
    else if (tool === 'crease') g = this.beginCrease(ptr, hit);
    else if (tool === 'fold') g = this.beginFold(ptr, hit);
    if (!g) return false;
    this.active.set(ptr.id, g);
    return true;
  }

  move(ptr) {
    const g = this.active.get(ptr.id);
    if (g) g.move(ptr);
  }

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

  isBusy() { return this.active.size > 0; }

  // End every gesture in progress (before undo or a new sheet replaces faces).
  finishAll() {
    for (const [id, g] of [...this.active]) {
      this.active.delete(id);
      g.end({});
    }
  }

  // --------------------------------------------------------------- paint

  beginPaint(ptr, hit) {
    this.clearSelection();
    const paint = this.app.paint;
    const side = hit.side;
    const radius = this.state.brushMM / 2000;
    const color = this.state.eraser ? null : this.state.color;
    paint.beginStroke(side);
    let last = [hit.x, hit.y];
    let lastWorld = hit.point.clone();
    paint.segment(side, last, last, radius, color);
    return {
      move: (p) => {
        const h = p.pick();
        if (!h || h.side !== side) { last = null; return; }
        const cur = [h.x, h.y];
        if (last) {
          // A jump in paper space that is not matched by the movement in 3D
          // means the stroke crossed onto another layer: don't connect it.
          const dp = Math.hypot(cur[0] - last[0], cur[1] - last[1]);
          if (dp > h.point.distanceTo(lastWorld) * 1.3 + 0.003) last = null;
        }
        paint.segment(side, last || cur, cur, radius, color);
        last = cur;
        lastWorld = h.point.clone();
      },
      end: () => {
        const rec = paint.endStroke();
        if (rec) this.app.history.push(rec);
      },
      cancel: () => {
        const rec = paint.endStroke();
        if (rec) paint.undo(rec);
      },
    };
  }

  // -------------------------------------------------------------- crease

  beginCrease(ptr, hit) {
    this.clearSelection();
    const paper = this.paper;
    const face = hit.face;
    const snapR = Math.max(0.006, paper.size * 0.03);
    const snapOn = this.state.snap;
    let a = [hit.x, hit.y];
    if (snapOn) a = paper.snap(face, a[0], a[1], snapR) || a;
    let b = a.slice();
    const plane = paper.renderPlane(face);
    const update = () => this.app.showCreasePreview(face, a, b);
    update();
    return {
      move: (p) => {
        const w = p.onPlane(plane);
        if (!w) return;
        let q = paper.worldToPaper(face, w);
        const snapped = snapOn ? paper.snap(face, q[0], q[1], snapR) : null;
        if (snapped) q = snapped;
        else if (snapOn) q = snapAngle(a, q);
        b = q;
        update();
      },
      end: () => {
        this.app.hideCreasePreview();
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < Math.max(0.004, paper.size * 0.015)) {
          this.app.toast('Drag further to draw a crease line.');
          return;
        }
        const before = paper.serialize();
        const n = paper.addCrease(face, a, b);
        if (n) {
          this.app.history.push({ type: 'geom', state: before });
          this.app.toast(n > 1 ? `Creased through ${n} layers.` : 'Crease added.');
          this.app.geometryChanged();
        } else {
          this.app.toast('That line is already a crease.');
        }
      },
      cancel: () => this.app.hideCreasePreview(),
    };
  }

  // ---------------------------------------------------------------- fold

  beginFold(ptr, hit) {
    this.stopAnimation();
    const paper = this.paper;
    const before = paper.serialize();
    const s = paper.beginFold(hit, this.viewerLocal(), this.state.layerMode);
    if (s.error) {
      this.app.toast(s.error);
      return null;
    }
    this.selectSession(s, before);
    const startTheta = 0;
    let grabOffset = null, stickDist = 0, stick = true;
    if (ptr.kind !== 'screen') {
      const gp = ptr.grabPoint(hit);
      stick = gp.stick;
      stickDist = hit.distance;
      grabOffset = hit.point.clone().sub(gp.point);
    }
    this.app.toast('Swing the flap. Release near flat to crease it.', 1600);
    return {
      move: (p) => {
        let th;
        if (p.kind === 'screen') {
          const o = this.toLocal(p.ray.origin);
          const d = this.toLocal(p.ray.origin.clone().add(p.ray.direction)).sub(o).normalize();
          th = paper.angleFromRay(s, o, d);
        } else {
          const gp = p.grabPoint(null, stickDist, stick);
          const X = gp.point.clone().add(grabOffset);
          th = paper.angleFromPoint(s, this.toLocal(X));
        }
        if (Math.abs(th - s.theta) > 1e-4) this.touchSession();
        paper.setFoldAngle(s, th);
        this.app.foldChanged(s);
      },
      end: () => {
        paper.finalizeFold(s, true);
        if (Math.abs(s.theta - startTheta) < 1e-6) {
          this.app.toast('Fold selected. Use Valley / Mountain, or drag the flap.');
        } else {
          this.app.toast(foldLabel(s.theta));
        }
        this.app.foldChanged(s, true);
      },
    };
  }

  selectSession(s, before) {
    this.clearSelection();
    this.session = s;
    this.session.before = before;
    this.session.pushed = false;
    this.paper.setHighlight(s, true);
    this.app.showAxis(s);
    this.app.notify();
  }

  // Record undo the first time a selected fold actually changes the paper.
  touchSession() {
    const s = this.session;
    if (s && !s.pushed) {
      this.app.history.push({ type: 'geom', state: s.before });
      s.pushed = true;
    }
  }

  clearSelection() {
    this.stopAnimation();
    if (this.session) {
      this.paper.setHighlight(this.session, false);
      this.session = null;
      this.app.notify();
    }
    this.app.hideAxis();
  }

  // Animate the selected fold to an angle (radians), then finalize.
  animateTo(target) {
    const s = this.session;
    if (!s) {
      this.app.toast('In Fold mode, tap or pinch a flap next to a crease first.');
      return;
    }
    this.stopAnimation();
    if (Math.abs(target - s.theta) < 1e-6) return;
    this.touchSession();
    this.anim = { s, from: s.theta, to: target, t: 0, dur: 0.45 };
  }

  stopAnimation() {
    if (this.anim) {
      const a = this.anim;
      this.anim = null;
      this.paper.setFoldAngle(a.s, a.to);
      this.paper.finalizeFold(a.s, false);
      this.app.foldChanged(a.s, true);
    }
  }

  update(dt) {
    const a = this.anim;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / a.dur);
    const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
    this.paper.setFoldAngle(a.s, a.from + (a.to - a.from) * e);
    this.app.foldChanged(a.s);
    if (a.t >= 1) {
      this.anim = null;
      this.paper.finalizeFold(a.s, false);
      this.app.foldChanged(a.s, true);
      this.app.toast(foldLabel(a.s.theta));
    }
  }

  // ---------------------------------------------------------------- move

  beginMove(ptr) {
    if (ptr.kind === 'screen') return false; // the camera orbits instead
    const root = this.paper.root;
    root.updateMatrixWorld(true);
    const start = ptr.grabMatrix();
    const offset = _inv.copy(start).invert().multiply(root.matrixWorld).clone();
    const g = {
      move: (p) => {
        const m = p.grabMatrix().clone().multiply(offset);
        const parent = root.parent;
        parent.updateMatrixWorld(true);
        m.premultiply(_inv.copy(parent.matrixWorld).invert());
        m.decompose(root.position, root.quaternion, new THREE.Vector3());
        root.scale.set(1, 1, 1);
        this.app.state.onTable = false;
      },
      end: () => {},
    };
    this.active.set(ptr.id, g);
    return true;
  }
}

export function foldLabel(theta) {
  const deg = Math.round(THREE.MathUtils.radToDeg(theta));
  if (deg === 0) return 'Unfolded.';
  if (deg === 180) return 'Valley fold (180°).';
  if (deg === -180) return 'Mountain fold (180°).';
  return `Folded ${Math.abs(deg)}° ${deg > 0 ? 'toward you' : 'away from you'}.`;
}

// Snap the direction a->q to multiples of 22.5° when it is within 2.5°.
function snapAngle(a, q) {
  const dx = q[0] - a[0], dy = q[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return q;
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 8;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(snapped - ang) > THREE.MathUtils.degToRad(2.5)) return q;
  return [a[0] + Math.cos(snapped) * len, a[1] + Math.sin(snapped) * len];
}
