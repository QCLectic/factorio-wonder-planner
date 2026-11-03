/* Group tests. Run: node tests/groups.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { solve } = require('../src/solver.js');
const { layout } = require('../src/layout.js');
const G = require('../src/groups.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));
const NAUVIS_RAW = ['iron-ore', 'copper-ore', 'coal', 'stone', 'crude-oil', 'water', 'uranium-ore'];

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const plan = (item, rate) => solve(data, { item, rate, settings: { allowedRaw: NAUVIS_RAW } });
const sum = (a) => a.reduce((s, x) => s + x, 0);

for (const rule of ['chain', 'category']) {
  test(`${rule}: every non-external node is in exactly one group, no empty groups, names unique`, () => {
    for (const item of ['chemical-science-pack', 'uranium-235', 'rocket-part', 'iron-gear-wheel']) {
      const p = plan(item, 1);
      assert.ok(p.ok, item);
      const s = G.propose(p, rule, data);
      for (const n of p.nodes) {
        if (n.kind === 'external') assert.ok(!s.assign[n.id], 'external grouped ' + n.id);
        else assert.ok(s.assign[n.id], `${item}: ${n.id} ungrouped`);
      }
      const used = new Set(Object.values(s.assign));
      assert.deepStrictEqual([...used].sort(), [...s.order].sort(), 'empty or unknown group');
      const names = Object.values(s.names);
      assert.strictEqual(new Set(names).size, names.length, 'duplicate names');
    }
  });

  test(`${rule}: group links keep the flow. Rate across group borders equals the node-level rate`, () => {
    const p = plan('chemical-science-pack', 1);
    const s = G.propose(p, rule, data);
    const gp = G.groupPlan(p, s);
    const cross = p.links.filter((l) => (s.assign[l.from] || l.from) !== (s.assign[l.to] || l.to));
    near(sum(gp.plan.links.map((l) => l.rate)), sum(cross.map((l) => l.rate)));
    // The target still receives 1 per second.
    near(sum(gp.plan.links.filter((l) => l.to === 'target').map((l) => l.rate)), 1);
    // Group machine totals add up to the plan total.
    near(sum(gp.groups.map((g) => g.machines)), sum(p.nodes.map((n) => n.machinesCeil || 0)));
    near(sum(gp.groups.map((g) => g.powerW)), p.powerW, 1e-6);
  });

  test(`${rule}: group plan lays out`, () => {
    const p = plan('chemical-science-pack', 1);
    const gp = G.groupPlan(p, G.propose(p, rule, data));
    const L = layout(gp.plan);
    assert.ok(L.nodes.length >= 2);
  });
}

function near(a, b, tol) {
  assert.ok(Math.abs(a - b) <= Math.max((tol || 1e-9) * Math.abs(b), 1e-6), `expected ${b}, got ${a}`);
}

test('chain rule on chemical science: a shared item like iron plate gets its own group', () => {
  const p = plan('chemical-science-pack', 1);
  const s = G.propose(p, 'chain', data);
  const main = s.assign['recipe:chemical-science-pack'];
  assert.notStrictEqual(s.assign['recipe:iron-plate'], main, 'iron plate has 4 consumers, so it is a head');
  assert.strictEqual(s.assign['mine:iron-ore'], s.assign['recipe:iron-plate'], 'ore joins its smelter group');
  assert.strictEqual(s.assign['recipe:sulfur'], main, 'sulfur has one consumer: the pack recipe');
});

test('manual edits survive: moving a node changes the aggregate, and reconcile drops dead nodes', () => {
  const p = plan('chemical-science-pack', 1);
  const s = G.propose(p, 'chain', data);
  const before = G.groupPlan(p, s).groups.length;
  s.assign['recipe:sulfur'] = 'g_new'; s.names.g_new = 'Sulfur'; s.order.push('g_new');
  const after = G.groupPlan(p, s);
  assert.strictEqual(after.groups.length, before + 1);
  s.assign['recipe:ghost'] = 'g1';
  assert.ok(!('recipe:ghost' in G.reconcile(p, s).assign));
});

// ---- Planets (step 7) ----
const solveHome = (item) => solve(data, { item, rate: 1, settings: { home: 'nauvis' } });

test('nodeProblem: metallurgic science needs Vulcanus pressure, iron ore is not on Vulcanus', () => {
  const foundry = { kind: 'recipe', name: 'metallurgic-science-pack', machine: 'foundry' };
  assert.ok(G.nodeProblem(data, foundry, 'nauvis'));
  assert.strictEqual(G.nodeProblem(data, foundry, 'vulcanus'), null);
  const ore = { kind: 'mine', name: 'iron-ore', machine: 'electric-mining-drill' };
  assert.strictEqual(G.nodeProblem(data, ore, 'nauvis'), null);
  assert.ok(G.nodeProblem(data, ore, 'vulcanus'));
  assert.ok(G.nodeProblem(data, { kind: 'pump', name: 'water', machine: 'offshore-pump' }, 'vulcanus'));
});

test('metallurgic science: pack group lands on Vulcanus, no group has problems, imports match cross links', () => {
  const p = solveHome('metallurgic-science-pack');
  assert.ok(p.ok);
  for (const rule of ['chain', 'category']) {
    const gp = G.groupPlan(p, G.propose(p, rule, data), data);
    const pack = gp.groups.find((g) => g.members.includes('recipe:metallurgic-science-pack'));
    assert.strictEqual(pack.planet, 'vulcanus');
    for (const g of gp.groups) assert.deepStrictEqual(g.problems, [], `${rule}: ${g.name} on ${g.planet}`);
    const cross = gp.plan.links.filter((l) => l.cross);
    assert.ok(cross.length > 0, 'ores and acid come from Nauvis');
    near(sum(gp.transfers.map((t) => t.rate)), sum(cross.map((l) => l.rate)));
    for (const g of gp.groups) near(sum(g.imports.map((i) => i.rate)), sum(cross.filter((l) => l.to === g.id).map((l) => l.rate)));
  }
});

test('a user planet choice is kept, flagged as not valid, and survives reconcile', () => {
  const p = solveHome('chemical-science-pack');
  const s = G.propose(p, 'chain', data);
  const gid = s.assign['recipe:iron-plate'];
  s.planet[gid] = 'vulcanus';
  const g = G.groupPlan(p, s, data).groups.find((x) => x.gid === gid);
  assert.strictEqual(g.planet, 'vulcanus');
  assert.ok(g.planetSet);
  assert.ok(g.problems.length > 0, 'iron ore is not on Vulcanus');
  assert.strictEqual(G.reconcile(p, s).planet[gid], 'vulcanus');
});

test('single-planet plan: no transfers, every group on that planet', () => {
  const p = solve(data, { item: 'chemical-science-pack', rate: 1, settings: { planet: 'nauvis' } });
  const gp = G.groupPlan(p, G.propose(p, 'chain', data), data, { prefer: 'nauvis' });
  assert.deepStrictEqual(gp.transfers, []);
  assert.ok(gp.groups.every((g) => g.planet === 'nauvis'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
