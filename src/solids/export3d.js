import * as THREE from 'three';
import { TEMPLATES } from './polyhedra.js';

// 3D model export: binary glTF (.glb) and Wavefront OBJ with its MTL file.
//
// The model is built from the shell's panels only, never from the scene, so
// the table, scenery, ghost, handles, labels, highlights and the view turn
// or magnification can never end up in the file. Internal faces were
// removed when the shell was built, so the exported surface is the
// exterior shell. Two poses:
//   assembled  every panel at rest: the closed form
//   current    every panel where it is now (folded part way, or flat)
// Units: glTF is in metres (its standard unit); OBJ is in millimetres,
// stated in the file header. Y is up in both.

const MM = 1000;

// One entry per solid: its panels as polygons in the chosen pose.
export function modelParts(shell, comp, { pose = 'assembled' } = {}) {
  // One part per solid: a polyhedron (stored as pieces that share an
  // origin), or the faces of a form built from shapes (one per object).
  const pieceOf = new Map((comp.pieces || []).map((pc) => [pc.id, pc]));
  const objectOf = new Map();
  (shell.pieces ? shell.pieces() : []).forEach((c, k) => { for (const p of c) objectOf.set(p, k); });
  const keyOf = (p) => {
    const pc = pieceOf.get(p.solidId);
    if (!pc) return `s${p.solidId}`;
    return pc.origin != null ? `o${pc.origin}` : `f${objectOf.get(p) ?? 0}`;
  };
  const order = new Map();
  const parts = new Map();
  for (const p of shell.panels) {
    const M = pose === 'assembled' ? null : p.M;
    const pts = p.verts.map((v) => (M ? v.clone().applyMatrix4(M) : v.clone()));
    const n = M ? p.normal.clone().transformDirection(M) : p.normal.clone();
    const key = keyOf(p);
    if (!order.has(key)) order.set(key, order.size);
    const idx = order.get(key);
    const parity = idx % 2;
    if (!parts.has(key)) {
      const tpl = TEMPLATES[p.type] || { name: 'Shape', colors: ['#f6ecd6', '#ecdcbc'] };
      const own = key[0] === 'f';
      parts.set(key, {
        id: key, index: idx + 1, type: p.type,
        name: own ? `Form ${idx + 1} (shapes)` : `Solid ${idx + 1} (${tpl.name.toLowerCase()})`,
        material: `${own ? 'shape' : p.type}_${'AB'[parity]}`,
        color: tpl.colors[parity],
        panels: [],
      });
    }
    parts.get(key).panels.push({ no: p.no, pts, n: n.normalize() });
  }
  return [...parts.values()].sort((a, b) => a.index - b.index);
}

export function modelBounds(parts) {
  const box = new THREE.Box3();
  for (const part of parts) for (const pn of part.panels) for (const v of pn.pts) box.expandByPoint(v);
  return box;
}

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
// sRGB components straight from the hex string, so the file does not depend
// on three.js colour-management settings.
function hexRGB(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

// ------------------------------------------------------------------- GLB

export function exportGLB(shell, comp, { pose = 'assembled', generator = 'Paper Fold Studio', meta = {} } = {}) {
  const parts = modelParts(shell, comp, { pose });
  const materials = [];
  const matIndex = new Map();
  const bin = [];
  let byteLength = 0;
  const bufferViews = [], accessors = [];
  const push = (typed, target) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { bin.push(new Uint8Array(pad)); byteLength += pad; }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: typed.byteLength, target });
    bin.push(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
    byteLength += typed.byteLength;
    return bufferViews.length - 1;
  };
  const meshes = [], nodes = [];
  let triangles = 0;
  for (const part of parts) {
    if (!matIndex.has(part.material)) {
      const [r, g, b] = hexRGB(part.color);
      matIndex.set(part.material, materials.length);
      materials.push({
        name: part.material,
        pbrMetallicRoughness: { baseColorFactor: [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), 1], metallicFactor: 0, roughnessFactor: 0.85 },
        // Paper has two sides: show the back of an opened flap too.
        doubleSided: true,
      });
    }
    const pos = [], nrm = [], idx = [];
    for (const pn of part.panels) {
      const base = pos.length / 3;
      for (const v of pn.pts) { pos.push(v.x, v.y, v.z); nrm.push(pn.n.x, pn.n.y, pn.n.z); }
      for (const [a, b, c] of convexTriangles(pn.pts, pn.n)) idx.push(base + a, base + b, base + c);
    }
    triangles += idx.length / 3;
    const P = new Float32Array(pos), N = new Float32Array(nrm);
    const big = pos.length / 3 > 65535;
    const I = big ? new Uint32Array(idx) : new Uint16Array(idx);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[i + k]); max[k] = Math.max(max[k], P[i + k]); }
    const pv = push(P, 34962), nv = push(N, 34962), iv = push(I, 34963);
    accessors.push({ bufferView: pv, componentType: 5126, count: P.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: nv, componentType: 5126, count: N.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: iv, componentType: big ? 5125 : 5123, count: I.length, type: 'SCALAR' });
    const a = accessors.length;
    meshes.push({ name: part.name, primitives: [{ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1, material: matIndex.get(part.material), mode: 4 }] });
    nodes.push({ name: part.name, mesh: meshes.length - 1 });
  }
  const box = modelBounds(parts);
  const size = box.getSize(new THREE.Vector3());
  const json = {
    asset: {
      version: '2.0',
      generator,
      extras: {
        units: 'metres (glTF standard)',
        pose: pose === 'assembled' ? 'assembled form' : 'current folded pose',
        contents: 'exterior shell only (internal faces removed); no table, scenery, ghost, handles, labels or selection',
        sizeMM: size.toArray().map((v) => Math.round(v * MM * 100) / 100),
        ...meta,
      },
    },
    scene: 0,
    scenes: [{ name: 'Composition', nodes: nodes.map((_, i) => i + 1) }],
    nodes: [{ name: 'Composition', children: nodes.map((_, i) => i + 1) }, ...nodes],
    meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength }],
  };
  // The scene's root is the parent node; list it, not each child.
  json.scenes[0].nodes = [0];
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(jsonBytes.length + jpad); t.set(jsonBytes); t.fill(0x20, jsonBytes.length); jsonBytes = t; }
  const bpad = (4 - (byteLength % 4)) % 4;
  const binLen = byteLength + bpad;
  const total = 12 + 8 + jsonBytes.length + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
  o += 8;
  for (const chunk of bin) { out.set(chunk, o); o += chunk.length; }
  return { bytes: out, parts: parts.length, panels: shell.panels.length, triangles, sizeMM: size.clone().multiplyScalar(MM), json };
}

// ------------------------------------------------------------------- OBJ

const f4 = (v) => (Math.round(v * 1e4) / 1e4).toString();

export function exportOBJ(shell, comp, { pose = 'assembled', name = 'model', header = [] } = {}) {
  const parts = modelParts(shell, comp, { pose });
  const box = modelBounds(parts);
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(MM);
  const lines = [
    '# Paper Fold Studio: 3D model',
    ...header.map((h) => `# ${h}`),
    '# Units: millimetres (1 unit = 1 mm). Y is up.',
    `# Pose: ${pose === 'assembled' ? 'assembled form' : 'current folded pose'}`,
    '# Exterior shell only: internal faces removed; no table, scenery, ghost, handles, labels or selection.',
    `# Size: ${size.toArray().map((v) => v.toFixed(2)).join(' x ')} mm (x, y, z)`,
    `mtllib ${name}.mtl`,
    `o ${name}`,
  ];
  // Shared corners are written once, so the shell's faces join edge to edge.
  const vIndex = new Map();
  const vLines = [], nLines = [], fLines = [];
  const key = (v) => `${Math.round(v.x * 1e7)},${Math.round(v.y * 1e7)},${Math.round(v.z * 1e7)}`;
  const vid = (v) => {
    const k = key(v);
    if (!vIndex.has(k)) { vIndex.set(k, vIndex.size + 1); vLines.push(`v ${f4(v.x * MM)} ${f4(v.y * MM)} ${f4(v.z * MM)}`); }
    return vIndex.get(k);
  };
  let faces = 0;
  for (const part of parts) {
    fLines.push(`g ${part.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/, '')}`, `usemtl ${part.material}`);
    for (const pn of part.panels) {
      nLines.push(`vn ${f4(pn.n.x)} ${f4(pn.n.y)} ${f4(pn.n.z)}`);
      const ni = nLines.length;
      fLines.push(`f ${pn.pts.map((v) => `${vid(v)}//${ni}`).join(' ')}`);
      faces++;
    }
  }
  const obj = [...lines, ...vLines, ...nLines, ...fLines, ''].join('\n');
  const seen = new Set();
  const mtl = ['# Paper Fold Studio materials (diffuse colours, sRGB 0-1)'];
  for (const part of parts) {
    if (seen.has(part.material)) continue;
    seen.add(part.material);
    const [r, g, b] = hexRGB(part.color);
    mtl.push('', `newmtl ${part.material}`, `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
  }
  return { obj, mtl: mtl.join('\n') + '\n', parts: parts.length, faces, vertices: vIndex.size, sizeMM: size };
}

// Triangles for a convex panel that may have straight corners (a merged
// panel keeps the corners where neighbouring edges meet, so the shell stays
// watertight). Every corner stays a vertex and no triangle has zero area:
// ears are cut at strictly convex corners, never leaving a flat remainder.
export function convexTriangles(pts, n) {
  const m = pts.length;
  if (m <= 3) return m === 3 ? [[0, 1, 2]] : [];
  const area2 = (i, j, k) => new THREE.Vector3().subVectors(pts[j], pts[i]).cross(new THREE.Vector3().subVectors(pts[k], pts[j])).dot(n);
  let ring = [...Array(m).keys()];
  const total = (r) => { let a = 0; for (let i = 1; i < r.length - 1; i++) a += area2(r[0], r[i], r[i + 1]); return a; };
  const out = [];
  let guard = 0;
  while (ring.length > 3 && guard++ < 4 * m) {
    const all = total(ring);
    const eps = Math.abs(all) * 1e-9;
    let cut = -1;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[(k + ring.length - 1) % ring.length], b = ring[k], c = ring[(k + 1) % ring.length];
      const ear = area2(a, b, c);
      if (ear > eps && all - ear > eps) { cut = k; break; }
    }
    if (cut < 0) break;
    const a = ring[(cut + ring.length - 1) % ring.length], b = ring[cut], c = ring[(cut + 1) % ring.length];
    out.push([a, b, c]);
    ring = ring.filter((_, i) => i !== cut);
  }
  if (ring.length === 3) out.push(ring);
  else for (let i = 1; i < ring.length - 1; i++) out.push([ring[0], ring[i], ring[i + 1]]);
  return out;
}
