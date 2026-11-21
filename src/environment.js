import * as THREE from 'three';

// Surroundings, kept separate from the work surface: changing one never
// moves the other.
//
//  terrace - a quiet wooden terrace with a glass railing, looking over
//            layered mountain ridges in soft haze (default)
//  studio  - the plain studio floor
//
// Everything here is generated in code (a few thousand triangles, one small
// texture) so it stays light on a standalone headset. Local frame: you
// stand at the origin looking toward -z, with the view ahead.

export const ENV_LABELS = { terrace: 'Mountain terrace', studio: 'Studio' };

export class Environments {
  constructor(app, hemi) {
    this.app = app;
    this.hemi = hemi;
    this.labels = ENV_LABELS;
    this.root = new THREE.Group();
    this.root.name = 'environment';
    this.studio = buildStudio();
    this.terrace = null;
    this.root.add(this.studio);
    this.envSun = new THREE.DirectionalLight('#fff1dc', 0.0);
    this.envSun.position.set(-40, 60, -80);
    this.root.add(this.envSun, this.envSun.target);
    this.current = null;
  }

  set(name) {
    if (!ENV_LABELS[name]) return;
    this.current = name;
    if (name === 'terrace' && !this.terrace) {
      this.terrace = buildTerrace();
      this.root.add(this.terrace);
    }
    this.studio.visible = name === 'studio';
    if (this.terrace) this.terrace.visible = name === 'terrace';
    const app = this.app;
    if (name === 'terrace') {
      this.hemi.color.set('#e8eef5');
      this.hemi.groundColor.set('#8a7c68');
      this.hemi.intensity = 1.25;
      this.envSun.intensity = 0.7;
      app.scene.fog = new THREE.Fog('#e4e3dc', 120, 2600);
    } else {
      this.hemi.color.set('#fffaf0');
      this.hemi.groundColor.set('#8c8476');
      this.hemi.intensity = 1.5;
      this.envSun.intensity = 0;
      app.scene.fog = null;
    }
    this.applyBackground();
  }

  applyBackground() {
    const app = this.app;
    if (app.state.xr === 'immersive-ar') { app.scene.background = null; return; }
    app.scene.background = new THREE.Color(this.current === 'terrace' ? '#e4e3dc' : '#e4e0d6');
  }

  // Stand the viewer on the terrace at a world point, facing a direction.
  align(position, yaw) {
    this.root.position.set(position.x, 0, position.z);
    this.root.rotation.set(0, yaw, 0);
  }
}

// ----------------------------------------------------------------- studio

function buildStudio() {
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#d6d0c3';
  x.fillRect(0, 0, 256, 256);
  x.strokeStyle = 'rgba(80, 70, 55, 0.18)';
  x.lineWidth = 3;
  x.strokeRect(0, 0, 256, 256);
  x.strokeStyle = 'rgba(80, 70, 55, 0.07)';
  x.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    x.beginPath(); x.moveTo(i * 64, 0); x.lineTo(i * 64, 256); x.stroke();
    x.beginPath(); x.moveTo(0, i * 64); x.lineTo(256, i * 64); x.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(12, 12);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);
  return g;
}

// ---------------------------------------------------------------- terrace

function buildTerrace() {
  const g = new THREE.Group();
  g.name = 'terrace';
  g.add(buildSky(), buildMountains(), buildValley());

  // Deck: you stand near the back; the railing is about three metres ahead.
  const deckTex = makePlankTexture();
  deckTex.wrapS = deckTex.wrapT = THREE.RepeatWrapping;
  deckTex.repeat.set(3.5, 2.6);
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(7, 5.4), new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.92 }));
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(0, 0, -0.6);
  deck.receiveShadow = true;
  g.add(deck);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(7.1, 0.3, 0.12), new THREE.MeshStandardMaterial({ color: '#7d6a55', roughness: 0.9 }));
  fascia.position.set(0, -0.15, -3.3);
  g.add(fascia);

  // Railing: dark posts, a wooden handrail and faint glass.
  const metal = new THREE.MeshStandardMaterial({ color: '#3b404c', roughness: 0.5, metalness: 0.4 });
  const rail = new THREE.MeshStandardMaterial({ color: '#9a7652', roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: '#d6e6ee', transparent: true, opacity: 0.14, roughness: 0.05, depthWrite: false, side: THREE.DoubleSide });
  const railLine = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 1.1));
    const ang = Math.atan2(x1 - x0, z1 - z0);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.02, 0.05), metal);
      post.position.set(x0 + (x1 - x0) * t, 0.51, z0 + (z1 - z0) * t);
      g.add(post);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.05, len + 0.05), rail);
    top.position.set((x0 + x1) / 2, 1.04, (z0 + z1) / 2);
    top.rotation.y = ang;
    g.add(top);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.86), glass);
    pane.position.set((x0 + x1) / 2, 0.52, (z0 + z1) / 2);
    pane.rotation.y = ang + Math.PI / 2;
    pane.renderOrder = 1;
    g.add(pane);
  };
  railLine(-3.45, -3.2, 3.45, -3.2);
  railLine(-3.45, -3.2, -3.45, 0.6);
  railLine(3.45, -3.2, 3.45, 0.6);

  // Back wall with a door, so the space feels like a balcony.
  const plaster = new THREE.MeshStandardMaterial({ color: '#e9e2d5', roughness: 0.95 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(7, 3.2, 0.2), plaster);
  wall.position.set(0, 1.6, 2.15);
  g.add(wall);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.1, 0.04), new THREE.MeshStandardMaterial({ color: '#6e5843', roughness: 0.7 }));
  door.position.set(1.6, 1.05, 2.04);
  g.add(door);
  const win = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 0.03), new THREE.MeshStandardMaterial({ color: '#b9c9d4', roughness: 0.1, metalness: 0.3 }));
  win.position.set(-1.5, 1.55, 2.04);
  g.add(win);

  // Planters at the front corners.
  const concrete = new THREE.MeshStandardMaterial({ color: '#8d8f93', roughness: 0.95 });
  const leaf = new THREE.MeshStandardMaterial({ color: '#6c8a57', roughness: 0.9, flatShading: true });
  for (const x of [-2.9, 2.9]) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.55), concrete);
    box.position.set(x, 0.225, -2.7);
    g.add(box);
    for (const [dx, dy, dz, r] of [[0, 0.62, 0, 0.26], [0.12, 0.78, 0.05, 0.18], [-0.1, 0.72, -0.08, 0.2]]) {
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leaf);
      b.position.set(x + dx, dy, -2.7 + dz);
      g.add(b);
    }
  }
  return g;
}

function buildSky() {
  const geo = new THREE.SphereGeometry(3200, 32, 16);
  const col = [];
  const top = new THREE.Color('#7fa4cc'), mid = new THREE.Color('#b8cde0'), hor = new THREE.Color('#ece6da'), low = new THREE.Color('#c8d0d3');
  const p = geo.attributes.position;
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 3200;
    if (y > 0.35) c.copy(mid).lerp(top, Math.min(1, (y - 0.35) / 0.65));
    else if (y > 0) c.copy(hor).lerp(mid, y / 0.35);
    else c.copy(hor).lerp(low, Math.min(1, -y / 0.2));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10;
  return sky;
}

// Ridges as strips on arcs ahead of you; farther ones are paler and taller.
function buildMountains() {
  const g = new THREE.Group();
  const layers = [
    { r: 280, base: -20, amp: 70, color: '#5c6f80', seed: 1.3, freq: 5.0 },
    { r: 560, base: 0, amp: 150, color: '#7a8da2', seed: 4.1, freq: 4.0 },
    { r: 950, base: 40, amp: 280, color: '#9aaabc', seed: 7.7, freq: 3.2 },
    { r: 1600, base: 120, amp: 470, color: '#bccad6', seed: 2.9, freq: 2.6, snow: 0.72 },
  ];
  for (const L of layers) {
    const seg = 180;
    const a0 = -2.2, a1 = 2.2;
    const pos = [], col = [], idx = [];
    const base = new THREE.Color(L.color), snow = new THREE.Color('#f1f4f6');
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (a1 - a0) * i / seg;
      const h = L.base + L.amp * ridge(a * L.freq + L.seed);
      const x = L.r * Math.sin(a), z = -L.r * Math.cos(a);
      pos.push(x, -90, z, x, h, z);
      const top = L.snow && (h - L.base) / L.amp > L.snow ? snow : base;
      col.push(base.r, base.g, base.b, top.r, top.g, top.b);
      if (i < seg) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }
  return g;
}

function buildValley() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000), new THREE.MeshBasicMaterial({ color: '#8d9b80' }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = -90;
  return m;
}

// Smooth ridge profile in [0, 1].
function ridge(x) {
  let v = 0, amp = 0.55, f = 1;
  for (let o = 0; o < 4; o++) {
    v += amp * (0.5 + 0.5 * Math.sin(x * f + Math.sin(x * f * 0.37 + o) * 1.7));
    f *= 2.1;
    amp *= 0.45;
  }
  return Math.min(1, Math.max(0, (v - 0.25) / 0.75));
}

function makePlankTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#a58c70';
  x.fillRect(0, 0, 512, 512);
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const y = (r * 512) / rows;
    const shade = 0.9 + ((r * 37) % 10) / 50;
    x.fillStyle = `rgb(${Math.round(165 * shade)}, ${Math.round(140 * shade)}, ${Math.round(112 * shade)})`;
    x.fillRect(0, y + 2, 512, 512 / rows - 4);
    x.strokeStyle = 'rgba(70, 50, 30, 0.10)';
    for (let k = 0; k < 6; k++) {
      x.beginPath();
      const yy = y + 8 + k * 9;
      x.moveTo(0, yy);
      x.bezierCurveTo(170, yy + 3, 340, yy - 3, 512, yy + 1);
      x.stroke();
    }
    x.fillStyle = 'rgba(50, 35, 20, 0.35)';
    const joint = ((r * 197) % 400) + 50;
    x.fillRect(joint, y + 2, 2, 512 / rows - 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
