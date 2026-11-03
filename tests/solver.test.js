/* Solver tests. Run: node tests/solver.test.js
 * Expected values are worked out by hand from the game rules (recipe times and amounts
 * from the Factorio wiki), not copied from solver output.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { solve } = require('../src/solver.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));
// Nauvis raw resources, from game knowledge. The data-based planet mapping comes in step 7.
const NAUVIS_RAW = ['iron-ore', 'copper-ore', 'coal', 'stone', 'crude-oil', 'water', 'uranium-ore'];

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function near(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) <= Math.max(tol * Math.abs(expected), 1e-6);
  assert.ok(ok, `${label || ''} expected ${expected}, got ${actual}`);
}
function nodeOf(plan, id) {
  const n = plan.nodes.find((x) => x.id === id);
  assert.ok(n, 'missing node ' + id);
  return n;
}

const AM2 = 'assembling-machine-2';       // crafting speed 0.75
const asAM2 = (recipes) => Object.fromEntries(recipes.map((r) => [r, AM2]));

console.log('basic ratios');
test('iron gear wheel: 2 plates per gear, 0.5 s craft in AM2', () => {
  const p = solve(data, { item: 'iron-gear-wheel', rate: 1, settings: { allowedRaw: NAUVIS_RAW, machines: asAM2(['iron-gear-wheel']) } });
  assert.ok(p.ok);
  near(nodeOf(p, 'recipe:iron-gear-wheel').machines, 0.5 / 0.75, 1e-9, 'gear machines');
  near(nodeOf(p, 'recipe:iron-plate').outputs['iron-plate'], 2, 1e-9, 'iron plate/s');
  near(p.raw['iron-ore'], 2, 1e-9, 'iron ore/s');
});

test('electronic circuit: 1 iron + 3 cable (1.5 copper) each; AM2 counts', () => {
  const p = solve(data, { item: 'electronic-circuit', rate: 1, settings: {
    allowedRaw: NAUVIS_RAW, machines: asAM2(['electronic-circuit', 'copper-cable']) } });
  assert.ok(p.ok);
  near(nodeOf(p, 'recipe:electronic-circuit').machines, 0.5 / 0.75, 1e-9, 'circuit machines');
  near(nodeOf(p, 'recipe:copper-cable').machines, 0.75 / 0.75, 1e-9, 'cable machines');
  near(p.raw['iron-ore'], 1, 1e-9, 'iron ore');
  near(p.raw['copper-ore'], 1.5, 1e-9, 'copper ore');
});

test('electric furnace (speed 2) smelts iron plate (3.2 s) at 1/s with 1.6 furnaces', () => {
  const p = solve(data, { item: 'iron-plate', rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(p.ok);
  const n = nodeOf(p, 'recipe:iron-plate');
  assert.strictEqual(n.machine, 'electric-furnace');
  near(n.machines, 1.6, 1e-9, 'furnaces');
  near(n.powerW, 1.6 * 180000, 1e-9, 'furnace power');
});

test('automation science: 5 s craft, 6.67 AM2 per 1/s', () => {
  const p = solve(data, { item: 'automation-science-pack', rate: 1, settings: {
    allowedRaw: NAUVIS_RAW, machines: asAM2(['automation-science-pack', 'iron-gear-wheel']) } });
  assert.ok(p.ok);
  near(nodeOf(p, 'recipe:automation-science-pack').machines, 5 / 0.75, 1e-9, 'science machines');
  near(p.raw['copper-ore'], 1, 1e-9, 'copper ore');
  near(p.raw['iron-ore'], 2, 1e-9, 'iron ore');
});

console.log('productivity and speed');
test('productivity +40% and speed -60% on circuits (4 prod modules 3 by dump values)', () => {
  const p = solve(data, { item: 'electronic-circuit', rate: 1, settings: {
    allowedRaw: NAUVIS_RAW, machines: asAM2(['electronic-circuit']),
    bonuses: { 'electronic-circuit': { productivity: 0.4, speed: -0.6 } } } });
  assert.ok(p.ok);
  const n = nodeOf(p, 'recipe:electronic-circuit');
  near(n.craftsPerSecond, 1 / 1.4, 1e-9, 'crafts/s');
  near(n.machines, (1 / 1.4) * 0.5 / (0.75 * 0.4), 1e-9, 'machines');
  near(p.raw['iron-ore'], 1 / 1.4, 1e-9, 'iron ore');
});

test('productivity is ignored for recipes that do not allow it', () => {
  const r = data.recipes['iron-plate'];
  assert.ok(!r.allow_productivity !== undefined);
  const p = solve(data, { item: 'iron-gear-wheel', rate: 1, settings: {
    allowedRaw: NAUVIS_RAW, bonuses: { 'iron-gear-wheel': { productivity: 0.5 } } } });
  assert.ok(p.ok);
  near(nodeOf(p, 'recipe:iron-gear-wheel').craftsPerSecond, 1 / 1.5, 1e-9, 'gear allows prod');
});

console.log('probability, byproducts, loops');
test('uranium: Kovarex loop is cheaper than raw processing and the solver finds it', () => {
  const p = solve(data, { item: 'uranium-235', rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(p.ok);
  assert.ok(nodeOf(p, 'recipe:kovarex-enrichment-process'));
  // Per Kovarex craft x: +1 U-235, -3 U-238. Processing y crafts gives 0.007 U-235 and 0.993 U-238 each.
  //   U-238: 0.993 y = 3 x      U-235: x + 0.007 y = 1      ore = 10 y
  const x = 1 / (1 + 0.007 * 3 / 0.993);
  near(p.raw['uranium-ore'], 10 * 3 * x / 0.993, 1e-6, 'ore/s');
  near(nodeOf(p, 'recipe:kovarex-enrichment-process').craftsPerSecond, x, 1e-6, 'kovarex crafts/s');
});

test('uranium-processing alone: 0.7% U-235 per craft, 10 ore per craft', () => {
  const p = solve(data, { item: 'uranium-235', rate: 1, settings: {
    allowedRaw: NAUVIS_RAW, disabledRecipes: ['kovarex-enrichment-process'] } });
  assert.ok(p.ok);
  near(p.raw['uranium-ore'], 10 / 0.007, 1e-6, 'ore/s');
});

test('oil: 100 PG/s uses advanced processing with full cracking (no heavy/light surplus)', () => {
  const p = solve(data, { item: 'petroleum-gas', rate: 100, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(p.ok);
  // Per 100 crude: 55 PG + (45 light + 25 heavy*0.75) * 2/3 = 97.5 PG.
  near(p.raw['crude-oil'], 100 / 97.5 * 100, 1e-3, 'crude/s');
  assert.ok(!p.surplus['heavy-oil'] && !p.surplus['light-oil'], 'unbalanced: ' + JSON.stringify(p.surplus));
});

console.log('flows and bookkeeping');
test('link rates add up: every node input is fully supplied', () => {
  const p = solve(data, { item: 'chemical-science-pack', rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(p.ok);
  for (const n of p.nodes) for (const [item, need] of Object.entries(n.inputs)) {
    const got = p.links.filter((l) => l.to === n.id && l.item === item).reduce((s, l) => s + l.rate, 0);
    near(got, need, 1e-6, `${n.id} input ${item}`);
  }
  const toTarget = p.links.filter((l) => l.to === 'target').reduce((s, l) => s + l.rate, 0);
  near(toTarget, 1, 1e-6, 'target');
});

test('mining: electric drill 0.5 ore/s each', () => {
  const p = solve(data, { item: 'iron-ore', rate: 1, settings: { allowedRaw: NAUVIS_RAW,
    machines: { 'mine:iron-ore': 'electric-mining-drill' } } });
  assert.ok(p.ok);
  near(nodeOf(p, 'mine:iron-ore').machines, 2, 1e-9, 'drills');
});

test('unknown machine for a recipe falls back to default with a note', () => {
  const p = solve(data, { item: 'iron-gear-wheel', rate: 1, settings: { allowedRaw: NAUVIS_RAW,
    machines: { 'iron-gear-wheel': 'chemical-plant' } } });
  assert.ok(p.ok);
  assert.ok(p.notes.some((n) => n.includes('chemical-plant')));
});

test('an item with a recipe is made, not imported, when an ingredient has no source', () => {
  const p = solve(data, { item: 'shotgun', rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(p.ok);
  assert.ok(nodeOf(p, 'recipe:shotgun'));
  near(p.external['wood'], 5, 1e-9, 'wood external');
  assert.ok(!p.external['shotgun']);
});

test('default-off alternates stay off; enabledRecipes turns one on', () => {
  const off = solve(data, { item: 'iron-plate', rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(!off.nodes.some((n) => n.name.startsWith('casting-')));
  const on = solve(data, { item: 'iron-gear-wheel', rate: 1, settings: {
    allowedRaw: NAUVIS_RAW, disabledRecipes: ['iron-gear-wheel'],
    enabledRecipes: ['casting-iron-gear-wheel'] } });
  assert.ok(on.ok);
  assert.ok(nodeOf(on, 'recipe:casting-iron-gear-wheel'), 'foundry casting used when enabled');
  assert.strictEqual(nodeOf(on, 'recipe:casting-iron-gear-wheel').machine, 'foundry');
});

console.log('machine tiers and research');
test('category default sets the tier; a per-recipe override beats it', () => {
  const cat = { crafting: 'assembling-machine-1' };   // speed 0.5: 0.5 s gear at 1/s = 1 machine
  const a = solve(data, { item: 'iron-gear-wheel', rate: 1, settings: { allowedRaw: NAUVIS_RAW, machineByCategory: cat } });
  assert.ok(a.ok);
  assert.strictEqual(nodeOf(a, 'recipe:iron-gear-wheel').machine, 'assembling-machine-1');
  near(nodeOf(a, 'recipe:iron-gear-wheel').machines, 1, 1e-9, 'AM1 gear machines');
  const b = solve(data, { item: 'iron-gear-wheel', rate: 1, settings: { allowedRaw: NAUVIS_RAW, machineByCategory: cat, machines: asAM2(['iron-gear-wheel']) } });
  near(nodeOf(b, 'recipe:iron-gear-wheel').machines, 0.5 / 0.75, 1e-9, 'AM2 override');
});

test('smelting category default: stone furnace (speed 1) gives 3.2 per plate/s', () => {
  const p = solve(data, { item: 'iron-plate', rate: 1, settings: { allowedRaw: NAUVIS_RAW, machineByCategory: { smelting: 'stone-furnace' } } });
  near(nodeOf(p, 'recipe:iron-plate').machines, 3.2, 1e-9, 'stone furnace speed 1');
});

test('research limits the default machine to unlocked tiers', () => {
  assert.strictEqual(data.recipes['assembling-machine-2'].enabled, false, 'data assumption');
  const mk = (researched) => solve(data, { item: 'iron-gear-wheel', rate: 1, settings: { allowedRaw: NAUVIS_RAW, researched } });
  assert.strictEqual(nodeOf(mk(['automation']), 'recipe:iron-gear-wheel').machine, 'assembling-machine-1');
  assert.strictEqual(nodeOf(mk(['automation', 'automation-2']), 'recipe:iron-gear-wheel').machine, 'assembling-machine-2');
  const f = solve(data, { item: 'iron-plate', rate: 1, settings: { allowedRaw: NAUVIS_RAW, researched: [] } });
  assert.strictEqual(nodeOf(f, 'recipe:iron-plate').machine, 'stone-furnace');
});

test('drill default: big mining drill (speed 2.5) needs 0.4 per ore/s', () => {
  const p = solve(data, { item: 'iron-ore', rate: 1, settings: { allowedRaw: NAUVIS_RAW, drill: 'big-mining-drill' } });
  near(nodeOf(p, 'mine:iron-ore').machines, 0.4, 1e-9, 'big drills');
});

console.log('oil balancing');
const CRACK = ['heavy-oil-cracking', 'light-oil-cracking'];
test('basic processing only: 45 PG per 100 crude, no byproducts', () => {
  const p = solve(data, { item: 'petroleum-gas', rate: 45, settings: { allowedRaw: NAUVIS_RAW, disabledRecipes: ['advanced-oil-processing'] } });
  assert.ok(p.ok);
  near(p.raw['crude-oil'], 100, 1e-6, 'crude/s');
  assert.deepStrictEqual(p.surplus, {});
});

test('advanced processing without cracking: 55 PG/s leaves 25 heavy and 45 light per 100 crude', () => {
  const p = solve(data, { item: 'petroleum-gas', rate: 55, settings: { allowedRaw: NAUVIS_RAW,
    disabledRecipes: ['basic-oil-processing'].concat(CRACK) } });
  assert.ok(p.ok);
  near(p.raw['crude-oil'], 100, 1e-6, 'crude/s');
  near(p.surplus['heavy-oil'], 25, 1e-6, 'heavy surplus');
  near(p.surplus['light-oil'], 45, 1e-6, 'light surplus');
});

test('lubricant 1/s needs 1 heavy/s: 4 crude/s via advanced processing, rest is surplus', () => {
  const p = solve(data, { item: 'lubricant', rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(p.ok);
  near(p.raw['crude-oil'], 4, 1e-6, 'crude/s');
  near(p.surplus['light-oil'], 1.8, 1e-6, 'light surplus');
  near(p.surplus['petroleum-gas'], 2.2, 1e-6, 'PG surplus');
});

test('PG 100/s with cracking: balanced by the LP, same as the closed-form 97.5 PG per 100 crude', () => {
  const p = solve(data, { item: 'petroleum-gas', rate: 100, settings: { allowedRaw: NAUVIS_RAW } });
  near(p.raw['crude-oil'], 100 / 97.5 * 100, 1e-3, 'crude/s');
  near(nodeOf(p, 'recipe:advanced-oil-processing').craftsPerSecond, 1.0256410256, 1e-5, 'refinery crafts/s');
});

console.log('modules, beacons, quality');
const AM3 = 'assembling-machine-3';   // speed 1.25, 4 module slots, 375 kW
const circ = (mods, extra) => solve(data, { item: 'electronic-circuit', rate: 1, settings: Object.assign({
  allowedRaw: NAUVIS_RAW, machines: { 'electronic-circuit': AM3 }, mods }, extra || {}) });

test('4 speed modules (+20% each, +50% power each) in an AM3', () => {
  const n = nodeOf(circ({ module: 'speed-module', quality: 'normal' }), 'recipe:electronic-circuit');
  near(n.machines, 0.5 / (1.25 * 1.8), 1e-9, 'machines');
  near(n.powerW, n.machines * 375000 * 3, 1e-9, 'power');
});

test('4 productivity modules 3: +40% output, -60% speed', () => {
  const n = nodeOf(circ({ module: 'productivity-module-3' }), 'recipe:electronic-circuit');
  near(n.craftsPerSecond, 1 / 1.4, 1e-9, 'crafts/s');
  near(n.machines, (1 / 1.4) * 0.5 / (1.25 * 0.4), 1e-9, 'machines');
});

test('module quality scales only the good side: rare speed module = +32%, power stays +50%', () => {
  const n = nodeOf(circ({ module: 'speed-module', quality: 'rare' }), 'recipe:electronic-circuit');
  near(n.machines, 0.5 / (1.25 * (1 + 4 * 0.32)), 1e-9, 'machines');
  near(n.powerW, n.machines * 375000 * 3, 1e-9, 'power');
});

test('8 beacons with 2 speed modules: sqrt(8) scaling, 1.5 effectivity, 480 kW each', () => {
  const p = circ({ beacons: 8, bModule: 'speed-module' });
  const n = nodeOf(p, 'recipe:electronic-circuit');
  const bonus = 2 * 0.2 * 1.5 * Math.sqrt(8);
  near(n.machines, 0.5 / (1.25 * (1 + bonus)), 1e-3, 'machines');
  // The beacon speed modules also add +50% consumption each to the machine, scaled like speed.
  const consBonus = 2 * 0.5 * 1.5 * Math.sqrt(8);
  near(n.powerW, n.machines * (375000 * (1 + consBonus) + 8 * 480000 * 2), 1e-3, 'power with beacons');
});

test('productivity modules cannot go in beacons', () => {
  const n = nodeOf(circ({ beacons: 2, bModule: 'productivity-module-3' }), 'recipe:electronic-circuit');
  assert.strictEqual(n.productivity, 0);
});

test('machine quality: legendary AM2 is 2.5x faster (+30% per level, wiki value)', () => {
  const p = solve(data, { item: 'iron-gear-wheel', rate: 1, settings: { allowedRaw: NAUVIS_RAW,
    machines: asAM2(['iron-gear-wheel']), mods: { machineQuality: 'legendary' } } });
  near(nodeOf(p, 'recipe:iron-gear-wheel').machines, 0.5 / (0.75 * 2.5), 1e-9, 'machines');
});

test('per-node modules replace the global spec', () => {
  const p = circ({ module: 'speed-module' }, { nodeMods: { 'electronic-circuit': { module: 'productivity-module-3' } } });
  near(nodeOf(p, 'recipe:electronic-circuit').productivity, 0.4, 1e-9, 'productivity');
});

test('defaultOn: casting is off, iron plate is on', () => {
  assert.strictEqual(require('../src/solver.js').defaultOn('casting-iron', data.recipes['casting-iron']), false);
  assert.strictEqual(require('../src/solver.js').defaultOn('iron-plate', data.recipes['iron-plate']), true);
});

console.log('sweep: every craftable item solves');
test('no infeasible or failed solves for any item (Nauvis raw set)', () => {
  const t0 = Date.now();
  const bad = [];
  let tried = 0, solved = 0;
  for (const [name, it] of Object.entries(data.items)) {
    if (it.hidden) continue;
    tried++;
    try {
      const p = solve(data, { item: name, rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
      if (p.ok) solved++; else bad.push(name + ':' + p.status);
    } catch (e) { bad.push(name + ':' + e.message); }
  }
  const ms = Date.now() - t0;
  console.log(`       tried ${tried}, solved ${solved}, ${ms} ms total`);
  assert.deepStrictEqual(bad, [], 'failures: ' + bad.slice(0, 20).join(', '));
});

// ---- Planets (step 7) ----
test('planet = vulcanus: no iron ore mine, tungsten and calcite are minable', () => {
  const p = solve(data, { item: 'tungsten-plate', rate: 1, settings: { planet: 'vulcanus' } });
  assert.ok(p.ok);
  assert.ok(!p.nodes.some((n) => n.id === 'mine:iron-ore'), 'iron ore is not on Vulcanus');
  assert.ok(p.nodes.some((n) => n.id === 'mine:tungsten-ore'));
  assert.ok(p.nodes.some((n) => n.id === 'mine:calcite'));
});

test('planet = nauvis: tungsten ore is external, not mined', () => {
  const p = solve(data, { item: 'tungsten-plate', rate: 1, settings: { planet: 'nauvis' } });
  assert.ok(p.ok);
  assert.ok(!p.nodes.some((n) => n.id === 'mine:tungsten-ore'));
  assert.ok(p.external['tungsten-ore'] > 0);
});

test('pump fluids follow planet tiles: water on Nauvis only, heavy oil on Fulgora, lava on Vulcanus', () => {
  const list = (planet) => {
    const pl = data.planets[planet];
    return Object.entries(data.pumpable_fluids).filter(([, tiles]) => tiles.some((t) => pl.tiles.includes(t))).map(([f]) => f);
  };
  assert.deepStrictEqual(list('nauvis'), ['water']);
  assert.ok(list('fulgora').includes('heavy-oil'));
  assert.ok(list('vulcanus').includes('lava'));
  const p = solve(data, { item: 'chemical-science-pack', rate: 1, settings: { planet: 'nauvis' } });
  assert.ok(!p.nodes.some((n) => n.id === 'pump:heavy-oil'));
});

test('home = nauvis: chemical science does not pump heavy oil from a Fulgora ocean', () => {
  const home = solve(data, { item: 'chemical-science-pack', rate: 1, settings: { home: 'nauvis' } });
  assert.ok(home.ok);
  assert.ok(!home.nodes.some((n) => n.id === 'pump:heavy-oil'), 'home plan should use refining');
});

test('home = nauvis still mines off-world resources when nothing at home makes them', () => {
  const p = solve(data, { item: 'tungsten-plate', rate: 1, settings: { home: 'nauvis' } });
  assert.ok(p.ok);
  assert.ok(p.nodes.some((n) => n.id === 'mine:tungsten-ore'));
  assert.deepStrictEqual(Object.keys(p.external), []);
});

// ---- Several targets ----
test('two targets: raw inputs equal the sum of the separate plans, and each gets a link to the target', () => {
  const s = { home: 'nauvis' };
  const both = solve(data, { targets: [{ item: 'electronic-circuit', rate: 2 }, { item: 'iron-gear-wheel', rate: 3 }], settings: s });
  const a = solve(data, { item: 'electronic-circuit', rate: 2, settings: s });
  const b = solve(data, { item: 'iron-gear-wheel', rate: 3, settings: s });
  assert.ok(both.ok);
  near(both.raw['iron-ore'], a.raw['iron-ore'] + b.raw['iron-ore'], 1e-9, 'iron ore');
  near(both.raw['copper-ore'], a.raw['copper-ore'], 1e-9, 'copper ore');
  const into = Object.fromEntries(both.links.filter((l) => l.to === 'target').map((l) => [l.item, l.rate]));
  near(into['electronic-circuit'], 2, 1e-9);
  near(into['iron-gear-wheel'], 3, 1e-9);
  assert.deepStrictEqual(both.targets, { 'electronic-circuit': 2, 'iron-gear-wheel': 3 });
});

test('a target that is also an ingredient of another target is not double counted', () => {
  const p = solve(data, { targets: [{ item: 'iron-plate', rate: 1 }, { item: 'iron-gear-wheel', rate: 1 }], settings: {} });
  near(p.raw['iron-ore'], 3, 1e-9, 'iron ore: 1 plate + 1 gear (2 plates)');
  assert.deepStrictEqual(p.surplus, {});
});

test('a repeated target item adds up, and the old single-target call still works', () => {
  const p = solve(data, { targets: [{ item: 'iron-plate', rate: 1 }, { item: 'iron-plate', rate: 2 }], settings: {} });
  near(p.targets['iron-plate'], 3, 1e-9);
  const q = solve(data, { item: 'iron-plate', rate: 3, settings: {} });
  near(q.raw['iron-ore'], p.raw['iron-ore'], 1e-9);
  assert.strictEqual(q.target, 'iron-plate');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
