/* MCP server tests: start the real server and talk to it over stdio. Run: node tests/mcp.test.js */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const proc = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
const stray = [];
readline.createInterface({ input: proc.stdout }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch (e) { stray.push(line); return; }
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.result.content[0].text;
  return { isError: !!r.result.isError, text, json: r.result.isError ? null : JSON.parse(text) };
};
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= (tol || 1e-3) * Math.max(1, Math.abs(b)), `expected ${b}, got ${a}`);

test('initialize and tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.strictEqual(init.result.serverInfo.name, 'factorio-planner');
  assert.ok(init.result.capabilities.tools);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list');
  assert.deepStrictEqual(list.result.tools.map((t) => t.name).sort(), ['compare_factory', 'get_recipe', 'plan', 'propose_groups', 'search_items']);
  for (const t of list.result.tools) { assert.strictEqual(t.inputSchema.type, 'object'); assert.ok(t.description.length > 20); }
});

test('search_items takes display names and partial names', async () => {
  const r = await call('search_items', { query: 'chemical science' });
  assert.strictEqual(r.json.matches[0].id, 'chemical-science-pack');
});

test('plan: gear wheel at 1 per second needs 2 iron ore per second and 1 assembler', async () => {
  const r = await call('plan', { targets: [{ item: 'Iron gear wheel', rate: 1 }] });
  near(r.json.raw_inputs['iron-ore'], 2);
  assert.strictEqual(r.json.nodes.find((n) => n.name === 'iron-gear-wheel').machines, 1);
});

test('plan: the unit changes the numbers, not the plan', async () => {
  const s = await call('plan', { targets: [{ item: 'iron-gear-wheel', rate: 1 }], unit: 'per_second' });
  const m = await call('plan', { targets: [{ item: 'iron-gear-wheel', rate: 60 }], unit: 'per_minute' });
  near(m.json.raw_inputs['iron-ore'], s.json.raw_inputs['iron-ore'] * 60);
  assert.deepStrictEqual(m.json.machine_totals, s.json.machine_totals);
});

test('plan: two targets share ingredients', async () => {
  const r = await call('plan', { targets: [{ item: 'iron-plate', rate: 1 }, { item: 'iron-gear-wheel', rate: 1 }] });
  near(r.json.raw_inputs['iron-ore'], 3);
});

test('plan: machine and module settings change the count', async () => {
  const base = await call('plan', { targets: [{ item: 'electronic-circuit', rate: 10 }] });
  const fast = await call('plan', { targets: [{ item: 'electronic-circuit', rate: 10 }], settings: { machines: { 'electronic-circuit': 'electromagnetic-plant' }, mods: { module: 'speed-module-3' } } });
  const n = (r) => r.json.nodes.find((x) => x.name === 'electronic-circuit');
  assert.ok(n(fast).machines_exact < n(base).machines_exact);
  assert.strictEqual(n(fast).machine, 'electromagnetic-plant');
});

test('plan: unknown names come back as errors with suggestions, not crashes', async () => {
  const bad = await call('plan', { targets: [{ item: 'chemcal science', rate: 1 }] });
  assert.ok(bad.isError);
  assert.ok(/not found/.test(bad.text));
  const zero = await call('plan', { targets: [{ item: 'iron-plate', rate: 0 }] });
  assert.ok(zero.isError);
  const warn = await call('plan', { targets: [{ item: 'iron-plate', rate: 1 }], settings: { machines: { 'iron-plate': 'no-such-machine' }, planet: 'mars' } });
  assert.ok(warn.json.notes.some((x) => /no-such-machine/.test(x)));
  assert.ok(warn.json.notes.some((x) => /mars/.test(x)));
});

test('plan: one planet only turns off other planets resources', async () => {
  const r = await call('plan', { targets: [{ item: 'tungsten-plate', rate: 1 }], settings: { planet: 'nauvis' } });
  assert.ok(r.json.external_inputs_no_modeled_source['tungsten-ore'] > 0);
});

test('get_recipe: recipe name and item name', async () => {
  const r = await call('get_recipe', { name: 'casting-pipe' });
  assert.strictEqual(r.json.recipes[0].results[0].name, 'pipe');
  assert.strictEqual(r.json.recipes[0].allow_productivity, false);
  const item = await call('get_recipe', { name: 'iron-plate' });
  assert.ok(item.json.recipes.length >= 1);
  assert.ok((await call('get_recipe', { name: 'zzzz' })).isError);
});

test('propose_groups: Vulcanus pack group and imports between planets', async () => {
  const r = await call('propose_groups', { targets: [{ item: 'metallurgic-science-pack', rate: 1 }] });
  const pack = r.json.groups.find((g) => g.members.some((m) => m.name === 'metallurgic-science-pack'));
  assert.strictEqual(pack.planet, 'vulcanus');
  assert.ok(r.json.transfers_between_planets.length > 0);
  for (const g of r.json.groups) assert.deepStrictEqual(g.problems, []);
});

function exportFile() {
  const f = {
    version: 1, tick: 3600 * 60 * 10, game_version: '2.1.24', failures: {},
    machines: [
      { surface: 'nauvis', name: 'assembling-machine-3', type: 'assembling-machine', quality: 'normal', recipe: 'iron-gear-wheel', count: 1, status: { item_ingredient_shortage: 1 }, pos: [0, 0] },
      { surface: 'nauvis', name: 'stone-furnace', type: 'furnace', quality: 'normal', recipe: 'iron-plate', count: 2, status: { working: 1, full_output: 1 }, pos: [0, 0, 4, 0] },
      { surface: 'nauvis', name: 'electric-mining-drill', type: 'mining-drill', quality: 'normal', recipe: '', mining_target: 'iron-ore', count: 1, status: { working: 1 }, pos: [100, 100] },
    ],
    stats: { nauvis: { items: { 'iron-plate': { produced: 100, consumed: 50, produced_per_s: 1, consumed_per_s: 0.5 } }, window_s: 600 } },
  };
  const p = path.join(os.tmpdir(), 'mcp-test-export-' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify(f));
  return p;
}

test('compare_factory: shortfall, starved trace, extra, production', async () => {
  const p = exportFile();
  try {
    const r = await call('compare_factory', { targets: [{ item: 'iron-gear-wheel', rate: 5 }], export_path: p });
    const gear = r.json.recipes.find((x) => x.name === 'iron-gear-wheel');
    assert.strictEqual(gear.built, 1);
    assert.strictEqual(gear.planned, 2);
    assert.strictEqual(gear.short_by, 1);
    assert.ok(/starved/.test(gear.status));
    assert.ok(gear.starved_input_trace[0].made_by.length >= 1);
    const plate = r.json.production.find((x) => x.item === 'iron-plate');
    near(plate.measured, 1);
    assert.ok((await call('compare_factory', { targets: [{ item: 'iron-gear-wheel', rate: 5 }], export_path: p, surface: 'mars' })).isError);
  } finally { fs.unlinkSync(p); }
});

test('propose_groups with export_path seeds groups from the save', async () => {
  const p = exportFile();
  try {
    const r = await call('propose_groups', { targets: [{ item: 'iron-gear-wheel', rate: 2 }], export_path: p });
    assert.ok(r.json.seeded_from_save.groups >= 1);
  } finally { fs.unlinkSync(p); }
});

test('export_path must be a real planner export', async () => {
  assert.ok((await call('compare_factory', { targets: [{ item: 'iron-plate', rate: 1 }], export_path: '/etc/passwd' })).isError);
  const bad = path.join(os.tmpdir(), 'mcp-bad-' + process.pid + '.json');
  fs.writeFileSync(bad, '{"version":2}');
  try {
    const r = await call('compare_factory', { targets: [{ item: 'iron-plate', rate: 1 }], export_path: bad });
    assert.ok(r.isError && /not a planner export/.test(r.text));
  } finally { fs.unlinkSync(bad); }
});

test('protocol errors: unknown tool and unknown method; nothing stray on stdout', async () => {
  const u = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.ok(u.error);
  const m = await rpc('does/not/exist', {});
  assert.strictEqual(m.error.code, -32601);
  assert.deepStrictEqual((await rpc('ping', {})).result, {});
  assert.deepStrictEqual(stray, []);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
  }
  proc.stdin.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
