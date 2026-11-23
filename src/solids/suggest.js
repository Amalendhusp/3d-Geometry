import * as THREE from 'three';
import { flatTargets } from './layout.js';

// "Suggest split layout": alternative cut-and-hinge layouts, ranked by
//   1. fewest pieces
//   2. shortest additional cut length
//   3. most compact packed layout (smallest bounding rectangle)
// First only arrangements without extra separation are searched (one
// piece per shell piece, i.e. spanning trees). Only if none of those
// unfolds without overlaps are extra cuts proposed: a tree is split along
// the hinge path between two overlapping panels, choosing the cut that
// clears the most overlaps and is shortest, until every piece is clear.
// Locked hinges stay hinges and locked cuts stay cuts throughout.
//
// Honesty: the number of pieces can never be below the number of
// connected parts left once locked cuts are removed, and the cut length can
// never be below (all seam length) − (longest spanning forest of hinges).
// A suggestion that meets both bounds is proven best on criteria 1 and 2;
// anything else is reported as the best found within the search budget.

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const edgeLength = (e) => e.a.distanceTo(e.b);

function unionFind(items) {
  const parent = new Map(items.map((x) => [x, x]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  return { find, union: (a, b) => { a = find(a); b = find(b); if (a === b) return false; parent.set(a, b); return true; } };
}

// Edges the search may use, with the user's locks.
export function lockInfo(shell) {
  const edges = shell.sharedEdges();
  const hingeLocked = edges.filter((e) => e.userLock === 'hinge');
  const cutLocked = edges.filter((e) => e.userLock === 'cut');
  const free = edges.filter((e) => !e.userLock);
  // Locked hinges must not close a loop.
  const uf = unionFind(shell.panels);
  const loop = hingeLocked.find((e) => !uf.union(e.uses[0].panel, e.uses[1].panel));
  // Fewest possible pieces: parts left once locked cuts are removed.
  const uf2 = unionFind(shell.panels);
  let parts = shell.panels.length;
  for (const e of [...hingeLocked, ...free]) if (uf2.union(e.uses[0].panel, e.uses[1].panel)) parts--;
  return { edges, hingeLocked, cutLocked, free, loop: loop || null, minPieces: parts };
}

// Total length of the seams that are cut (each seam counted once).
export function cutLength(shell, hinges) {
  let s = 0;
  for (const e of shell.edges) if (e.shared && !hinges.has(e)) s += edgeLength(e);
  return s;
}

// Lower bound on cut length: keep the longest possible spanning forest of
// hinges (locked hinges first, locked cuts never).
export function cutLengthBound(shell, info = lockInfo(shell)) {
  const uf = unionFind(shell.panels);
  let kept = 0;
  for (const e of info.hingeLocked) { uf.union(e.uses[0].panel, e.uses[1].panel); kept += edgeLength(e); }
  for (const e of info.free.slice().sort((a, b) => edgeLength(b) - edgeLength(a))) {
    if (uf.union(e.uses[0].panel, e.uses[1].panel)) kept += edgeLength(e);
  }
  let total = 0;
  for (const e of shell.edges) if (e.shared) total += edgeLength(e);
  return total - kept;
}

// Random spanning forest respecting the locks; `bias` favours long edges
// (shorter cuts) and coplanar joins.
function randomForest(shell, info, rng, bias) {
  const L = shell.edgeLen || 0.1;
  const w = new Map(info.free.map((e) => [e, rng() - bias * (edgeLength(e) / L) - (shell.isCoplanar(e) ? 0.6 : 0)]));
  const order = info.free.slice().sort((a, b) => w.get(a) - w.get(b));
  const uf = unionFind(shell.panels);
  const h = new Set();
  for (const e of info.hingeLocked) { uf.union(e.uses[0].panel, e.uses[1].panel); h.add(e); }
  for (const e of order) if (uf.union(e.uses[0].panel, e.uses[1].panel)) h.add(e);
  return h;
}

// Overlapping panel pairs inside each piece when hinge set `h` is unfolded
// flat from the closed form. The shell's poses and types are left as they
// were.
function unfoldPairs(shell, h) {
  const savedM = shell.panels.map((p) => p.M.clone());
  const savedT = shell.edges.map((e) => e.type);
  shell.setLayout(h);
  for (const p of shell.panels) p.M.identity();
  const F = shell.forest();
  shell.applyForest(F, shell.flatAngles(F));
  const rootOf = shell.pieceRoots(F);
  const res = shell.overlaps((a, b) => rootOf.get(a) === rootOf.get(b));
  shell.panels.forEach((p, i) => p.M.copy(savedM[i]));
  shell.edges.forEach((e, i) => { e.type = savedT[i]; });
  return res.pairs;
}

// Hinge edges on the path between panels a and b in forest `h`.
function pathEdges(shell, h, a, b) {
  const prev = new Map([[a, null]]);
  const queue = [a];
  while (queue.length) {
    const p = queue.shift();
    if (p === b) break;
    for (const e of p.edges) {
      if (!h.has(e)) continue;
      const q = shell.other(e, p);
      if (!q || prev.has(q)) continue;
      prev.set(q, e);
      queue.push(q);
    }
  }
  if (!prev.has(b)) return [];
  const out = [];
  for (let p = b; p !== a;) { const e = prev.get(p); out.push(e); p = shell.other(e, p); }
  return out;
}

const pieceCount = (shell, h) => {
  const uf = unionFind(shell.panels);
  let n = shell.panels.length;
  for (const e of h) if (uf.union(e.uses[0].panel, e.uses[1].panel)) n--;
  return n;
};

// Pack the pieces of hinge set `h` (flat, side by side) and measure the
// layout. Poses and types are restored afterwards.
function packedLayout(shell, h) {
  const savedM = shell.panels.map((p) => p.M.clone());
  const savedT = shell.edges.map((e) => e.type);
  shell.setLayout(h);
  const t = flatTargets(shell, { keepFlat: false });
  shell.applyForest(t.F, t.angles, t.roots);
  const box = new THREE.Box3();
  for (const p of shell.panels) for (const v of shell.worldPoly(p)) box.expandByPoint(v);
  const ov = shell.overlapReport();
  const poses = shell.panels.map((p) => p.M.clone());
  shell.panels.forEach((p, i) => p.M.copy(savedM[i]));
  shell.edges.forEach((e, i) => { e.type = savedT[i]; });
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  return { w, d, area: w * d, overlaps: ov.within + ov.between, within: ov.within, between: ov.between, poses };
}

// Greedy split of tree `h` until no piece overlaps itself. Returns the
// forest and the extra cuts, or null if a locked hinge blocks it.
function splitUntilClear(shell, h, deadline) {
  const cur = new Set(h);
  const extra = [];
  for (let iter = 0; iter < shell.panels.length; iter++) {
    const pairs = unfoldPairs(shell, cur);
    if (!pairs.length) return { hinges: cur, extra };
    if (now() > deadline) return null;
    let best = null;
    for (const [a, b] of pairs.slice(0, 3)) {
      for (const e of pathEdges(shell, cur, a, b)) {
        if (e.userLock === 'hinge') continue;
        cur.delete(e);
        const left = unfoldPairs(shell, cur).length;
        cur.add(e);
        const score = left * 1e3 + edgeLength(e) / (shell.edgeLen || 0.1);
        if (!best || score < best.score) best = { e, score };
      }
    }
    if (!best) return null;
    cur.delete(best.e);
    extra.push(best.e);
  }
  return null;
}

const keyOf = (h) => [...h].map((e) => e.key).sort().join('|');

// Measures any hinge set the same way (used for "My layout" too).
export function layoutStats(shell, hinges, info = lockInfo(shell), bound = cutLengthBound(shell, info)) {
  const pieces = pieceCount(shell, hinges);
  const cut = cutLength(shell, hinges);
  return {
    pieces,
    extraCuts: Math.max(0, pieces - info.minPieces),
    cutLength: cut,
    addLength: Math.max(0, cut - bound),
  };
}

// The search, as a generator so a page can run it a slice at a time.
// Yields { tried } now and then; returns the result.
export function* searchLayouts(shell, { budgetMs = 3000, want = 4, seed = 5 } = {}) {
  const t0 = now();
  const deadline = t0 + budgetMs;
  const info = lockInfo(shell);
  if (info.loop) return { error: `Locked hinges close a loop (edge ${info.loop.no}), so no net can keep them all. Unlock one of them.`, suggestions: [], tried: 0, ms: 0 };
  const bound = cutLengthBound(shell, info);
  const rng = mulberry32(seed);
  const seen = new Set();
  const oneP = [];
  let tried = 0, sliceAt = now();
  const near = new Map(); // tree key -> overlap count, for phase 2
  // Phase 1: spanning forests only (no extra separation).
  const biases = [0, 0.3, 0.8, 1.5];
  let misses = 0;
  while (now() < t0 + budgetMs * 0.55 && oneP.length < want * 3 && misses < 600) {
    const h = randomForest(shell, info, rng, biases[tried % biases.length]);
    const k = keyOf(h);
    if (seen.has(k)) { misses++; continue; }
    seen.add(k);
    tried++;
    const pairs = unfoldPairs(shell, h);
    if (!pairs.length) oneP.push(h); else near.set(k, { h, n: pairs.length });
    if (now() - sliceAt > 25) { yield { tried, phase: 1 }; sliceAt = now(); }
  }
  let candidates = oneP.map((h) => ({ hinges: h, extra: [] }));
  let phase = 1;
  // Phase 2: only if no arrangement without extra separation was found.
  if (!candidates.length) {
    phase = 2;
    const pool = [...near.values()].sort((a, b) => a.n - b.n).map((x) => x.h);
    for (let i = 0; i < pool.length && now() < deadline; i++) {
      const r = splitUntilClear(shell, pool[i], deadline);
      tried++;
      if (r && !seen.has('S' + keyOf(r.hinges))) { seen.add('S' + keyOf(r.hinges)); candidates.push(r); }
      if (now() - sliceAt > 25) { yield { tried, phase: 2 }; sliceAt = now(); }
    }
  }
  // Measure and rank.
  const out = [];
  for (const c of candidates) {
    const st = layoutStats(shell, c.hinges, info, bound);
    const pk = packedLayout(shell, c.hinges);
    out.push({ hinges: c.hinges, extra: c.extra, ...st, width: pk.w, depth: pk.d, area: pk.area, overlaps: pk.overlaps, poses: pk.poses });
    if (now() - sliceAt > 25) { yield { tried, phase: 3 }; sliceAt = now(); }
  }
  const round = (v) => Math.round(v * 1e6) / 1e6; // compare lengths to 1 µm
  out.sort((a, b) => a.pieces - b.pieces || round(a.addLength) - round(b.addLength) || a.area - b.area);
  const best = out.slice(0, want);
  const top = best[0];
  const provenPieces = !!top && top.pieces === info.minPieces;
  const provenLength = provenPieces && top.addLength < 1e-9;
  return {
    suggestions: best,
    tried, ms: Math.round(now() - t0), phase,
    minPieces: info.minPieces, bound,
    locks: { hinge: info.hingeLocked.length, cut: info.cutLocked.length },
    proven: { pieces: provenPieces, length: provenLength },
    note: !top ? `No valid layout found within the search budget (${tried} layouts tried in ${(Math.round(now() - t0) / 1000).toFixed(1)} s). This does not prove that none exists.`
      : provenLength ? `Best found: ${top.pieces} piece${top.pieces > 1 ? 's' : ''} is the fewest possible and its cut length equals the lower bound, so it is optimal for pieces and cut length (proven). Compactness is the best found within the search budget.`
        : provenPieces ? `Best found within the search budget: ${top.pieces} piece${top.pieces > 1 ? 's' : ''} is the fewest possible (proven), but a shorter cut length may exist.`
          : `Best found within the search budget (${tried} layouts tried). Fewer pieces may be possible; this is not proven.`,
  };
}

// Run the whole search at once (tests, or small shells).
export function suggestLayouts(shell, opts) {
  const g = searchLayouts(shell, opts);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
