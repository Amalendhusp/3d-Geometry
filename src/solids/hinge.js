import * as THREE from 'three';

// Turning a grabbed point about a hinge axis. A frame describes the circle
// the grab point travels on: centre C on the axis, axis direction U, the
// starting direction v0n (unit, perpendicular to U), w0 = U x v0n, radius r.
// Angles are offsets from where the grab started.

const _d = new THREE.Vector3();
const _g = new THREE.Vector3();

export function makeFrame(axisPoint, axisDir, grab) {
  const U = axisDir.clone().normalize();
  const C = axisPoint.clone().addScaledVector(U, grab.clone().sub(axisPoint).dot(U));
  const v0 = grab.clone().sub(C);
  const r = v0.length();
  if (r < 1e-6) return null;
  const v0n = v0.divideScalar(r);
  return { C, U, v0n, w0: new THREE.Vector3().crossVectors(U, v0n), r };
}

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Offset that turns the grab point toward a 3D point (a hand or fingertip).
export function angleFromPoint(f, X, prev) {
  _d.copy(X).sub(f.C);
  _d.addScaledVector(f.U, -_d.dot(f.U));
  if (_d.lengthSq() < 1e-10) return prev;
  const raw = Math.atan2(f.w0.dot(_d), f.v0n.dot(_d));
  return prev + wrap(raw - prev);
}

// Offset whose grab point lies closest to a ray (mouse or finger on a
// screen). Searches near the previous offset so the panel follows smoothly;
// between equally good answers it picks the one nearer the eye.
export function angleFromRay(f, origin, dir, prev) {
  const step = THREE.MathUtils.degToRad(1);
  const samples = [];
  for (let k = -75; k <= 75; k++) {
    const a = prev + k * step;
    _g.copy(f.C).addScaledVector(f.v0n, f.r * Math.cos(a)).addScaledVector(f.w0, f.r * Math.sin(a));
    _d.subVectors(_g, origin);
    const t = Math.max(0, _d.dot(dir));
    const dist = _d.addScaledVector(dir, -t).length();
    samples.push({ a, dist, t });
  }
  let dmin = Infinity;
  for (const s of samples) dmin = Math.min(dmin, s.dist);
  const good = samples.filter((s, i) => {
    const p = samples[i - 1], n = samples[i + 1];
    return (!p || p.dist >= s.dist) && (!n || n.dist >= s.dist) && s.dist <= dmin + Math.max(0.002, f.r * 0.03);
  });
  good.sort((p, q) => p.t - q.t);
  return (good[0] || samples[75]).a;
}
