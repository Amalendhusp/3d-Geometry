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
    this.hoverKey = null;
    this.clearHover();
    if (tool === 'move') return this.beginMove(ptr, !!toolOverride);
    const hit = ptr.pick();
    if (!hit) return false;
    let g = null;
    if (tool === 'paint') g = this.beginPaint(ptr, hit);
    else if (tool === 'crease') g = this.beginCrease(ptr, hit);
    else if (tool === 'cut') g = this.beginCut(ptr, hit);
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

  // Show what a press here would do, before anything is pressed:
  // fold -> the flap that would move and the crease it would turn on;
  // cut -> the crease segment that would be cut; crease -> the snap point.
  hover(ptr, hit) {
    const tool = this.state.tool;
    const key = hit && hit.face ? `${tool}|${hit.face.id}|${Math.round(hit.x * 250)}|${Math.round(hit.y * 250)}` : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.clearHover();
    if (!hit || !hit.face || this.anim) return;
    const paper = this.paper;
    if (tool === 'fold') {
      const s = paper.beginFold(hit, this.viewerLocal(), this.state.layerMode);
      if (s.error) return;
      this.hoverFold = s;
      paper.setHighlightSets(this.session ? new Set(this.session.moving) : null, new Set(s.moving));
      this.app.showAxis(s, 'hover');
    } else if (tool === 'cut') {
      const tol = Math.max(0.006, paper.size * 0.03) * (ptr && ptr.kind === 'ray' && !hit.near ? 1.7 : 1);
      const line = paper.creaseLineAt(hit, tol);
      if (line) { this.app.showCutPreview(line, line.segment[0], line.segment[1], true); this.hoverShown = true; }
    } else if (tool === 'crease') {
      const snapR = Math.max(0.006, paper.size * 0.03);
      const snapped = this.state.snap ? paper.snap(hit.face, hit.x, hit.y, snapR) : null;
      const q = snapped || [hit.x, hit.y];
      this.app.showSnapPreview(hit.face, q, !!snapped);
      this.hoverShown = true;
    }
  }

  clearHover() {
    if (this.hoverFold) {
      this.hoverFold = null;
      this.paper.setHighlightSets(this.session ? new Set(this.session.moving) : null, null);
      if (this.session) this.app.showAxis(this.session); else this.app.hideAxis();
    }
    if (this.hoverShown) {
      this.hoverShown = false;
      if (!this.active.size) this.app.hideCreasePreview();
    }
  }

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
    // On a screen, dragging the flap across its crease folds it over toward
    // you: the angle follows where the finger meets the paper's plane,
    // from the grab point (0°) to its mirror image across the crease (180°).
    const across = ptr.kind === 'screen';
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
          const dn = d.dot(s.n);
          if (across && Math.abs(dn) > 0.2) {
            const t = s.C.clone().sub(o).dot(s.n) / dn;
            const X = o.addScaledVector(d, t);
            const k = X.sub(s.C).dot(s.v0n) / s.r;
            th = Math.acos(THREE.MathUtils.clamp(k, -1, 1));
          } else {
            th = paper.angleFromRay(s, o, d);
          }
        } else {
          const gp = p.grabPoint(null, stickDist, stick);
          const X = gp.point.clone().add(grabOffset);
          th = paper.angleFromPoint(s, this.toLocal(X));
        }
        if (Math.abs(th - s.theta) > 1e-4) this.touchSession();
        paper.setFoldAngle(s, th);
        this.app.foldChanged(s);
      },
      cancel: () => {
        // Hand lost mid-fold: put the paper back exactly as it was.
        const before = s.before, pushed = s.pushed;
        this.clearSelection();
        paper.restore(before);
        if (pushed) { this.app.history.stack.pop(); this.app.notify(); }
        this.app.geometryChanged();
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

  // Once the sheet is cut into several pieces, Move carries the piece you
  // grab. The grip button (wholeSheet) always carries everything.
  beginMove(ptr, wholeSheet) {
    if (!wholeSheet && this.paper.pieceCount > 1) {
      const hit = ptr.pick();
      if (hit) {
        const g = this.beginPieceMove(ptr, hit);
        this.active.set(ptr.id, g);
        return true;
      }
    }
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

// -------------------------------------------------------------------- cut

Tools.prototype.beginCut = function beginCut(ptr, hit) {
  this.clearSelection();
  const paper = this.paper;
  const near = Math.max(0.006, paper.size * 0.03) * (ptr.kind === 'ray' && !hit.near ? 1.7 : 1);
  const line = paper.creaseLineAt(hit, near);
  if (!line) {
    if (ptr.kind !== 'touch') this.app.toast('Start on a crease line. Cuts follow creases.');
    return null;
  }
  const snapR = Math.max(0.005, paper.size * 0.025);
  const lo = line.stops[0], hi = line.stops[line.stops.length - 1];
  const snapT = (t) => {
    t = Math.min(hi, Math.max(lo, t));
    let best = t, bd = snapR;
    for (const v of line.stops) if (Math.abs(v - t) < bd) { bd = Math.abs(v - t); best = v; }
    return best;
  };
  const t0 = line.t;
  let t1 = t0;
  let dragged = false;
  const plane = paper.renderPlane(hit.face);
  const show = () => {
    const [a, b] = dragged ? [snapT(t0), snapT(t1)] : line.segment;
    this.app.showCutPreview(line, Math.min(a, b), Math.max(a, b));
  };
  show();
  return {
    move: (p) => {
      const w = p.onPlane(plane);
      if (!w) return;
      const q = paper.worldToPaper(hit.face, w);
      t1 = paper.toLocal(hit.face, q[0], q[1]).sub(line.P).dot(line.u);
      if (Math.abs(t1 - t0) > snapR * 0.8) dragged = true;
      show();
    },
    end: () => {
      this.app.hideCreasePreview();
      let a, b;
      if (dragged) { a = snapT(t0); b = snapT(t1); } else [a, b] = line.segment;
      if (Math.abs(b - a) < 1e-4) { this.app.toast('Drag further along the crease to cut.'); return; }
      const before = paper.serialize();
      const piecesBefore = paper.pieceCount;
      const n = paper.cutAlong(line.P, line.u, Math.min(a, b), Math.max(a, b));
      if (!n) { this.app.toast('That part is already cut.'); return; }
      this.app.history.push({ type: 'geom', state: before });
      const extra = paper.pieceCount - piecesBefore;
      this.app.toast(extra > 0
        ? `Cut free: ${paper.pieceCount} pieces. Use Move to pull a piece away.`
        : `Cut ${Math.round(Math.abs(b - a) * 1000)} mm${n > 1 ? ` through ${n} layers` : ''}.`);
      this.app.geometryChanged();
    },
    cancel: () => this.app.hideCreasePreview(),
  };
};

// Carry one cut-out piece. On screen it slides across the table plane; in
// XR it follows the hand and settles flat when released near the table.
Tools.prototype.beginPieceMove = function beginPieceMove(ptr, hit) {
  this.clearSelection();
  const paper = this.paper;
  const before = paper.serialize();
  const piece = paper.pieceOf(hit.face);
  const M0 = new Map(piece.map((f) => [f, f.M.clone()]));
  const off0 = new Map(paper.faces.map((f) => [f, f.off]));
  paper.setHighlightFaces(piece, true);
  const root = paper.root;
  root.updateMatrixWorld(true);
  let moved = false;
  const apply = (D) => {
    for (const f of piece) f.M.multiplyMatrices(D, M0.get(f));
    paper.updateAllMatrices();
    moved = true;
  };
  let move;
  if (ptr.kind === 'screen') {
    const nWorld = new THREE.Vector3().setFromMatrixColumn(root.matrixWorld, 2).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nWorld, hit.point);
    const start = this.toLocal(hit.point);
    move = (p) => {
      const w = p.onPlane(plane);
      if (!w) return;
      const d = this.toLocal(w).sub(start);
      apply(new THREE.Matrix4().makeTranslation(d.x, d.y, 0));
    };
  } else {
    const startInv = ptr.grabMatrix().clone().invert();
    move = (p) => {
      root.updateMatrixWorld(true);
      const rootInv = root.matrixWorld.clone().invert();
      const D = rootInv.multiply(p.grabMatrix()).multiply(startInv).multiply(root.matrixWorld);
      apply(D);
    };
  }
  return {
    move,
    end: () => {
      paper.setHighlightFaces(piece, false);
      if (!moved) return;
      paper.settlePiece(piece, M0, off0);
      this.app.history.push({ type: 'geom', state: before });
      this.app.geometryChanged();
    },
  };
};

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
