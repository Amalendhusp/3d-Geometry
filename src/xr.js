import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

// Controllers and tracked hands.
//
// Every frame each input works out what it is aiming at, in priority order:
// a button on the control panel, a placement handle, a tool in the tray, or
// the work itself (paper or solid panels). What it aims at is highlighted
// before anything is pressed, so you can see exactly what will happen.
//
//   trigger / pinch   act on the target (press, grab, fold...)
//   grip / squeeze    carry: a handle if one is in reach, else the work
//   fingertip         touch the work or poke panel buttons
//   held tool tip     draws creases or cuts where it touches (see handtools.js)
//
// Hands: a pinch that drops for a moment (tracking blip) does not end the
// grab, and a gesture whose hand is lost for a while is cancelled rather
// than committed.

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);
const LOCAL_CONTROLLERS = new Set(['meta-quest-touch-plus', 'meta-quest-touch-plus-v2', 'meta-quest-touch-pro', 'oculus-touch-v3']);
const CDN_CONTROLLERS = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles';

const DEBOUNCE = 0.15; // s: a pinch release must last this long
const LOST_CANCEL = 0.45; // s: hand lost this long during a gesture -> cancel
const NEAR_WORK = 0.035; // m: pinch this close to the work grabs it directly
const COLORS = { idle: '#ffffff', hover: '#ffc54d', active: '#36d98a' };

export class XRInput {
  constructor(app) {
    this.app = app;
    this.cmf = new XRControllerModelFactory();
    this.hmf = new XRHandModelFactory();
    this.hmf.setPath('vendor/hands/');
    this.mats = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: k === 'idle' ? 0.35 : 0.95, depthWrite: false,
    })]));
    this.dotMats = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: k === 'idle' ? 0.7 : 1, depthTest: false, side: THREE.DoubleSide,
    })]));
    this.slots = [0, 1].map((i) => this.makeSlot(i));
  }

  now() { return performance.now() / 1000; }

  // --------------------------------------------------------------- setup

  makeSlot(i) {
    const { renderer, scene } = this.app;
    const ctrl = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    const hand = renderer.xr.getHand(i);
    scene.add(ctrl, grip, hand);
    grip.add(this.cmf.createControllerModel(grip));
    hand.add(this.hmf.createHandModel(hand, 'mesh'));

    // A thin tube rather than a 1-pixel line, so the ray is easy to see.
    const ray = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5), this.mats.idle);
    ray.visible = false;
    ctrl.add(ray);
    const tipDot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: COLORS.hover }));
    tipDot.visible = false;
    ctrl.add(tipDot);

    const ring = (r0) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r0, 1, 40), this.dotMats.hover);
      m.renderOrder = 22;
      m.visible = false;
      scene.add(m);
      return m;
    };
    const disc = () => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(1, 24), this.dotMats.active);
      m.renderOrder = 23;
      m.visible = false;
      scene.add(m);
      return m;
    };
    const vis = {
      ray, tipDot,
      cursor: ring(0.7), cursorDot: disc(),
      contact: ring(0.72), contactDot: disc(),
      pinch: ring(0.78),
      fingertip: new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), this.dotMats.idle),
    };
    vis.fingertip.renderOrder = 21;
    vis.fingertip.visible = false;
    scene.add(vis.fingertip);

    const slot = {
      i, ctrl, grip, hand, vis,
      source: null, isHand: false, connected: false,
      pressed: false, gesture: null, squeeze: null,
      touch: { down: false, state: 'none' },
      pendingEnd: null, lostSince: null, ignoreRelease: false,
      held: null,
      ray: new THREE.Ray(),
      pp: null, tipPos: null, gap: 1, tracked: false, focus: { kind: null },
    };
    slot.rayPtr = this.makeRayPointer(slot, 'xr-ray-' + i);
    slot.gripPtr = this.makeRayPointer(slot, 'xr-grip-' + i);
    slot.touchPtr = this.makeTouchPointer(slot);

    ctrl.addEventListener('connected', (e) => {
      slot.source = e.data;
      slot.isHand = !!e.data.hand;
      slot.connected = true;
      tipDot.visible = !slot.isHand;
      // Runs before the grip's model loader sees the same event.
      const local = (e.data.profiles || []).some((p) => LOCAL_CONTROLLERS.has(p));
      this.cmf.setPath(local ? 'vendor/controllers' : CDN_CONTROLLERS);
    });
    ctrl.addEventListener('disconnected', () => {
      // Lost input never commits a half-done gesture.
      this.finishSelect(slot, true);
      this.finishSqueeze(slot, true);
      this.endTouch(slot, true);
      this.app.handTools?.dropFrom(slot);
      slot.connected = false;
      slot.source = null;
      this.hideVisuals(slot);
    });
    ctrl.addEventListener('selectstart', () => this.onSelectStart(slot));
    ctrl.addEventListener('selectend', () => this.onSelectEnd(slot));
    ctrl.addEventListener('squeezestart', () => this.onSqueeze(slot, true));
    ctrl.addEventListener('squeezeend', () => this.onSqueeze(slot, false));
    return slot;
  }

  // ------------------------------------------------------------ tracking

  joint(slot, name) {
    const j = slot.hand.joints && slot.hand.joints[name];
    if (!j || !j.visible) return null;
    return j.getWorldPosition(new THREE.Vector3());
  }

  // Light, speed-dependent smoothing: steady hands lose jitter, quick
  // movements pass straight through.
  smooth(prev, cur) {
    if (!cur) return null;
    if (!prev) return cur.clone();
    const d = prev.distanceTo(cur);
    const a = THREE.MathUtils.clamp(0.35 + d / 0.01, 0.35, 1);
    return prev.clone().lerp(cur, a);
  }

  sample(slot) {
    slot.ctrl.updateMatrixWorld(true);
    slot.ray.origin.setFromMatrixPosition(slot.ctrl.matrixWorld);
    slot.ray.direction.set(0, 0, -1).transformDirection(slot.ctrl.matrixWorld);
    if (!slot.isHand) {
      slot.tracked = true;
      slot.pp = null;
      slot.tipPos = null;
      return;
    }
    const tip = this.joint(slot, 'index-finger-tip');
    const thumb = this.joint(slot, 'thumb-tip');
    slot.tracked = !!(tip && thumb);
    if (!slot.tracked) return; // keep the last good values while lost
    slot.gap = tip.distanceTo(thumb);
    slot.pp = this.smooth(slot.pp, tip.clone().add(thumb).multiplyScalar(0.5));
    slot.tipPos = this.smooth(slot.tipPos, tip);
  }

  tip(slot) { return slot.isHand && slot.tracked ? slot.tipPos : null; }
  pinchPoint(slot) { return slot.isHand && slot.tracked ? slot.pp : null; }

  // Point that touches things: a held tool's tip, else the index fingertip.
  touchPoint(slot) {
    if (slot.held) return this.app.handTools.tipPosition(slot);
    return this.tip(slot);
  }

  // Where a hand or controller is, for things within reach.
  reachPoint(slot) {
    if (slot.isHand) return this.pinchPoint(slot);
    return slot.ray.origin.clone();
  }

  // ------------------------------------------------------------ pointers

  makeRayPointer(slot, id) {
    const app = this.app;
    return {
      id, kind: 'ray', ray: slot.ray,
      pick: () => {
        const pp = this.pinchPoint(slot);
        if (pp) {
          const near = app.nearestActive(pp, NEAR_WORK);
          if (near) return { ...near, near: true };
        }
        return app.pickActive(slot.ray);
      },
      onPlane: (plane) => {
        const pp = this.pinchPoint(slot);
        if (pp && Math.abs(plane.distanceToPoint(pp)) < 0.06) return plane.projectPoint(pp, new THREE.Vector3());
        return slot.ray.intersectPlane(plane, new THREE.Vector3());
      },
      grabPoint: (hit, dist, stick) => {
        const pp = this.pinchPoint(slot);
        if (hit) {
          if (pp && pp.distanceTo(hit.point) < 0.06) return { point: pp.clone(), stick: false };
          return { point: hit.point.clone(), stick: true };
        }
        if (!stick && pp) return { point: pp.clone(), stick: false };
        return { point: slot.ray.origin.clone().addScaledVector(slot.ray.direction, dist), stick: true };
      },
      grabMatrix: () => {
        const m = slot.ctrl.matrixWorld.clone();
        const pp = this.pinchPoint(slot);
        if (pp) m.setPosition(pp);
        return m;
      },
    };
  }

  makeTouchPointer(slot) {
    const app = this.app;
    return {
      id: 'xr-touch-' + slot.i, kind: 'touch', ray: slot.ray,
      pick: () => {
        const t = this.touchPoint(slot);
        return t ? app.nearestActive(t, 0.02) : null;
      },
      onPlane: (plane) => {
        const t = this.touchPoint(slot);
        return t ? plane.projectPoint(t, new THREE.Vector3()) : null;
      },
      grabPoint: () => ({ point: (this.touchPoint(slot) || new THREE.Vector3()).clone(), stick: false }),
      grabMatrix: () => slot.ctrl.matrixWorld.clone(),
    };
  }

  // ------------------------------------------------------------- focus

  // What this input would act on right now.
  probe(slot) {
    const app = this.app;
    if (!slot.connected || !slot.tracked) return { kind: null };
    const reach = this.reachPoint(slot);
    if (reach) {
      const h = app.placement.nearest(reach, slot.isHand ? 0.05 : 0.06);
      if (h) return { kind: 'handle', ...h };
      const t = !slot.held && app.handTools?.nearest(reach, slot.isHand ? 0.07 : 0.08);
      if (t) return { kind: 'tool', ...t };
      if (slot.isHand && !slot.held) {
        const w = app.nearestActive(reach, NEAR_WORK);
        if (w) return { kind: 'work', hit: w, near: true, distance: w.distance, point: w.point, normal: w.normal };
      }
    }
    const cands = [];
    const ph = app.panel.raycast(slot.ray);
    if (ph) cands.push({ kind: 'panel', ...ph });
    const h = app.placement.pick(slot.ray);
    if (h) cands.push({ kind: 'handle', ...h });
    const t = !slot.held && app.handTools?.pick(slot.ray);
    if (t) cands.push({ kind: 'tool', ...t });
    if (!slot.held) {
      const w = app.pickActive(slot.ray);
      if (w) cands.push({ kind: 'work', hit: w, distance: w.distance, point: w.point, normal: w.normal });
    }
    if (!cands.length) return { kind: null };
    cands.sort((a, b) => a.distance - b.distance);
    return cands[0];
  }

  // ------------------------------------------------------------- select

  onSelectStart(slot) {
    if (slot.pendingEnd) {
      // The pinch came back quickly: keep the same grab going.
      slot.pendingEnd = null;
      slot.pressed = true;
      return;
    }
    if (slot.ignoreRelease) return;
    const app = this.app;
    slot.pressed = true;
    this.sample(slot);
    this.endTouch(slot, false);
    if (slot.held) {
      // A hand holding a tool only puts it down (at the tray).
      if (app.handTools.nearTray(slot)) app.handTools.putDown(slot);
      else app.toast('Holding a tool: touch the paper with its tip. Pinch next to the tray to put it down.');
      slot.gesture = { kind: 'consumed' };
      return;
    }
    const f = this.probe(slot);
    slot.gesture = null;
    if (f.kind === 'panel') {
      if (f.button) {
        app.panel.setPressed(f.button, true);
        app.panel.click(f.button);
        this.pulse(slot, 0.25, 20);
      }
      slot.gesture = { kind: 'panel', button: f.button };
    } else if (f.kind === 'handle') {
      if (app.placement.begin(slot.rayPtr, f)) { slot.gesture = { kind: 'handle' }; this.pulse(slot, 0.35, 30); }
    } else if (f.kind === 'tool') {
      app.handTools.pickUp(slot, f.tool);
      slot.gesture = { kind: 'consumed' };
      this.pulse(slot, 0.4, 40);
    } else if (f.kind === 'work') {
      if (app.activeTools.down(slot.rayPtr)) { slot.gesture = { kind: 'work' }; this.pulse(slot, 0.3, 25); }
    }
  }

  onSelectEnd(slot) {
    if (slot.ignoreRelease) { slot.ignoreRelease = false; slot.pressed = false; return; }
    if (slot.isHand) {
      // Wait a moment before ending a pinch; longer if the hand is lost.
      slot.pendingEnd = { at: this.now() + (slot.tracked ? DEBOUNCE : LOST_CANCEL), lost: !slot.tracked };
      return;
    }
    this.finishSelect(slot, false);
  }

  finishSelect(slot, cancel) {
    slot.pressed = false;
    slot.pendingEnd = null;
    const g = slot.gesture;
    slot.gesture = null;
    if (!g) return;
    const app = this.app;
    if (g.kind === 'panel') app.panel.setPressed(g.button, false);
    else if (g.kind === 'handle') cancel ? app.placement.cancel(slot.rayPtr) : app.placement.end(slot.rayPtr);
    else if (g.kind === 'work') {
      if (cancel) { app.activeTools.cancel(slot.rayPtr); app.toast('Hand tracking was lost, so that action was cancelled.'); }
      else app.activeTools.up(slot.rayPtr);
    }
  }

  onSqueeze(slot, on) {
    const app = this.app;
    this.sample(slot);
    if (on) {
      const f = this.probe(slot);
      if (f.kind === 'handle' && app.placement.begin(slot.gripPtr, f)) slot.squeeze = 'handle';
      else if (app.activeTools.down(slot.gripPtr, 'move')) slot.squeeze = 'work';
      if (slot.squeeze) this.pulse(slot, 0.3, 30);
    } else this.finishSqueeze(slot, false);
  }

  finishSqueeze(slot, cancel) {
    const app = this.app;
    if (slot.squeeze === 'handle') cancel ? app.placement.cancel(slot.gripPtr) : app.placement.end(slot.gripPtr);
    else if (slot.squeeze === 'work') cancel ? app.activeTools.cancel(slot.gripPtr) : app.activeTools.up(slot.gripPtr);
    slot.squeeze = null;
  }

  // ------------------------------------------------------------- touch

  endTouch(slot, cancel) {
    if (!slot.touch.down) return;
    slot.touch.down = false;
    if (cancel) this.app.activeTools.cancel(slot.touchPtr);
    else this.app.activeTools.up(slot.touchPtr);
  }

  // Fingertip (or held tool tip) touching the work or the panel.
  updateTouch(slot) {
    const app = this.app;
    const t = this.touchPoint(slot);
    slot.touch.state = 'none';
    slot.touch.surface = null;
    if (!t) { if (!slot.tracked) return; this.endTouch(slot, false); return; }
    const pk = app.panel.poke('h' + slot.i, slot.pressed && !slot.held ? null : t);
    if (pk !== 'none') {
      this.endTouch(slot, false);
      slot.touch.state = pk;
      return;
    }
    if (slot.pressed && !slot.held) { this.endTouch(slot, false); return; }
    const allowed = slot.held ? app.handTools.canUse(slot) : app.touchAllowed();
    const tool = !!slot.held;
    const start = tool ? 0.004 : 0.008, keep = tool ? 0.012 : 0.02;
    const near = app.nearestActive(t, 0.04);
    if (near) slot.touch.surface = near;
    if (!allowed) { this.endTouch(slot, false); slot.touch.state = near ? 'near' : 'none'; return; }
    const touching = near && near.distance < (slot.touch.down ? keep : start);
    if (!slot.touch.down) {
      if (touching && app.activeTools.down(slot.touchPtr)) { slot.touch.down = true; this.pulse(slot, 0.2, 15); }
    } else if (touching) {
      app.activeTools.move(slot.touchPtr);
    } else {
      this.endTouch(slot, false);
    }
    slot.touch.state = slot.touch.down ? 'touch' : near ? 'near' : 'none';
  }

  // ---------------------------------------------------------- per frame

  update() {
    const app = this.app;
    const now = this.now();
    let hover = null;
    for (const slot of this.slots) {
      if (!slot.connected) continue;
      this.sample(slot);
      // Pinch release that outlasted the debounce.
      if (slot.pendingEnd && now >= slot.pendingEnd.at) {
        this.finishSelect(slot, slot.pendingEnd.lost && !slot.tracked);
      }
      // Hand lost in the middle of a gesture: wait, then cancel.
      if (slot.isHand && !slot.tracked) {
        slot.lostSince ??= now;
        if (now - slot.lostSince > LOST_CANCEL) {
          if (slot.gesture) { this.finishSelect(slot, true); slot.ignoreRelease = true; }
          if (slot.squeeze) this.finishSqueeze(slot, true);
          this.endTouch(slot, true);
        }
        this.hideVisuals(slot);
        continue;
      }
      slot.lostSince = null;
      const g = slot.gesture;
      if (g && g.kind === 'work' && slot.pressed) app.activeTools.move(slot.rayPtr);
      if (g && g.kind === 'handle') app.placement.move(slot.rayPtr);
      if (slot.squeeze === 'work') app.activeTools.move(slot.gripPtr);
      if (slot.squeeze === 'handle') app.placement.move(slot.gripPtr);
      app.handTools?.follow(slot);
      this.updateTouch(slot);
      slot.focus = slot.gesture || slot.squeeze ? slot.focus : this.probe(slot);
      this.updateVisuals(slot);
      // Hover preview on the work: tool tip first, then a near pinch, then a ray.
      if (!slot.pressed && !slot.touch.down) {
        const cand = slot.held && slot.touch.surface ? { ptr: slot.touchPtr, hit: slot.touch.surface, rank: 3 }
          : slot.focus.kind === 'work' ? { ptr: slot.rayPtr, hit: slot.focus.hit, rank: slot.focus.near ? 2 : 1 } : null;
        if (cand && (!hover || cand.rank > hover.rank)) hover = cand;
      }
    }
    const busy = this.slots.some((s) => s.gesture || s.touch.down);
    app.activeTools.hover?.(busy ? null : hover && hover.ptr, busy ? null : hover && hover.hit);
  }

  // ------------------------------------------------------------ visuals

  hideVisuals(slot) {
    const v = slot.vis;
    v.ray.visible = v.cursor.visible = v.cursorDot.visible = v.contact.visible = v.contactDot.visible = v.pinch.visible = v.fingertip.visible = false;
    this.app.panel.setHover('r' + slot.i, null);
    this.app.placement.setHover('s' + slot.i, null);
    this.app.handTools?.setHover('s' + slot.i, null);
  }

  updateVisuals(slot) {
    const app = this.app;
    const v = slot.vis;
    const f = slot.focus;
    const grabbing = !!(slot.gesture && slot.gesture.kind !== 'consumed') || !!slot.squeeze;
    const state = grabbing ? 'active' : f.kind ? 'hover' : 'idle';

    app.panel.setHover('r' + slot.i, f.kind === 'panel' ? f.button : null);
    app.placement.setHover('s' + slot.i, f.kind === 'handle' ? f.handle : null);
    app.handTools?.setHover('s' + slot.i, f.kind === 'tool' ? f.tool : null);

    // Ray: hands show it only when aiming at something out of reach.
    const nearFocus = f.near || f.kind === 'tool' && f.near;
    const showRay = !slot.held && !slot.touch.down && slot.touch.state === 'none'
      && (slot.isHand ? !!f.kind && !nearFocus : true);
    v.ray.visible = showRay;
    if (showRay) {
      const len = f.kind && !f.near ? f.distance : 0.5;
      const r = state === 'idle' ? 0.0009 : state === 'hover' ? 0.0014 : 0.002;
      v.ray.material = this.mats[state];
      v.ray.scale.set(r, r, Math.max(0.01, len));
    }

    // Cursor where the ray meets its target.
    const showCursor = showRay && !!f.kind && !f.near && f.point;
    v.cursor.visible = !!showCursor;
    v.cursorDot.visible = !!showCursor && grabbing;
    if (showCursor) {
      const n = f.normal ? f.normal.clone() : slot.ray.direction.clone().negate();
      if (n.dot(slot.ray.direction) > 0) n.negate();
      const s = Math.max(0.004, f.distance * 0.012);
      placeFlat(v.cursor, f.point, n, s, 0.0012);
      v.cursor.material = this.dotMats[state === 'idle' ? 'hover' : state];
      placeFlat(v.cursorDot, f.point, n, s * 0.45, 0.0015);
    }

    // Fingertip marker and its contact point on the surface below.
    const t = slot.isHand && !slot.held ? this.tip(slot) : null;
    v.fingertip.visible = !!t;
    if (t) {
      const ts = slot.touch.state;
      v.fingertip.position.copy(t);
      v.fingertip.scale.setScalar(ts === 'touch' ? 0.0055 : 0.0042);
      v.fingertip.material = this.dotMats[ts === 'touch' ? 'active' : ts === 'near' ? 'hover' : 'idle'];
    }
    const surf = slot.touch.surface;
    const showContact = !!surf && slot.touch.state !== 'none' && app.touchAllowed();
    v.contact.visible = showContact;
    v.contactDot.visible = showContact && slot.touch.state === 'touch';
    if (showContact) {
      const s = 0.003 + surf.distance * 0.3;
      placeFlat(v.contact, surf.point, surf.normal || Z, s, 0.0012);
      placeFlat(v.contactDot, surf.point, surf.normal || Z, 0.0035, 0.0015);
    }

    // Pinch ring between thumb and index: closes as you pinch.
    const pp = slot.isHand && !slot.held ? this.pinchPoint(slot) : null;
    v.pinch.visible = !!pp;
    if (pp) {
      const head = app.viewerPosition();
      v.pinch.position.copy(pp);
      v.pinch.lookAt(head);
      v.pinch.scale.setScalar(THREE.MathUtils.clamp(slot.gap * 0.5, 0.005, 0.02));
      v.pinch.material = this.dotMats[grabbing ? 'active' : f.near || f.kind === 'handle' || f.kind === 'tool' ? 'hover' : 'idle'];
    }
  }

  pulse(slot, intensity = 0.3, ms = 25) {
    const h = slot.source && slot.source.gamepad && slot.source.gamepad.hapticActuators;
    if (h && h[0] && h[0].pulse) { try { h[0].pulse(intensity, ms); } catch { /* ignore */ } }
  }

  hapticAll() { for (const s of this.slots) if (s.connected) this.pulse(s, 0.2, 15); }
}

function placeFlat(mesh, point, normal, scale, lift) {
  mesh.position.copy(point).addScaledVector(normal, lift);
  mesh.quaternion.copy(_q.setFromUnitVectors(Z, _v.copy(normal).normalize()));
  mesh.scale.setScalar(scale);
}
