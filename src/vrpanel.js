import * as THREE from 'three';

// A floating control panel for VR, drawn on a canvas. Use it with a
// controller or hand ray (trigger / pinch) or by poking it with a fingertip.

const PX_W = 1024, PX_H = 900;
const C = {
  bg: 'rgba(24, 28, 56, 0.94)',
  btn: '#2d3468',
  btnHover: '#3d478a',
  active: '#f0b44c',
  activeText: '#1b1e33',
  text: '#f3f1ea',
  muted: '#a9aed0',
  line: 'rgba(255,255,255,0.12)',
};

export class VRPanel {
  constructor(app) {
    this.app = app;
    this.canvas = document.createElement('canvas');
    this.canvas.width = PX_W;
    this.canvas.height = PX_H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.width = 0.4;
    this.height = this.width * PX_H / PX_W;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(this.width, this.height),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
    this.mesh.name = 'vr-panel';
    this.hover = new Map();
    this.pokes = new Map();
    this.flash = null;
    this.buttons = [];
    this.dirty = true;
    this.font = '"Zen Kaku Gothic New", system-ui, sans-serif';
    this.pressedKeys = new Set();
    // Where a fingertip is about to touch the panel.
    this.contact = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1, 32),
      new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.contact.renderOrder = 25;
    this.contact.visible = false;
    this.mesh.add(this.contact);
    this.contactDot = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color: '#36d98a', depthTest: false }));
    this.contactDot.renderOrder = 26;
    this.contactDot.visible = false;
    this.mesh.add(this.contactDot);
  }

  invalidate() { this.dirty = true; }

  layout() {
    const s = this.app.state;
    const a = this.app.actions;
    const B = [];
    const M = 24, W = PX_W - 2 * M;
    const btn = (x, y, w, h, label, action, opts = {}) => B.push({ x, y, w, h, label, action, ...opts });
    const row = (y, h, items, gap = 12) => {
      const total = items.reduce((t, it) => t + (it.w || 1), 0);
      const free = W - gap * (items.length - 1);
      let x = M;
      for (const it of items) {
        const w = Math.round(free * (it.w || 1) / total);
        btn(x, y, w, h, it.label, it.action, it);
        x += w + gap;
      }
    };

    // Workspace switch, then the active workspace's controls.
    const space = this.app.space;
    const page = this.app.panelPage;
    row(84, 60, [
      { label: 'Paper', action: () => { this.app.panelPage = 'work'; a.setSpace('paper'); this.invalidate(); }, active: page === 'work' && space === 'paper' },
      { label: 'Solids', action: () => { this.app.panelPage = 'work'; a.setSpace('solids'); this.invalidate(); }, active: page === 'work' && space === 'solids' },
      { label: 'Place & view', action: () => { this.app.panelPage = 'place'; this.invalidate(); }, active: page === 'place' },
    ]);
    if (page === 'place') {
      this.placeRows(row, B, M, W);
      B.push({ kind: 'text', x: M, y: 672, w: W - 210, h: 170, label: this.app.statusText || '', status: true });
      btn(PX_W - M - 196, 752, 196, 70, 'Exit VR', () => a.exitXR());
      this.buttons = B;
      return;
    }
    if (space === 'solids') {
      this.app.solids.panelRows(row, B, M, W, 160);
      B.push({ kind: 'text', x: M, y: 672, w: W - 210, h: 170, label: this.app.statusText || '', status: true });
      btn(PX_W - M - 196, 752, 196, 70, 'Exit VR', () => a.exitXR());
      this.buttons = B;
      return;
    }

    row(160, 96, [
      { label: 'Paint', action: () => a.setTool('paint'), active: s.tool === 'paint' },
      { label: 'Crease', action: () => a.setTool('crease'), active: s.tool === 'crease' },
      { label: 'Cut', action: () => a.setTool('cut'), active: s.tool === 'cut' },
      { label: 'Fold', action: () => a.setTool('fold'), active: s.tool === 'fold' },
      { label: 'Move', action: () => a.setTool('move'), active: s.tool === 'move' },
    ]);

    if (s.tool === 'paint') {
      const sw = this.app.palette.map((c) => ({ label: '', swatch: c, action: () => a.setColor(c), active: !s.eraser && s.color === c }));
      sw.push({ label: 'Eraser', w: 1.4, action: () => a.toggleEraser(), active: s.eraser });
      row(272, 84, sw, 10);
      row(372, 84, [
        { label: '−', action: () => a.brush(-1) },
        { label: `Brush ${s.brushMM} mm`, w: 2, kind: 'label' },
        { label: '+', action: () => a.brush(1) },
        { label: 'Clear paint', w: 2, action: () => a.clearPaint() },
      ]);
    } else if (s.tool === 'crease') {
      row(272, 84, [
        { label: `Snap ${s.snap ? 'on' : 'off'}`, action: () => a.toggleSnap(), active: s.snap },
        { label: 'Unfold all', action: () => a.unfoldAll() },
      ]);
      B.push({ kind: 'text', x: M, y: 372, w: W, h: 84, label: 'Trigger or pinch on the paper, drag, release. Or draw with your fingertip. The line runs through every layer.' });
    } else if (s.tool === 'cut') {
      row(272, 84, [
        { label: 'Unfold all', action: () => a.unfoldAll() },
        { label: 'Undo cut', action: () => a.undo() },
      ]);
      B.push({ kind: 'text', x: M, y: 372, w: W, h: 84, label: 'Point at a crease and tap to cut that segment, or hold and drag along it. Fingertip works too. Cuts go through every layer.' });
    } else if (s.tool === 'fold') {
      row(272, 84, [
        { label: 'Valley ↑', action: () => a.valley() },
        { label: 'Mountain ↓', action: () => a.mountain() },
        { label: 'Flatten', action: () => a.flatten() },
      ]);
      row(372, 84, [
        { label: 'All layers', action: () => a.setLayerMode('all'), active: s.layerMode === 'all' },
        { label: 'Top flap', action: () => a.setLayerMode('top'), active: s.layerMode === 'top' },
      ]);
    } else {
      row(272, 84, [
        { label: 'Flip over', action: () => a.flip() },
        { label: 'Back on table', action: () => a.resetPosition() },
      ]);
      B.push({ kind: 'text', x: M, y: 372, w: W, h: 84, label: this.app.paper.pieceCount > 1
        ? 'Trigger or pinch a cut-out piece to carry it alone. Grip (squeeze) carries the whole sheet.'
        : 'Grab the paper with trigger or pinch and move it. Grip (squeeze) carries it in any mode.' });
    }

    row(472, 84, [
      { label: 'Undo', action: () => a.undo() },
      { label: 'Unfold all', action: () => a.unfoldAll() },
      { label: 'Flip', action: () => a.flip() },
      { label: 'Recenter', action: () => a.recenter() },
    ]);

    row(572, 84, [
      { label: 'W −', action: () => a.draftSize(-5, 0) },
      { label: `${s.draftW} × ${s.draftH} cm`, w: 2, kind: 'label' },
      { label: 'W +', action: () => a.draftSize(5, 0) },
      { label: 'H −', action: () => a.draftSize(0, -5) },
      { label: 'H +', action: () => a.draftSize(0, 5) },
      { label: 'New paper', w: 1.6, action: () => a.newPaper() },
    ], 10);

    B.push({ kind: 'text', x: M, y: 672, w: W - 210, h: 170, label: this.app.statusText || '', status: true });
    btn(PX_W - M - 196, 752, 196, 70, 'Exit VR', () => a.exitXR());
    this.buttons = B;
  }

  // Workspace placement and surface options.
  placeRows(row, B, M, W) {
    const pl = this.app.placement;
    const locked = pl.locked;
    row(160, 84, [
      { label: 'Place in front of me', w: 2, action: () => pl.placeInFront() },
      { label: 'Seated', action: () => pl.setPosture('seated'), active: pl.used === 'seated' },
      { label: 'Standing', action: () => pl.setPosture('standing'), active: pl.used === 'standing' },
    ]);
    const n = (label, kind, sign) => ({ label, action: () => pl.nudge(kind, sign), disabled: locked });
    row(258, 78, [n('Lower', 'height', -1), n('Higher', 'height', 1), n('Closer', 'distance', -1), n('Farther', 'distance', 1)]);
    row(346, 78, [n('Left', 'side', -1), n('Right', 'side', 1), n('Turn ⟲', 'turn', 1), n('Turn ⟳', 'turn', -1)]);
    const surf = { mat: 'Cutting mat', plain: 'Plain table', hidden: 'No table' }[this.app.state.surface];
    row(434, 78, [
      { label: locked ? 'Locked ✓' : 'Lock placement', action: () => pl.setLocked(!locked), active: locked },
      { label: `Surface: ${surf}`, w: 1.4, action: () => this.app.cycleSurface() },
      ...(this.app.envLabel ? [{ label: `View: ${this.app.envLabel()}`, w: 1.3, action: () => this.app.cycleEnvironment() }] : []),
    ]);
    B.push({ kind: 'text', x: M, y: 530, w: W, h: 130, label: locked
      ? 'Placement is locked. Unlock to move the table or this panel.'
      : 'Grab the yellow bar at the front edge to slide, raise or lower the table; the round knobs turn it; the bar under this panel moves the panel.' });
  }

  draw() {
    this.layout();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, PX_W, PX_H);
    roundRect(ctx, 0, 0, PX_W, PX_H, 36);
    ctx.fillStyle = C.bg;
    ctx.fill();
    ctx.fillStyle = C.text;
    ctx.font = `700 36px ${this.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Paper Fold Studio', 28, 46);
    ctx.font = `500 26px ${this.font}`;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'right';
    ctx.fillText(this.app.space === 'solids'
      ? `${this.app.solids.comp.solids.length} cube${this.app.solids.comp.solids.length === 1 ? '' : 's'} · ${this.app.solids.shell.panels.length} panels`
      : `Sheet ${fmt(this.app.paper.W * 100)} × ${fmt(this.app.paper.H * 100)} cm`, PX_W - 28, 46);
    const hovered = new Set(this.hover.values());
    for (const b of this.buttons) {
      if (b.kind === 'text') {
        ctx.fillStyle = b.status ? C.text : C.muted;
        ctx.font = `${b.status ? 600 : 500} 27px ${this.font}`;
        ctx.textAlign = 'left';
        wrapText(ctx, b.label, b.x + 4, b.y + 20, b.w - 8, 36);
        continue;
      }
      if (b.kind === 'label') {
        ctx.fillStyle = C.text;
        ctx.font = `600 28px ${this.font}`;
        ctx.textAlign = 'center';
        ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
        continue;
      }
      if (b.disabled) {
        roundRect(ctx, b.x, b.y, b.w, b.h, 18);
        ctx.fillStyle = 'rgba(45, 52, 104, 0.45)';
        ctx.fill();
        ctx.fillStyle = C.muted;
        ctx.font = `600 30px ${this.font}`;
        ctx.textAlign = 'center';
        ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
        continue;
      }
      const isFlash = this.flash && this.flash.b === b.label && performance.now() - this.flash.t < 180;
      const key = `${b.x},${b.y}`;
      const isHover = hovered.has(key);
      const isPressed = this.pressedKeys.has(key);
      const inset = isPressed ? 4 : 0;
      roundRect(ctx, b.x + inset, b.y + inset, b.w - 2 * inset, b.h - 2 * inset, 18);
      ctx.fillStyle = b.active || isFlash || isPressed ? C.active : isHover ? C.btnHover : C.btn;
      ctx.fill();
      if (isHover) {
        // A bold outline marks exactly what will be pressed.
        roundRect(ctx, b.x - 5, b.y - 5, b.w + 10, b.h + 10, 22);
        ctx.strokeStyle = '#ffd27a';
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      if (b.swatch) {
        roundRect(ctx, b.x + 12, b.y + 12, b.w - 24, b.h - 24, 12);
        ctx.fillStyle = b.swatch;
        ctx.fill();
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 2;
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = b.active || isFlash ? C.activeText : C.text;
      ctx.font = `600 30px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  update() {
    if (this.flash && performance.now() - this.flash.t > 200 && !this.flash.done) {
      this.flash.done = true;
      this.dirty = true;
    }
    if (this.dirty && this.mesh.visible) this.draw();
  }

  // Button under a panel-local point. With tolerance (canvas px), a point
  // in the gap between buttons picks the nearest one.
  buttonAtLocal(local, tolerance = 0) {
    const px = (local.x / this.width + 0.5) * PX_W;
    const py = (0.5 - local.y / this.height) * PX_H;
    let best = null, bd = tolerance;
    for (const b of this.buttons) {
      if (!b.action || b.disabled) continue;
      const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
      const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
      const d = Math.hypot(dx, dy);
      if (d === 0) return b;
      if (d <= bd) { bd = d; best = b; }
    }
    return best;
  }

  // Ray test in world space. Returns { distance, point, button } or null.
  raycast(ray) {
    if (!this.mesh.visible) return null;
    const hits = new THREE.Raycaster(ray.origin, ray.direction, 0, 10).intersectObject(this.mesh, false);
    if (!hits.length) return null;
    const local = this.mesh.worldToLocal(hits[0].point.clone());
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(this.mesh.matrixWorld);
    return { distance: hits[0].distance, point: hits[0].point, normal, button: this.buttonAtLocal(local, 30) };
  }

  setPressed(button, on) {
    if (!button) return;
    const key = `${button.x},${button.y}`;
    if (on) this.pressedKeys.add(key); else this.pressedKeys.delete(key);
    this.dirty = true;
  }

  setHover(id, button) {
    const key = button ? `${button.x},${button.y}` : null;
    const prev = this.hover.get(id) ?? null;
    if (prev === key) return;
    if (key) this.hover.set(id, key);
    else this.hover.delete(id);
    this.dirty = true;
  }

  click(button) {
    if (!button || !button.action) return;
    this.flash = { b: button.label, t: performance.now() };
    this.app.haptic?.();
    button.action();
    this.dirty = true;
  }

  // Fingertip poke. Shows the contact point as the finger approaches,
  // outlines the button it will press, presses at 1.2 cm and releases at
  // 2.5 cm. Returns 'none' | 'near' | 'touch'.
  poke(id, tipWorld) {
    const state = this.pokes.get(id) || { down: false, button: null };
    this.pokes.set(id, state);
    const clear = () => {
      if (state.down) this.setPressed(state.button, false);
      state.down = false;
      state.button = null;
      this.setHover(id + ':poke', null);
      if (this.contactOwner === id) { this.contact.visible = this.contactDot.visible = false; this.contactOwner = null; }
      return 'none';
    };
    if (!this.mesh.visible || !tipWorld) return clear();
    const local = this.mesh.worldToLocal(tipWorld.clone());
    const margin = 0.02;
    const inside = Math.abs(local.x) < this.width / 2 + margin && Math.abs(local.y) < this.height / 2 + margin;
    if (!inside || local.z > 0.07 || local.z < -0.05) return clear();
    const b = state.down ? state.button : this.buttonAtLocal(local, 24);
    this.setHover(id + ':poke', b);
    // Contact marker: a ring that shrinks as the finger approaches.
    this.contactOwner = id;
    const z = Math.max(0, local.z);
    this.contact.visible = true;
    this.contact.position.set(local.x, local.y, 0.002);
    this.contact.scale.setScalar(0.004 + z * 0.25);
    this.contactDot.visible = state.down || z < 0.012;
    this.contactDot.position.set(local.x, local.y, 0.003);
    this.contactDot.scale.setScalar(0.004);
    if (!state.down && local.z < 0.012) {
      state.down = true;
      state.button = b;
      this.setPressed(b, true);
      this.click(b);
    } else if (state.down && local.z > 0.025) {
      this.setPressed(state.button, false);
      state.down = false;
      state.button = null;
    }
    return state.down || local.z < 0.03 ? 'touch' : 'near';
  }
}

function fmt(v) { return Math.round(v * 10) / 10; }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxW, lh) {
  const words = String(text).split(/\s+/);
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
}
