// 2D helpers for convex polygons in paper coordinates (metres).
// A polygon is an array of [x, y] points in counter-clockwise order.

export function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polyCentroid(poly) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-14) {
    // Degenerate: fall back to the vertex average.
    let sx = 0, sy = 0;
    for (const p of poly) { sx += p[0]; sy += p[1]; }
    return [sx / poly.length, sy / poly.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function dedupe(poly, tol) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol) out.pop();
  }
  return out;
}

// Split a convex polygon by the infinite line through a and b.
// Returns [leftPoly, rightPoly] or null when the line does not cut it
// into two pieces that are both larger than minArea.
export function splitConvex(poly, a, b, tol = 1e-6, minArea = 1e-9) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;
  const nx = -dy / len, ny = dx / len; // left normal
  const n = poly.length;
  const s = poly.map((p) => {
    const d = (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
    return Math.abs(d) < tol ? 0 : d;
  });
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const sp = s[i], sq = s[(i + 1) % n];
    if (sp >= 0) L.push(p);
    if (sp <= 0) R.push(p);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq);
      const m = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      L.push(m);
      R.push(m);
    }
  }
  const l = dedupe(L, tol), r = dedupe(R, tol);
  if (l.length < 3 || r.length < 3) return null;
  if (Math.abs(polyArea(l)) < minArea || Math.abs(polyArea(r)) < minArea) return null;
  return [l, r];
}

export function pointInConvex(poly, p, margin = 0) {
  // Works for either winding.
  let sign = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    const c = (ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / len;
    if (Math.abs(c) <= margin) continue;
    const sg = Math.sign(c);
    if (sign === 0) sign = sg;
    else if (sg !== sign) return false;
  }
  return true;
}

export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

// Clip the infinite line a + t (b - a) against a convex polygon.
// Returns [p0, p1] (the chord) or null.
export function clipLineToConvex(poly, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = -Infinity, t1 = Infinity;
  const ccw = polyArea(poly) > 0 ? 1 : -1;
  for (let i = 0, n = poly.length; i < n; i++) {
    const v = poly[i], w = poly[(i + 1) % n];
    // Inward normal of edge v->w for a CCW polygon is the left normal.
    const nx = -(w[1] - v[1]) * ccw, ny = (w[0] - v[0]) * ccw;
    const num = (a[0] - v[0]) * nx + (a[1] - v[1]) * ny;
    const den = dx * nx + dy * ny;
    if (Math.abs(den) < 1e-15) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  if (!isFinite(t0) || !isFinite(t1) || t1 - t0 < 1e-9) return null;
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

// Separating-axis test for two convex polygons. They overlap only when
// they interpenetrate by more than tol along every axis.
export function convexOverlap(A, B, tol = 1e-4) {
  for (const P of [A, B]) {
    for (let i = 0, n = P.length; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      let ax = -(b[1] - a[1]), ay = b[0] - a[0];
      const len = Math.hypot(ax, ay);
      if (len < 1e-12) continue;
      ax /= len; ay /= len;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of A) { const d = p[0] * ax + p[1] * ay; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const p of B) { const d = p[0] * ax + p[1] * ay; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (Math.min(maxA, maxB) - Math.max(minA, minB) <= tol) return false;
    }
  }
  return true;
}

// If segments a1-b1 and a2-b2 are collinear and overlap, return the shared part.
export function sharedSegment(a1, b1, a2, b2, tol = 1e-5) {
  const dx = b1[0] - a1[0], dy = b1[1] - a1[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;
  const ux = dx / len, uy = dy / len;
  const off = (p) => Math.abs((p[0] - a1[0]) * uy - (p[1] - a1[1]) * ux);
  if (off(a2) > tol || off(b2) > tol) return null;
  const ta = (a2[0] - a1[0]) * ux + (a2[1] - a1[1]) * uy;
  const tb = (b2[0] - a1[0]) * ux + (b2[1] - a1[1]) * uy;
  const lo = Math.max(0, Math.min(ta, tb));
  const hi = Math.min(len, Math.max(ta, tb));
  if (hi - lo < tol * 10) return null;
  return [
    [a1[0] + ux * lo, a1[1] + uy * lo],
    [a1[0] + ux * hi, a1[1] + uy * hi],
  ];
}

export function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}
