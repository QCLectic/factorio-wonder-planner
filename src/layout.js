/* Layered left-to-right layout for a solver plan. No DOM, so it can be tested in Node.
 *
 * Input: plan from FPSolver.solve. Output: positioned boxes and edge paths.
 * Steps: find back edges (cycles such as Kovarex) with a DFS, rank nodes by longest path
 * over the remaining edges, pull source nodes next to their first consumer, order each
 * layer with barycenter sweeps, then spread edge ports along box sides.
 */
(function (root) {
  'use strict';
  const BOX_W = 210, GAP_X = 120, GAP_Y = 24, PORT = 13, MIN_H = 64, PAD = 30;

  // Edge paths for the current node positions. Ports on a box are ordered by the height of the
  // other end. The app calls this again after the user moves a box.
  function route(nodes, links, back) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const outs = new Map(nodes.map((n) => [n.id, []]));
    const ins = new Map(nodes.map((n) => [n.id, []]));
    links.forEach((l, i) => { outs.get(l.from).push(i); ins.get(l.to).push(i); });
    const cy = (id) => byId.get(id).y + byId.get(id).h / 2;
    const portY = new Map();
    for (const n of nodes) {
      outs.get(n.id).sort((a, b) => cy(links[a].to) - cy(links[b].to));
      ins.get(n.id).sort((a, b) => cy(links[a].from) - cy(links[b].from));
      outs.get(n.id).forEach((li, k) => portY.set('o' + li, n.y + n.h * (k + 1) / (outs.get(n.id).length + 1)));
      ins.get(n.id).forEach((li, k) => portY.set('i' + li, n.y + n.h * (k + 1) / (ins.get(n.id).length + 1)));
    }
    return links.map((l, i) => {
      const a = byId.get(l.from), b = byId.get(l.to);
      const sx = a.x + a.w, sy = portY.get('o' + i), tx = b.x, ty = portY.get('i' + i);
      const dx = Math.max(50, Math.abs(tx - sx) / 2);
      const d = `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
      return { link: l, sx, sy, tx, ty, d, back: back.has(l.from + '>' + l.to) };
    });
  }

  function layout(plan) {
    const nodes = plan.nodes.map((n) => ({ id: n.id, ref: n }));
    if (plan.links.some((l) => l.to === 'target')) nodes.push({ id: 'target', ref: { kind: 'target', name: plan.targets && Object.keys(plan.targets).length > 1 ? Object.keys(plan.targets).length + ' items' : plan.target } });
    if (plan.links.some((l) => l.to === 'surplus')) nodes.push({ id: 'surplus', ref: { kind: 'surplus', name: 'surplus' } });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = plan.links.filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to);

    const succ = new Map(nodes.map((n) => [n.id, new Set()]));
    const pred = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const l of links) { succ.get(l.from).add(l.to); pred.get(l.to).add(l.from); }

    // Back edges by DFS. Roots are nodes with no producers.
    const state = new Map();
    const back = new Set();
    const dfs = (u) => {
      state.set(u, 1);
      for (const v of [...succ.get(u)].sort()) {
        if (!state.get(v)) dfs(v);
        else if (state.get(v) === 1) back.add(u + '>' + v);
      }
      state.set(u, 2);
    };
    const order = nodes.map((n) => n.id).sort();
    for (const id of order) if (!pred.get(id).size && !state.get(id)) dfs(id);
    for (const id of order) if (!state.get(id)) dfs(id);

    // Longest-path ranks over non-back edges, in topological order (Kahn).
    const fwdPred = new Map(), fwdSucc = new Map();
    for (const n of nodes) { fwdPred.set(n.id, []); fwdSucc.set(n.id, []); }
    for (const l of links) {
      if (back.has(l.from + '>' + l.to)) continue;
      if (!fwdSucc.get(l.from).includes(l.to)) { fwdSucc.get(l.from).push(l.to); fwdPred.get(l.to).push(l.from); }
    }
    const indeg = new Map(nodes.map((n) => [n.id, fwdPred.get(n.id).length]));
    const queue = order.filter((id) => !indeg.get(id));
    const rank = new Map(nodes.map((n) => [n.id, 0]));
    const topo = [];
    while (queue.length) {
      const u = queue.shift();
      topo.push(u);
      for (const v of fwdSucc.get(u)) {
        rank.set(v, Math.max(rank.get(v), rank.get(u) + 1));
        indeg.set(v, indeg.get(v) - 1);
        if (!indeg.get(v)) queue.push(v);
      }
    }
    // Pull sources right, next to their earliest consumer.
    for (let k = topo.length - 1; k >= 0; k--) {
      const u = topo[k];
      if (fwdPred.get(u).length || !fwdSucc.get(u).length) continue;
      rank.set(u, Math.min(...fwdSucc.get(u).map((v) => rank.get(v))) - 1);
    }
    const minRank = Math.min(...nodes.map((n) => rank.get(n.id)));
    for (const n of nodes) n.rank = rank.get(n.id) - minRank;

    // Layers and barycenter ordering.
    const nLayers = Math.max(0, ...nodes.map((n) => n.rank)) + 1;
    const layers = Array.from({ length: nLayers }, () => []);
    for (const id of order) layers[byId.get(id).rank].push(byId.get(id));
    const pos = new Map();
    const reindex = () => layers.forEach((L) => L.forEach((n, i) => pos.set(n.id, i)));
    reindex();
    const bary = (n, nbrs) => {
      const v = [...nbrs].map((id) => pos.get(id));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : pos.get(n.id);
    };
    for (let sweep = 0; sweep < 6; sweep++) {
      const down = sweep % 2 === 0;
      const seq = down ? layers.map((_, i) => i) : layers.map((_, i) => nLayers - 1 - i);
      for (const li of seq) {
        layers[li].sort((a, b) => bary(a, down ? pred.get(a.id) : succ.get(a.id)) - bary(b, down ? pred.get(b.id) : succ.get(b.id)));
        reindex();
      }
    }

    // Box heights from port counts, then positions.
    const outs = new Map(nodes.map((n) => [n.id, []]));
    const ins = new Map(nodes.map((n) => [n.id, []]));
    links.forEach((l, i) => { outs.get(l.from).push(i); ins.get(l.to).push(i); });
    for (const n of nodes) {
      n.w = BOX_W;
      n.h = Math.max(MIN_H, PORT * Math.max(outs.get(n.id).length, ins.get(n.id).length) + 14);
    }
    let height = 0;
    const colH = layers.map((L) => L.reduce((s, n) => s + n.h, 0) + GAP_Y * Math.max(0, L.length - 1));
    const maxH = Math.max(...colH, 0);
    layers.forEach((L, li) => {
      let y = PAD + (maxH - colH[li]) / 2;
      for (const n of L) { n.x = PAD + li * (BOX_W + GAP_X); n.y = y; y += n.h + GAP_Y; }
    });
    height = maxH + PAD * 2;
    const width = nLayers * (BOX_W + GAP_X) - GAP_X + PAD * 2;

    const edges = route(nodes, links, back);
    return { nodes, edges, links, back, width, height };
  }

  const api = { layout, route, BOX_W };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
