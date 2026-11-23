import * as THREE from 'three';
import { flatTargets } from './layout.js';

// Resolve overlaps with the fewest additional cuts, keeping the current
// hinge layout (and every cut already made) as it is.
//
// Cutting a hinge never moves the panels that stay joined, so two panels
// of a flat piece that overlap keep overlapping exactly as long as a path
// of hinges still joins them. In a hinge forest that path is unique, and
// the task is to choose the smallest set of hinges that meets the path of
// every overlapping pair (one cut may serve several pairs). The search
// tries one cut, then two, and so on, branching on the edges of a path
// that is still joined; every solution must contain one of them, so each
// level is searched completely unless the time budget runs out.
//
// Cycles are handled explicitly. A loop of hinges that closes exactly
// when unfolded can stay, but then a pair is only separated once every
// route between its panels is cut (the search branches on the remaining
// route). A loop that does not close cannot lie flat: one of its hinges
// has to be cut, and which one changes the unfolding, so the overlaps are
// worked out again for each such choice.
//
// Then the pieces are arranged: the largest part of each original piece
// stays where it is and each detached part is moved (slid away from its
// cut, turned if that helps) just far enough to be clear of everything.
// Nothing else is cut. The result is checked again (no overlaps within or
// between pieces) before it can be applied.

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export const edgeLength = (e) => e.a.distanceTo(e.b);
const cuttable = (e) => e.userLock !== 'hinge';

function unionFind(items) {
  const parent = new Map(items.map((x) => [x, x]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  return { find, union: (a, b) => { a = find(a); b = find(b); if (a === b) return false; parent.set(a, b); return true; } };
}

function components(shell, hinges) {
  const uf = unionFind(shell.panels);
  for (const e of hinges) uf.union(e.uses[0].panel, e.uses[1].panel);
  return uf;
}

// Edges of the hinge graph that lie on a cycle (not bridges).
function cycleEdges(shell, hinges) {
  const adj = new Map(shell.panels.map((p) => [p, []]));
  for (const e of hinges) { adj.get(e.uses[0].panel).push(e); adj.get(e.uses[1].panel).push(e); }
  const disc = new Map(), low = new Map(), out = new Set();
  let t = 0;
  const dfs = (u, via) => {
    disc.set(u, t); low.set(u, t); t++;
    for (const e of adj.get(u)) {
      if (e === via) continue;
      const v = shell.other(e, u);
      if (!disc.has(v)) { dfs(v, e); low.set(u, Math.min(low.get(u), low.get(v))); if (low.get(v) <= disc.get(u)) out.add(e); }
      else { low.set(u, Math.min(low.get(u), disc.get(v))); out.add(e); }
    }
  };
  for (const p of shell.panels) if (!disc.has(p)) dfs(p, null);
  // A tree edge is a bridge when low(v) > disc(u); the others, and every
  // back edge, lie on a cycle.
  return out;
}

// Shortest route of hinges between a and b (BFS), or null.
function route(shell, hinges, a, b) {
  const prev = new Map([[a, null]]);
  const q = [a];
  while (q.length) {
    const p = q.shift();
    if (p === b) break;
    for (const e of p.edges) {
      if (!hinges.has(e)) continue;
      const o = shell.other(e, p);
      if (!o || prev.has(o)) continue;
      prev.set(o, e);
      q.push(o);
    }
  }
  if (!prev.has(b)) return null;
  const out = [];
  for (let p = b; p !== a;) { const e = prev.get(p); out.push(e); p = shell.other(e, p); }
  return out;
}

function withState(shell, types, Ms, fn) {
  const savedT = shell.edges.map((e) => e.type);
  const savedM = shell.panels.map((p) => p.M.clone());
  if (types) shell.setLayout(types);
  if (Ms) shell.panels.forEach((p, i) => p.M.copy(Ms[i]));
  try { return fn(); } finally {
    shell.edges.forEach((e, i) => { e.type = savedT[i]; });
    shell.panels.forEach((p, i) => p.M.copy(savedM[i]));
  }
}

// The flat unfolding for hinge set `h`: the current poses where they are
// already flat (they are the user's layout), otherwise laid flat. Also
// reports loops of hinges that do not close when unfolded.
function unfolding(shell, h, keepCurrent) {
  return withState(shell, h, null, () => {
    const F = shell.forest();
    // Loops: unfold the spanning forest from the closed form and see
    // whether each extra hinge still meets its partner exactly.
    const bad = [];
    if (F.loops.length) {
      withState(shell, null, shell.panels.map(() => new THREE.Matrix4()), () => {
        shell.applyForest(F, shell.flatAngles(F), null);
        const tol = (shell.edgeLen || 0.1) * 1e-6;
        for (const e of F.loops) {
          const [u, v] = e.uses;
          const ok = e.a.clone().applyMatrix4(u.panel.M).distanceTo(e.a.clone().applyMatrix4(v.panel.M)) < tol
            && e.b.clone().applyMatrix4(u.panel.M).distanceTo(e.b.clone().applyMatrix4(v.panel.M)) < tol;
          if (!ok) {
            const tree = new Set([...h].filter((x) => !F.loops.includes(x)));
            bad.push([e, ...(route(shell, tree, u.panel, v.panel) || [])]);
          }
        }
      });
    }
    if (bad.length) return { bad, Ms: null, pairs: [] };
    const t = flatTargets(shell, { keepFlat: keepCurrent });
    shell.applyForest(t.F, t.angles, t.roots);
    const uf = components(shell, h);
    const res = shell.overlaps((a, b) => uf.find(a) === uf.find(b));
    return { bad, Ms: shell.panels.map((p) => p.M.clone()), pairs: res.pairs };
  });
}

// Move the detached parts as little as possible so nothing overlaps.
function arrange(shell, hAfter, Ms, h0, cuts) {
  return withState(shell, hAfter, Ms, () => {
    const ufAfter = components(shell, hAfter);
    const uf0 = components(shell, h0);
    const groups = new Map();
    for (const p of shell.panels) { const r = ufAfter.find(p); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); }
    const parts = [...groups.values()];
    // Per original piece, its largest part stays put.
    const byOrig = new Map();
    for (const part of parts) { const o = uf0.find(part[0]); if (!byOrig.has(o)) byOrig.set(o, []); byOrig.get(o).push(part); }
    const moving = [];
    for (const list of byOrig.values()) {
      list.sort((a, b) => b.length - a.length);
      moving.push(...list.slice(1));
    }
    moving.sort((a, b) => b.length - a.length);
    const gap = (shell.edgeLen || 0.1) * 0.15;
    const centre = (ps) => { const c = new THREE.Vector3(); let n = 0; for (const p of ps) for (const v of shell.worldPoly(p)) { c.add(v); n++; } return c.divideScalar(n); };
    const clear = (part) => {
      const set = new Set(part);
      return shell.overlaps((a, b) => set.has(a) !== set.has(b)).pairs.length === 0;
    };
    let moved = 0, maxShift = 0;
    for (const part of moving) {
      if (clear(part)) continue;
      const set = new Set(part);
      const start = part.map((p) => p.M.clone());
      const c = centre(part);
      // Away from the cut that freed it.
      const cut = cuts.find((e) => set.has(e.uses[0].panel) !== set.has(e.uses[1].panel)) || cuts[0];
      let dir = new THREE.Vector3(1, 0, 0);
      if (cut) {
        const P = set.has(cut.uses[0].panel) ? cut.uses[0].panel : cut.uses[1].panel;
        const mid = cut.a.clone().add(cut.b).multiplyScalar(0.5).applyMatrix4(P.M);
        dir = c.clone().sub(mid); dir.y = 0;
        if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
        dir.normalize();
      }
      const turns = [0, 15, -15, 30, -30, 45, -45, 90, -90, 180].map((d) => THREE.MathUtils.degToRad(d));
      // Away from the cut first, then the other directions: the smallest
      // shift that clears everything wins (then the smallest turn).
      const dirs = [0, 45, -45, 90, -90, 135, -135, 180].map((d) => dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(d)));
      let done = false;
      for (let k = 1; k <= 60 && !done; k++) {
        const s = gap * k;
        for (const yaw of turns) {
          for (const dv of dirs) {
            const T = new THREE.Matrix4().makeTranslation(c.x + dv.x * s, 0, c.z + dv.z * s)
              .multiply(new THREE.Matrix4().makeRotationY(yaw))
              .multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
            part.forEach((p, i) => p.M.copy(T).multiply(start[i]));
            if (clear(part)) { done = true; break; }
          }
          if (done) { moved++; maxShift = Math.max(maxShift, s); break; }
        }
      }
      if (!done) {
        // Beside everything else.
        const box = new THREE.Box3();
        for (const p of shell.panels) if (!set.has(p)) for (const v of shell.worldPoly(p)) box.expandByPoint(v);
        part.forEach((p, i) => p.M.copy(start[i]));
        const pb = new THREE.Box3();
        for (const p of part) for (const v of shell.worldPoly(p)) pb.expandByPoint(v);
        const T = new THREE.Matrix4().makeTranslation(box.max.x + gap - pb.min.x, 0, box.min.z - pb.min.z);
        part.forEach((p) => p.M.premultiply(T));
        moved++;
        maxShift = Math.max(maxShift, box.max.x + gap - pb.min.x);
      }
    }
    const ov = shell.overlapReport();
    const box = new THREE.Box3();
    for (const p of shell.panels) for (const v of shell.worldPoly(p)) box.expandByPoint(v);
    return {
      Ms: shell.panels.map((p) => p.M.clone()),
      within: ov.within, between: ov.between,
      width: box.max.x - box.min.x, depth: box.max.z - box.min.z,
      pieces: parts.length, pieceSizes: parts.map((p) => p.length).sort((a, b) => b - a),
      moved, maxShift,
    };
  });
}

// Generator so a page can run it a slice at a time; returns the result.
export function* resolveOverlaps(shell, { budgetMs = 3000, maxCuts = 8, keep = 6 } = {}) {
  const t0 = now();
  const deadline = t0 + budgetMs;
  const h0 = new Set(shell.sharedEdges().filter((e) => e.type === 'hinge'));
  const flatNow = shell.flatReport().ok;
  const loopEdges = cycleEdges(shell, h0);
  const cache = new Map();
  const ctxFor = (C) => {
    const key = [...C].filter((e) => loopEdges.has(e)).map((e) => e.key).sort().join('|');
    if (!cache.has(key)) {
      const h = new Set([...h0].filter((e) => !(C.has(e) && loopEdges.has(e))));
      // The user's own poses are used when nothing about the loops changed.
      cache.set(key, unfolding(shell, h, key === ''));
    }
    return cache.get(key);
  };
  const base = ctxFor(new Set());
  const basePairs = base.pairs;
  const mine = {
    pieces: (() => { const uf = components(shell, h0); return new Set(shell.panels.map((p) => uf.find(p))).size; })(),
    pairs: basePairs.length,
    badLoops: base.bad.length,
    flat: flatNow,
  };
  // What is still wrong after cutting C: a loop that does not close, or
  // a pair still joined (with a route through the hinges left).
  const need = (C) => {
    const ctx = ctxFor(C);
    const h = new Set([...h0].filter((e) => !C.has(e)));
    if (ctx.bad.length) {
      for (const cyc of ctx.bad) if (cyc.every((e) => h.has(e))) return { kind: 'loop', edges: cyc };
    }
    const uf = components(shell, h);
    let best = null;
    for (const [a, b] of ctx.pairs) {
      if (uf.find(a) !== uf.find(b)) continue;
      const r = route(shell, h, a, b);
      if (r && (!best || r.length < best.edges.length)) best = { kind: 'pair', pair: [a, b], edges: r };
    }
    return best;
  };
  const solutions = new Map();
  const complete = [];
  let nodes = 0, sliceAt = now(), found = -1, blocked = null;
  for (let k = 0; k <= maxCuts && found < 0; k++) {
    const seen = new Set();
    let timedOut = false;
    const stack = [new Set()];
    while (stack.length) {
      if (now() > deadline) { timedOut = true; break; }
      const C = stack.pop();
      const key = [...C].map((e) => e.key).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      nodes++;
      const n = need(C);
      if (!n) { solutions.set(key, C); continue; }
      if (C.size >= k) continue;
      const opts = n.edges.filter((e) => cuttable(e) && !C.has(e));
      if (!opts.length && !blocked) blocked = n;
      for (const e of opts) stack.push(new Set([...C, e]));
      if (now() - sliceAt > 25) { yield { level: k, nodes }; sliceAt = now(); }
    }
    complete[k] = !timedOut;
    if (solutions.size) found = k;
    if (timedOut) break;
  }
  // Nothing within the budget: cut greedily (not proven minimal).
  let greedy = false;
  if (!solutions.size && !blocked) {
    greedy = true;
    const C = new Set();
    for (let guard = 0; guard < shell.panels.length; guard++) {
      const n = need(C);
      if (!n) { solutions.set([...C].map((e) => e.key).sort().join('|'), C); break; }
      const opts = n.edges.filter((e) => cuttable(e) && !C.has(e));
      if (!opts.length) { blocked = n; break; }
      // The edge that frees the most pairs at once; then the shortest.
      let best = null;
      for (const e of opts) {
        const h = new Set([...h0].filter((x) => !C.has(x) && x !== e));
        const uf = components(shell, h);
        const ctx = ctxFor(new Set([...C, e]));
        const left = ctx.pairs.filter(([a, b]) => uf.find(a) === uf.find(b)).length;
        const sc = left * 1e3 + edgeLength(e) / (shell.edgeLen || 0.1);
        if (!best || sc < best.sc) best = { e, sc };
      }
      C.add(best.e);
      yield { level: C.size, nodes };
    }
  }
  // Measure, arrange and check each solution (shortest first).
  const list = [...solutions.values()].map((C) => ({ C, len: [...C].reduce((s, e) => s + edgeLength(e), 0) }))
    .sort((a, b) => a.C.size - b.C.size || a.len - b.len).slice(0, Math.max(keep * 2, 12));
  const out = [];
  for (const { C, len } of list) {
    const ctx = ctxFor(C);
    const hAfter = new Set([...h0].filter((e) => !C.has(e)));
    const cuts = [...C];
    const ar = arrange(shell, hAfter, ctx.Ms, h0, cuts);
    out.push({
      C, cuts, cutLength: len, hinges: hAfter, Ms: ar.Ms,
      pieces: ar.pieces, pieceSizes: ar.pieceSizes,
      overlaps: ar.within + ar.between, within: ar.within, between: ar.between,
      width: ar.width, depth: ar.depth, area: ar.width * ar.depth,
      moved: ar.moved, maxShift: ar.maxShift,
      valid: ar.within === 0 && ar.between === 0,
    });
    if (now() - sliceAt > 25) { yield { level: found, nodes }; sliceAt = now(); }
  }
  const r6 = (v) => Math.round(v * 1e6);
  out.sort((a, b) => (a.valid ? 0 : 1) - (b.valid ? 0 : 1) || a.cuts.length - b.cuts.length || r6(a.cutLength) - r6(b.cutLength) || a.area - b.area);
  const best = out.slice(0, keep);
  // Why each cut: the overlapping pairs that would join again without it,
  // and the single hinges that could replace it.
  for (const s of best) {
    const { C, cuts } = s;
    const hAfter = s.hinges;
    const ctx = ctxFor(C);
    s.why = cuts.map((e) => {
      const h = new Set([...hAfter, e]);
      const uf = components(shell, h);
      // Pairs only this cut separates (they join again without it) …
      const pairs = ctx.pairs.filter(([a, b]) => uf.find(a) === uf.find(b));
      // … and pairs whose hinge path it lies on together with other cuts.
      const hAll = new Set([...hAfter, ...C]);
      const shared = ctx.pairs.filter((pr) => !pairs.includes(pr)).map(([a, b]) => {
        const r = route(shell, hAll, a, b) || [];
        return r.includes(e) ? { pair: [a, b], with: r.filter((x) => x !== e && C.has(x)) } : null;
      }).filter(Boolean);
      const before = ctxFor(new Set([...C].filter((x) => x !== e)));
      const loops = before.bad.filter((cyc) => cyc.includes(e) && cyc.every((x) => x === e || h.has(x)));
      // Single hinges that could replace it and still resolve everything.
      const alts = [];
      for (const f of h0) {
        if (C.has(f) || !cuttable(f)) continue;
        const C2 = new Set([...C].filter((x) => x !== e)); C2.add(f);
        if (!need(C2)) alts.push(f);
      }
      return { e, pairs, shared, loops, alts, shortest: alts.every((f) => edgeLength(f) >= edgeLength(e) - 1e-9) };
    });
    yield { level: found, nodes };
  }
  const top = best[0];
  const k = top ? top.cuts.length : -1;
  const provenCount = !greedy && found >= 0 && complete.slice(0, found).every(Boolean);
  const provenLength = provenCount && complete[found] === true;
  let note;
  if (!basePairs.length && !base.bad.length) note = 'Nothing to resolve: no panels overlap inside a piece in this layout. (Overlaps between pieces only need Arrange pieces.)';
  else if (blocked && !top) note = blocked.kind === 'pair'
    ? `Cannot be resolved with the current locks: panels P${blocked.pair[0].no} and P${blocked.pair[1].no} overlap and every hinge joining them is locked. Unlock one of them, or try Other nets for a different hinge layout.`
    : 'Cannot be resolved with the current locks: a loop of hinges that cannot lie flat is made entirely of locked hinges. Unlock one of them.';
  else if (!top) note = `No resolution found within the search budget (${nodes} combinations checked). This does not prove that none exists.`;
  else if (provenCount) note = `Minimum proven for the current hinge layout: ${k} additional cut${k === 1 ? '' : 's'}${k > 1 ? ` (every set of ${k - 1} cut${k - 1 === 1 ? '' : 's'} was checked; none separates all ${basePairs.length} overlapping pairs)` : ''}.${provenLength ? ` All ${solutions.size} option${solutions.size === 1 ? '' : 's'} with ${k} cut${k === 1 ? '' : 's'} were compared; the shortest is first.` : ' Not every option of that size was compared within the budget, so a shorter one may exist.'} A different hinge layout (Other nets) is a separate search and may need fewer cuts.`;
  else note = `Best found within the search budget: ${k} additional cut${k === 1 ? '' : 's'}${greedy ? ' (chosen one at a time)' : ''}. Fewer may be possible; this is not proven. A different hinge layout (Other nets) is a separate search.`;
  return {
    suggestions: best, mine, pairs: basePairs, badLoops: base.bad, nodes,
    ms: Math.round(now() - t0), minCuts: k, proven: { count: provenCount, length: provenLength }, greedy, blocked, note,
  };
}

// Run the whole search at once (tests).
export function resolveNow(shell, opts) {
  const g = resolveOverlaps(shell, opts);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
