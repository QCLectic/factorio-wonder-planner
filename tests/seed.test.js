/* Seed tests. Run: node tests/seed.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { solve } = require('../src/solver.js');
const G = require('../src/groups.js');
const S = require('../src/seed.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// A row of machines: n machines of one recipe, 4 tiles apart, starting at (x0, y0).
const row = (surface, recipe, n, x0, y0, extra) => Object.assign({
  surface, type: 'assembling-machine', recipe, miningTarget: '', count: n,
  pos: Array.from({ length: n }, (_, i) => [x0 + i * 4, y0]).flat(),
}, extra || {});
const drills = (surface, target, n, x0, y0) => row(surface, '', n, x0, y0, { type: 'mining-drill', miningTarget: target });

const plan = solve(data, { item: 'electronic-circuit', rate: 3, settings: { home: 'nauvis' } });
const base = G.propose(plan, 'chain', data);

test('components: points within EPS join, points far apart do not', () => {
  const c = S.components([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 16, y: 0 }, { x: 500, y: 500 }]);
  assert.deepStrictEqual(c.map((x) => x.length).sort(), [1, 3]);
});

test('split: a long block is cut until each part fits MAX_SPAN', () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ x: i * 8, y: 0 }));   // 792 tiles long
  const parts = S.split(pts);
  assert.ok(parts.length >= 5);
  for (const p of parts) assert.ok(Math.max(...p.map((q) => q.x)) - Math.min(...p.map((q) => q.x)) <= S.MAX_SPAN);
  assert.strictEqual(parts.reduce((s, p) => s + p.length, 0), 100);
});

test('two separate areas become two groups, each node goes to the area with most of its machines', () => {
  const f = { machines: [
    row('nauvis', 'electronic-circuit', 5, 0, 0), row('nauvis', 'copper-cable', 8, 0, 6),
    drills('nauvis', 'iron-ore', 6, 1000, 1000), row('nauvis', 'iron-plate', 6, 1000, 1008),
  ] };
  const { state, report } = S.seed(plan, f, base, data);
  assert.strictEqual(report.blocks, 2);
  assert.strictEqual(state.assign['recipe:electronic-circuit'], state.assign['recipe:copper-cable']);
  assert.strictEqual(state.assign['mine:iron-ore'], state.assign['recipe:iron-plate']);
  assert.notStrictEqual(state.assign['recipe:electronic-circuit'], state.assign['mine:iron-ore']);
  assert.ok(report.seeded >= 4);
});

test('a recipe built in two places goes where most of it is', () => {
  const f = { machines: [
    row('nauvis', 'iron-plate', 2, 0, 0), row('nauvis', 'copper-cable', 2, 0, 6),
    row('nauvis', 'iron-plate', 9, 2000, 0), row('nauvis', 'electronic-circuit', 2, 2000, 6),
  ] };
  const { state } = S.seed(plan, f, base, data);
  assert.strictEqual(state.assign['recipe:iron-plate'], state.assign['recipe:electronic-circuit']);
});

test('surfaces: a Vulcanus block gets the Vulcanus tag, a platform block gets space-platform', () => {
  const f = { machines: [row('vulcanus', 'copper-cable', 4, 0, 0), row('platform-1', 'iron-plate', 4, 0, 0), row('nauvis', 'electronic-circuit', 4, 0, 0)] };
  const { state } = S.seed(plan, f, base, data);
  assert.strictEqual(state.planet[state.assign['recipe:copper-cable']], 'vulcanus');
  assert.strictEqual(state.planet[state.assign['recipe:iron-plate']], 'space-platform');
  assert.strictEqual(state.planet[state.assign['recipe:electronic-circuit']], 'nauvis');
});

test('unbuilt nodes follow their seeded consumer, every non-external node stays grouped, names are unique', () => {
  const f = { machines: [row('nauvis', 'electronic-circuit', 3, 0, 0)] };
  const { state, report } = S.seed(plan, f, base, data);
  assert.ok(report.unbuilt > 0);
  assert.strictEqual(state.assign['recipe:copper-cable'], state.assign['recipe:electronic-circuit'], 'unbuilt node follows its seeded consumer');
  for (const n of plan.nodes) if (n.kind !== 'external') assert.ok(state.assign[n.id], n.id);
  const gp = G.groupPlan(plan, state, data);
  const names = gp.groups.map((g) => g.name);
  assert.strictEqual(new Set(names).size, names.length, 'duplicate names: ' + names);
  for (const g of gp.groups) assert.ok(g.members.length > 0);
});

test('a pump joins the seeded group of its consumer', () => {
  const p = solve(data, { item: 'sulfur', rate: 1, settings: { home: 'nauvis' } });
  const b = G.propose(p, 'chain', data);
  const f = { machines: [row('nauvis', 'sulfur', 4, 0, 0), drills('nauvis', 'crude-oil', 3, 2000, 0)] };
  const { state } = S.seed(p, f, b, data);
  assert.strictEqual(state.assign['pump:water'], state.assign['recipe:sulfur']);
});

test('eps option: a larger distance joins blocks that a smaller one keeps apart', () => {
  const f = { machines: [row('nauvis', 'electronic-circuit', 3, 0, 0), row('nauvis', 'copper-cable', 3, 0, 40)] };
  assert.notStrictEqual(S.seed(plan, f, base, data, { eps: 10 }).state.assign['recipe:copper-cable'], S.seed(plan, f, base, data, { eps: 10 }).state.assign['recipe:electronic-circuit']);
  const wide = S.seed(plan, f, base, data, { eps: 50 }).state;
  assert.strictEqual(wide.assign['recipe:copper-cable'], wide.assign['recipe:electronic-circuit']);
});

test('the base state is not changed', () => {
  const before = JSON.stringify(base);
  S.seed(plan, { machines: [row('nauvis', 'electronic-circuit', 3, 0, 0)] }, base, data);
  assert.strictEqual(JSON.stringify(base), before);
});

test('an empty factory seeds nothing and keeps the base', () => {
  const { state, report } = S.seed(plan, { machines: [] }, base, data);
  assert.strictEqual(report.groups, 0);
  assert.deepStrictEqual(state.assign, base.assign);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
