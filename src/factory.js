/* Factory: read a save export (tools/export_save.py) and compare it with a plan.
 * No DOM, so the web page, the tests and the MCP server all use the same code.
 * The export is untrusted input, so cleanFactory() keeps known fields only.
 */
(function (root) {
  'use strict';

  const STARVED = new Set(['item_ingredient_shortage', 'no_ingredients', 'fluid_ingredient_shortage', 'no_input_fluid', 'low_input_fluid', 'missing_required_fluid']);
  const FULL = new Set(['full_output', 'not_enough_space_in_output', 'full_burnt_result_output', 'waiting_for_space_in_destination']);
  const NOPOWER = new Set(['low_power', 'no_power', 'no_fuel']);
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const num0 = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 80) : '');

  function cleanFactory(raw) {
    if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.machines)) throw new Error('not a planner export file (version 1)');
    const out = { tick: num0(raw.tick), gameVersion: str(raw.game_version, 20), machines: [], stats: {}, failures: isObj(raw.failures) ? Object.keys(raw.failures).slice(0, 20).map((k) => str(k, 60)) : [] };
    for (const g of raw.machines.slice(0, 20000)) {
      if (!isObj(g)) continue;
      const status = {};
      for (const [k, v] of Object.entries(isObj(g.status) ? g.status : {}).slice(0, 40)) status[str(k, 60)] = num0(v);
      out.machines.push({
        surface: str(g.surface, 60), name: str(g.name), type: str(g.type), quality: str(g.quality, 20) || 'normal',
        recipe: str(g.recipe), miningTarget: str(g.mining_target), modules: str(g.modules, 300),
        count: num0(g.count), pos: Array.isArray(g.pos) ? g.pos.slice(0, 40000).filter(Number.isFinite).map(Math.round) : [],
        status, beacons: num0(g.beacons_avg), productivity: num0(g.productivity_bonus_avg), speed: num0(g.speed_bonus_avg),
      });
    }
    for (const [sn, st] of Object.entries(isObj(raw.stats) ? raw.stats : {}).slice(0, 50)) {
      const items = {};
      for (const [n, v] of Object.entries(isObj(st.items) ? st.items : {}).slice(0, 3000)) {
        if (isObj(v)) items[str(n)] = { produced: num0(v.produced), consumed: num0(v.consumed), producedPerS: num0(v.produced_per_s), consumedPerS: num0(v.consumed_per_s) };
      }
      out.stats[str(sn, 60)] = { items, windowS: num0(st.window_s) };
    }
    return out;
  }

  const emptyCls = () => ({ working: 0, starved: 0, full: 0, power: 0, depleted: 0, removing: 0, other: 0 });
  function statusClass(st) {
    const c = emptyCls();
    for (const [k, v] of Object.entries(st)) {
      if (k === 'working' || k === 'normal') c.working += v;
      else if (STARVED.has(k)) c.starved += v;
      else if (FULL.has(k)) c.full += v;
      else if (NOPOWER.has(k)) c.power += v;
      else if (k === 'no_minable_resources') c.depleted += v;
      else if (k === 'marked_for_deconstruction') c.removing += v;
      else c.other += v;
    }
    return c;
  }
  const STATUS_LABEL = { power: 'low power', full: 'output full', depleted: 'depleted', removing: 'marked for removal' };
  const statusText = (c) => Object.keys(c).filter((k) => c[k]).map((k) => `${c[k]} ${STATUS_LABEL[k] || k}`).join(', ') || 'none';

  // What the factory built, by plan key: recipe name, or "mine:<resource>" for drills.
  function builtByKey(factory, surface) {
    const m = {};
    for (const g of factory.machines) {
      if (surface && g.surface !== surface) continue;
      const key = g.type === 'mining-drill' ? (g.miningTarget ? 'mine:' + g.miningTarget : '') : g.recipe;
      if (!key) continue;
      const e = m[key] || (m[key] = { count: 0, cls: emptyCls(), machines: {} });
      e.count += g.count;
      const c = statusClass(g.status);
      for (const k of Object.keys(c)) e.cls[k] += c[k];
      e.machines[g.name] = (e.machines[g.name] || 0) + g.count;
    }
    return m;
  }

  // Plan against factory. rows: one per recipe or mine in the plan, worst first.
  //   { n, key, b: {count, cls, machines}, planned, diff }   diff = built - planned
  // extra: built things that are not in the plan. planned and measured: items per second.
  function compare(plan, factory, surface) {
    const built = builtByKey(factory, surface);
    const rows = plan.nodes.filter((n) => (n.kind === 'recipe' || n.kind === 'mine') && n.machinesCeil > 0).map((n) => {
      const key = n.kind === 'mine' ? 'mine:' + n.name : n.name;
      const b = built[key] || { count: 0, cls: emptyCls(), machines: {} };
      return { n, key, b, planned: n.machinesCeil, diff: b.count - n.machinesCeil };
    });
    const problem = (r) => (r.diff < 0 ? 2 : 0) + (r.b.cls.starved ? 1 : 0) + (r.b.cls.power ? 1 : 0);
    rows.sort((a, b) => problem(b) - problem(a) || b.planned - a.planned);
    const inPlan = new Set(rows.map((r) => r.key));
    const extra = Object.entries(built).filter(([k]) => !inPlan.has(k)).sort((a, b) => b[1].count - a[1].count).map(([key, b]) => ({ key, count: b.count }));
    const planned = {};
    for (const r of rows) for (const [item, v] of Object.entries(r.n.outputs)) planned[item] = (planned[item] || 0) + v;
    const measured = {};
    for (const [sn, st] of Object.entries(factory.stats)) {
      if (surface && sn !== surface) continue;
      for (const [item, v] of Object.entries(st.items)) measured[item] = (measured[item] || 0) + v.producedPerS;
    }
    return { rows, extra, planned, measured };
  }

  // For a recipe with starved machines: each ingredient and the plan rows that make it.
  function trace(rows, recipeRow, data) {
    const rec = data.recipes[recipeRow.n.name];
    return ((rec && rec.ingredients) || []).map((e) => ({
      item: e.name,
      producers: rows.filter((r) => r.n.outputs[e.name] > 0 && r.key !== recipeRow.key),
    }));
  }

  const api = { cleanFactory, statusClass, statusText, emptyCls, builtByKey, compare, trace };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPFactory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
