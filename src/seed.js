/* Seed groups from a save export. No DOM, so it runs in Node tests.
 *
 * Idea: the places where the player really built things are the groups they think in. So:
 *   1. Take every machine in the save that makes something (recipe) or mines (target) with its position.
 *   2. Cut them into blocks. Machines on the same surface within EPS tiles of each other join one block
 *      (single linkage). A block wider than MAX_SPAN tiles is cut in half along its long side, again
 *      and again, so one huge connected base still gives readable groups.
 *   3. Each plan node goes to the block that holds most of its built machines.
 *   4. Each block that got nodes becomes a group. Its planet is its surface.
 * Plan nodes with no built machine keep the group from the base proposal (the chain rule).
 *
 * EPS and MAX_SPAN are judgement calls, not game data. They are exported so tests and the UI can name them.
 */
(function (root) {
  'use strict';

  const EPS = 25;          // tiles. Machines closer than this are one block. Checked on one real save: 10 gave 44 blocks, 25 about 17, 80 merged most of it.
  const MAX_SPAN = 160;    // tiles. A block wider or taller than this is split.
  const MIN_SPLIT = 4;     // never split a block with fewer machines than this

  const pretty = (s) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

  function keyOf(g) {
    if (g.type === 'mining-drill') return g.miningTarget ? 'mine:' + g.miningTarget : '';
    return g.recipe || '';
  }

  // Single-linkage components by grid hashing. points: [{x, y, key}] on one surface.
  function components(points, eps) {
    eps = eps || EPS;
    const cell = (v) => Math.floor(v / eps);
    const grid = new Map();
    points.forEach((p, i) => {
      const k = cell(p.x) + ',' + cell(p.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    const parent = points.map((_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    points.forEach((p, i) => {
      const cx = cell(p.x), cy = cell(p.y);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get((cx + dx) + ',' + (cy + dy));
        if (!list) continue;
        for (const j of list) if (j > i && Math.hypot(points[j].x - p.x, points[j].y - p.y) <= eps) union(i, j);
      }
    });
    const by = new Map();
    points.forEach((p, i) => { const r = find(i); if (!by.has(r)) by.set(r, []); by.get(r).push(p); });
    return [...by.values()];
  }

  function split(block) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of block) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const w = maxX - minX, h = maxY - minY;
    if (Math.max(w, h) <= MAX_SPAN || block.length < MIN_SPLIT) return [block];
    const axis = w >= h ? 'x' : 'y';
    const sorted = block.slice().sort((a, b) => a[axis] - b[axis]);
    const mid = Math.floor(sorted.length / 2);
    return split(sorted.slice(0, mid)).concat(split(sorted.slice(mid)));
  }

  function planetOfSurface(surface, data) {
    if (data && data.planets && data.planets[surface]) return surface;
    if (/^platform-?\d*$/.test(surface) || surface === 'space-platform') return 'space-platform';
    return null;
  }

  // factory: cleaned export { machines: [{surface, type, recipe, miningTarget, count, pos: [x1,y1,...]}] }
  // base: a group state from groups.propose. Returns a new state and a small report.
  function seed(plan, factory, base, data, opts) {
    const eps = (opts && opts.eps) || EPS;
    const planKeys = new Map();
    for (const n of plan.nodes) {
      if (n.kind === 'recipe') planKeys.set(n.name, n.id);
      else if (n.kind === 'mine') planKeys.set('mine:' + n.name, n.id);
    }
    // Points per surface. A machine group without positions counts as one point at the origin.
    const bySurface = new Map();
    for (const g of factory.machines) {
      const key = keyOf(g);
      if (!key) continue;
      if (!bySurface.has(g.surface)) bySurface.set(g.surface, []);
      const list = bySurface.get(g.surface);
      const pos = g.pos && g.pos.length >= 2 ? g.pos : [0, 0];
      for (let i = 0; i + 1 < pos.length; i += 2) list.push({ x: pos[i], y: pos[i + 1], key });
    }
    const blocks = [];
    for (const [surface, points] of [...bySurface.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const comp of components(points, eps)) for (const b of split(comp)) blocks.push({ surface, points: b });
    }
    blocks.sort((a, b) => b.points.length - a.points.length);
    for (const b of blocks) {
      b.counts = {};
      for (const p of b.points) b.counts[p.key] = (b.counts[p.key] || 0) + 1;
    }

    const state = {
      assign: Object.assign({}, base.assign), names: Object.assign({}, base.names),
      order: base.order.slice(), planet: Object.assign({}, base.planet || {}),
    };
    const report = { blocks: blocks.length, seeded: 0, unbuilt: 0, groups: 0 };
    const blockGroup = new Map();
    let seq = 0;
    for (const [key, id] of planKeys) {
      let best = null, bestN = 0;
      for (const b of blocks) {
        const c = b.counts[key] || 0;
        if (c > bestN) { best = b; bestN = c; }
      }
      if (!best) { report.unbuilt++; continue; }
      let gid = blockGroup.get(best);
      if (!gid) {
        gid = 's' + (++seq);
        blockGroup.set(best, gid);
        state.order.push(gid);
        const planet = planetOfSurface(best.surface, data);
        if (planet) state.planet[gid] = planet;
      }
      state.assign[id] = gid;
      report.seeded++;
    }
    // Plan nodes with no built machine, and pumps, join the seeded group of the consumer that takes
    // most of their output. This repeats a few times so a chain of unbuilt nodes follows its consumer.
    const seeded = new Set(blockGroup.values());
    const flowTo = new Map();
    for (const l of plan.links) {
      if (l.to === 'target' || l.to === 'surplus' || l.from === l.to) continue;
      const m = flowTo.get(l.from) || flowTo.set(l.from, new Map()).get(l.from);
      m.set(l.to, (m.get(l.to) || 0) + l.rate);
    }
    const direct = new Set([...planKeys.values()].filter((id) => seeded.has(state.assign[id])));
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const n of plan.nodes) {
        if (n.kind === 'external' || direct.has(n.id)) continue;
        const m = flowTo.get(n.id);
        if (!m) continue;
        let best = null, bestRate = 0;
        for (const [to, r] of m) if (seeded.has(state.assign[to]) && r > bestRate) { best = state.assign[to]; bestRate = r; }
        if (best && state.assign[n.id] !== best) { state.assign[n.id] = best; changed = true; }
      }
      if (!changed) break;
    }
    // Names: the two plan keys with most machines in the block, plus the surface when the base spans several.
    const surfaces = new Set(blocks.map((b) => b.surface));
    const used = new Set(Object.values(state.names));
    for (const [b, gid] of blockGroup) {
      const top = Object.entries(b.counts).filter(([k]) => planKeys.has(k)).sort((x, y) => y[1] - x[1]).slice(0, 2)
        .map(([k]) => (k.startsWith('mine:') ? 'Mine ' + pretty(k.slice(5)) : pretty(k)));
      let name = (surfaces.size > 1 ? pretty(b.surface) + ': ' : '') + (top.join(', ') || 'Block');
      for (let i = 2; used.has(name); i++) name = name.replace(/ \(\d+\)$/, '') + ` (${i})`;
      used.add(name);
      state.names[gid] = name;
    }
    report.groups = blockGroup.size;
    return { state, report };
  }

  const api = { seed, components, split, EPS, MAX_SPAN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPSeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
