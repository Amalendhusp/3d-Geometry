import * as THREE from 'three';

// One check of the net layout, used both for the issue list on screen and
// by the SVG exporter, so the two always agree.
//
// Each piece (hinge-connected panels) is classified:
//   on the table      planar, face down in the surface plane: exports as laid
//   tilted / raised   planar but not lying in the surface plane: still a
//                     valid flat piece; it exports from its own plane
//   residual folds    not planar because hinges are not at their flat
//                     angle: the hinges and panels are named; never
//                     flattened silently
// and the layout as a whole is checked for overlapping panels (inside a
// piece, or between pieces) and for invalid geometry or connectivity
// (warped or collapsed panels, hinge loops, open edges).

export const TOL = { dist: 1e-5, angle: THREE.MathUtils.degToRad(0.01) }; // 0.01 mm, 0.01°

const DOWN = new THREE.Vector3(0, -1, 0);
const deg = THREE.MathUtils.radToDeg;

function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

// Panels hinged beyond `p` in forest F (p included).
function subtree(F, p) {
  if (!F._kids) {
    F._kids = new Map();
    for (const [c, l] of F.parent) { if (!F._kids.has(l.parent)) F._kids.set(l.parent, []); F._kids.get(l.parent).push(c); }
  }
  const out = [p];
  for (let i = 0; i < out.length; i++) for (const c of F._kids.get(out[i]) || []) out.push(c);
  return out;
}

export function validateLayout(shell, tol = TOL) {
  const F = shell.forest();
  const rootOf = shell.pieceRoots(F);
  const groups = shell.hingePieces(F);
  const issues = [];
  const add = (o) => issues.push(o);

  // Invalid geometry or connectivity.
  const badPanels = new Set();
  for (const p of shell.panels) {
    let dev = 0, worst = 0;
    p.verts.forEach((v, i) => { const d = Math.abs(v.clone().sub(p.verts[0]).dot(p.normal)); if (d > dev) { dev = d; worst = i; } });
    if (dev > tol.dist) {
      badPanels.add(p);
      add({ kind: 'invalid', severity: 'error', panels: [p], edges: [], verts: [{ panel: p, i: worst }], text: `Panel P${p.no} is warped (a corner is ${(dev * 1000).toFixed(2)} mm out of its plane), so it cannot be cut from flat paper. Fix the shape (Surface Modeling) or triangulate that face.` });
    }
    let area = 0;
    for (let i = 1; i < p.verts.length - 1; i++) area += new THREE.Vector3().crossVectors(p.verts[i].clone().sub(p.verts[0]), p.verts[i + 1].clone().sub(p.verts[0])).length() / 2;
    if (area < 1e-6) { badPanels.add(p); add({ kind: 'invalid', severity: 'error', panels: [p], edges: [], text: `Panel P${p.no} has collapsed (almost no area).` }); }
  }
  if (F.loops.length) {
    add({ kind: 'invalid', severity: 'error', panels: [], edges: F.loops.slice(), text: `Hinges form ${F.loops.length} closed loop${F.loops.length > 1 ? 's' : ''} (edge${F.loops.length > 1 ? 's' : ''} ${F.loops.map((e) => e.no).join(', ')}): a net cannot have a loop of hinges. Cut one edge of each loop.` });
  }
  const open = shell.edges.filter((e) => e.uses.length === 1);
  if (open.length) add({ kind: 'invalid', severity: 'error', panels: open.map((e) => e.uses[0].panel), edges: open, text: `${open.length} edge${open.length > 1 ? 's are' : ' is'} not joined to any other panel: the shell is not closed.` });

  // Pieces.
  const pieces = groups.map((panels, i) => {
    const root = rootOf.get(panels[0]);
    const pts = panels.flatMap((p) => shell.worldPoly(p));
    // The piece's plane is its root panel's plane (outside normal).
    const n = shell.worldNormal(root).normalize();
    const o = shell.worldPoly(root)[0];
    let maxDev = 0;
    for (const v of pts) maxDev = Math.max(maxDev, Math.abs(v.clone().sub(o).dot(n)));
    const g = pts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(pts.length);
    const c = g.clone().addScaledVector(n, -g.clone().sub(o).dot(n));
    const aligned = panels.every((p) => shell.worldNormal(p).dot(n) > Math.cos(tol.angle));
    // Hinges inside this piece that are not at their flat angle. A fold
    // counts when its angle is over the angle tolerance, or when it lifts
    // the panels beyond it by more than the distance tolerance (a tiny
    // angle on a long piece), so nothing out of plane goes unnamed.
    const residual = [];
    const inPiece = new Set(panels);
    for (const [child, link] of F.parent) {
      if (!inPiece.has(child)) continue;
      const off = wrap(shell.angle(link.e, child, link.parent) - shell.flatAngle(link.e, child, link.parent));
      if (Math.abs(off) < 1e-12) continue;
      const u = link.e.uses.find((x) => x.panel === child) || link.e.uses[0];
      const w = shell.worldPoly(u.panel);
      const A = w[u.i], B = w[(u.i + 1) % w.length];
      const axis = B.clone().sub(A).normalize();
      let reach = 0;
      for (const p of subtree(F, child)) for (const v of shell.worldPoly(p)) { const d = v.clone().sub(A); reach = Math.max(reach, d.addScaledVector(axis, -d.dot(axis)).length()); }
      const lift = Math.abs(Math.sin(off)) * reach;
      if (Math.abs(off) > tol.angle || lift > tol.dist) residual.push({ e: link.e, P: child, Q: link.parent, deg: deg(off), lift });
    }
    const planar = maxDev <= tol.dist && aligned && !residual.length;
    // Largest gap between the two sides of a hinge in this piece.
    let seam = 0;
    for (const [child, link] of F.parent) {
      if (!inPiece.has(child)) continue;
      const [u, v] = link.e.uses;
      seam = Math.max(seam, link.e.a.clone().applyMatrix4(u.panel.M).distanceTo(link.e.a.clone().applyMatrix4(v.panel.M)), link.e.b.clone().applyMatrix4(u.panel.M).distanceTo(link.e.b.clone().applyMatrix4(v.panel.M)));
    }
    const down = n.dot(DOWN);
    const tilt = deg(Math.acos(Math.min(1, Math.abs(down))));
    let minY = Infinity, maxY = -Infinity;
    for (const v of pts) { minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
    const onTable = planar && tilt <= deg(tol.angle) && Math.abs(minY) <= tol.dist && Math.abs(maxY) <= tol.dist;
    const valid = !panels.some((p) => badPanels.has(p));
    return { index: i + 1, panels, root, planar, onTable, valid, maxDev, residual, seam, tilt, faceUp: down < 0, minY, maxY, normal: n, centre: c };
  });
  const pieceOf = new Map();
  for (const pc of pieces) for (const p of pc.panels) pieceOf.set(p, pc);

  for (const pc of pieces) {
    for (const r of pc.residual) {
      const a = Math.abs(r.deg);
      add({ kind: 'fold', severity: 'error', piece: pc, panels: [r.P, r.Q], edges: [r.e], text: `Piece ${pc.index}: hinge ${r.e.no} is still folded ${a < 0.01 ? a.toFixed(4) : a.toFixed(2)}° from flat (between P${r.P.no} and P${r.Q.no}), lifting the panels beyond it by up to ${(r.lift * 1000).toFixed(2)} mm. This is a real residual fold, not rounding. It is not exported until it lies flat: press Arrange net on surface (Net → Arrange), or open that hinge fully.` });
    }
    if (!pc.residual.length && !pc.planar && pc.valid) {
      add({ kind: 'fold', severity: 'error', piece: pc, panels: pc.panels, edges: [], text: `Piece ${pc.index} is not flat (up to ${(pc.maxDev * 1000).toFixed(2)} mm out of its plane), and no single hinge fold or warped panel explains it (hinge seams up to ${(pc.seam * 1000).toFixed(3)} mm apart). It is not exported until it lies flat: press Arrange pieces to lay it out again from its hinges.` });
    }
  }
  const ov = shell.overlapReport();
  for (const [a, b] of ov.pairs) {
    const pa = pieceOf.get(a), pb = pieceOf.get(b);
    if (pa === pb) add({ kind: 'overlap', severity: 'error', piece: pa, panels: [a, b], edges: [], text: `Panels P${a.no} and P${b.no} overlap inside piece ${pa.index}: as laid out, this piece cannot be cut from one sheet. Resolve overlaps finds the fewest additional cuts and keeps the rest of the net; Other nets searches a different hinge layout instead.` });
    else add({ kind: 'overlap', severity: 'warning', panels: [a, b], edges: [], text: `Panels P${a.no} (piece ${pa.index}) and P${b.no} (piece ${pb.index}) overlap: move the pieces apart or press Arrange pieces.` });
  }
  for (const pc of pieces) {
    if (pc.planar && !pc.onTable && pc.valid) {
      const raised = Math.max(Math.abs(pc.minY), Math.abs(pc.maxY));
      add({ kind: 'placement', severity: 'info', piece: pc, panels: pc.panels, edges: [], text: `Piece ${pc.index} is flat but ${pc.tilt > deg(tol.angle) ? `tilted ${pc.tilt.toFixed(1)}°` : ''}${pc.tilt > deg(tol.angle) && raised > tol.dist ? ' and ' : ''}${raised > tol.dist ? `up to ${(raised * 1000).toFixed(1)} mm off the table` : ''}${pc.faceUp ? ' (face up)' : ''}. That is fine: it exports from its own plane. Arrange net on surface puts it on the table.` });
    }
  }
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  for (const is of issues) {
    is.verts = is.verts || [];
    is.key = `${is.kind}|${is.panels.map((p) => p.id).join(',')}|${is.edges.map((e) => e.key).join(',')}`;
    const pts = [];
    for (const p of is.panels) pts.push(...shell.worldPoly(p));
    for (const e of is.edges) { const u = e.uses[0]; const w = shell.worldPoly(u.panel); pts.push(w[u.i], w[(u.i + 1) % w.length]); }
    const box = new THREE.Box3().setFromPoints(pts);
    is.box = box;
    is.centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  }
  const exportable = pieces.filter((pc) => pc.planar && pc.valid);
  return {
    pieces,
    issues,
    exportable,
    excluded: pieces.filter((pc) => !(pc.planar && pc.valid)),
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    allOnTable: pieces.every((pc) => pc.onTable),
  };
}

// Why nothing (or not everything) can be exported, one sentence per piece
// left out: a piece with many folded hinges is summarised, not listed.
export function refusalText(check) {
  const parts = [];
  for (const is of check.issues) {
    if (is.kind === 'invalid' && is.severity === 'error' && !is.panels.length) parts.push(is.text);
  }
  for (const pc of check.excluded) {
    if (!pc.valid) { parts.push(`Piece ${pc.index} has invalid panels (see the issue list).`); continue; }
    const r = pc.residual;
    if (r.length === 1) {
      const x = r[0];
      parts.push(`Piece ${pc.index}: hinge ${x.e.no} is still folded ${Math.abs(x.deg).toFixed(2)}° from flat (between P${x.P.no} and P${x.Q.no}).`);
    } else if (r.length > 1) {
      const worst = Math.max(...r.map((x) => Math.abs(x.deg)));
      parts.push(`Piece ${pc.index}: ${r.length} hinges are still folded (hinges ${r.slice(0, 4).map((x) => x.e.no).join(', ')}${r.length > 4 ? ', …' : ''}; up to ${worst.toFixed(2)}° from flat).`);
    } else parts.push(`Piece ${pc.index} is not flat (up to ${(pc.maxDev * 1000).toFixed(2)} mm out of its plane).`);
  }
  const folded = check.excluded.filter((pc) => pc.valid).reduce((n, pc) => n + pc.residual.length, 0);
  if (check.excluded.some((pc) => pc.valid)) parts.push(`A piece is exported once it lies flat: press Arrange net on surface (Net → Arrange), or open ${folded === 1 ? 'that hinge' : 'those hinges'} fully.`);
  return parts.join(' ');
}

// Rigid move that lays a planar piece face down at its own centre (for
// drawing it from its own plane). Identity for a piece already on the table.
export function pieceToTable(pc) {
  const q = new THREE.Quaternion().setFromUnitVectors(pc.normal.clone(), DOWN);
  const c = pc.centre;
  return new THREE.Matrix4().makeTranslation(c.x, 0, c.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}
