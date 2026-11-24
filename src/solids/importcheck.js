// Checks a file before anything from it is added to the workspace. Returns
// what the file holds, any problems that make it unusable, and what it
// does not say that a foldable model needs (faces, hinges, fold angles).

const fmt = (x) => (Math.round(x * 100) / 100).toString();

export function checkImport(name, bytes) {
  const lower = name.toLowerCase();
  try {
    if (lower.endsWith('.obj')) return checkOBJ(new TextDecoder().decode(bytes));
    if (lower.endsWith('.glb')) return checkGLB(bytes);
    if (lower.endsWith('.svg')) return checkSVG(new TextDecoder().decode(bytes));
  } catch (err) {
    return { ok: false, kind: '?', errors: [`The file could not be read (${String(err && err.message || err).slice(0, 80)}).`], missing: [] };
  }
  return { ok: false, kind: '?', errors: ['Only .json (saved models), .obj, .glb and .svg files can be imported.'], missing: [] };
}

// ------------------------------------------------------------------ OBJ

function checkOBJ(text) {
  const v = [], faces = [];
  const errors = [];
  let unit = 1; // OBJ has no unit; ours are in millimetres (stated in a comment)
  if (/^#.*\bmillimet/im.test(text)) unit = 0.001;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, n) => {
    const t = line.trim();
    if (t.startsWith('v ')) {
      const xyz = t.slice(2).trim().split(/\s+/).slice(0, 3).map(Number);
      if (xyz.length < 3 || !xyz.every(Number.isFinite)) errors.push(`Line ${n + 1}: a vertex without three numbers.`);
      else v.push(xyz.map((x) => x * unit));
    } else if (t.startsWith('f ')) {
      const idx = t.slice(2).trim().split(/\s+/).map((w) => parseInt(w.split('/')[0], 10));
      const ix = idx.map((i) => (i < 0 ? v.length + i : i - 1));
      if (ix.length < 3) errors.push(`Line ${n + 1}: a face with fewer than 3 corners.`);
      else if (ix.some((i) => !Number.isInteger(i) || i < 0)) errors.push(`Line ${n + 1}: a face refers to a missing vertex.`);
      else faces.push({ ix, line: n + 1 });
    }
  });
  for (const f of faces) if (f.ix.some((i) => i >= v.length)) errors.push(`Line ${f.line}: a face refers to a vertex that does not exist.`);
  if (!v.length) errors.push('There are no vertices.');
  if (!faces.length) errors.push('There are no faces.');
  if (errors.length) return { ok: false, kind: 'OBJ', errors: errors.slice(0, 6), missing: [] };
  return meshReport('OBJ', v, faces.map((f) => f.ix), { polygons: true });
}

// ------------------------------------------------------------------ GLB

function checkGLB(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return { ok: false, kind: 'GLB', errors: ['This is not a binary glTF (.glb) file.'], missing: [] };
  if (dv.getUint32(4, true) !== 2) return { ok: false, kind: 'GLB', errors: ['Only glTF 2.0 files can be read.'], missing: [] };
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const body = new Uint8Array(buf, off + 8, len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  if (!json || !bin) return { ok: false, kind: 'GLB', errors: ['The file has no geometry data.'], missing: [] };
  const acc = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC3: 3 }[a.type];
    const C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    if (!n || !C) throw new Error('unsupported accessor');
    return new C(bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0), a.count * n);
  };
  const v = [], tris = [];
  for (const mesh of json.meshes || []) {
    for (const pr of mesh.primitives || []) {
      if (pr.mode !== undefined && pr.mode !== 4) return { ok: false, kind: 'GLB', errors: ['Only triangle meshes can be read.'], missing: [] };
      const P = acc(pr.attributes.POSITION);
      const base = v.length;
      for (let i = 0; i < P.length; i += 3) v.push([P[i], P[i + 1], P[i + 2]]);
      const I = pr.indices !== undefined ? acc(pr.indices) : Array.from({ length: P.length / 3 }, (_, i) => i);
      for (let i = 0; i + 2 < I.length; i += 3) tris.push([base + I[i], base + I[i + 1], base + I[i + 2]]);
    }
  }
  if (!tris.length) return { ok: false, kind: 'GLB', errors: ['The file has no triangles.'], missing: [] };
  return meshReport('GLB', v, tris, { polygons: false });
}

// ------------------------------------------------------------------ SVG

function checkSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || !doc.documentElement || doc.documentElement.nodeName.toLowerCase() !== 'svg') {
    return { ok: false, kind: 'SVG', errors: ['This is not a readable SVG file.'], missing: [] };
  }
  const shapes = doc.querySelectorAll('path, polygon, polyline, line, rect');
  if (!shapes.length) return { ok: false, kind: 'SVG', errors: ['The drawing has no lines or outlines.'], missing: [] };
  const ours = !!doc.querySelector('path.cut') && (!!doc.querySelector('path.mountain') || !!doc.querySelector('path.valley') || !!doc.querySelector('path.flat'));
  const missing = ours
    ? ['how far each fold turns (the drawing marks mountain and valley folds but not their angles), so the closed form is not known']
    : ['which lines are folds and which are cuts', 'how far each fold turns, so the closed form is not known'];
  return { ok: true, kind: 'SVG', errors: [], missing, summary: ours ? 'a net drawn by Paper Fold Studio (cut, mountain and valley lines)' : `a drawing with ${shapes.length} outline element${shapes.length === 1 ? '' : 's'}` };
}

// ---------------------------------------------------------- mesh checks

function meshReport(kind, v, faceIx, { polygons }) {
  // Join corners at the same place; size scale for tolerances.
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of v) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const q = size * 1e-6;
  const key = (p) => p.map((x) => Math.round(x / q)).join(',');
  const ids = new Map();
  const id = (i) => { const k = key(v[i]); if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const faces = faceIx.map((f) => f.map(id));
  const errors = [];
  // Flat faces (polygons in OBJ): every corner on the face's plane.
  if (polygons) {
    faces.forEach((f, n) => {
      if (f.length < 4) return;
      const pts = faceIx[n].map((i) => v[i]);
      const nr = newell(pts);
      const d0 = dot(nr, pts[0]);
      const off = Math.max(...pts.map((p) => Math.abs(dot(nr, p) - d0)));
      if (off > size * 1e-5) errors.push(`Face ${n + 1} is not flat: a corner is ${fmt(off * 1000)} mm off its plane.`);
    });
  }
  faces.forEach((f, n) => { if (new Set(f).size !== f.length) errors.push(`Face ${n + 1} uses the same corner twice.`); });
  // Edges: each joins exactly two faces, running opposite ways.
  const dir = new Map();
  for (const f of faces) for (let i = 0; i < f.length; i++) { const k = `${f[i]}>${f[(i + 1) % f.length]}`; dir.set(k, (dir.get(k) || 0) + 1); }
  let open = 0, flipped = 0, many = 0;
  const und = new Map();
  for (const [k, c] of dir) {
    const [a, b] = k.split('>');
    const u = a < b ? `${a}|${b}` : `${b}|${a}`;
    und.set(u, (und.get(u) || 0) + c);
    if (c > 1) flipped++;
  }
  for (const c of und.values()) { if (c === 1) open++; else if (c > 2) many++; }
  if (many) errors.push(`${many} edge${many === 1 ? ' is' : 's are'} shared by more than two faces.`);
  if (flipped) errors.push(`${flipped} face${flipped === 1 ? ' faces' : 's face'} the wrong way (inconsistent winding).`);
  const closed = open === 0 && !many;
  const nFaces = faces.length;
  const summary = `${nFaces} ${polygons ? 'faces' : 'triangles'}, ${und.size} edges, ${ids.size} corners, ${closed ? 'a closed surface' : `${open} open edge${open === 1 ? '' : 's'}`}`;
  if (errors.length) return { ok: false, kind, errors: errors.slice(0, 6), missing: [], summary };
  const missing = [];
  if (!polygons) missing.push('which triangles together make one flat face (a GLB stores triangles, not faces)');
  missing.push('which edges are hinges and which are cuts (the net)');
  if (!closed) missing.push('how the open surface folds');
  return { ok: true, kind, errors: [], missing, summary, closed };
}

function newell(pts) {
  const n = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
