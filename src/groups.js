/* Groups: a named set of machine nodes from a solver plan. No DOM, so it can be tested in Node.
 *
 * state = { assign: {nodeId: groupId}, names: {groupId: name}, order: [groupId], planet: {groupId: planet} }
 * planet holds only the planets the user chose. A group without an entry gets a suggestion.
 * Nodes with no entry in assign are ungrouped. External inputs are never grouped.
 *
 * Proposal rules (decided after the solver worked, see CLAUDE.md):
 *   'chain'    A node joins the group of its only consumer. A node with two or more consumers,
 *              or none, starts a new group. Mines and pumps join the group that takes most of
 *              their output. Result: one group per final product, plus one per shared sub-chain.
 *   'category' One group per kind of work: mining, smelting, chemistry, and so on.
 *
 * Planets (step 7). A group fits a planet when every member can run there:
 *   recipe  surface_conditions of the recipe and of its machine hold on the planet's properties
 *   mine    the resource is in planets.<name>.entities (map generation settings in the dump)
 *   pump    a tile of the fluid is in planets.<name>.tiles
 * A link between two groups on different planets is an import for the receiving group.
 */
(function (root) {
  'use strict';

  const S = typeof module !== 'undefined' && module.exports ? require('./solver.js') : root.FPSolver;
  // Order used for suggestions and ties. Planets not listed here follow, sorted by name.
  const PLANET_ORDER = ['nauvis', 'vulcanus', 'gleba', 'fulgora', 'aquilo', 'space-platform'];

  const pretty = (s) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const isRaw = (n) => n.kind === 'mine' || n.kind === 'pump';
  const isPseudo = (id) => id === 'target' || id === 'surplus';

  function uniqueName(names, base) {
    const taken = new Set(Object.values(names));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  function propose(plan, rule, data) {
    const state = { assign: {}, names: {}, order: [], planet: {} };
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));
    const grouped = plan.nodes.filter((n) => n.kind !== 'external');
    let seq = 0;
    const newGroup = (name) => {
      const id = 'g' + (++seq);
      state.names[id] = uniqueName(state.names, name);
      state.order.push(id);
      return id;
    };

    // Planet-aware joining. A group keeps the list of planets where all its members can run.
    // A node joins only if that list stays non-empty. Otherwise it starts its own group.
    const names = data && data.planets ? planetNames(data) : null;
    const gfit = {};
    const fitOf = (n) => (names ? names.filter((p) => !nodeProblem(data, n, p)) : []);
    const tryJoin = (n, g) => {
      const nf = fitOf(n);
      if (nf.length) {
        const next = gfit[g] ? gfit[g].filter((p) => nf.includes(p)) : nf;
        if (!next.length) return false;
        gfit[g] = next;
      }
      state.assign[n.id] = g;
      return true;
    };
    const startGroup = (n, name) => {
      const g = newGroup(name);
      const nf = fitOf(n);
      if (nf.length) gfit[g] = nf;
      state.assign[n.id] = g;
      return g;
    };

    if (rule === 'category') {
      const keyOf = (n) => {
        if (n.kind === 'mine') return 'Mining';
        if (n.kind === 'pump') return 'Pumping';
        const rec = data && data.recipes[n.name];
        const cat = rec && rec.categories && rec.categories.length ? rec.categories[0] : 'crafting';
        return pretty(cat);
      };
      const ids = {};
      for (const n of grouped) {
        const k = keyOf(n);
        const list = ids[k] || (ids[k] = []);
        if (!list.some((g) => tryJoin(n, g))) list.push(startGroup(n, k));
      }
      return state;
    }

    // 'chain': consumers first, by DFS post-order.
    const flow = new Map();                      // node -> Map(consumer -> rate)
    for (const n of plan.nodes) flow.set(n.id, new Map());
    for (const l of plan.links) {
      if (l.from === l.to || !byId.has(l.from) || isPseudo(l.to) || !byId.has(l.to)) continue;
      const m = flow.get(l.from);
      m.set(l.to, (m.get(l.to) || 0) + l.rate);
    }
    const done = new Set(), visiting = new Set();
    const visit = (n) => {
      if (done.has(n.id) || visiting.has(n.id)) return;
      visiting.add(n.id);
      for (const c of flow.get(n.id).keys()) visit(byId.get(c));
      visiting.delete(n.id);
      done.add(n.id);
      if (isRaw(n) || n.kind === 'external') return;
      const cons = [...flow.get(n.id).keys()];
      if (cons.length === 1 && state.assign[cons[0]] && tryJoin(n, state.assign[cons[0]])) return;
      startGroup(n, pretty(n.name));
    };
    for (const n of grouped) if (!isRaw(n)) visit(n);
    for (const n of grouped) {
      if (!isRaw(n)) continue;
      // Try the consumer groups in order of flow, largest first.
      const cands = [...flow.get(n.id)].filter(([c]) => state.assign[c]).sort((a, b) => b[1] - a[1]);
      if (!cands.some(([c]) => tryJoin(n, state.assign[c]))) startGroup(n, pretty(n.name));
    }
    return state;
  }

  // Drop assignments for nodes that left the plan. Keep names of groups that still have members.
  function reconcile(plan, state) {
    const ids = new Set(plan.nodes.map((n) => n.id));
    const assign = {};
    for (const [k, g] of Object.entries(state.assign)) if (ids.has(k)) assign[k] = g;
    const used = new Set(Object.values(assign));
    const order = state.order.filter((g) => used.has(g));
    const names = {};
    for (const g of order) names[g] = state.names[g];
    const planet = {};
    for (const g of order) if (state.planet && state.planet[g]) planet[g] = state.planet[g];
    return { assign, names, order, planet };
  }

  function planetNames(data) {
    const all = new Set([...Object.keys(data.planets || {}), ...Object.keys(data.surfaces || {})]);
    return PLANET_ORDER.filter((p) => all.has(p)).concat([...all].filter((p) => !PLANET_ORDER.includes(p)).sort());
  }

  // Why a node cannot run on a planet, or null when it can.
  function nodeProblem(data, n, planet) {
    const props = S.surfaceProps(data, planet);
    const pl = data.planets[planet] || data.surfaces[planet];
    const lab = pretty(planet);
    if (n.kind === 'recipe') {
      const r = data.recipes[n.name], m = data.machines[n.machine];
      if (r && !S.conditionsOk(r.surface_conditions, props)) return `${pretty(n.name)} cannot be made on ${lab}`;
      if (m && !S.conditionsOk(m.surface_conditions, props)) return `${pretty(n.machine)} cannot be built on ${lab}`;
    } else if (n.kind === 'mine') {
      const d = data.mining_drills[n.machine];
      if (!(pl.entities || []).includes(n.name)) return `${pretty(n.name)} is not found on ${lab}`;
      if (d && !S.conditionsOk(d.surface_conditions, props)) return `${pretty(n.machine)} cannot be built on ${lab}`;
    } else if (n.kind === 'pump') {
      const tiles = (data.pumpable_fluids || {})[n.name] || [];
      if (!(pl.tiles || []).some((t) => tiles.includes(t))) return `${pretty(n.name)} cannot be pumped on ${lab}`;
    }
    return null;
  }
  function problemsOn(data, nodes, planet) {
    const out = [];
    for (const n of nodes) { const p = nodeProblem(data, n, planet); if (p && !out.includes(p)) out.push(p); }
    return out;
  }

  // Pick a planet for every group. Order of preference:
  //   1. the user's choice
  //   2. the only planet where the group fits
  //   3. among several fits, the planet that holds most of the group's linked flow
  //      (flow of mixed items and fluids is added as plain numbers, so this is a heuristic)
  //   4. ties and groups with no placed neighbor: opts.prefer, then the first planet in order
  // A group that fits nowhere gets the planet with the fewest problems and lists them.
  function resolvePlanets(data, groups, nodesOf, links, state, opts) {
    const names = planetNames(data);
    const where = new Map();
    const flex = [];
    for (const g of groups) {
      g.fit = names.filter((p) => !problemsOn(data, nodesOf.get(g.id), p).length);
      const chosen = state.planet && state.planet[g.gid];
      g.planetSet = !!(chosen && names.includes(chosen));
      if (g.planetSet) where.set(g.id, chosen);
      else if (g.fit.length === 1) where.set(g.id, g.fit[0]);
      else if (!g.fit.length) {
        // Fits nowhere: take the planet with the fewest problems and show them.
        let bestP = null, bestN = Infinity;
        for (const p of [opts && opts.prefer].concat(names)) {
          if (!p || !names.includes(p)) continue;
          const k = problemsOn(data, nodesOf.get(g.id), p).length;
          if (k < bestN) { bestP = p; bestN = k; }
        }
        where.set(g.id, bestP);
      } else flex.push(g);
    }
    const prefer = (fit) => (opts && fit.includes(opts.prefer) ? opts.prefer : fit.includes(names[0]) ? names[0] : fit[0]);
    while (flex.length) {
      let best = null;
      for (const g of flex) {
        const fit = g.fit;
        const w = {};
        for (const l of links) {
          const other = l.from === g.id ? l.to : l.to === g.id ? l.from : null;
          const op = other && where.get(other);
          if (op && fit.includes(op)) w[op] = (w[op] || 0) + l.rate;
        }
        let pick = null, pw = 0;
        for (const p of fit) if ((w[p] || 0) > pw) { pick = p; pw = w[p]; }
        if (!best || pw > best.pw) best = { g, pick: pick || prefer(fit), pw };
      }
      where.set(best.g.id, best.pick);
      flex.splice(flex.indexOf(best.g), 1);
    }
    for (const g of groups) {
      g.planet = where.get(g.id);
      g.problems = problemsOn(data, nodesOf.get(g.id), g.planet);
    }
    return { names, where };
  }

  // Build the group-level plan: groups replace their members, other nodes stay as they are.
  // Links between members of one group are internal and drop out. Parallel links with the same
  // item and ends are summed. The result has the same shape as a solver plan, so the layout
  // and the flow view work on it unchanged.
  function groupPlan(plan, state, data, opts) {
    const st = reconcile(plan, state);
    const gid = (id) => (st.assign[id] ? 'group:' + st.assign[id] : id);
    const nodes = [];
    const groups = [];
    const nodesOf = new Map();
    for (const g of st.order) {
      const members = plan.nodes.filter((n) => st.assign[n.id] === g);
      const info = {
        id: 'group:' + g, kind: 'group', gid: g, name: st.names[g], members: members.map((n) => n.id),
        machines: members.reduce((s, n) => s + (n.machinesCeil || 0), 0),
        powerW: members.reduce((s, n) => s + n.powerW, 0),
        fuelW: members.reduce((s, n) => s + n.fuelW, 0),
        raw: {}, external: {}, inputs: [], outputs: [], imports: [], exports: [],
      };
      nodesOf.set(info.id, members);
      for (const n of members) if (isRaw(n)) for (const [i, v] of Object.entries(n.outputs)) info.raw[i] = (info.raw[i] || 0) + v;
      groups.push(info);
      nodes.push(info);
    }
    for (const n of plan.nodes) if (!st.assign[n.id]) nodes.push(n);

    const agg = new Map();
    for (const l of plan.links) {
      const from = gid(l.from), to = gid(l.to);
      if (from === to) continue;
      const k = from + '|' + to + '|' + l.item;
      const e = agg.get(k) || { item: l.item, from, to, rate: 0 };
      e.rate += l.rate;
      agg.set(k, e);
    }
    const links = [...agg.values()];
    const byGid = new Map(groups.map((g) => [g.id, g]));
    for (const l of links) {
      const src = byGid.get(l.from), dst = byGid.get(l.to);
      if (dst) dst.inputs.push({ item: l.item, from: l.from, rate: l.rate });
      if (src) src.outputs.push({ item: l.item, to: l.to, rate: l.rate });
      if (dst && l.from.startsWith('ext:')) dst.external[l.item] = (dst.external[l.item] || 0) + l.rate;
    }
    const planets = {}, transfers = [];
    let planetList = [];
    if (data && groups.length) {
      const r = resolvePlanets(data, groups, nodesOf, links, st, opts);
      planetList = r.names;
      for (const l of links) {
        const sp = r.where.get(l.from), dp = r.where.get(l.to);
        if (!sp || !dp || sp === dp) continue;
        l.cross = true; l.fromPlanet = sp; l.toPlanet = dp;
        byGid.get(l.to).imports.push({ item: l.item, from: l.from, fromPlanet: sp, rate: l.rate });
        byGid.get(l.from).exports.push({ item: l.item, to: l.to, toPlanet: dp, rate: l.rate });
        const k = l.item + '|' + sp + '|' + dp;
        let t = transfers.find((x) => x.key === k);
        if (!t) transfers.push(t = { key: k, item: l.item, from: sp, to: dp, rate: 0 });
        t.rate += l.rate;
      }
      for (const g of groups) {
        const e = planets[g.planet] || (planets[g.planet] = { groups: 0, machines: 0, powerW: 0 });
        e.groups++; e.machines += g.machines; e.powerW += g.powerW;
      }
    }
    return {
      plan: Object.assign({}, plan, { nodes, links }),
      groups, state: st, planets, transfers, planetList,
    };
  }

  const api = { propose, reconcile, groupPlan, planetNames, nodeProblem, PLANET_ORDER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPGroups = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
