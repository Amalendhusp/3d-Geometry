import * as THREE from 'three';

// Solid templates with unit edge length, centred on the origin. Faces are
// vertex-index loops; winding is fixed up so every face is counter-clockwise
// seen from outside (normal pointing away from the centre).
//
// Only the cube is enabled in this stage. Tetrahedron, octahedron and
// cuboctahedron will reuse the same shape: { vertices, faces }.

const h = 0.5;
const CUBE = {
  name: 'Cube',
  vertices: [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ],
  faces: [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3],
    [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2],
  ],
};

export const TEMPLATES = { cube: CUBE };

const cache = new Map();

// Template geometry scaled to an edge length, with outward normals.
export function template(type) {
  if (cache.has(type)) return cache.get(type);
  const t = TEMPLATES[type];
  if (!t) throw new Error(`Unknown solid type ${type}`);
  const verts = t.vertices.map((v) => new THREE.Vector3(...v));
  const centre = verts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(verts.length);
  const faces = t.faces.map((loop) => {
    let idx = loop.slice();
    const c = idx.reduce((a, i) => a.add(verts[i]), new THREE.Vector3()).divideScalar(idx.length);
    const n = new THREE.Vector3().subVectors(verts[idx[1]], verts[idx[0]])
      .cross(new THREE.Vector3().subVectors(verts[idx[2]], verts[idx[0]])).normalize();
    if (n.dot(c.clone().sub(centre)) < 0) { idx = idx.reverse(); n.negate(); }
    return { idx, normal: n, centroid: c, sides: idx.length };
  });
  const out = { type, name: t.name, verts, faces };
  cache.set(type, out);
  return out;
}

export const SOLID_TYPES = Object.keys(TEMPLATES);
