import * as THREE from 'three';
import { validateLayout, pieceToTable } from './validate.js';

// Exports of the Solid → Unfold workspace.
//
// netSVG: the flat layout as a cutting pattern at full size in millimetres,
// seen from the outside of the solid (the printed side). Lines:
//   cut       solid black: piece outlines (cut edges and glue-tab outlines)
//   mountain  red dash-dot: hinge that folds away from the printed side
//   valley    blue dashed:  hinge that folds toward the printed side
//   flat      grey dotted:  panel division between coplanar panels (no fold)
// A hinge is one line shared by two panels and is drawn once. A cut edge has
// two sides in the layout; both are outlines unless they lie on top of each
// other, when the line is drawn once. Matching numbers mark the two sides of
// each cut edge. Optional glue tabs sit on one side of each cut edge.

const MM = 1000;

function fmt(v) { return (Math.round(v * 100) / 100).toString(); }

// 2D convex polygons overlap (separating axis), ignoring touching.
function convexOverlap(A, B, tol = 0.05) {
  for (const S of [A, B]) {
    for (let i = 0; i < S.length; i++) {
      const a = S[i], b = S[(i + 1) % S.length];
      let x = -(b[1] - a[1]), y = b[0] - a[0];
      const len = Math.hypot(x, y);
      if (len < 1e-9) continue;
      x /= len; y /= len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of A) { const d = p[0] * x + p[1] * y; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const p of B) { const d = p[0] * x + p[1] * y; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (Math.min(a1, b1) - Math.max(a0, b0) <= tol) return false;
    }
  }
  return true;
}

// Fold type of a hinge seen from the outside (printed side).
export function foldKind(shell, e) {
  const P = e.uses[0].panel, Q = e.uses[1].panel;
  const phi = shell.interior(e, P, Q);
  if (Math.abs(phi - Math.PI) < 1e-6) return 'flat';
  return phi < Math.PI ? 'mountain' : 'valley';
}

export function netSVG(shell, opts = {}) {
  const { ids = false, labels = true, tabs = false, title = 'Net' } = opts;
  // The same check the layout shows on screen.
  const check = validateLayout(shell);
  if (!check.exportable.length) {
    const why = check.issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => i.text).join(' ');
    return { error: `No piece can be exported yet. ${why}`, check };
  }
  // Each valid planar piece is drawn from its own plane: laid face down at
  // its own centre (a rigid move, so nothing is stretched), then seen from
  // the outside (from below, hence the mirrored x). Pieces already on the
  // table keep their arrangement; a piece that was tilted or raised keeps
  // its position unless it would land on another piece.
  const to2 = (v) => [-v.x * MM, v.z * MM];
  const polys = new Map();
  const placed = [];
  const boxOf = (list) => { const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; for (const q of list) for (const [x, y] of q) { b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); } return b; };
  const hits = (a, b) => a.x0 < b.x1 + 5 && b.x0 < a.x1 + 5 && a.y0 < b.y1 + 5 && b.y0 < a.y1 + 5;
  for (const pc of [...check.exportable].sort((a, b) => Number(b.onTable) - Number(a.onTable))) {
    const T = pc.onTable ? null : pieceToTable(pc);
    let list = pc.panels.map((p) => shell.worldPoly(p).map((v) => to2(T ? v.applyMatrix4(T) : v)));
    if (!pc.onTable) {
      let b = boxOf(list);
      if (placed.some((o) => hits(o, b))) {
        const all = placed.reduce((u, o) => ({ x0: Math.min(u.x0, o.x0), x1: Math.max(u.x1, o.x1), y0: Math.min(u.y0, o.y0), y1: Math.max(u.y1, o.y1) }), { ...b });
        const dx = all.x1 + 15 - b.x0, dy = all.y0 - b.y0;
        list = list.map((q) => q.map(([x, y]) => [x + dx, y + dy]));
        b = boxOf(list);
      }
    }
    placed.push(boxOf(list));
    pc.panels.forEach((p, i) => polys.set(p, list[i]));
  }
  const drawn = (p) => polys.has(p);

  const lines = { cut: [], mountain: [], valley: [], flat: [] };
  const seen = new Set();
  const segKey = (a, b) => {
    const k = (p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
    const ka = k(a), kb = k(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const add = (kind, a, b) => {
    const key = segKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    lines[kind].push([a, b]);
  };

  // Hinges: one line each.
  for (const e of shell.edges) {
    if (!e.shared || e.locked || e.type !== 'hinge') continue;
    if (!e.uses.every((x) => drawn(x.panel))) continue;
    const u = e.uses[0];
    const poly = polys.get(u.panel);
    add(foldKind(shell, e), poly[u.i], poly[(u.i + 1) % poly.length]);
  }

  // Glue tabs: one per cut edge pair, on a side where it overlaps nothing.
  const tabPolys = [];
  const tabSide = new Map();
  let tabConflicts = 0;
  if (tabs) {
    const all = [...polys.values()];
    for (const e of shell.edges) {
      if (!e.shared || e.locked || e.type === 'hinge') continue;
      if (!e.uses.every((x) => drawn(x.panel))) continue;
      const cands = e.uses.map((u) => {
        const poly = polys.get(u.panel);
        const a = poly[u.i], b = poly[(u.i + 1) % poly.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const c = poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
        let nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if ((c[0] - mx) * nx + (c[1] - my) * ny > 0) { nx = -nx; ny = -ny; } // outward
        const d = Math.min(10, len * 0.22), sh = Math.min(d, len * 0.25);
        const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len;
        const tab = [a, [a[0] + nx * d + tx * sh, a[1] + ny * d + ty * sh], [b[0] + nx * d - tx * sh, b[1] + ny * d - ty * sh], b];
        const clash = all.some((q) => convexOverlap(tab, q)) || tabPolys.some((q) => convexOverlap(tab, q));
        return { u, a, b, tab, clash };
      });
      const pick = cands.find((c) => !c.clash) || cands[0];
      if (pick.clash) tabConflicts++;
      tabPolys.push(pick.tab);
      tabSide.set(e, pick.u);
      add('mountain', pick.a, pick.b); // the tab folds away behind the print
      for (let i = 0; i < 3; i++) add('cut', pick.tab[i], pick.tab[i + 1]);
    }
  }

  // Outlines: every panel side that is not a hinge (and has no tab).
  for (const p of shell.panels) {
    if (!drawn(p)) continue;
    const poly = polys.get(p);
    for (let i = 0; i < poly.length; i++) {
      const e = p.edges[i];
      if (e.shared && !e.locked && e.type === 'hinge') continue;
      const tu = tabSide.get(e);
      if (tu && tu.panel === p && tu.i === i) continue;
      add('cut', poly[i], poly[(i + 1) % poly.length]);
    }
  }

  // Bounds and text.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p) => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); };
  for (const poly of polys.values()) poly.forEach(grow);
  for (const t of tabPolys) t.forEach(grow);
  const margin = 10;
  const legendH = 16;
  const W = x1 - x0 + 2 * margin, H = y1 - y0 + 2 * margin + legendH;
  const X = (p) => fmt(p[0] - x0 + margin), Y = (p) => fmt(p[1] - y0 + margin);
  const edgeMM = shell.edgeLen * MM;
  let longMM = 0;
  for (const p of shell.panels) for (let i = 0; i < p.verts.length; i++) longMM = Math.max(longMM, p.verts[i].distanceTo(p.verts[(i + 1) % p.verts.length]) * MM);
  const edgeText = Math.abs(longMM - edgeMM) < 0.01 ? `Edge length ${fmt(edgeMM)} mm` : `Edges ${fmt(edgeMM)} to ${fmt(longMM)} mm`;
  const fs = Math.max(2.5, Math.min(7, edgeMM * 0.07));

  const texts = [];
  if (labels) {
    for (const p of shell.panels) {
      if (!drawn(p)) continue;
      const poly = polys.get(p);
      const c = poly.reduce((s, q) => [s[0] + q[0] / poly.length, s[1] + q[1] / poly.length], [0, 0]);
      for (let i = 0; i < poly.length; i++) {
        const e = p.edges[i];
        if (!e.no || (e.shared && !e.locked && e.type === 'hinge')) continue;
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        let ux = c[0] - mx, uy = c[1] - my;
        const ul = Math.hypot(ux, uy) || 1;
        ux /= ul; uy /= ul;
        const off = Math.min(len * 0.12, fs * 1.4);
        let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang <= -90) ang += 180;
        texts.push({ x: mx + ux * off, y: my + uy * off, ang, text: String(e.no), cls: 'edge' });
      }
    }
  }
  if (ids) {
    for (const p of shell.panels) {
      if (!drawn(p)) continue;
      const poly = polys.get(p);
      const c = poly.reduce((s, q) => [s[0] + q[0] / poly.length, s[1] + q[1] / poly.length], [0, 0]);
      texts.push({ x: c[0], y: c[1], ang: 0, text: `P${p.no}`, cls: 'id' });
    }
  }

  const path = (segs) => segs.map(([a, b]) => `M${X(a)} ${Y(a)}L${X(b)} ${Y(b)}`).join('');
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}mm" height="${fmt(H)}mm" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`);
  out.push(`<title>${escapeXml(title)}</title>`);
  out.push(`<desc>Full size, units mm. Seen from the outside (printed side). ${edgeText}. ${polys.size} of ${shell.panels.length} panels, ${check.exportable.length} piece(s)${check.excluded.length ? `; not exported: ${check.excluded.map((pc) => `piece ${pc.index} (${pc.valid ? 'not flat' : 'invalid panels'})`).join(', ')}` : ''}.</desc>`);
  out.push('<style>.cut{stroke:#000;stroke-width:0.3}.mountain{stroke:#d4462a;stroke-width:0.3;stroke-dasharray:4 1.2 0.8 1.2}.valley{stroke:#1e6ad4;stroke-width:0.3;stroke-dasharray:2.4 1.6}.flat{stroke:#9a9a9a;stroke-width:0.2;stroke-dasharray:0.6 1.2}path{fill:none;stroke-linecap:round}text{font-family:Helvetica,Arial,sans-serif;text-anchor:middle;dominant-baseline:central}.edge{fill:#b3261e;font-weight:700}.id{fill:#555}.legend{fill:#333;text-anchor:start}</style>');
  for (const kind of ['flat', 'valley', 'mountain', 'cut']) {
    if (lines[kind].length) out.push(`<path id="${kind}" class="${kind}" d="${path(lines[kind])}"/>`);
  }
  if (texts.length) {
    out.push('<g id="labels">');
    for (const t of texts) {
      out.push(`<text class="${t.cls}" x="${fmt(t.x - x0 + margin)}" y="${fmt(t.y - y0 + margin)}" font-size="${fmt(t.cls === 'id' ? fs * 0.9 : fs)}" transform="rotate(${fmt(t.ang)} ${fmt(t.x - x0 + margin)} ${fmt(t.y - y0 + margin)})">${escapeXml(t.text)}</text>`);
    }
    out.push('</g>');
  }
  const ly = H - legendH / 2;
  out.push(`<g id="legend" font-size="3">`);
  out.push(`<path class="cut" d="M${margin} ${fmt(ly)}h8"/><text class="legend" x="${margin + 10}" y="${fmt(ly)}">cut</text>`);
  out.push(`<path class="mountain" d="M${margin + 24} ${fmt(ly)}h8"/><text class="legend" x="${margin + 34}" y="${fmt(ly)}">mountain fold</text>`);
  out.push(`<path class="valley" d="M${margin + 62} ${fmt(ly)}h8"/><text class="legend" x="${margin + 72}" y="${fmt(ly)}">valley fold</text>`);
  out.push(`<path class="flat" d="M${margin + 96} ${fmt(ly)}h8"/><text class="legend" x="${margin + 106}" y="${fmt(ly)}">no fold</text>`);
  out.push(`<text class="legend" x="${margin + 126}" y="${fmt(ly)}">mm, 1:1, printed side = outside${labels ? '; equal numbers join' : ''}</text>`);
  out.push('</g>');
  out.push('</svg>');
  const counts = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.length]));
  return { svg: out.join('\n'), width: W, height: H, counts, tabs: tabPolys.length, tabConflicts, labels: texts.filter((t) => t.cls === 'edge').length, check, excluded: check.excluded, moved: check.exportable.filter((pc) => !pc.onTable).length };
}

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// PNG of the current 3D view, without the interface, selection or hover
// highlights. transparent: only the solids on a clear background;
// otherwise the scene as it is (room, table, scenery).
export function viewPNG(app, { transparent = false, scale = 2 } = {}) {
  const r = app.renderer;
  if (r.xr.isPresenting) return { error: 'Leave VR to save an image of the view.' };
  const ws = app.solids;
  const scene = app.scene;
  const camera = app.camera;
  const restore = [];
  const hide = (o) => { if (o && o.visible) { o.visible = false; restore.push(() => { o.visible = true; }); } };
  // Interface objects in the scene.
  hide(app.hoverCursor);
  hide(ws.ghost);
  if (app.panel?.mesh) hide(app.panel.mesh);
  scene.traverse((o) => { if (o.userData && (o.userData.ui || o.userData.label)) hide(o); });
  if (transparent) {
    // Keep only the branch that holds the solids, and the lights.
    const keep = ws.root;
    const chain = new Set();
    for (let o = keep; o; o = o.parent) chain.add(o);
    const walk = (node) => {
      for (const c of node.children) {
        if (c === keep || c.isLight) continue;
        if (chain.has(c)) walk(c);
        else hide(c);
      }
    };
    walk(scene);
    const bg = scene.background, fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    restore.push(() => { scene.background = bg; scene.fog = fog; });
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    restore.push(() => r.setClearColor(cc, ca));
  }
  // Plain look: no selection, hover or warning tints.
  ws.clean = true;
  ws.refreshStyles();
  restore.push(() => { ws.clean = false; ws.refreshStyles(); });
  const pr = r.getPixelRatio();
  r.setPixelRatio(Math.max(pr, scale));
  restore.push(() => r.setPixelRatio(pr));
  let url;
  try {
    r.render(scene, camera);
    url = r.domElement.toDataURL('image/png');
  } finally {
    for (let i = restore.length - 1; i >= 0; i--) restore[i]();
  }
  const w = r.domElement.width, h = r.domElement.height;
  return { url, width: Math.round(w * Math.max(pr, scale) / pr), height: Math.round(h * Math.max(pr, scale) / pr) };
}
