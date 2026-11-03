/* Layout tests. Run: node tests/layout.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { solve } = require('../src/solver.js');
const { layout } = require('../src/layout.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));
const NAUVIS_RAW = ['iron-ore', 'copper-ore', 'coal', 'stone', 'crude-oil', 'water', 'uranium-ore'];

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function check(item, rate) {
  const plan = solve(data, { item, rate, settings: { allowedRaw: NAUVIS_RAW } });
  assert.ok(plan.ok, item + ' did not solve');
  const L = layout(plan);
  const ids = new Set(L.nodes.map((n) => n.id));
  assert.strictEqual(L.edges.length, plan.links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to).length, 'edge count');
  // No two boxes overlap.
  for (let i = 0; i < L.nodes.length; i++) for (let j = i + 1; j < L.nodes.length; j++) {
    const a = L.nodes[i], b = L.nodes[j];
    const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.ok(!hit, `overlap ${a.id} / ${b.id}`);
  }
  // Every box sits inside the canvas.
  for (const n of L.nodes) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= L.width && n.y + n.h <= L.height, 'outside ' + n.id);
  // Forward edges point right. Only cycle edges may point left.
  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  const backCount = L.edges.filter((e) => e.back).length;
  for (const e of L.edges) if (!e.back) assert.ok(byId.get(e.link.to).rank > byId.get(e.link.from).rank, `rank order ${e.link.from} > ${e.link.to}`);
  return { plan, L, backCount };
}

test('gear: three boxes (ore, plate, gear) plus target', () => {
  const { L } = check('iron-gear-wheel', 1);
  assert.strictEqual(L.nodes.length, 4);
});
test('chemical science: no overlaps, ranks ordered, no cycles', () => {
  const { backCount } = check('chemical-science-pack', 1);
  assert.strictEqual(backCount, 0);
});
test('Kovarex plan has a self-link (loop on one node) and still lays out', () => {
  const { plan } = check('uranium-235', 1);
  assert.ok(plan.links.some((l) => l.from === l.to), 'expected a self-link');
});
test('oil plan with cracking lays out', () => check('plastic-bar', 2));
test('sweep: every item lays out without error', () => {
  const bad = [];
  for (const name of Object.keys(data.items)) {
    const plan = solve(data, { item: name, rate: 1, settings: { allowedRaw: NAUVIS_RAW } });
    if (!plan.ok) continue;
    try { layout(plan); } catch (e) { bad.push(name + ':' + e.message); }
  }
  assert.deepStrictEqual(bad, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
