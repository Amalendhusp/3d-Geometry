import * as THREE from 'three';

// Solid templates with unit edge length, centred on the origin. Each is
// given by its vertices only; faces are found as the convex hull, ordered
// counter-clockwise seen from outside (normal pointing away from the
// centre). Every edge is checked to have length 1, so triangles of the
// tetrahedron, octahedron and cuboctahedron match each other exactly, and
// the squares of the cube and cuboctahedron match each other.

const S2 = Math.SQRT2;

function cuboctaVerts() {
  const out = [];
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
    for (const a of [-1, 1]) {
      for (const b of [-1, 1]) {
        const v = [0, 0, 0];
        v[i] = a; v[j] = b;
        out.push(v.map((x) => x / S2));
      }
    }
  }
  return out;
}

// A 12-sided right prism with unit edges: its 12 sides are unit squares (so
// they join cubes and cuboctahedron squares) and its ends are regular
// 12-gons. This is what "Cylinder" means here: a faceted approximation.
function prism12Verts() {
  const R = 1 / (2 * Math.sin(Math.PI / 12));
  const out = [];
  for (const y of [-0.5, 0.5]) {
    for (let k = 0; k < 12; k++) {
      const a = (k + 0.5) * Math.PI / 6;
      out.push([R * Math.cos(a), y, R * Math.sin(a)]);
    }
  }
  return out;
}

export const TEMPLATES = {
  cube: {
    name: 'Cube', plural: 'cubes',
    vertices: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map((v) => v.map((x) => x / 2)),
    // Fixed face order: saved layouts refer to cube faces by index.
    faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2]],
    colors: ['#f1e6cf', '#e3d3b2'],
  },
  tetra: {
    name: 'Tetrahedron', plural: 'tetrahedra',
    vertices: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((v) => v.map((x) => x / (2 * S2))),
    colors: ['#dbe8cf', '#c4d8b3'],
  },
  octa: {
    name: 'Octahedron', plural: 'octahedra',
    vertices: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((v) => v.map((x) => x / S2)),
    colors: ['#d7e3f0', '#c1d2e5'],
  },
  cubocta: {
    name: 'Cuboctahedron', plural: 'cuboctahedra',
    vertices: cuboctaVerts(),
    colors: ['#f3dcc8', '#e6c6ad'],
  },
  cyl12: {
    name: 'Cylinder (12-sided prism)', plural: 'cylinders (12-sided prisms)', short: 'Cylinder',
    vertices: prism12Verts(),
    colors: ['#e6dcef', '#d4c6e3'],
  },
};

// The name of a face shape, for messages.
export function faceShapeName(sides) {
  return sides === 3 ? 'triangle' : sides === 4 ? 'square' : `${sides}-sided face`;
}

export const SOLID_TYPES = Object.keys(TEMPLATES);

// Faces of the convex hull of a point set (small sets only).
export function hullFaces(verts, eps = 1e-6) {
  const faces = [];
  const seen = new Set();
  const n = verts.length;
  const centre = verts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const nrm = new THREE.Vector3().subVectors(verts[j], verts[i]).cross(new THREE.Vector3().subVectors(verts[k], verts[i]));
        if (nrm.lengthSq() < 1e-12) continue;
        nrm.normalize();
        const d = nrm.dot(verts[i]);
        let pos = 0, neg = 0;
        const on = [];
        for (let m = 0; m < n; m++) {
          const s = nrm.dot(verts[m]) - d;
          if (s > eps) pos++;
          else if (s < -eps) neg++;
          else on.push(m);
        }
        if (pos && neg) continue;
        if (pos) nrm.negate(); // make it point outward
        const key = on.slice().sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const c = on.reduce((a, m) => a.add(verts[m]), new THREE.Vector3()).divideScalar(on.length);
        if (nrm.dot(c.clone().sub(centre)) < 0) nrm.negate();
        const u = verts[on[0]].clone().sub(c).normalize();
        const w = new THREE.Vector3().crossVectors(nrm, u);
        on.sort((a, b) => {
          const pa = verts[a].clone().sub(c), pb = verts[b].clone().sub(c);
          return Math.atan2(w.dot(pa), u.dot(pa)) - Math.atan2(w.dot(pb), u.dot(pb));
        });
        faces.push(on);
      }
    }
  }
  return faces;
}

const cache = new Map();

// Template geometry (unit edge) with outward normals and a resting pose.
export function template(type) {
  if (cache.has(type)) return cache.get(type);
  const t = TEMPLATES[type];
  if (!t) throw new Error(`Unknown solid type ${type}`);
  const verts = t.vertices.map((v) => new THREE.Vector3(...v));
  const centre = verts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(verts.length);
  const faces = (t.faces || hullFaces(verts)).map((loop) => {
    let idx = loop.slice();
    const c = idx.reduce((a, i) => a.add(verts[i]), new THREE.Vector3()).divideScalar(idx.length);
    const n = new THREE.Vector3().subVectors(verts[idx[1]], verts[idx[0]])
      .cross(new THREE.Vector3().subVectors(verts[idx[2]], verts[idx[0]])).normalize();
    if (n.dot(c.clone().sub(centre)) < 0) { idx = idx.reverse(); n.negate(); }
    return { idx, normal: n, centroid: c, sides: idx.length };
  });
  for (const f of faces) {
    for (let i = 0; i < f.idx.length; i++) {
      const len = verts[f.idx[i]].distanceTo(verts[f.idx[(i + 1) % f.idx.length]]);
      if (Math.abs(len - 1) > 1e-9) throw new Error(`${type}: edge length ${len}`);
    }
  }
  const out = { type, name: t.name, plural: t.plural, colors: t.colors, verts, faces, rest: restPose(verts, faces) };
  cache.set(type, out);
  return out;
}

// Orientation that rests the solid on a face (the largest kind of face),
// with one bottom edge running left to right.
function restPose(verts, faces) {
  const maxSides = Math.max(...faces.map((f) => f.sides));
  // Among the largest faces, the one already closest to facing down.
  const f = faces.filter((x) => x.sides === maxSides).sort((a, b) => a.normal.y - b.normal.y)[0];
  const q = new THREE.Quaternion().setFromUnitVectors(f.normal, new THREE.Vector3(0, -1, 0));
  const a = verts[f.idx[0]].clone().applyQuaternion(q), b = verts[f.idx[1]].clone().applyQuaternion(q);
  const yaw = -Math.atan2(-(b.z - a.z), b.x - a.x);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return qy.multiply(q);
}

// A reflection (det −1) that maps a template's vertex set onto itself.
// Every solid here is mirror-symmetric; a mirrored copy of it is the same
// solid in another orientation: reflection · rotation · this = rotation.
const mirrorCache = new Map();
export function templateMirror(type) {
  if (mirrorCache.has(type)) return mirrorCache.get(type);
  const t = template(type);
  const cands = [
    [-1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, 0, -1, 0, 0, 0, 1], [1, 0, 0, 0, 1, 0, 0, 0, -1],
    [0, 1, 0, 1, 0, 0, 0, 0, 1], [0, 0, 1, 0, 1, 0, 1, 0, 0], [1, 0, 0, 0, 0, 1, 0, 1, 0],
  ].map((e) => new THREE.Matrix3().set(...e));
  const found = cands.find((M) => t.verts.every((v) => { const w = v.clone().applyMatrix3(M); return t.verts.some((u) => u.distanceTo(w) < 1e-9); }));
  if (!found) throw new Error(`${type}: no mirror symmetry found`);
  mirrorCache.set(type, found);
  return found;
}

// Height of the centre above the resting face, for an edge length.
export function restHeight(type, edge) {
  const t = template(type);
  let minY = Infinity;
  for (const v of t.verts) minY = Math.min(minY, v.clone().applyQuaternion(t.rest).y);
  return -minY * edge;
}
