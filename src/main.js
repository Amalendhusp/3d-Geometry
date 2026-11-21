import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PaintSurface } from './paint.js';
import { Paper } from './paper.js';
import { Tools } from './tools.js';
import { VRPanel } from './vrpanel.js';
import { XRInput } from './xr.js';
import { UI } from './ui.js';
import { SolidsWorkspace } from './solids/workspace.js';
import { SolidsUI } from './solids/ui.js';
import { Placement, SURFACES, SURFACE_LABELS } from './placement.js';
import { HandTools } from './handtools.js';
import { Environments, ENV_LABELS } from './environment.js';

const PALETTE = ['#1d1f2b', '#d8452f', '#f0a325', '#f2d64b', '#3f9b5a', '#2f74c0', '#7a4bb3', '#ffffff'];
const BRUSH_SIZES = [1, 2, 3, 5, 8, 12, 18, 25, 35];
const TABLE_TOP = 0.74;

class App {
  constructor() {
    this.palette = PALETTE;
    this.state = {
      tool: 'paint',
      color: PALETTE[1],
      eraser: false,
      brushMM: 5,
      snap: true,
      layerMode: 'all',
      widthCm: 30,
      heightCm: 30,
      draftW: 30,
      draftH: 30,
      frontColor: '#fbfaf6',
      backColor: '#bcd3ee',
      detail: 2048,
      onTable: true,
      surface: 'mat', // 'mat' | 'plain' | 'hidden'
      xr: null, // 'immersive-vr' | 'immersive-ar' | null
    };
    this.panelPage = 'work'; // VR panel page: 'work' | 'place'
    this.statusText = 'Pick a tool. Paint, draw a crease, then fold along it.';
    this.tableTop = TABLE_TOP;
    this.history = this.makeHistory();
    this.listeners = new Set();

    this.initRenderer();
    this.initScene();
    this.paint = new PaintSurface(this.renderer);
    this.paint.create(0.3, 0.3, this.state.frontColor, this.state.backColor, this.state.detail);
    this.paper = new Paper(this.paint);
    this.surface.add(this.paper.root);
    this.paper.reset(0.3, 0.3);
    this.tools = new Tools(this);
    this.panel = new VRPanel(this);
    this.panel.mesh.visible = false;
    this.surface.add(this.panel.mesh);
    this.initPreviews();
    this.space = location.hash === '#solids' ? 'solids' : 'paper';
    this.solids = new SolidsWorkspace(this);
    this.surface.add(this.solids.root);
    this.placement = new Placement(this);
    this.handTools = new HandTools(this);
    this.actions = this.makeActions();
    this.xrInput = new XRInput(this);
    this.haptic = () => this.xrInput.hapticAll();
    this.initScreenInput();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 0.12;
    this.controls.maxDistance = 6;
    this.ui = new UI(this);
    this.solidsUI = new SolidsUI(this);
    this.applySpace();
    this.environments.set('terrace');
    this.environments.align(new THREE.Vector3(0, 0, 0.5), 0);
    if (this.space === 'solids') this.statusText = 'Solid → Unfold: tap a panel to see its hinges, then swing it open. Build adds and joins cubes.';
    this.layoutTable();
    this.resetPosition();
    this.fitCamera();
    this.initXR();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop((t, frame) => this.tick(t, frame));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.panel.invalidate());
    window.addEventListener('resize', () => this.onResize());
    this.notify();
  }

  // ------------------------------------------------------------- scene

  initRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');
    r.xr.setFoveation(0.4);
    document.getElementById('stage').appendChild(r.domElement);
    r.domElement.id = 'scene';
    this.renderer = r;
  }

  initScene() {
    const scene = new THREE.Scene();
    this.bg = new THREE.Color('#e4e0d6');
    scene.background = this.bg;
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.03, 4000);
    this.camera.position.set(0, 1.25, 0.55);

    // workspace: the table's footprint on the floor (position + yaw).
    // surface: the table top, at table height; everything on it rides along.
    this.workspace = new THREE.Group();
    this.workspace.name = 'workspace';
    scene.add(this.workspace);
    this.surface = new THREE.Group();
    this.surface.name = 'surface';
    this.workspace.add(this.surface);

    const hemi = new THREE.HemisphereLight('#fffaf0', '#8c8476', 1.5);
    scene.add(hemi);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight('#ffffff', 1.9);
    sun.position.set(0.5, 1.6, 0.7);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 0.2;
    sun.shadow.camera.far = 4;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.01;
    this.sun = sun;
    this.surface.add(sun, sun.target);

    // Surroundings are separate from the work surface (environment.js).
    this.environments = new Environments(this, hemi);
    this.env = this.environments.root;
    scene.add(this.env);

    this.table = new THREE.Group(); // legs (floor based)
    this.workspace.add(this.table);
    this.wood = new THREE.MeshStandardMaterial({ color: '#a77b52', roughness: 0.75 });
    this.tableTopMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.04, 1), this.wood);
    this.tableTopMesh.receiveShadow = true;
    this.tableTopMesh.castShadow = true;
    this.surface.add(this.tableTopMesh);
    this.legs = [];
    const legMat = new THREE.MeshStandardMaterial({ color: '#2b2f45', roughness: 0.6, metalness: 0.2 });
    for (let k = 0; k < 4; k++) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1, 0.04), legMat);
      leg.castShadow = true;
      this.legs.push(leg);
      this.table.add(leg);
    }
    this.mat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 0.95 }));
    this.mat.rotation.x = -Math.PI / 2;
    this.mat.receiveShadow = true;
    this.surface.add(this.mat);
  }

  // Depth of the work area (for placing the table at arm's length).
  workDepth() {
    return this.space === 'solids' ? Math.min(0.6, this.solids.extent()) : this.paper.H;
  }

  // Size the table and cutting mat to the work; surface coordinates.
  layoutTable() {
    const ext = this.space === 'solids' && this.solids ? this.solids.extent() : null;
    const W = ext ?? this.paper.W, H = ext ?? this.paper.H;
    const tw = Math.max(1.0, W + 0.45), td = Math.max(0.7, H + 0.35);
    this.tableSize = { tw, td };
    this.tableTopMesh.scale.set(tw, 1, td);
    this.tableTopMesh.position.set(0, -0.02, 0);
    this.legPos = [[-(tw / 2 - 0.06), -(td / 2 - 0.06)], [tw / 2 - 0.06, -(td / 2 - 0.06)], [-(tw / 2 - 0.06), td / 2 - 0.06], [tw / 2 - 0.06, td / 2 - 0.06]];
    const mw = Math.min(tw - 0.06, Math.max(W, H) + 0.16), md = Math.min(td - 0.06, Math.max(W, H) + 0.12);
    const key = `${mw.toFixed(3)}x${md.toFixed(3)}`;
    if (this.matKey !== key) {
      this.matKey = key;
      if (this.mat.material.map) this.mat.material.map.dispose();
      this.mat.material.map = makeMatTexture(mw, md);
      this.mat.material.needsUpdate = true;
    }
    this.mat.scale.set(mw, md, 1);
    this.mat.position.set(0, 0.0005, 0);

    const sc = this.sun.shadow.camera;
    const shadowExt = Math.max(tw, td) * 0.75 + 0.2;
    sc.left = -shadowExt; sc.right = shadowExt; sc.top = shadowExt; sc.bottom = -shadowExt;
    sc.updateProjectionMatrix();

    if (this.solids && !this.solids.carried) this.solids.root.position.set(0, 0.002, 0);
    if (!this.placement?.panelCustom) this.resetPanelPose();
    this.placement?.layout(tw, td);
    this.handTools?.layout(tw, td);
    this.applySurfaceStyle();
    this.applyHeight();
  }

  // Table height changes only move the surface and stretch the legs.
  applyHeight() {
    const top = this.tableTop;
    this.surface.position.y = top;
    this.legPos.forEach(([x, z], k) => {
      const leg = this.legs[k];
      leg.scale.y = Math.max(0.05, top - 0.04);
      leg.position.set(x, (top - 0.04) / 2, z);
    });
  }

  // Default spot for the VR panel: left of the work, angled toward you.
  resetPanelPose() {
    const W = this.space === 'solids' ? this.solids.extent() : this.paper.W;
    const H = this.space === 'solids' ? this.solids.extent() : this.paper.H;
    const seated = this.placement?.used === 'seated';
    const px = -Math.max(seated ? 0.32 : 0.36, W / 2 + 0.16);
    this.panel.mesh.position.set(px, seated ? 0.22 : 0.29, Math.min(0.2, H / 2 + 0.05));
    this.panel.mesh.rotation.set(0, 0, 0);
    this.panel.mesh.rotateY(0.62);
    this.panel.mesh.rotateX(seated ? -0.55 : -0.42);
  }

  envLabel() { return ENV_LABELS[this.environments.current]; }

  setEnvironment(name) {
    this.environments.set(name);
    this.toast(`View: ${ENV_LABELS[name]}.`);
    this.notify();
  }

  cycleEnvironment() {
    const keys = Object.keys(ENV_LABELS);
    this.setEnvironment(keys[(keys.indexOf(this.environments.current) + 1) % keys.length]);
  }

  // Stand the viewer on the terrace facing the view (does not move the table).
  faceTheView() {
    const head = this.viewerPosition();
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    this.environments.align(head, Math.atan2(-fwd.x, -fwd.z));
  }

  setSurface(style) {
    this.state.surface = style;
    this.applySurfaceStyle();
    this.toast(`Surface: ${SURFACE_LABELS[style]}.`);
    this.notify();
  }

  cycleSurface() {
    this.setSurface(SURFACES[(SURFACES.indexOf(this.state.surface) + 1) % SURFACES.length]);
  }

  applySurfaceStyle() {
    const style = this.state.surface;
    const hidden = style === 'hidden' || this.state.xr === 'immersive-ar';
    this.tableTopMesh.visible = !hidden;
    this.table.visible = !hidden;
    this.mat.visible = !hidden && style === 'mat';
    this.wood.color.set(style === 'plain' ? '#d8c6a6' : '#a77b52');
  }

  initPreviews() {
    const accent = new THREE.MeshBasicMaterial({ color: '#f0b44c', transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.creasePreview = new THREE.Group();
    this.creasePreview.renderOrder = 15;
    this.paper.root.add(this.creasePreview);
    this.previewMat = accent;
    this.cutMat = new THREE.MeshBasicMaterial({ color: '#c43d1a', transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.cutHoverMat = new THREE.MeshBasicMaterial({ color: '#ff8a5c', transparent: true, opacity: 0.8, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.tickMat = new THREE.MeshBasicMaterial({ color: '#1d1f2b', transparent: true, opacity: 0.7, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.axisMat = new THREE.MeshBasicMaterial({ color: '#e0661d', transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    this.axis = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), this.axisMat);
    this.axis.renderOrder = 16;
    this.axis.visible = false;
    this.paper.root.add(this.axis);
    this.hoverCursor = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 40),
      new THREE.MeshBasicMaterial({ color: '#1d1f2b', transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }),
    );
    this.hoverCursor.renderOrder = 20;
    this.hoverCursor.visible = false;
    this.scene.add(this.hoverCursor);
  }

  showCreasePreview(face, a, b) {
    const segs = this.paper.creaseSegments(face, a, b);
    const n = new THREE.Vector3().setFromMatrixColumn(face.M, 2).normalize();
    const dots = [a, b].map((p) => this.paper.toLocal(face, p[0], p[1]));
    this.drawPreview(segs, n, this.previewMat, dots);
  }

  // Cut preview: the span [a, b] along the crease line, plus the crossings
  // it can snap to.
  showCutPreview(line, a, b, hover = false) {
    const lift = this.paper.maxStackHeight() + 0.0004;
    const at = (t) => line.P.clone().addScaledVector(line.u, t).addScaledVector(line.n, lift);
    const stops = line.stops.filter((t, i) => i === 0 || t - line.stops[i - 1] > 1e-4).map(at);
    this.drawPreview([[at(a), at(b)]], line.n, hover ? this.cutHoverMat : this.cutMat, [at(a), at(b)], stops);
  }

  // Where a crease would start: a ring, filled when it snaps to a point.
  showSnapPreview(face, p, snapped) {
    const n = new THREE.Vector3().setFromMatrixColumn(face.M, 2).normalize();
    const P = this.paper.toLocal(face, p[0], p[1]).addScaledVector(n, face.off);
    this.drawPreview([], n, this.previewMat, snapped ? [P] : [], snapped ? [] : [P]);
  }

  drawPreview(segs, n, mat, dots, ticks = []) {
    const g = this.creasePreview;
    for (const c of g.children) c.geometry.dispose();
    g.clear();
    const w = Math.max(0.0008, this.paper.size * 0.003);
    const pos = [];
    for (const [A, B] of segs) {
      if (A.distanceTo(B) < 1e-6) continue;
      const d = B.clone().sub(A).normalize();
      const side = new THREE.Vector3().crossVectors(n, d).multiplyScalar(w);
      const p = [A.clone().add(side), B.clone().add(side), B.clone().sub(side), A.clone().sub(side)];
      pos.push(...p[0].toArray(), ...p[1].toArray(), ...p[2].toArray(), ...p[0].toArray(), ...p[2].toArray(), ...p[3].toArray());
    }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 15;
      g.add(m);
    }
    const r = Math.max(0.0025, this.paper.size * 0.008);
    const disc = (P, radius, material) => {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), material);
      dot.position.copy(P);
      dot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      dot.renderOrder = 15;
      g.add(dot);
    };
    for (const P of ticks) disc(P, r * 0.55, this.tickMat);
    for (const P of dots) disc(P, r, mat);
  }

  hideCreasePreview() {
    for (const c of this.creasePreview.children) c.geometry.dispose();
    this.creasePreview.clear();
  }

  showAxis(s, mode) {
    this.axisMat.color.set(mode === 'hover' ? '#4f8fff' : '#e0661d');
    const A = s.axisA, B = s.axisB;
    const len = A.distanceTo(B);
    if (!(len > 1e-5)) { this.axis.visible = false; return; }
    const r = Math.max(0.0007, this.paper.size * 0.0025);
    this.axis.position.copy(A).add(B).multiplyScalar(0.5);
    this.axis.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    this.axis.scale.set(r, len, r);
    this.axis.visible = true;
  }

  hideAxis() { this.axis.visible = false; }

  // ------------------------------------------------------------ helpers

  makeHistory() {
    const app = this;
    return {
      stack: [],
      push(e) {
        this.stack.push(e);
        if (this.stack.length > 60) this.stack.shift();
        app.notify();
      },
      clear() { this.stack = []; app.notify(); },
      get canUndo() { return this.stack.length > 0; },
    };
  }

  notify() {
    for (const fn of this.listeners) fn();
    this.panel.invalidate();
  }

  toast(msg, ms = 2600) {
    this.statusText = msg;
    this.ui?.toast(msg, ms);
    this.panel?.invalidate();
  }

  viewerPosition() {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    return cam.getWorldPosition(new THREE.Vector3());
  }

  // ---------------------------------------------------- workspace routing

  get activeTools() { return this.space === 'solids' ? this.solids.tools : this.tools; }

  pickActive(ray) { return this.space === 'solids' ? this.solids.pick(ray) : this.pickPaper(ray); }

  nearestActive(point, maxDist) {
    return this.space === 'solids' ? this.solids.nearest(point, maxDist) : this.paper.nearestFace(point, maxDist);
  }

  // Tools that fingertips can use by touching the surface.
  touchAllowed() {
    return this.space === 'solids' || ['paint', 'crease', 'cut'].includes(this.state.tool);
  }

  cursorRadius() {
    if (this.space === 'solids') return this.solids.edgeLen * 0.035;
    return this.state.tool === 'paint' ? Math.max(0.0015, this.state.brushMM / 2000) : 0.004;
  }

  applySpace() {
    const solids = this.space === 'solids';
    this.paper.root.visible = !solids;
    this.solids.root.visible = solids;
    this.hideCreasePreview();
    this.hideAxis();
    this.hoverCursor.visible = false;
    document.body.dataset.space = this.space;
  }

  setSpace(space) {
    if (space === this.space) return;
    this.tools.finishAll();
    this.solids.tools.finishAll();
    this.tools.clearSelection();
    this.space = space;
    this.applySpace();
    this.handTools.updateVisibility();
    try { history.replaceState(null, '', space === 'solids' ? '#solids' : '#paper'); } catch { /* ignore */ }
    this.layoutTable();
    if (!this.renderer.xr.isPresenting) this.fitCamera();
    this.toast(space === 'solids'
      ? 'Solid → Unfold: tap a panel to see its hinges, then swing it open. Build adds and joins cubes.'
      : 'Paper folding: paint, crease, cut and fold a sheet.');
    this.notify();
  }

  pickPaper(ray) {
    this.paper.root.updateMatrixWorld(true);
    this.raycaster = this.raycaster || new THREE.Raycaster();
    this.raycaster.set(ray.origin, ray.direction);
    this.raycaster.near = 0;
    this.raycaster.far = 20;
    const hits = this.raycaster.intersectObjects(this.paper.pickables, false);
    return hits.length ? this.paper.hitInfo(hits[0]) : null;
  }

  geometryChanged() {
    this.restOnTable();
    this.notify();
  }

  foldChanged(s, final = false) {
    if (final) {
      this.paper.setHighlight(s, true);
      this.restOnTable();
    }
    this.ui.syncAngle(s.theta);
  }

  restOnTable() {
    if (!this.state.onTable) return;
    const box = this.paper.worldBounds();
    if (box.isEmpty()) return;
    const want = this.surface.getWorldPosition(new THREE.Vector3()).y + 0.0015;
    this.paper.root.position.y += want - box.min.y;
    this.paper.root.updateMatrixWorld(true);
  }

  resetPosition() {
    const root = this.paper.root;
    root.position.set(0, 0.0015, 0);
    root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    this.state.onTable = true;
    this.restOnTable();
  }

  fitCamera() {
    const s = this.space === 'solids' ? Math.max(0.3, this.solids.extent() * 0.75) : this.paper.size;
    const aspect = window.innerWidth / window.innerHeight;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const visible = 2 * Math.tan(vfov / 2);
    // Keep the sheet in the middle half of the screen, clear of the tool dock.
    const d = s / (0.5 * visible * Math.min(1, aspect)) + 0.05;
    const el = THREE.MathUtils.degToRad(60);
    const target = new THREE.Vector3(0, this.tableTop + (this.space === 'solids' ? 0.04 : 0), 0.16 * s);
    this.camera.position.set(0, target.y + Math.sin(el) * d, target.z + Math.cos(el) * d);
    this.controls.target.copy(target);
    this.controls.update();
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ------------------------------------------------------------ actions

  makeActions() {
    const app = this;
    const st = this.state;
    return {
      setTool(t) {
        if (st.tool === t) return;
        st.tool = t;
        if (t !== 'fold') app.tools.clearSelection();
        const hints = {
          paint: 'Paint on either side of the sheet.',
          crease: 'Drag across the paper to draw a crease. Ends snap to corners, midpoints and crossings.',
          cut: 'Tap a crease segment to cut it, or drag along a crease to cut part of it. Cuts go through every layer.',
          fold: 'Grab the paper next to a crease and swing it over. Or tap a flap, then Valley / Mountain.',
          move: app.paper.pieceCount > 1
            ? 'Grab a cut-out piece to move it on its own.'
            : app.renderer.xr.isPresenting ? 'Grab the paper and move it.' : 'Drag to orbit, pinch or scroll to zoom, two fingers to pan.',
        };
        app.toast(hints[t]);
        app.notify();
      },
      setColor(c) {
        st.color = c;
        st.eraser = false;
        if (st.tool !== 'paint') this.setTool('paint');
        app.notify();
      },
      toggleEraser() { st.eraser = !st.eraser; app.notify(); },
      setBrush(mm) { st.brushMM = mm; app.notify(); },
      brush(dir) {
        let i = BRUSH_SIZES.findIndex((v) => v >= st.brushMM);
        if (i < 0) i = BRUSH_SIZES.length - 1;
        i = Math.max(0, Math.min(BRUSH_SIZES.length - 1, i + dir));
        st.brushMM = BRUSH_SIZES[i];
        app.notify();
      },
      toggleSnap() { st.snap = !st.snap; app.toast(st.snap ? 'Snapping on.' : 'Snapping off.'); app.notify(); },
      setLayerMode(m) {
        st.layerMode = m;
        app.tools.clearSelection();
        app.toast(m === 'all' ? 'Folds move every layer on that side.' : 'Folds move only the flap you grab.');
        app.notify();
      },
      valley() { app.tools.animateTo(Math.PI); },
      mountain() { app.tools.animateTo(-Math.PI); },
      flatten() { app.tools.animateTo(0); },
      // Live angle from the slider (degrees). commit=true finalizes it.
      setAngle(deg, commit) {
        const s = app.tools.session;
        if (!s) { if (commit) app.toast('In Fold mode, tap a flap next to a crease first.'); return; }
        app.tools.stopAnimation();
        app.tools.touchSession();
        app.paper.setFoldAngle(s, THREE.MathUtils.degToRad(deg));
        if (commit) {
          app.paper.finalizeFold(s, false);
          app.foldChanged(s, true);
        }
      },
      setSpace(space) { app.setSpace(space); },
      undo() {
        if (app.space === 'solids') { app.solids.undo(); return; }
        app.tools.finishAll();
        const e = app.history.stack.pop();
        if (!e) { app.toast('Nothing to undo.'); return; }
        app.tools.clearSelection();
        const apply = (rec) => {
          if (rec.type === 'paint') app.paint.undo(rec);
          else if (rec.type === 'geom') app.paper.restore(rec.state);
          else if (rec.type === 'group') rec.items.slice().reverse().forEach(apply);
        };
        apply(e);
        app.toast('Undone.');
        app.geometryChanged();
      },
      unfoldAll() {
        app.tools.finishAll();
        if (app.paper.isFlat()) { app.toast('The sheet is already flat.'); return; }
        app.tools.clearSelection();
        app.history.push({ type: 'geom', state: app.paper.serialize() });
        app.paper.unfoldAll();
        app.toast('Unfolded. Your creases are still there.');
        app.geometryChanged();
      },
      removeCreases() {
        app.tools.finishAll();
        if (app.paper.faces.length === 1) { app.toast('There are no creases yet.'); return; }
        app.tools.clearSelection();
        app.history.push({ type: 'geom', state: app.paper.serialize() });
        app.paper.reset(app.paper.W, app.paper.H);
        app.toast('Creases removed. Paint kept.');
        app.geometryChanged();
      },
      clearPaint() {
        const items = [];
        for (const side of ['front', 'back']) {
          app.paint.beginStroke(side);
          const sd = app.paint[side];
          app.paint.fill(side, sd.base);
          app.paint.stroke.rect = [0, 0, sd.canvas.width, sd.canvas.height];
          const rec = app.paint.endStroke();
          if (rec) items.push(rec);
        }
        app.history.push({ type: 'group', items });
        app.toast('Paint cleared on both sides.');
      },
      flip() {
        app.tools.finishAll();
        app.tools.clearSelection();
        app.paper.root.rotateY(Math.PI);
        if (app.state.onTable) app.restOnTable();
        app.toast('Flipped over.');
        app.notify();
      },
      resetPosition() { app.resetPosition(); app.toast('Back on the table.'); },
      recenter() {
        app.solids.carried = false;
        if (app.renderer.xr.isPresenting) app.recenterXR();
        else app.fitCamera();
      },
      resetView() { app.solids.carried = false; app.layoutTable(); app.fitCamera(); },
      draftSize(dw, dh) {
        st.draftW = THREE.MathUtils.clamp(st.draftW + dw, 5, 150);
        st.draftH = THREE.MathUtils.clamp(st.draftH + dh, 5, 150);
        app.notify();
      },
      newPaper(opts = {}) {
        app.tools.finishAll();
        const w = opts.widthCm ?? st.draftW;
        const h = opts.heightCm ?? st.draftH;
        if (opts.frontColor) st.frontColor = opts.frontColor;
        if (opts.backColor) st.backColor = opts.backColor;
        if (opts.detail) st.detail = opts.detail;
        st.widthCm = st.draftW = w;
        st.heightCm = st.draftH = h;
        app.tools.clearSelection();
        app.paint.create(w / 100, h / 100, st.frontColor, st.backColor, st.detail);
        app.paper.refreshTextures();
        app.paper.reset(w / 100, h / 100);
        app.history.clear();
        app.layoutTable();
        app.resetPosition();
        if (!app.renderer.xr.isPresenting) app.fitCamera();
        app.toast(`New ${w} × ${h} cm sheet.`);
        app.notify();
      },
      async enterXR(mode) { return app.enterXR(mode); },
      exitXR() { const s = app.renderer.xr.getSession(); if (s) s.end(); },
    };
  }

  // ------------------------------------------------------- screen input

  initScreenInput() {
    const el = this.renderer.domElement;
    const ndc = new THREE.Vector2();
    const rc = new THREE.Raycaster();
    const ptr = {
      id: 'screen', kind: 'screen', ray: new THREE.Ray(),
      pick: () => this.pickActive(ptr.ray),
      onPlane: (plane) => ptr.ray.intersectPlane(plane, new THREE.Vector3()),
    };
    this.screenPtr = ptr;
    let active = null, activeAt = 0;
    const setRay = (e) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      rc.setFromCamera(ndc, this.camera);
      ptr.ray.copy(rc.ray);
    };
    el.addEventListener('pointerdown', (e) => {
      if (this.renderer.xr.isPresenting) return;
      if (active !== null) {
        // A second finger shortly after the first means pinch-zoom, not drawing.
        if (e.pointerType === 'touch' && performance.now() - activeAt < 250) {
          this.activeTools.cancel(ptr);
          active = null;
        }
        e.stopImmediatePropagation();
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      setRay(e);
      if (this.activeTools.down(ptr)) {
        active = e.pointerId;
        activeAt = performance.now();
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.stopImmediatePropagation();
        this.hoverCursor.visible = false;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === active) {
        setRay(e);
        this.activeTools.move(ptr);
        e.stopImmediatePropagation();
        return;
      }
      if (e.pointerType === 'mouse' && active === null) {
        setRay(e);
        this.updateHoverCursor(ptr);
      }
    });
    const end = (e) => {
      if (e.pointerId !== active) return;
      setRay(e);
      this.activeTools.up(ptr);
      active = null;
      e.stopImmediatePropagation();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== active) return;
      this.activeTools.cancel(ptr);
      active = null;
    });
    el.addEventListener('pointerleave', () => { this.hoverCursor.visible = false; this.activeTools.hover?.(null, null); });

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); this.actions.undo(); return; }
      if (this.space === 'solids') {
        const sm = { 1: 'build', 2: 'open', 3: 'edges', b: 'build', o: 'open', e: 'edges' };
        if (sm[k]) this.solids.setTool(sm[k]);
        else if (k === 'u') this.solids.unfoldAll();
        else if (k === 'r') this.solids.refoldAll();
        return;
      }
      const map = { 1: 'paint', 2: 'crease', 3: 'cut', 4: 'fold', 5: 'move', p: 'paint', c: 'crease', x: 'cut', f: 'fold', m: 'move' };
      if (map[k]) this.actions.setTool(map[k]);
      else if (k === 'e') this.actions.toggleEraser();
      else if (k === '[') this.actions.brush(-1);
      else if (k === ']') this.actions.brush(1);
    });
  }

  updateHoverCursor(ptr) {
    const c = this.hoverCursor;
    const hit = this.space === 'paper' && this.state.tool === 'move' ? null : ptr.pick();
    this.activeTools.hover?.(ptr, hit);
    c.visible = !!hit;
    if (!hit) return;
    let n;
    if (hit.normal) n = hit.normal.clone();
    else {
      n = new THREE.Vector3().setFromMatrixColumn(hit.face.group.matrixWorld, 2).normalize();
      if (hit.side === 'back') n.negate();
    }
    c.position.copy(hit.point).addScaledVector(n, 0.0006);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const r = this.space === 'solids' ? this.cursorRadius()
      : this.state.tool === 'paint' ? Math.max(0.001, this.state.brushMM / 2000) : Math.max(0.002, this.paper.size * 0.008);
    c.scale.setScalar(r);
    c.material.color.set(this.space === 'paper' && this.state.tool === 'paint' && !this.state.eraser ? this.state.color : '#1d1f2b');
  }

  // ----------------------------------------------------------------- XR

  initXR() {
    this.xrSupport = { vr: false, ar: false };
    const r = this.renderer;
    r.xr.addEventListener('sessionstart', () => {
      this.needRecenter = true;
      this.placement.updateVisibility();
      this.handTools.updateVisibility();
      this.panel.mesh.visible = true;
      this.hoverCursor.visible = false;
      this.savedView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
      const ar = this.state.xr === 'immersive-ar';
      this.env.visible = !ar;
      this.applySurfaceStyle();
      this.environments.applyBackground();
      this.panel.invalidate();
      this.notify();
    });
    r.xr.addEventListener('sessionend', () => {
      this.state.xr = null;
      this.panel.mesh.visible = false;
      this.env.visible = true;
      this.environments.applyBackground();
      this.environments.align(new THREE.Vector3(0, 0, 0.5), 0);
      this.workspace.position.set(0, 0, 0);
      this.workspace.rotation.set(0, 0, 0);
      this.tableTop = TABLE_TOP;
      this.placement.panelCustom = false;
      this.placement.used = 'standing';
      this.placement.updateVisibility();
      this.handTools.updateVisibility();
      this.layoutTable();
      if (this.state.onTable) this.resetPosition();
      this.onResize();
      if (this.savedView) {
        this.camera.position.copy(this.savedView.pos);
        this.controls.target.copy(this.savedView.target);
        this.controls.update();
      }
      this.notify();
    });
    if (navigator.xr && navigator.xr.isSessionSupported) {
      navigator.xr.isSessionSupported('immersive-vr').then((ok) => { this.xrSupport.vr = ok; this.notify(); }).catch(() => {});
      navigator.xr.isSessionSupported('immersive-ar').then((ok) => { this.xrSupport.ar = ok; this.notify(); }).catch(() => {});
    }
  }

  async enterXR(mode) {
    if (!navigator.xr) {
      this.toast('WebXR is not available in this browser. Open the link in the Meta Quest Browser (or another WebXR browser).', 5000);
      return;
    }
    if (this.renderer.xr.isPresenting) return;
    try {
      const session = await navigator.xr.requestSession(mode, {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });
      this.state.xr = mode;
      await this.renderer.xr.setSession(session);
    } catch (err) {
      console.error(err);
      this.state.xr = null;
      const blocked = err && (err.name === 'SecurityError' || err.name === 'NotAllowedError');
      this.toast(blocked
        ? 'This page is embedded where VR is blocked. Open the app link directly in the Meta Quest Browser.'
        : `Could not start ${mode === 'immersive-ar' ? 'AR' : 'VR'}: ${err.message || err}`, 6000);
    }
  }

  recenterXR() { this.placement.placeInFront(); }

  // ----------------------------------------------------------- frame

  tick() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const xr = this.renderer.xr.isPresenting;
    if (xr && this.needRecenter) {
      const p = this.viewerPosition();
      if (p.lengthSq() > 0) {
        this.needRecenter = false;
        this.recenterXR();
        this.faceTheView();
      }
    }
    if (xr) this.xrInput.update();
    else this.controls.update();
    this.activeTools.update(dt);
    this.panel.update();
    this.paint.flush();
    this.renderer.render(this.scene, this.camera);
  }
}

// A self-healing cutting mat with a 1 cm grid and 5 cm major lines.
function makeMatTexture(wM, hM) {
  const pxPerCm = 16;
  const wc = Math.round(wM * 100), hc = Math.round(hM * 100);
  const c = document.createElement('canvas');
  c.width = Math.min(2048, wc * pxPerCm);
  c.height = Math.min(2048, hc * pxPerCm);
  const sx = c.width / wc, sy = c.height / hc;
  const g = c.getContext('2d');
  g.fillStyle = '#2f5a4f';
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i <= wc; i++) {
    g.strokeStyle = i % 5 === 0 ? 'rgba(214, 236, 222, 0.55)' : 'rgba(214, 236, 222, 0.2)';
    g.lineWidth = i % 5 === 0 ? 2 : 1;
    g.beginPath(); g.moveTo(i * sx, 0); g.lineTo(i * sx, c.height); g.stroke();
  }
  for (let j = 0; j <= hc; j++) {
    g.strokeStyle = j % 5 === 0 ? 'rgba(214, 236, 222, 0.55)' : 'rgba(214, 236, 222, 0.2)';
    g.lineWidth = j % 5 === 0 ? 2 : 1;
    g.beginPath(); g.moveTo(0, j * sy); g.lineTo(c.width, j * sy); g.stroke();
  }
  g.fillStyle = 'rgba(214, 236, 222, 0.6)';
  g.font = `${Math.round(sx * 0.7)}px sans-serif`;
  for (let i = 5; i < wc; i += 5) g.fillText(String(i), i * sx + 3, sy * 0.9);
  g.strokeStyle = 'rgba(240, 180, 76, 0.5)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, c.height); g.lineTo(c.width, 0); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

window.app = new App();
