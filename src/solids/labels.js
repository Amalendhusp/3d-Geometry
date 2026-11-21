import * as THREE from 'three';

// Assembly labels drawn on the panels: the number of each cut edge next to
// that edge on both panels it joins (so matching numbers show which edges go
// together), and optionally a number for each panel. Labels are children of
// the panel meshes, so they move with the panels, and they are readable from
// both sides of the paper.

const PLANE = new THREE.PlaneGeometry(1, 1);

export class LabelLayer {
  constructor(ws) {
    this.ws = ws;
    this.sig = null;
    this.items = [];
    this.mats = new Map();
  }

  reset() { this.sig = null; this.items = []; }

  wanted() {
    const s = this.ws.state;
    const where = s.tool === 'layout' || s.tool === 'edges';
    return { edges: where && s.showLabels, ids: where && s.showIds };
  }

  refresh() {
    if (typeof document === 'undefined') return;
    const ws = this.ws;
    const w = this.ws.clean ? { edges: false, ids: false } : this.wanted();
    const sig = `${w.edges}|${w.ids}|${w.edges ? ws.shell.edges.map((e) => e.type[0]).join('') : ''}`;
    if (sig === this.sig) return;
    this.sig = sig;
    for (const it of this.items) if (it.parent) it.parent.remove(it);
    this.items = [];
    if (!w.edges && !w.ids) return;
    const L = ws.edgeLen;
    for (const [p, m] of ws.meshes) {
      if (w.edges) {
        const n = p.verts.length;
        for (let i = 0; i < n; i++) {
          const e = p.edges[i];
          if (!e.no || (e.type === 'hinge' && e.shared && !e.locked)) continue;
          const a = p.verts[i], b = p.verts[(i + 1) % n];
          const t = b.clone().sub(a).normalize();
          const up = new THREE.Vector3().crossVectors(p.normal, t).normalize();
          if (up.dot(p.centroid.clone().sub(a)) < 0) up.negate();
          const len = a.distanceTo(b);
          const pos = a.clone().add(b).multiplyScalar(0.5).addScaledVector(up, Math.min(len, L) * 0.19);
          this.place(m.group, String(e.no), pos, up, p.normal, Math.min(len, L) * 0.21, '#b3261e');
        }
      }
      if (w.ids) {
        const a = p.verts[0], b = p.verts[1];
        const t = b.clone().sub(a).normalize();
        const up = new THREE.Vector3().crossVectors(p.normal, t).normalize();
        if (up.dot(p.centroid.clone().sub(a)) < 0) up.negate();
        this.place(m.group, `P${p.no}`, p.centroid.clone(), up, p.normal, L * 0.17, '#1d1f2b');
      }
    }
  }

  // Two quads, one facing each side of the panel, with text upright along `up`.
  place(group, text, pos, up, normal, h, color) {
    const mat = this.material(text, color);
    const aspect = mat.userData.aspect;
    for (const f of [normal.clone(), normal.clone().negate()]) {
      const right = new THREE.Vector3().crossVectors(up, f).normalize();
      const mesh = new THREE.Mesh(PLANE, mat);
      mesh.matrixAutoUpdate = false;
      const basis = new THREE.Matrix4().makeBasis(right, up, f);
      const at = pos.clone().addScaledVector(f, this.ws.edgeLen * 0.005);
      mesh.matrix.compose(at, new THREE.Quaternion().setFromRotationMatrix(basis), new THREE.Vector3(h * aspect, h, 1));
      mesh.renderOrder = 2;
      mesh.userData.label = true;
      group.add(mesh);
      this.items.push(mesh);
    }
  }

  material(text, color) {
    const key = `${text}|${color}`;
    if (this.mats.has(key)) return this.mats.get(key);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = '700 46px "Zen Kaku Gothic New", system-ui, sans-serif';
    ctx.font = font;
    const w = Math.max(64, Math.ceil(ctx.measureText(text).width + 22));
    c.width = w;
    c.height = 64;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeText(text, w / 2, 34);
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
    m.userData.aspect = w / 64;
    this.mats.set(key, m);
    return m;
  }
}
