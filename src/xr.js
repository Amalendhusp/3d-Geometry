import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

// Controllers and tracked hands. Each input source gets:
//   rayPtr   - trigger / pinch along the target ray (or right at the pinch
//              point when the hand is close to the paper)
//   gripPtr  - squeeze / grip button, always carries the paper
//   touchPtr - index fingertip touching the paper (hands only)

const _v = new THREE.Vector3();
// Quest controller models ship with the app; other headsets load theirs from the CDN.
const LOCAL_CONTROLLERS = new Set(['meta-quest-touch-plus', 'meta-quest-touch-plus-v2', 'meta-quest-touch-pro', 'oculus-touch-v3']);
const CDN_CONTROLLERS = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles';
const _q = new THREE.Quaternion();

export class XRInput {
  constructor(app) {
    this.app = app;
    this.cmf = new XRControllerModelFactory();
    this.hmf = new XRHandModelFactory();
    this.hmf.setPath('vendor/hands/');
    this.slots = [0, 1].map((i) => this.makeSlot(i));
  }

  makeSlot(i) {
    const { renderer, scene } = this.app;
    const ctrl = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    const hand = renderer.xr.getHand(i);
    scene.add(ctrl, grip, hand);
    grip.add(this.cmf.createControllerModel(grip));
    hand.add(this.hmf.createHandModel(hand, 'mesh'));

    const lineGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0xf0b44c, transparent: true, opacity: 0.75, depthWrite: false }));
    line.visible = false;
    ctrl.add(line);
    const tipDot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf0b44c }));
    tipDot.visible = false;
    ctrl.add(tipDot);

    const cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 1, 40),
      new THREE.MeshBasicMaterial({ color: 0xf0b44c, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }),
    );
    cursor.renderOrder = 20;
    cursor.visible = false;
    scene.add(cursor);

    const slot = {
      i, ctrl, grip, hand, line, cursor, tipDot,
      source: null, isHand: false, connected: false,
      pressed: false, squeezing: false, panelPress: false, touchDown: false,
      ray: new THREE.Ray(),
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
      this.releaseAll(slot);
      slot.connected = false;
      slot.source = null;
      line.visible = cursor.visible = tipDot.visible = false;
    });
    ctrl.addEventListener('selectstart', () => this.onSelectStart(slot));
    ctrl.addEventListener('selectend', () => this.onSelectEnd(slot));
    ctrl.addEventListener('squeezestart', () => this.onSqueeze(slot, true));
    ctrl.addEventListener('squeezeend', () => this.onSqueeze(slot, false));
    return slot;
  }

  joint(slot, name) {
    const j = slot.hand.joints && slot.hand.joints[name];
    if (!j || !j.visible) return null;
    return j.getWorldPosition(new THREE.Vector3());
  }

  tip(slot) { return slot.isHand ? this.joint(slot, 'index-finger-tip') : null; }

  pinchPoint(slot) {
    if (!slot.isHand) return null;
    const a = this.joint(slot, 'index-finger-tip');
    const b = this.joint(slot, 'thumb-tip');
    if (!a || !b) return null;
    return a.add(b).multiplyScalar(0.5);
  }

  makeRayPointer(slot, id) {
    const app = this.app;
    return {
      id, kind: 'ray', ray: slot.ray,
      pick: () => {
        const pp = this.pinchPoint(slot);
        if (pp) {
          const near = app.paper.nearestFace(pp, 0.03);
          if (near) return near;
        }
        return app.pickPaper(slot.ray);
      },
      onPlane: (plane) => {
        const pp = this.pinchPoint(slot);
        if (pp && Math.abs(plane.distanceToPoint(pp)) < 0.06) return plane.projectPoint(pp, new THREE.Vector3());
        return slot.ray.intersectPlane(plane, new THREE.Vector3());
      },
      grabPoint: (hit, dist, stick) => {
        const pp = this.pinchPoint(slot);
        if (hit) {
          if (pp && pp.distanceTo(hit.point) < 0.06) return { point: pp, stick: false };
          return { point: hit.point.clone(), stick: true };
        }
        if (!stick && pp) return { point: pp, stick: false };
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
        const t = this.tip(slot);
        return t ? app.paper.nearestFace(t, 0.02) : null;
      },
      onPlane: (plane) => {
        const t = this.tip(slot);
        return t ? plane.projectPoint(t, new THREE.Vector3()) : null;
      },
      grabPoint: () => ({ point: this.tip(slot) || new THREE.Vector3(), stick: false }),
      grabMatrix: () => slot.ctrl.matrixWorld.clone(),
    };
  }

  updateRay(slot) {
    slot.ctrl.updateMatrixWorld(true);
    slot.ray.origin.setFromMatrixPosition(slot.ctrl.matrixWorld);
    slot.ray.direction.set(0, 0, -1).transformDirection(slot.ctrl.matrixWorld);
  }

  onSelectStart(slot) {
    const app = this.app;
    slot.pressed = true;
    if (slot.touchDown) { app.tools.up(slot.touchPtr); slot.touchDown = false; }
    this.updateRay(slot);
    const ph = app.panel.raycast(slot.ray);
    const hit = app.pickPaper(slot.ray);
    if (ph && (!hit || ph.distance < hit.distance)) {
      slot.panelPress = true;
      app.panel.click(ph.button);
      return;
    }
    if (app.tools.down(slot.rayPtr)) this.pulse(slot, 0.25, 20);
  }

  onSelectEnd(slot) {
    slot.pressed = false;
    if (slot.panelPress) { slot.panelPress = false; return; }
    this.app.tools.up(slot.rayPtr);
  }

  onSqueeze(slot, on) {
    slot.squeezing = on;
    this.updateRay(slot);
    if (on) { if (this.app.tools.down(slot.gripPtr, 'move')) this.pulse(slot, 0.3, 30); }
    else this.app.tools.up(slot.gripPtr);
  }

  releaseAll(slot) {
    const t = this.app.tools;
    t.up(slot.rayPtr); t.up(slot.gripPtr); t.up(slot.touchPtr);
    slot.pressed = slot.squeezing = slot.touchDown = slot.panelPress = false;
  }

  pulse(slot, intensity = 0.3, ms = 25) {
    const h = slot.source && slot.source.gamepad && slot.source.gamepad.hapticActuators;
    if (h && h[0] && h[0].pulse) { try { h[0].pulse(intensity, ms); } catch { /* ignore */ } }
  }

  hapticAll() { for (const s of this.slots) if (s.connected) this.pulse(s, 0.2, 15); }

  update() {
    const app = this.app;
    for (const slot of this.slots) {
      if (!slot.connected) continue;
      this.updateRay(slot);
      const t = app.tools;
      if (slot.pressed && t.active.has(slot.rayPtr.id)) t.move(slot.rayPtr);
      if (slot.squeezing && t.active.has(slot.gripPtr.id)) t.move(slot.gripPtr);
      this.updateTouch(slot);
      this.updateVisuals(slot);
    }
  }

  updateTouch(slot) {
    const app = this.app;
    const tip = this.tip(slot);
    if (!tip || slot.pressed) {
      if (slot.touchDown) { app.tools.up(slot.touchPtr); slot.touchDown = false; }
      if (!tip) return;
    }
    if (app.panel.poke('h' + slot.i, tip)) {
      if (slot.touchDown) { app.tools.up(slot.touchPtr); slot.touchDown = false; }
      return;
    }
    if (slot.pressed) return;
    const tool = app.state.tool;
    if (tool !== 'paint' && tool !== 'crease') {
      if (slot.touchDown) { app.tools.up(slot.touchPtr); slot.touchDown = false; }
      return;
    }
    const near = app.paper.nearestFace(tip, slot.touchDown ? 0.02 : 0.008);
    if (!slot.touchDown) {
      if (near && app.tools.down(slot.touchPtr)) slot.touchDown = true;
    } else if (near) {
      app.tools.move(slot.touchPtr);
    } else {
      app.tools.up(slot.touchPtr);
      slot.touchDown = false;
    }
  }

  updateVisuals(slot) {
    const app = this.app;
    const ph = app.panel.raycast(slot.ray);
    const hit = app.pickPaper(slot.ray);
    const panelFirst = ph && (!hit || ph.distance < hit.distance);
    app.panel.setHover('r' + slot.i, panelFirst ? ph.button : null);
    const dist = panelFirst ? ph.distance : hit ? hit.distance : null;
    const busy = app.tools.active.has(slot.rayPtr.id);
    // Hands only show a ray while it points at something useful.
    slot.line.visible = !slot.touchDown && (dist !== null || (!slot.isHand && !busy));
    slot.line.scale.z = dist !== null ? dist : 0.6;

    const c = slot.cursor;
    const target = !panelFirst && hit ? hit : null;
    c.visible = !!target;
    if (target) {
      const n = _v.setFromMatrixColumn(target.face.group.matrixWorld, 2).normalize();
      if (target.side === 'back') n.negate();
      c.position.copy(target.point).addScaledVector(n, 0.0008);
      c.quaternion.copy(_q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n));
      const r = app.state.tool === 'paint' ? Math.max(0.0015, app.state.brushMM / 2000) : 0.004;
      c.scale.setScalar(r);
    }
  }
}
