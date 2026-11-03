/* Compare our machine counts with Factorio Lab rows. Run: node tools/compare_lab.js
 *
 * The Lab numbers below were read from Factorio Lab 4.14.10 (Space Age 2.0 data) on 2026-11-03:
 *   https://factoriolab.github.io/spa/list?o=chemical-science-pack*6000&mpr=2&v=12
 * Preset "2 Beacons". Lab shows machines rounded UP to one decimal, so a row matches when our
 * count, rounded up the same way, is within 0.1 of Lab's.
 *
 * The module setup is INFERRED from the numbers, not read from Lab: 4 productivity module 3 in
 * each machine slot (or all slots), and 2 beacons with 2 speed module 3 each.
 * Lab also picks machines we do not pick by default, and adds research productivity:
 *   electromagnetic plant for circuits (our default uses the primary category, so assembling machine 3)
 *   cryogenic plant for plastic bar
 *   +10% productivity on plastic bar and steel casting (research bonus in Lab's default)
 * Those are passed as overrides below so the rows compare like with like.
 */
'use strict';
const path = require('path');
const { solve } = require(path.join(__dirname, '..', 'src', 'solver.js'));
const data = require(path.join(__dirname, '..', 'data', 'data.json'));

// [recipe, item the recipe makes, Lab rate per minute, Lab machines, note]
const ROWS = [
  ['chemical-science-pack', 'chemical-science-pack', 6000, 272.2],
  ['advanced-circuit', 'advanced-circuit', 6428.6, 67.9],
  ['electronic-circuit', 'electronic-circuit', 6428.6, 5.7],
  ['engine-unit', 'engine-unit', 4285.8, 162.0],
  ['plastic-bar', 'plastic-bar', 6428.6, 7.4],
  ['light-oil-cracking', 'petroleum-gas', 33834.6, 16.3],
  ['heavy-oil-cracking', 'light-oil', 39040.0, 12.5],
  ['casting-iron', 'iron-plate', 3214.3, 4.5],
  ['casting-steel', 'steel-plate', 3061.3, 8.1],
  ['casting-iron-gear-wheel', 'iron-gear-wheel', 3061.3, 2.7],
  ['casting-pipe', 'pipe', 6122.5, 3.4, 'KNOWN DIFFERENCE: Lab puts speed modules here (productivity is disallowed) and still applies the foundry base +50%. We apply no base productivity. With that, ours is 3.32, so 3.4. Unverified in game. See CLAUDE.md.'],
  ['casting-copper-cable', 'copper-cable', 22500, 9.8],
];
const MACHINES = { 'electronic-circuit': 'electromagnetic-plant', 'advanced-circuit': 'electromagnetic-plant', 'plastic-bar': 'cryogenic-plant' };
const RESEARCH = { 'plastic-bar': 0.1, 'casting-steel': 0.1 };

const spec = () => ({ module: 'productivity-module-3', beacons: 2, bModule: 'speed-module-3', bCount: 2 });
const ceil1 = (v) => Math.ceil(v * 10 - 1e-9) / 10;

function ours(recipe, item, perMin) {
  const others = Object.entries(data.recipes)
    .filter(([n, r]) => n !== recipe && (r.results || []).some((x) => x.name === item)).map(([n]) => n);
  const bonuses = RESEARCH[recipe] ? { [recipe]: { productivity: RESEARCH[recipe] } } : {};
  const p = solve(data, {
    item, rate: perMin / 60,
    settings: {
      home: 'nauvis', enabledRecipes: [recipe], disabledRecipes: others, mods: spec(), bonuses,
      machines: MACHINES[recipe] ? { [recipe]: MACHINES[recipe] } : {},
    },
  });
  const n = p.ok && p.nodes.find((x) => x.id === 'recipe:' + recipe);
  return n ? { machines: n.machines, machine: n.machine } : null;
}

if (require.main === module) {
  let bad = 0, known = 0;
  for (const [recipe, item, rate, lab, note] of ROWS) {
    const o = ours(recipe, item, rate);
    if (!o) { console.log(recipe.padEnd(26), 'ours: not found'); bad++; continue; }
    const ok = Math.abs(ceil1(o.machines) - lab) < 0.15;
    if (!ok && note) known++; else if (!ok) bad++;
    console.log(recipe.padEnd(26), o.machine.padEnd(22), 'lab', String(lab).padStart(6), 'ours', o.machines.toFixed(3).padStart(8),
      'ceil', String(ceil1(o.machines)).padStart(6), ok ? 'ok' : (note ? 'known difference' : 'DIFF'));
  }
  console.log(`\n${ROWS.length - bad - known} match, ${known} known difference, ${bad} unexplained`);
  process.exit(bad ? 1 : 0);
}
module.exports = { ours, spec, ROWS };
