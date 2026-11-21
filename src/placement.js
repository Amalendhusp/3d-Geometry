import * as THREE from 'three';

// Where the work surface sits in the room, and the handles that move it.
//
//  - Move bar (front edge): drag to slide the table and raise or lower it.
//  - Rotate knobs (front corners): drag around the table to turn it.
//  - Panel bar (under the control panel): drag to put the panel anywhere;
//    it keeps facing you and stays attached to the table.
//
// Everything on the surface (paper, solids, panel, tool tray) moves with it.

const COLORS = { idle: '#f0b44c', hover: '#ffd27a', grab: '#36d98a' };
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export const SURFACES = ['mat', 'plain', 'hidden'];
export const SURFACE_LABELS = { mat: 'Cutting mat', plain: 'Plain table', hidden: 'No table' };

export class Placement {
  constructor(app) {
    this.app = app;
    this.locked = false;
    this.posture = 'auto'; // 'auto' | 'seated' | 'standing'
    this.used = 'standing';
    this.panelCustom = false;
    this.group = new THREE.Group();
    this.group.name = 'placement-handles';
    app.surface.add(this.group);
    this.hover = new Map(); // key -> handle
    this.drags = new Map(); // pointer id -> drag
    this.mats = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, new THREE.MeshStandardMaterial({
      color: c, roughness: 0.4, metalness: 0.1, emissive: new THREE.Color(c), emissiveIntensity: k === 'idle' ? 0.15 : 0.55,
    })]));
    const bar = (len) => new THREE.CapsuleGeometry(0.011, len, 4, 14).rotateZ(Math.PI / 2);
    this.moveBar = this.makeHandle('move', bar(0.22), 'Move · raise · lower', { len: 0.22, r: 0.011 });
    this.rotL = this.makeHandle('rotate', new THREE.SphereGeometry(0.017, 20, 14), 'Turn table', { r: 0.017 });
    this.rotR = this.makeHandle('rotate', new THREE.SphereGeometry(0.017, 20, 14), 'Turn table', { r: 0.017 });
    this.group.add(this.moveBar, this.rotL, this.rotR);
    this.panelBar = this.makeHandle('panel', bar(0.16), 'Move panel', { len: 0.16, r: 0.011 });
    app.panel.mesh.add(this.panelBar);
    this.handles = [this.moveBar, this.rotL, this.rotR, this.panelBar];
    this.updateVisibility();
  }

  makeHandle(kind, geometry, label, shape) {
    const m = new THREE.Mesh(geometry, this.mats.idle);
    m.userData.handle = { kind, label, ...shape };
    // A larger invisible shape makes it easier to hit with a ray.
    const collider = new THREE.Mesh(
      shape.len ? new THREE.CapsuleGeometry(0.035, shape.len, 2, 8).rotateZ(Math.PI / 2) : new THREE.SphereGeometry(0.04, 10, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    collider.userData.owner = m;
    m.add(collider);
    m.userData.collider = collider;
    const sprite = makeLabel(label);
    sprite.position.set(0, 0.045, 0);
    sprite.visible = false;
    m.add(sprite);
    m.userData.label = sprite;
    m.castShadow = true;
    return m;
  }

  // Positions on a table of the given size (surface coordinates).
  layout(tw, td) {
    this.moveBar.position.set(0, -0.012, td / 2 + 0.04);
    this.rotL.position.set(-tw / 2 + 0.03, -0.012, td / 2 + 0.035);
    this.rotR.position.set(tw / 2 - 0.03, -0.012, td / 2 + 0.035);
    const p = this.app.panel;
    this.panelBar.position.set(0, -p.height / 2 - 0.03, 0.004);
  }

  get active() { return this.app.renderer.xr.isPresenting && !this.locked; }

  updateVisibility() {
    const on = this.active;
    for (const h of this.handles) h.visible = on;
  }

  setLocked(v) {
    this.locked = v;
    for (const id of [...this.drags.keys()]) this.drags.delete(id);
    this.updateVisibility();
    this.app.toast(v ? 'Placement locked. The table and panel stay where they are.' : 'Placement unlocked. Grab the yellow handles to move things.');
    this.app.notify();
  }

  // ------------------------------------------------------------ targeting

  pick(ray) {
    if (!this.active) return null;
    const rc = new THREE.Raycaster(ray.origin, ray.direction, 0, 6);
    const hits = rc.intersectObjects(this.handles.map((h) => h.userData.collider), false);
    if (!hits.length) return null;
    return { handle: hits[0].object.userData.owner, distance: hits[0].distance, point: hits[0].point.clone(), near: false };
  }

  // Closest handle within maxDist of a point (hands and controllers up close).
  nearest(point, maxDist) {
    if (!this.active) return null;
    let best = null;
    for (const h of this.handles) {
      const d = this.distanceTo(h, point);
      if (d < maxDist && (!best || d < best.distance)) best = { handle: h, distance: d, point: point.clone(), near: true };
    }
    return best;
  }

  distanceTo(h, point) {
    h.updateWorldMatrix(true, false);
    const s = h.userData.handle;
    if (!s.len) return Math.max(0, point.distanceTo(_v.setFromMatrixPosition(h.matrixWorld)) - s.r);
    const a = new THREE.Vector3(-s.len / 2, 0, 0).applyMatrix4(h.matrixWorld);
    const b = new THREE.Vector3(s.len / 2, 0, 0).applyMatrix4(h.matrixWorld);
    const ab = b.clone().sub(a);
    const t = THREE.MathUtils.clamp(point.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
    return Math.max(0, point.distanceTo(a.addScaledVector(ab, t)) - s.r);
  }

  setHover(key, handle) {
    if ((this.hover.get(key) || null) === handle) return;
    if (handle) this.hover.set(key, handle); else this.hover.delete(key);
    this.refresh();
  }

  refresh() {
    const grabbed = new Set([...this.drags.values()].map((d) => d.handle));
    const hovered = new Set(this.hover.values());
    for (const h of this.handles) {
      const state = grabbed.has(h) ? 'grab' : hovered.has(h) ? 'hover' : 'idle';
      h.material = this.mats[state];
      h.scale.setScalar(state === 'idle' ? 1 : 1.18);
      h.userData.label.visible = state !== 'idle';
    }
  }

  // --------------------------------------------------------------- drags

  isDragging(ptrId) { return this.drags.has(ptrId); }

  grabPoint(ptr, d) {
    if (d.near) return new THREE.Vector3().setFromMatrixPosition(ptr.grabMatrix());
    return ptr.ray.origin.clone().addScaledVector(ptr.ray.direction, d.dist);
  }

  begin(ptr, target) {
    if (!this.active || !target) return false;
    const ws = this.app.workspace;
    const d = {
      handle: target.handle, kind: target.handle.userData.handle.kind,
      near: target.near, dist: target.distance,
      w0: ws.position.clone(), yaw0: ws.rotation.y, h0: this.app.tableTop,
    };
    d.p0 = this.grabPoint(ptr, d);
    if (d.kind === 'rotate') {
      const c = ws.getWorldPosition(new THREE.Vector3());
      d.c = c;
      d.a0 = Math.atan2(d.p0.x - c.x, d.p0.z - c.z);
    } else if (d.kind === 'panel') {
      d.offset = this.app.panel.mesh.getWorldPosition(new THREE.Vector3()).sub(d.p0);
      d.panel0 = { p: this.app.panel.mesh.position.clone(), q: this.app.panel.mesh.quaternion.clone() };
    }
    this.drags.set(ptr.id, d);
    this.refresh();
    return true;
  }

  move(ptr) {
    const d = this.drags.get(ptr.id);
    if (!d) return;
    const p = this.grabPoint(ptr, d);
    const app = this.app;
    const ws = app.workspace;
    if (d.kind === 'move') {
      ws.position.set(d.w0.x + (p.x - d.p0.x), d.w0.y, d.w0.z + (p.z - d.p0.z));
      app.tableTop = THREE.MathUtils.clamp(d.h0 + (p.y - d.p0.y), 0.45, 1.25);
      app.applyHeight();
    } else if (d.kind === 'rotate') {
      const a = Math.atan2(p.x - d.c.x, p.z - d.c.z);
      ws.rotation.y = d.yaw0 + wrap(a - d.a0);
    } else if (d.kind === 'panel') {
      this.placePanelAt(p.clone().add(d.offset));
      this.panelCustom = true;
    }
  }

  end(ptr) {
    const d = this.drags.get(ptr.id);
    if (!d) return;
    this.drags.delete(ptr.id);
    this.refresh();
    const msg = { move: `Table at ${Math.round(this.app.tableTop * 100)} cm.`, rotate: 'Table turned.', panel: 'Panel placed.' }[d.kind];
    this.app.toast(msg);
    this.app.notify();
  }

  // Tracking lost mid-drag: put things back where they were.
  cancel(ptr) {
    const d = this.drags.get(ptr.id);
    if (!d) return;
    this.drags.delete(ptr.id);
    const ws = this.app.workspace;
    ws.position.copy(d.w0);
    ws.rotation.y = d.yaw0;
    this.app.tableTop = d.h0;
    this.app.applyHeight();
    if (d.panel0) { this.app.panel.mesh.position.copy(d.panel0.p); this.app.panel.mesh.quaternion.copy(d.panel0.q); }
    this.refresh();
  }

  // Put the panel at a world point, turned to face the viewer.
  placePanelAt(world) {
    const app = this.app;
    const panel = app.panel.mesh;
    const head = app.viewerPosition();
    const tmp = new THREE.Object3D();
    tmp.position.copy(world);
    tmp.lookAt(head.x, head.y, head.z);
    const parent = panel.parent;
    parent.updateWorldMatrix(true, false);
    panel.position.copy(parent.worldToLocal(world.clone()));
    panel.quaternion.copy(parent.getWorldQuaternion(_q).invert().multiply(tmp.quaternion));
  }

  // ------------------------------------------------------ comfort placing

  // Table straight ahead at a height that suits sitting or standing.
  placeInFront(posture = this.posture) {
    const app = this.app;
    const head = app.viewerPosition();
    const cam = app.renderer.xr.isPresenting ? app.renderer.xr.getCamera() : app.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const h = head.y > 0.5 ? head.y : 1.6;
    const seated = posture === 'seated' || (posture === 'auto' && h < 1.35);
    this.used = seated ? 'seated' : 'standing';
    app.tableTop = seated ? THREE.MathUtils.clamp(h - 0.47, 0.58, 0.86) : THREE.MathUtils.clamp(h - 0.62, 0.78, 1.15);
    const reach = (seated ? 0.3 : 0.36) + app.workDepth() / 2;
    app.workspace.position.set(head.x + fwd.x * reach, 0, head.z + fwd.z * reach);
    app.workspace.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    this.panelCustom = false;
    app.workspace.updateMatrixWorld(true);
    app.resetPosition();
    app.solids.carried = false;
    app.layoutTable();
    app.notify();
  }

  setPosture(p) {
    this.posture = p;
    this.placeInFront(p);
    this.app.toast(this.used === 'seated'
      ? `Seated: table at ${Math.round(this.app.tableTop * 100)} cm, a little closer.`
      : `Standing: table at ${Math.round(this.app.tableTop * 100)} cm.`);
  }

  // Small steps for precise placement (buttons on the control panel).
  nudge(kind, sign) {
    if (this.locked) { this.app.toast('Unlock placement first.'); return; }
    const app = this.app;
    const ws = app.workspace;
    const head = app.viewerPosition();
    const fwd = ws.getWorldPosition(new THREE.Vector3()).sub(head);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (kind === 'height') { app.tableTop = THREE.MathUtils.clamp(app.tableTop + sign * 0.015, 0.45, 1.25); app.applyHeight(); }
    else if (kind === 'distance') ws.position.addScaledVector(fwd, sign * 0.03);
    else if (kind === 'side') ws.position.addScaledVector(right, sign * 0.03);
    else if (kind === 'turn') ws.rotation.y += sign * THREE.MathUtils.degToRad(10);
    const labels = { height: `Table at ${Math.round(app.tableTop * 100)} cm.`, distance: sign > 0 ? 'Moved farther.' : 'Moved closer.', side: sign > 0 ? 'Moved right.' : 'Moved left.', turn: 'Turned.' };
    app.toast(labels[kind]);
    app.notify();
  }
}

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(24, 28, 56, 0.88)';
  const r = 40;
  g.beginPath();
  g.moveTo(r, 8); g.arcTo(504, 8, 504, 88, r); g.arcTo(504, 88, 8, 88, r); g.arcTo(8, 88, 8, 8, r); g.arcTo(8, 8, 504, 8, r);
  g.fill();
  g.fillStyle = '#f6f3ea';
  g.font = '600 40px "Zen Kaku Gothic New", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(0.12, 0.0225, 1);
  s.renderOrder = 30;
  return s;
}
