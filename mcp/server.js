#!/usr/bin/env node
/* MCP server for the Factorio planner. Lets Claude plan production with the same solver as the web page.
 *
 * Transport: stdio, one JSON-RPC 2.0 message per line (the MCP stdio transport). No packages.
 * Start it with: node mcp/server.js        Nothing but protocol messages goes to stdout.
 *
 * Tools (all read only):
 *   search_items     find an item by name
 *   get_recipe       recipe data, crafting machines and research that unlocks it
 *   plan             solve targets and rates: machines, raw inputs, power, oil balance
 *   propose_groups   split a plan into groups with planet tags and imports, optionally seeded from a save export
 *   compare_factory  compare a plan with a save export from tools/export_save.py
 *
 * Files: only compare_factory and propose_groups read a file, and only when given export_path. It must be
 * a .json file under 30 MB in the planner export format (version 1). Nothing is written anywhere.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'src', 'solver.js'));
const G = require(path.join(ROOT, 'src', 'groups.js'));
const SEED = require(path.join(ROOT, 'src', 'seed.js'));
const F = require(path.join(ROOT, 'src', 'factory.js'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'data.json'), 'utf8'));

const SERVER = { name: 'factorio-planner', version: '0.1.0' };
const MAX_EXPORT_BYTES = 30e6;
const UNITS = { per_second: 1, per_minute: 60, per_hour: 3600 };

// ---------- items ----------
const pretty = (s) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const norm = (t) => String(t).toLowerCase().replace(/[-_\s]+/g, ' ').trim();
const craftable = new Set();
for (const r of Object.values(data.recipes)) for (const p of r.results || []) craftable.add(p.name);
for (const r of Object.values(data.resources || {})) for (const p of (r.results || [])) craftable.add(p.name);
const names = [...craftable].filter((n) => data.items[n] || data.fluids[n]).sort();
const byNorm = new Map(names.map((n) => [norm(n), n]));

function matchItems(text, limit) {
  const q = norm(text);
  if (!q) return [];
  const starts = [], has = [];
  for (const n of names) { const k = norm(n); if (k.startsWith(q)) starts.push(n); else if (k.includes(q)) has.push(n); }
  return starts.concat(has).slice(0, limit || 8);
}
function resolveItem(text) {
  const q = norm(text);
  if (byNorm.has(q)) return byNorm.get(q);
  const m = matchItems(text, 2);
  return m.length === 1 ? m[0] : null;
}
function needItem(text, what) {
  const id = resolveItem(text);
  if (id) return id;
  const m = matchItems(text);
  throw new Error(`${what || 'item'} "${text}" not found.` + (m.length ? ` Did you mean: ${m.join(', ')}?` : ''));
}

// ---------- number formatting ----------
const r4 = (v) => (Number.isFinite(v) ? Number(Number(v).toPrecision(4)) : v);
const mapVals = (o, f) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, f(v)]));

// ---------- plan inputs ----------
const TARGETS_SCHEMA = {
  type: 'array', minItems: 1, maxItems: 10,
  items: {
    type: 'object', required: ['item', 'rate'],
    properties: {
      item: { type: 'string', description: 'Item or fluid name. Display name ("Chemical science pack") or id ("chemical-science-pack").' },
      rate: { type: 'number', exclusiveMinimum: 0, description: 'Amount wanted, in the unit given by "unit".' },
    },
  },
};
const SETTINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Optional. All fields are optional. Unknown names are ignored and reported in warnings.',
  properties: {
    planet: { type: 'string', description: 'Plan for this one planet only: recipes, resources and pumps are limited to it. Omit to allow any planet with Nauvis preferred.' },
    home: { type: 'string', description: 'Preferred planet when "planet" is omitted. Default nauvis. Sources off this planet cost 10 times more.' },
    machineByCategory: { type: 'object', description: 'Recipe category to machine, for example {"crafting": "assembling-machine-2"}.', additionalProperties: { type: 'string' } },
    machines: { type: 'object', description: 'Recipe name (or "mine:<resource>") to machine, for example {"electronic-circuit": "electromagnetic-plant"}.', additionalProperties: { type: 'string' } },
    drill: { type: 'string', description: 'Mining drill for solid resources.' },
    mods: {
      type: 'object', description: 'Modules and beacons for every machine.',
      properties: {
        module: { type: 'string', description: 'For example productivity-module-3.' }, count: { type: 'integer', description: 'Modules per machine. Omit to fill all slots.' },
        quality: { type: 'string' }, machineQuality: { type: 'string' }, beacons: { type: 'integer' },
        bModule: { type: 'string', description: 'Module in beacons, for example speed-module-3.' }, bCount: { type: 'integer' }, bQuality: { type: 'string' }, beaconQuality: { type: 'string' },
      },
    },
    enabledRecipes: { type: 'array', items: { type: 'string' }, description: 'Recipes to turn on that are off by default, for example casting-iron or coal-liquefaction.' },
    disabledRecipes: { type: 'array', items: { type: 'string' }, description: 'Recipes to turn off.' },
    researched: { type: 'array', items: { type: 'string' }, description: 'Technologies researched. When given, recipes that need other technologies are not used.' },
    oil: {
      type: 'object', properties: {
        mode: { type: 'string', enum: ['auto', 'basic', 'advanced'], description: 'Which oil processing to use.' },
        cracking: { type: 'boolean', description: 'Allow cracking recipes. Default true.' },
      },
    },
  },
};
const PLAN_PROPS = {
  targets: TARGETS_SCHEMA,
  unit: { type: 'string', enum: Object.keys(UNITS), description: 'Unit of all rates in input and output. Default per_second.' },
  settings: SETTINGS_SCHEMA,
};

const CRACKING = ['heavy-oil-cracking', 'light-oil-cracking'];
function buildSettings(input, warnings) {
  const st = input || {};
  const planets = G.planetNames(data);
  const s = {};
  const known = (obj, ok, label) => {
    const out = {};
    for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
      if (typeof v === 'string' && ok(v)) out[k] = v; else warnings.push(`${label} ${k}: unknown machine ${JSON.stringify(v)}, ignored`);
    }
    return out;
  };
  const machOk = (v) => !!(data.machines[v] || data.mining_drills[v]);
  s.machineByCategory = known(st.machineByCategory, machOk, 'machineByCategory');
  s.machines = known(st.machines, machOk, 'machines');
  if (st.drill) { if (data.mining_drills[st.drill]) s.drill = st.drill; else warnings.push(`drill ${st.drill} unknown, ignored`); }
  if (st.mods) s.mods = st.mods;
  if (st.nodeMods) s.nodeMods = st.nodeMods;
  const recipes = (list, label) => (Array.isArray(list) ? list : []).filter((n) => {
    if (data.recipes[n]) return true;
    warnings.push(`${label}: unknown recipe ${n}, ignored`); return false;
  });
  s.enabledRecipes = recipes(st.enabledRecipes, 'enabledRecipes');
  const off = new Set(recipes(st.disabledRecipes, 'disabledRecipes'));
  const oil = st.oil || {};
  if (oil.mode === 'basic') off.add('advanced-oil-processing');
  if (oil.mode === 'advanced') off.add('basic-oil-processing');
  if (oil.cracking === false) CRACKING.forEach((r) => off.add(r));
  s.disabledRecipes = [...off];
  if (Array.isArray(st.researched)) s.researched = st.researched.filter((t) => data.technologies[t] || (warnings.push(`researched: unknown technology ${t}, ignored`), false));
  if (st.planet) {
    if (planets.includes(st.planet)) s.planet = st.planet; else warnings.push(`planet ${st.planet} unknown, ignored. Known: ${planets.join(', ')}`);
  }
  if (!s.planet) s.home = planets.includes(st.home) ? st.home : 'nauvis';
  return s;
}

function runPlan(args) {
  const warnings = [];
  const unit = args.unit || 'per_second';
  if (!UNITS[unit]) throw new Error('unit must be one of ' + Object.keys(UNITS).join(', '));
  const mul = UNITS[unit];
  if (!Array.isArray(args.targets) || !args.targets.length) throw new Error('targets must be a list with at least one {item, rate}');
  const targets = args.targets.map((t) => {
    if (!(t && typeof t.rate === 'number' && t.rate > 0)) throw new Error('every target needs a rate above 0');
    return { item: needItem(t.item, 'target item'), rate: t.rate / mul };
  });
  const settings = buildSettings(args.settings, warnings);
  const plan = S.solve(data, { targets, settings });
  if (!plan.ok) throw new Error('No solution (' + (plan.status || 'unknown') + ')');
  return { plan, unit, mul, warnings, settings, targets };
}

function planSummary(ctx) {
  const { plan, unit, mul, warnings } = ctx;
  const rate = (v) => r4(v * mul);
  const nodes = plan.nodes.filter((n) => n.kind !== 'external').map((n) => {
    const o = {
      kind: n.kind, name: n.name, machine: n.machine, machines_exact: r4(n.machines), machines: n.machinesCeil,
      inputs: mapVals(n.inputs, rate), outputs: mapVals(n.outputs, rate),
    };
    if (n.powerW) o.power_kw = r4(n.powerW / 1000);
    if (n.fuelW) o.fuel_kw = r4(n.fuelW / 1000);
    if (n.productivity) o.productivity = r4(n.productivity);
    return o;
  });
  nodes.sort((a, b) => b.machines - a.machines);
  const oil = {};
  for (const f of ['crude-oil', 'heavy-oil', 'light-oil', 'petroleum-gas']) {
    let made = 0, used = 0;
    for (const n of plan.nodes) { made += n.outputs[f] || 0; used += n.inputs[f] || 0; }
    if (made || used) oil[f] = { made: rate(made), used: rate(used), surplus: rate(plan.surplus[f] || 0) };
  }
  return {
    unit, targets: mapVals(plan.targets, rate),
    electric_power_mw: r4(plan.powerW / 1e6), burner_fuel_mw: plan.fuelW ? r4(plan.fuelW / 1e6) : undefined,
    raw_inputs: mapVals(plan.raw, rate),
    external_inputs_no_modeled_source: mapVals(plan.external, rate),
    surplus: mapVals(plan.surplus, rate),
    machine_totals: plan.machineTotals,
    oil_balance: Object.keys(oil).length ? oil : undefined,
    nodes, notes: plan.notes.concat(warnings),
  };
}

function loadExport(p) {
  if (typeof p !== 'string' || !p.toLowerCase().endsWith('.json')) throw new Error('export_path must be a .json file made by tools/export_save.py');
  const full = path.resolve(p);
  const st = fs.statSync(full);
  if (!st.isFile()) throw new Error('export_path is not a file');
  if (st.size > MAX_EXPORT_BYTES) throw new Error('export file is larger than 30 MB');
  return F.cleanFactory(JSON.parse(fs.readFileSync(full, 'utf8')));
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'search_items',
    description: 'Find Factorio items and fluids by name. Use it to get exact item names before planning.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    run: (a) => ({ matches: matchItems(a.query, a.limit || 10).map((id) => ({ id, name: pretty(id) })) }),
  },
  {
    name: 'get_recipe',
    description: 'Recipe data from the game: ingredients, results, time, categories, machines that can craft it, and the research that unlocks it. Give a recipe name, or an item name to list every recipe that makes it.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    run: (a) => {
      const id = String(a.name).trim().toLowerCase().replace(/\s+/g, '-');
      const list = data.recipes[id] ? [id] : Object.keys(data.recipes).filter((n) => (data.recipes[n].results || []).some((r) => r.name === id) && !data.recipes[n].parameter);
      if (!list.length) throw new Error(`No recipe or item "${a.name}". ` + (matchItems(a.name).length ? 'Did you mean: ' + matchItems(a.name).join(', ') : ''));
      return {
        recipes: list.slice(0, 30).map((n) => {
          const r = data.recipes[n];
          const cands = S.candidateMachines(data, r, null);
          return {
            name: n, time_s: r.energy_required !== undefined ? r.energy_required : 0.5,
            ingredients: (r.ingredients || []).map((e) => ({ name: e.name, amount: e.amount })),
            results: (r.results || []).map((e) => ({ name: e.name, amount: S.expectedAmount(e) })),
            categories: r.categories, allow_productivity: !!r.allow_productivity,
            on_by_default: S.defaultOn(n, r), surface_conditions: r.surface_conditions,
            machines: cands.map((m) => ({ name: m, crafting_speed: data.machines[m].crafting_speed, module_slots: data.machines[m].module_slots || 0 })),
            unlocked_by: r.enabled === false ? (data.recipe_unlocked_by[n] || []) : 'available from the start',
          };
        }),
      };
    },
  },
  {
    name: 'plan',
    description: 'Solve a production plan for one or more targets. Returns machines needed per recipe (exact and rounded up), raw inputs per resource, external inputs with no modeled source, surplus byproducts, power, and the oil balance. Uses a linear-programming solver with alternate recipes, cracking and byproducts, the same as the web planner. Values come from the game data (Factorio 2.1.24 with Space Age, no mods). Spoilage is not modeled. Quality bonuses of +30% per level come from the wiki, not the data.',
    inputSchema: { type: 'object', required: ['targets'], properties: PLAN_PROPS },
    run: (a) => planSummary(runPlan(a)),
  },
  {
    name: 'propose_groups',
    description: 'Split a plan into named groups of machines, each with a planet tag, inputs, outputs and the imports between planets. A group fits a planet when every machine in it can run there (surface conditions, resources, pumps). Rule "chain" groups by product chain, "category" by kind of work. With export_path the groups are seeded from where the player really built things in a save.',
    inputSchema: {
      type: 'object', required: ['targets'],
      properties: Object.assign({}, PLAN_PROPS, {
        rule: { type: 'string', enum: ['chain', 'category'] },
        export_path: { type: 'string', description: 'Optional path to an export.json from tools/export_save.py. Seeds groups from the save.' },
        block_distance: { type: 'number', description: 'Seeding only: machines closer than this many tiles are one block. Default 25.' },
      }),
    },
    run: (a) => {
      const ctx = runPlan(a);
      const { plan, mul } = ctx;
      const rate = (v) => r4(v * mul);
      let state = G.propose(plan, a.rule === 'category' ? 'category' : 'chain', data);
      let seeded;
      if (a.export_path) {
        const r = SEED.seed(plan, loadExport(a.export_path), state, data, a.block_distance ? { eps: Math.max(3, Math.min(200, a.block_distance)) } : undefined);
        state = r.state; seeded = r.report;
      }
      const gp = G.groupPlan(plan, state, data, { prefer: ctx.settings.planet || ctx.settings.home || 'nauvis' });
      const byId = new Map(plan.nodes.map((n) => [n.id, n]));
      return {
        unit: ctx.unit, seeded_from_save: seeded,
        groups: gp.groups.map((g) => ({
          name: g.name, planet: g.planet, valid_planets: g.fit, problems: g.problems,
          machines: g.machines, power_mw: r4(g.powerW / 1e6),
          members: g.members.map((id) => { const n = byId.get(id); return { kind: n.kind, name: n.name, machine: n.machine, machines: n.machinesCeil }; }),
          inputs_from_other_groups: g.inputs.map((i) => ({ item: i.item, from: i.from.replace(/^group:/, ''), rate: rate(i.rate) })),
          imports_from_other_planets: g.imports.map((i) => ({ item: i.item, from_planet: i.fromPlanet, rate: rate(i.rate) })),
          raw_mined_here: mapVals(g.raw, rate),
        })),
        transfers_between_planets: gp.transfers.map((t) => ({ item: t.item, from: t.from, to: t.to, rate: rate(t.rate) })),
        by_planet: gp.planets,
        group_ids: Object.fromEntries(gp.groups.map((g) => [g.id.replace(/^group:/, ''), g.name])),
        notes: ctx.warnings,
      };
    },
  },
  {
    name: 'compare_factory',
    description: 'Compare a plan with a real save. Needs export_path: a JSON file made by tools/export_save.py from a COPY of a save. Returns, per recipe or mine in the plan, planned and built machines and their status (working, starved, output full, low power, depleted), a trace of the inputs for starved machines, things built but not in the plan, and measured against planned production.',
    inputSchema: {
      type: 'object', required: ['targets', 'export_path'],
      properties: Object.assign({}, PLAN_PROPS, {
        export_path: { type: 'string', description: 'Path to export.json.' },
        surface: { type: 'string', description: 'Only count this surface, for example nauvis. Default all.' },
      }),
    },
    run: (a) => {
      const ctx = runPlan(a);
      const factory = loadExport(a.export_path);
      const surface = a.surface || '';
      if (surface && !factory.machines.some((g) => g.surface === surface)) throw new Error(`No machines on surface "${surface}". Surfaces: ${[...new Set(factory.machines.map((g) => g.surface))].join(', ')}`);
      const cmp = F.compare(ctx.plan, factory, surface);
      const rate = (v) => r4(v * ctx.mul);
      const label = (r) => (r.n.kind === 'mine' ? 'mine ' : '') + r.n.name;
      return {
        unit: ctx.unit, save_time_hours: r4(factory.tick / 60 / 3600), game_version: factory.gameVersion,
        note: 'Status is one snapshot from 300 ticks after loading. Measured production is the average of the last 10 game minutes.',
        recipes: cmp.rows.map((r) => {
          const o = { name: label(r), planned: r.planned, built: r.b.count, short_by: r.diff < 0 ? -r.diff : 0, status: F.statusText(r.b.cls) };
          if (r.b.cls.starved && r.n.kind === 'recipe') {
            o.starved_input_trace = F.trace(cmp.rows, r, data).map((t) => ({
              input: t.item,
              made_by: t.producers.map((p) => `${label(p)}: ${p.b.count} of ${p.planned} built (${F.statusText(p.b.cls)})`),
            }));
          }
          return o;
        }),
        built_not_in_plan: cmp.extra.slice(0, 20),
        production: Object.keys(cmp.planned).sort((x, y) => cmp.planned[y] - cmp.planned[x]).slice(0, 30)
          .map((i) => ({ item: i, planned: rate(cmp.planned[i]), measured: rate(cmp.measured[i] || 0) })),
        warnings: ctx.warnings.concat(factory.failures.length ? ['some export values could not be read: ' + factory.failures.join(', ')] : []),
      };
    },
  },
];
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

// ---------- JSON-RPC over stdio ----------
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER,
      instructions: 'Factorio 2.1 Space Age production planner. Use search_items for exact names, then plan. Rates default to per second; set unit for per_minute or per_hour. Plans cover machines, raw inputs, power and oil. propose_groups adds planet tags. compare_factory needs an export from tools/export_save.py.',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
  }
  if (method === 'tools/call') {
    const tool = params && toolByName.get(params.name);
    if (!tool) return fail(id, -32602, 'Unknown tool: ' + (params && params.name));
    try {
      const result = tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: String(e && e.message ? e.message : e) }], isError: true });
    }
  }
  if (!isRequest) return;                       // notifications such as notifications/initialized
  return fail(id, -32601, 'Method not found: ' + method);
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return fail(null, -32700, 'Parse error'); }
    try { handle(msg); } catch (e) { if (msg && msg.id !== undefined) fail(msg.id, -32603, 'Internal error: ' + e.message); }
  });
  rl.on('close', () => process.exit(0));
}
module.exports = { TOOLS, handle };
