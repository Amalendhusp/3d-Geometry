import * as THREE from 'three';

// Physical tools that live in a tray on the work surface.
//
//  - Crease stylus (a bone folder): its tip draws crease lines.
//  - Cutter (a craft knife): its tip cuts along crease segments.
//
// Pick one up with a pinch (hand), or the trigger with a controller close
// to it or pointing at it. It then stays in that hand without holding the
// pinch: on a hand it extends the index finger, on a controller it sticks
// out of the front. Touch the paper with the glowing tip to use it; the
// effect is previewed before you lift. Pinch next to the tray to put it
// back. Paper workspace only, in VR.

const _m = new THREE.Matrix4();
const NEG_Z = new THREE.Vector3(0, 0, -1);

const TIP = { idle: '#ffc54d', near: '#ffe08a', crease: '#36d98a', cut: '#ff5a3d' };

export class HandTools {
  constructor(app) {
    this.app = app;
    this.tray = new THREE.Group();
    this.tray.name = 'tool-tray';
    app.surface.add(this.tray);
    this.hover = new Map();
    this.buildTray();
    this.tools = [
      this.makeTool('crease', 'Crease stylus', makeStylus()),
      this.makeTool('cut', 'Cutter', makeCutter()),
    ];
    this.tools[0].rest = { p: new THREE.Vector3(-0.07, 0.012, -0.022), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2) };
    this.tools[1].rest = { p: new THREE.Vector3(-0.07, 0.012, 0.022), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2) };
    for (const t of this.tools) this.rest(t);
    this.updateVisibility();
  }

  buildTray() {
    const wood = new THREE.MeshStandardMaterial({ color: '#8a6440', roughness: 0.7 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.006, 0.1), wood);
    base.position.y = 0.003;
    base.receiveShadow = true;
    this.tray.add(base);
    for (const [w, d, x, z] of [[0.2, 0.006, 0, -0.047], [0.2, 0.006, 0, 0.047], [0.006, 0.1, -0.097, 0], [0.006, 0.1, 0.097, 0]]) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.014, d), wood);
      rim.position.set(x, 0.007, z);
      rim.castShadow = true;
      this.tray.add(rim);
    }
    this.trayLabel = makeLabel('Tools · pinch to pick up');
    this.trayLabel.position.set(0, 0.07, 0);
    this.trayLabel.visible = false;
    this.tray.add(this.trayLabel);
  }

  makeTool(id, label, mesh) {
    const tool = { id, label, mesh, holder: null, rest: null };
    // Generous invisible shape for pointing at it.
    const collider = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0, 0.07), new THREE.MeshBasicMaterial({ visible: false }));
    collider.userData.tool = tool;
    mesh.add(collider);
    tool.collider = collider;
    tool.glow = mesh.userData.tip;
    tool.label3d = makeLabel(`${label} · pinch to pick up`);
    tool.label3d.position.set(0, 0.04, 0.06);
    tool.label3d.visible = false;
    mesh.add(tool.label3d);
    return tool;
  }

  // Tray at the front right of the table (surface coordinates).
  layout(tw, td) {
    this.tray.position.set(tw / 2 - 0.16, 0, td / 2 - 0.1);
  }

  get enabled() { return this.app.renderer.xr.isPresenting && this.app.space === 'paper'; }

  updateVisibility() {
    const on = this.enabled;
    this.tray.visible = on;
    for (const t of this.tools) t.mesh.visible = on || !!t.holder;
    if (!on) for (const t of this.tools) if (t.holder) this.putDown(t.holder, true);
  }

  rest(t) {
    this.tray.add(t.mesh);
    t.mesh.position.copy(t.rest.p);
    t.mesh.quaternion.copy(t.rest.q);
    t.holder = null;
    this.setTip(t, 'idle');
  }

  // ------------------------------------------------------------ targeting

  pick(ray) {
    if (!this.enabled) return null;
    const rc = new THREE.Raycaster(ray.origin, ray.direction, 0, 5);
    const hits = rc.intersectObjects(this.tools.filter((t) => !t.holder).map((t) => t.collider), false);
    if (!hits.length) return null;
    return { tool: hits[0].object.userData.tool, distance: hits[0].distance, point: hits[0].point.clone(), near: false };
  }

  nearest(point, maxDist) {
    if (!this.enabled) return null;
    let best = null;
    for (const t of this.tools) {
      if (t.holder) continue;
      const d = distToTool(t, point);
      if (d < maxDist && (!best || d < best.distance)) best = { tool: t, distance: d, point: point.clone(), near: true };
    }
    return best;
  }

  setHover(key, tool) {
    if ((this.hover.get(key) || null) === tool) return;
    if (tool) this.hover.set(key, tool); else this.hover.delete(key);
    const hovered = new Set(this.hover.values());
    for (const t of this.tools) {
      const on = hovered.has(t) && !t.holder;
      t.label3d.visible = on;
      t.mesh.userData.body.material.emissiveIntensity = on ? 0.45 : 0;
    }
  }

  nearTray(slot) {
    const p = this.app.xrInput.reachPoint(slot);
    if (!p) return false;
    return p.distanceTo(this.tray.getWorldPosition(new THREE.Vector3())) < 0.13;
  }

  canUse(slot) { return !!slot.held && this.app.space === 'paper'; }

  // --------------------------------------------------------- pick / drop

  pickUp(slot, tool) {
    if (tool.holder) return;
    if (slot.held) this.putDown(slot, true);
    tool.holder = slot;
    slot.held = tool;
    this.app.scene.add(tool.mesh);
    tool.label3d.visible = false;
    tool.mesh.userData.body.material.emissiveIntensity = 0;
    this.app.actions.setTool(tool.id);
    this.follow(slot);
    this.app.toast(tool.id === 'crease'
      ? 'Crease stylus in hand. Touch the paper with its tip and draw a line; lift to crease. Pinch by the tray to put it down.'
      : 'Cutter in hand. Touch a crease with its tip and draw along it; lift to cut. Pinch by the tray to put it down.', 4000);
  }

  putDown(slot, quiet = false) {
    const t = slot.held;
    if (!t) return;
    slot.held = null;
    this.rest(t);
    if (!quiet) {
      if (this.app.state.tool === 'crease' || this.app.state.tool === 'cut') this.app.actions.setTool('fold');
      this.app.toast('Tool put down. Pinch a flap next to a crease to fold it.');
    }
  }

  dropFrom(slot) { if (slot.held) this.putDown(slot, true); }

  // ---------------------------------------------------------- following

  // World pose of the tool in a hand or on a controller (tip at origin,
  // body along +z, so the tool points along its local -z).
  poseFor(slot) {
    const xr = this.app.xrInput;
    if (slot.isHand) {
      const tip = xr.tip(slot);
      const mid = xr.joint(slot, 'index-finger-phalanx-intermediate');
      if (!tip || !mid) return null;
      const dir = tip.clone().sub(mid).normalize();
      const pos = tip.clone().addScaledVector(dir, 0.028);
      const a = xr.joint(slot, 'index-finger-metacarpal'), b = xr.joint(slot, 'middle-finger-metacarpal');
      let side = a && b ? b.clone().sub(a) : new THREE.Vector3(1, 0, 0);
      side.addScaledVector(dir, -side.dot(dir));
      if (side.lengthSq() < 1e-8) side = new THREE.Vector3(1, 0, 0).addScaledVector(dir, -dir.x);
      side.normalize();
      const back = dir.clone().negate();
      const up = new THREE.Vector3().crossVectors(back, side);
      const q = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(side, up, back));
      return { pos, q };
    }
    slot.ctrl.updateMatrixWorld(true);
    const q = slot.ctrl.getWorldQuaternion(new THREE.Quaternion());
    const dir = NEG_Z.clone().applyQuaternion(q);
    const pos = new THREE.Vector3().setFromMatrixPosition(slot.ctrl.matrixWorld).addScaledVector(dir, 0.1);
    return { pos, q };
  }

  follow(slot) {
    const t = slot.held;
    if (!t) return;
    const pose = this.poseFor(slot);
    if (!pose) return;
    t.mesh.position.copy(pose.pos);
    t.mesh.quaternion.copy(pose.q);
    const st = slot.touch ? slot.touch.state : 'none';
    this.setTip(t, st === 'touch' ? t.id : st === 'near' ? 'near' : 'idle');
  }

  tipPosition(slot) {
    const t = slot.held;
    if (!t) return null;
    return t.mesh.getWorldPosition(new THREE.Vector3());
  }

  setTip(t, state) {
    if (t.tipState === state) return;
    t.tipState = state;
    t.glow.material.color.set(TIP[state]);
    t.glow.scale.setScalar(state === 'idle' ? 1 : state === 'near' ? 1.3 : 1.6);
  }
}

// ---------------------------------------------------------------- meshes

function makeStylus() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.0065, 0.13, 6, 14).rotateX(Math.PI / 2).translate(0, 0, 0.074).scale(1.5, 0.55, 1),
    new THREE.MeshStandardMaterial({ color: '#efe5cf', roughness: 0.5, emissive: new THREE.Color('#ffc54d'), emissiveIntensity: 0 }),
  );
  body.castShadow = true;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 16, 12), new THREE.MeshBasicMaterial({ color: TIP.idle }));
  g.add(body, tip);
  g.userData.body = body;
  g.userData.tip = tip;
  return g;
}

function makeCutter() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0062, 0.0062, 0.11, 14).rotateX(Math.PI / 2).translate(0, 0, 0.082),
    new THREE.MeshStandardMaterial({ color: '#2d3468', roughness: 0.45, metalness: 0.2, emissive: new THREE.Color('#ffc54d'), emissiveIntensity: 0 }),
  );
  body.castShadow = true;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0055, 0.012, 14).rotateX(Math.PI / 2).translate(0, 0, 0.024), new THREE.MeshStandardMaterial({ color: '#9aa3b5', metalness: 0.8, roughness: 0.3 }));
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(0.0045, 0.018); shape.lineTo(-0.0025, 0.018); shape.closePath();
  const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.0006, bevelEnabled: false }).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#d4d9e2', metalness: 0.9, roughness: 0.2 }));
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 16, 12), new THREE.MeshBasicMaterial({ color: TIP.idle }));
  g.add(body, collar, blade, tip);
  g.userData.body = body;
  g.userData.tip = tip;
  return g;
}

function distToTool(t, point) {
  t.mesh.updateWorldMatrix(true, false);
  const a = new THREE.Vector3(0, 0, 0).applyMatrix4(t.mesh.matrixWorld);
  const b = new THREE.Vector3(0, 0, 0.14).applyMatrix4(t.mesh.matrixWorld);
  const ab = b.clone().sub(a);
  const k = THREE.MathUtils.clamp(point.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return Math.max(0, point.distanceTo(a.addScaledVector(ab, k)) - 0.008);
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(24, 28, 56, 0.88)';
  const r = 40;
  g.beginPath();
  g.moveTo(r, 8); g.arcTo(632, 8, 632, 88, r); g.arcTo(632, 88, 8, 88, r); g.arcTo(8, 88, 8, 8, r); g.arcTo(8, 8, 632, 8, r);
  g.fill();
  g.fillStyle = '#f6f3ea';
  g.font = '600 38px "Zen Kaku Gothic New", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 320, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(0.15, 0.0225, 1);
  s.renderOrder = 30;
  return s;
}
