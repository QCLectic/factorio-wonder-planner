/* Production solver: target item and rate -> recipes, machines, raw inputs.
 *
 * Model (all rates are per second):
 *   Each "activity" a (a recipe, a mining operation, a pump) runs x_a times per second.
 *   For every item i:   sum_a (out[a][i] - in[a][i]) * x_a  >=  demand[i]
 *   demand is the target rate for the target item and 0 for all others, so any
 *   byproduct surplus is allowed and reported.
 *   Objective: minimize  sum raw_cost[i] * (raw output of extraction)  +  EPS * machines.
 *   The machine term only breaks ties. Raw costs are a solver preference, not game data.
 *
 * Formulas (documented where used below):
 *   effective craft time   = energy_required / (crafting_speed * speedFactor)
 *   speedFactor            = max(0.2, 1 + base speed effect + module/beacon speed)
 *   productivity bonus p   = min(maximum_productivity, base + modules + research), only
 *                            when the recipe allows productivity
 *   products per craft     = nonprod + (expected - nonprod) * (1 + p)
 *   expected               = amount * probability + extra_count_fraction
 *   machines               = crafts_per_second * effective craft time
 *   electric power         = machines * energy_usage * consumptionFactor
 */
(function (root) {
  'use strict';
  const LP = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./lp.js') : root.FPLP;

  const DEFAULTS = {
    recipeEnergy: 0.5,
    recipeCategories: ['crafting'],
    maxProductivity: 3,
    resourceCategory: 'basic-solid',
    preferredDrill: 'electric-mining-drill',
    minSpeedFactor: 0.2,       // Factorio never lets total speed drop below 20%
    minConsumptionFactor: 0.2,
  };
  // Recipes that are off by default because a cheaper-in-raw-units route is not what a
  // player picks first (coal liquefaction instead of crude oil, lava casting, bio
  // alternatives, gleba bacteria loops). The dump does not mark alternates, so this list is
  // a judgement call and Q should review it. Turn recipes back on with
  // settings.enabledRecipes, or turn the whole filter off with settings.allAlternates.
  const DEFAULT_OFF_RECIPES = [
    'coal-liquefaction', 'simple-coal-liquefaction', 'bioplastic', 'biosulfur', 'biolubricant',
    'rocket-fuel-from-jelly', 'ammonia-rocket-fuel', 'solid-fuel-from-ammonia',
    'nutrients-from-fish', 'nutrients-from-biter-egg', 'nutrients-from-bioflux',
    'ice-melting', 'steam-condensation', 'advanced-thruster-fuel', 'advanced-thruster-oxidizer',
    'burnt-spoilage', 'copper-bacteria-cultivation', 'iron-bacteria-cultivation',
    'concrete-from-molten-iron', 'molten-iron-from-lava', 'molten-copper-from-lava',
    'casting-copper-cable', 'casting-copper', 'casting-iron-gear-wheel', 'casting-iron',
    'casting-iron-stick', 'casting-low-density-structure', 'casting-pipe',
    'casting-pipe-to-ground', 'casting-steel',
  ];
  // Categories that are off by default: recycling loops, asteroid crushing, spawner captures.
  const DEFAULT_OFF_CATEGORIES = ['recycling', 'crushing', 'captive-spawner-process', 'parameters'];
  const EPS_MACHINE = 1e-4;
  // Big-M cost per external unit: larger than any real route's raw cost per unit
  // (uranium-235 without Kovarex needs about 1.4e3 raw units per item, the largest seen).
  const EXTERNAL_COST = 1e6;
  // A raw source that is not on settings.home costs this many times more. Judgement call: it makes
  // the plan use home sources when it can, and other planets only when nothing at home works.
  const OFF_HOME_FACTOR = 10;
  const FLOW_EPS = 1e-9;

  // Expected amount of one product entry per craft, before productivity.
  // independent_probability: chance of the whole entry.
  // shared_probability {min,max}: one roll shared by several entries, chance = max - min.
  // Both forms are inferred from the dump (checked: uranium-processing gives 0.7% U-235).
  function expectedAmount(e) {
    let p = 1;
    if (e.independent_probability !== undefined) p = e.independent_probability;
    else if (e.shared_probability) p = e.shared_probability.max - e.shared_probability.min;
    const amt = e.amount !== undefined ? e.amount : ((e.amount_min + e.amount_max) / 2);
    return amt * p + (e.extra_count_fraction || 0);
  }

  function addTo(obj, k, v) { obj[k] = (obj[k] || 0) + v; }

  function surfaceProps(data, planet) {
    const base = Object.assign({}, data.surface_properties);
    const pl = data.planets[planet] || data.surfaces[planet];
    if (!pl) throw new Error('unknown planet: ' + planet);
    return Object.assign(base, pl.surface_properties);
  }

  function conditionsOk(conds, props) {
    if (!conds) return true;
    return conds.every((c) => {
      const v = props[c.property];
      if (v === undefined) return false;
      if (c.min !== undefined && v < c.min) return false;
      if (c.max !== undefined && v > c.max) return false;
      return true;
    });
  }

  function recipeCats(r) {
    return r.categories && r.categories.length ? r.categories : DEFAULTS.recipeCategories;
  }

  // Recipes that are on unless the user turns them on or off. See DEFAULT_OFF_* above.
  function defaultOn(name, r) {
    if (DEFAULT_OFF_RECIPES.includes(name)) return false;
    if (recipeCats(r).some((c) => DEFAULT_OFF_CATEGORIES.includes(c))) return false;
    if (name.endsWith('-barrel')) return false;      // barrel fill/empty loops
    return true;
  }

  // Quality levels. Module and machine bonuses use +30% per level. That figure is from the
  // wiki, not the dump (the dump has no such field). Beacon effectivity per level IS in the dump.
  const QUALITY_STEP = 0.3;
  const levelOf = (data, q) => (data.quality[q || 'normal'] || { level: 0 }).level;

  // Effect of one module at a quality. Only the beneficial side of each effect scales:
  // more speed, productivity or quality, less consumption or pollution.
  function moduleEffect(data, name, quality) {
    const mod = data.modules[name];
    if (!mod) return null;
    const k = 1 + QUALITY_STEP * levelOf(data, quality);
    const out = {};
    for (const [e, v] of Object.entries(mod.effect)) {
      const good = (e === 'consumption' || e === 'pollution') ? v < 0 : v > 0;
      out[e] = good ? v * k : v;
    }
    return out;
  }

  // Effects on one machine from the user's module spec and its beacons.
  //   spec = { module, count, quality, beacons, bModule, bCount, bQuality, machineQuality }
  // Returns { speed, productivity, consumption, quality, beaconW, machineSpeed }.
  // Beacon total = per-beacon effect * n * profile[n-1]. The profile is 1/sqrt(n), so the total
  // grows as sqrt(n). Beacon power is counted per machine with no sharing: an upper bound.
  function bonusFor(settings, key, data, machine, recipe, notes) {
    const b = (settings.bonuses && settings.bonuses[key]) || {};
    const out = {
      speed: b.speed || 0, productivity: b.productivity || 0, consumption: b.consumption || 0,
      quality: 0, beaconW: 0, machineSpeed: 1,
    };
    const spec = (settings.nodeMods && settings.nodeMods[key]) || settings.mods;
    if (!spec || !data) return out;
    const allowed = machine && machine.allowed_effects ? machine.allowed_effects : null;
    const slots = (machine && machine.module_slots) || 0;
    const tag = key.replace(/^mine:/, 'mine ');
    const addEffects = (eff, scale, src, only) => {
      for (const [e, v] of Object.entries(eff)) {
        // Beacons cannot carry some effects (productivity, quality). Say so only for the useful ones.
        if (only && !only.includes(e)) { if (v > 0) notes.push(`${tag}: ${e} from ${src} cannot go in a beacon; ignored`); continue; }
        if (allowed && !allowed.includes(e)) { if (v > 0) notes.push(`${tag}: machine does not accept ${e}; ignored`); continue; }
        if (e === 'productivity' && recipe && !recipe.allow_productivity) { if (v > 0) notes.push(`${tag}: recipe does not allow productivity; ignored`); continue; }
        out[e] = (out[e] || 0) + v * scale;
      }
    };
    if (spec.module && slots) {
      const eff = moduleEffect(data, spec.module, spec.quality);
      const n = Math.min(spec.count == null ? slots : spec.count, slots);
      if (eff && n > 0) addEffects(eff, n, spec.module);
    } else if (spec.module && !slots) notes.push(`${tag}: machine has no module slots`);
    const bk = Object.values(data.beacons || {})[0];
    if (spec.beacons > 0 && spec.bModule && bk) {
      const eff = moduleEffect(data, spec.bModule, spec.bQuality);
      const per = Math.min(spec.bCount == null ? bk.module_slots : spec.bCount, bk.module_slots);
      if (eff && per > 0) {
        const effectivity = bk.distribution_effectivity + (bk.distribution_effectivity_bonus_per_quality_level || 0) * levelOf(data, spec.beaconQuality);
        const prof = bk.profile[Math.min(spec.beacons, bk.profile.length) - 1];
        addEffects(eff, per * effectivity * spec.beacons * prof, spec.bModule, bk.allowed_effects);
        const q = data.quality[spec.beaconQuality || 'normal'] || {};
        const cons = Math.max(DEFAULTS.minConsumptionFactor, 1 + (eff.consumption || 0) * per);
        out.beaconW = spec.beacons * bk.energy_usage * (q.beacon_power_usage_multiplier || 1) * cons;
      }
    }
    if (recipe && spec.machineQuality) out.machineSpeed = 1 + QUALITY_STEP * levelOf(data, spec.machineQuality);
    if (out.quality > 0) notes.push(`${tag}: quality modules only change speed here; quality outputs are not modeled`);
    return out;
  }

  // Pick the machine for a recipe: user override, else the fastest machine for the
  // recipe's first category. (Heuristic: the first category is the primary one. Machines
  // for extra categories, such as the electromagnetic plant for circuits, are used
  // only when chosen by the user.)
  function candidateMachines(data, r, props) {
    const cats = recipeCats(r);
    const nFluidIn = (r.ingredients || []).filter((e) => e.type === 'fluid').length;
    const nFluidOut = (r.results || []).filter((e) => e.type === 'fluid').length;
    const out = [];
    for (const [name, m] of Object.entries(data.machines)) {
      if (m.fixed_recipe) continue;
      if (!m.crafting_categories || !m.crafting_categories.some((c) => cats.includes(c))) continue;
      if (m.fluid_inputs < nFluidIn || m.fluid_outputs < nFluidOut) continue;
      if (m.ingredient_count !== undefined &&
          m.ingredient_count < (r.ingredients || []).filter((e) => e.type === 'item').length) continue;
      if (props && !conditionsOk(m.surface_conditions, props)) continue;
      out.push(name);
    }
    return out;
  }

  // A machine counts as available when its own recipe (same name) is enabled from the start
  // or unlocked by a researched technology. Machines with no such recipe are always available.
  // Inferred from names: the dump has no direct machine-to-item link.
  function machineAvailable(data, name, researched) {
    if (!researched) return true;
    const r = data.recipes[name];
    if (!r || r.enabled !== false) return true;
    return (data.recipe_unlocked_by[name] || []).some((t) => researched.has(t));
  }

  // Order of preference: user override (checked by the caller), the global default for the
  // recipe's category, then the fastest available machine.
  function defaultMachine(data, r, cands, settings, researched) {
    const primary = recipeCats(r)[0];
    const byCat = settings.machineByCategory && settings.machineByCategory[primary];
    if (byCat && cands.includes(byCat)) return byCat;
    let pool = cands.filter((n) => data.machines[n].crafting_categories.includes(primary));
    if (!pool.length) pool = cands;
    const avail = pool.filter((n) => machineAvailable(data, n, researched));
    if (avail.length) pool = avail;
    pool.sort((a, b) => {
      const A = data.machines[a], B = data.machines[b];
      // Fastest first. On a tie prefer electric over burner, then the lower power draw.
      const elec = (m) => (m.energy_source && m.energy_source.type === 'electric' ? 0 : 1);
      return (B.crafting_speed - A.crafting_speed) || (elec(A) - elec(B)) ||
        (A.energy_usage - B.energy_usage);
    });
    return pool[0];
  }

  // Build every activity the solver may use.
  function buildActivities(data, settings, notes) {
    const props = settings.planet ? surfaceProps(data, settings.planet) : null;
    const disabled = new Set(settings.disabledRecipes || []);
    const enabled = new Set(settings.enabledRecipes || []);
    const researched = settings.researched ? new Set(settings.researched) : null;
    const acts = [];

    for (const [name, r] of Object.entries(data.recipes)) {
      if (disabled.has(name)) continue;
      const cats = recipeCats(r);
      if (r.parameter) continue;
      if (!settings.allAlternates && !enabled.has(name) && !defaultOn(name, r)) continue;
      if (cats.includes('parameters')) continue;
      if (props && !conditionsOk(r.surface_conditions, props)) continue;
      if (researched && r.enabled === false) {
        const techs = data.recipe_unlocked_by[name] || [];
        if (!techs.some((t) => researched.has(t))) continue;
      }
      const cands = candidateMachines(data, r, props);
      if (!cands.length) continue;
      let machine = settings.machines && settings.machines[name];
      if (machine && !cands.includes(machine)) {
        notes.push(`machine ${machine} cannot craft ${name}; using default`);
        machine = null;
      }
      machine = machine || defaultMachine(data, r, cands, settings, researched);
      const m = data.machines[machine];
      const bonus = bonusFor(settings, name, data, m, r, notes);
      const base = (m.effect_receiver && m.effect_receiver.base_effect) || {};
      const speedFactor = Math.max(DEFAULTS.minSpeedFactor, 1 + (base.speed || 0) + bonus.speed);
      const consFactor = Math.max(DEFAULTS.minConsumptionFactor, 1 + (base.consumption || 0) + bonus.consumption);
      let prod = 0;
      if (r.allow_productivity) {
        const cap = r.maximum_productivity !== undefined ? r.maximum_productivity : DEFAULTS.maxProductivity;
        prod = Math.min(cap, (base.productivity || 0) + bonus.productivity);
      }
      const inputs = {}, outputs = {};
      for (const e of r.ingredients || []) addTo(inputs, e.name, e.amount);
      for (const e of r.results || []) {
        const exp = expectedAmount(e);
        const nonprod = Math.min(e.ignored_by_productivity || 0, exp);
        addTo(outputs, e.name, nonprod + (exp - nonprod) * (1 + prod));
      }
      const time = (r.energy_required !== undefined ? r.energy_required : DEFAULTS.recipeEnergy) /
        (m.crafting_speed * bonus.machineSpeed * speedFactor);
      acts.push({
        id: 'recipe:' + name, kind: 'recipe', name, machine, machineData: m,
        inputs, outputs, secondsPerCraft: time, speedFactor, consFactor, productivity: prod,
        beaconW: bonus.beaconW,
        conditionsNote: !props && r.surface_conditions ? r.surface_conditions : null,
      });
    }

    // Mining: one activity per resource.
    const drills = Object.entries(data.mining_drills);
    // With a planet set, only resources the map generator can place there are minable, and
    // only fluids with a tile there are pumpable. Both lists come from the dump (planets.*).
    const pl = settings.planet && (data.planets[settings.planet] || data.surfaces[settings.planet]);
    const hereEntity = (n) => !pl || (pl.entities || []).includes(n);
    const hereTiles = (tiles) => !pl || (pl.tiles || []).some((t) => tiles.includes(t));
    const home = !pl && settings.home ? (data.planets[settings.home] || data.surfaces[settings.home]) : null;
    const offHomeMine = (n) => !!home && !(home.entities || []).includes(n);
    const offHomePump = (tiles) => !!home && !(home.tiles || []).some((t) => tiles.includes(t));
    for (const [name, res] of Object.entries(data.resources)) {
      if (!hereEntity(name)) continue;
      const cat = res.category || DEFAULTS.resourceCategory;
      const mn = res.minable;
      const out = {};
      if (mn.results) for (const e of mn.results) addTo(out, e.name, e.amount);
      else if (mn.result) addTo(out, mn.result, 1);
      let machine = settings.machines && settings.machines['mine:' + name];
      let cands = drills.filter(([, d]) => d.resource_categories.includes(cat) &&
        (!props || conditionsOk(d.surface_conditions, props))).map(([n]) => n);
      if (!cands.length) continue;
      if (!machine || !cands.includes(machine)) {
        // Default: the plain electric drill when it can mine the resource, else the fastest.
        // Judgement call: the fastest drill (big mining drill) is a late Vulcanus item.
        cands.sort((a, b) => data.mining_drills[b].mining_speed - data.mining_drills[a].mining_speed);
        const avail = cands.filter((n) => machineAvailable(data, n, researched));
        const pool = avail.length ? avail : cands;
        machine = settings.drill && cands.includes(settings.drill) ? settings.drill
          : pool.includes(DEFAULTS.preferredDrill) ? DEFAULTS.preferredDrill : pool[0];
      }
      const d = data.mining_drills[machine];
      const bonus = bonusFor(settings, 'mine:' + name, data, d, null, notes);
      const speedFactor = Math.max(DEFAULTS.minSpeedFactor, 1 + bonus.speed);
      const consFactor = Math.max(DEFAULTS.minConsumptionFactor, 1 + bonus.consumption);
      const prod = (d.base_productivity || 0) + bonus.productivity;
      for (const k of Object.keys(out)) out[k] *= 1 + prod;
      // These notes belong to the mine, so buildPlan adds them only when the plan uses it.
      const mineNotes = [];
      if (mn.required_fluid) {
        mineNotes.push(`${name}: needs ${mn.required_fluid} to mine (fluid_amount ${mn.fluid_amount}); ` +
          'the unit of fluid_amount is not documented, so this input is NOT modeled');
      }
      if (res.infinite) mineNotes.push(`${name}: assumes 100% yield (${Object.values(out)[0]}/operation)`);
      acts.push({
        mineNotes,
        id: 'mine:' + name, kind: 'mine', name, machine, machineData: d,
        inputs: {}, outputs: out,
        secondsPerCraft: mn.mining_time / (d.mining_speed * speedFactor),
        speedFactor, consFactor, productivity: prod, beaconW: bonus.beaconW,
        offHome: offHomeMine(name),
      });
    }

    // Pumping: one activity per fluid that a tile can give.
    const pump = Object.keys(data.offshore_pumps)[0];
    if (pump) {
      const p = data.offshore_pumps[pump];
      for (const [fluid, tiles] of Object.entries(data.pumpable_fluids || {})) {
        if (!hereTiles(tiles)) continue;
        acts.push({
          id: 'pump:' + fluid, kind: 'pump', name: fluid, machine: pump,
          machineData: { energy_usage: p.energy_usage, energy_source: { type: 'electric' } },
          inputs: {}, outputs: { [fluid]: p.pumping_speed * 60 },
          secondsPerCraft: 1, speedFactor: 1, consFactor: 1, productivity: 0,
          offHome: offHomePump(tiles),
        });
      }
    }
    return acts;
  }

  function solve(data, req) {
    const settings = req.settings || {};
    const target = req.item;
    const rate = req.rate;                       // items per second
    if (!(rate > 0)) throw new Error('rate must be > 0');
    const notes = [];
    const all = buildActivities(data, settings, notes);

    const producers = {};
    for (const a of all) for (const i of Object.keys(a.outputs)) {
      if (a.outputs[i] > 0) (producers[i] = producers[i] || []).push(a);
    }
    const allowedRaw = settings.allowedRaw ? new Set(settings.allowedRaw) : null;
    const isRaw = (a) => a.kind === 'mine' || a.kind === 'pump';
    const usable = (a) => !(allowedRaw && isRaw(a) && !Object.keys(a.outputs).every((i) => allowedRaw.has(i)));

    // Items with no usable producer become external inputs.
    const included = new Map();
    const need = [target], seen = new Set([target]);
    while (need.length) {
      const item = need.pop();
      for (const a of (producers[item] || []).filter(usable)) {
        if (included.has(a.id)) continue;
        included.set(a.id, a);
        for (const i of Object.keys(a.inputs)) if (!seen.has(i)) { seen.add(i); need.push(i); }
      }
    }
    // An item can come from outside at a very high cost when nothing modeled makes it
    // (wood, asteroid chunks, spent fuel cells) or the settings forbid its raw source.
    // The plan lists the external inputs it actually uses. Pass 1 allows this only for
    // items with no usable producer. If that is infeasible (a producer loop with no
    // entry, such as asteroid reprocessing), pass 2 allows it for every item except the target.
    const makeExt = (item) => ({
      id: 'ext:' + item, kind: 'external', name: item, machine: null, machineData: null,
      inputs: {}, outputs: { [item]: 1 }, secondsPerCraft: 0, speedFactor: 1, consFactor: 1, productivity: 0,
    });
    const noSource = [...seen].filter((i) => !(producers[i] || []).some(usable));
    let res, acts;
    for (const pass of [1, 2]) {
      const ext = (pass === 1 ? noSource : [...seen].filter((i) => i !== target)).map(makeExt);
      acts = [...included.values(), ...ext];
      res = runLP(acts, target, rate, settings);
      if (res.status === 'optimal') break;
    }
    if (res.status !== 'optimal') return { ok: false, status: res.status, notes };
    return buildPlan(data, acts, res.x, target, rate, notes, settings);
  }

  function runLP(acts, target, rate, settings) {
    // LP rows: one per item that appears.
    const itemIdx = {};
    for (const a of acts) for (const i of [...Object.keys(a.inputs), ...Object.keys(a.outputs)]) {
      if (!(i in itemIdx)) itemIdx[i] = Object.keys(itemIdx).length;
    }
    const items = Object.keys(itemIdx);
    const rows = items.map((i) => ({ a: {}, b: i === target ? rate : 0, op: '>=' }));
    acts.forEach((a, k) => {
      for (const [i, v] of Object.entries(a.outputs)) rows[itemIdx[i]].a[k] = (rows[itemIdx[i]].a[k] || 0) + v;
      for (const [i, v] of Object.entries(a.inputs)) rows[itemIdx[i]].a[k] = (rows[itemIdx[i]].a[k] || 0) - v;
    });

    // Raw cost: pumped fluids are nearly free, everything else costs 1 per unit.
    // Solver preference, adjustable with settings.rawCost.
    const costOf = (item, kind) => {
      // External inputs have no modeled source, so avoid them unless nothing else works.
      if (kind === 'external') return EXTERNAL_COST;
      if (settings.rawCost && settings.rawCost[item] !== undefined) return settings.rawCost[item];
      return kind === 'pump' ? 0.01 : 1;
    };
    const c = acts.map((a) => {
      let cost = 0;
      if (a.kind === 'mine' || a.kind === 'pump' || a.kind === 'external') {
        for (const [i, v] of Object.entries(a.outputs)) {
          const unit = costOf(i, a.kind);
          cost += (a.offHome && a.kind !== 'external' ? Math.max(unit, 1) * OFF_HOME_FACTOR : unit) * v;
        }
      }
      return cost + EPS_MACHINE * a.secondsPerCraft;
    });

    return LP.solveLP(acts.length, c, rows);
  }

  function buildPlan(data, acts, x, target, rate, notes, settings) {
    const nodes = [];
    acts.forEach((a, k) => {
      const crafts = x[k];
      if (crafts < FLOW_EPS) return;
      const inputs = {}, outputs = {};
      for (const [i, v] of Object.entries(a.inputs)) inputs[i] = v * crafts;
      for (const [i, v] of Object.entries(a.outputs)) outputs[i] = v * crafts;
      const machines = crafts * a.secondsPerCraft;
      const node = {
        id: a.id, kind: a.kind, name: a.name, machine: a.machine,
        craftsPerSecond: crafts, machines, machinesCeil: Math.ceil(machines - 1e-9),
        speedFactor: a.speedFactor, productivity: a.productivity,
        inputs, outputs, powerW: 0, fuelW: 0,
      };
      const md = a.machineData;
      if (md && md.energy_usage) {
        const w = machines * md.energy_usage * a.consFactor;
        const es = md.energy_source || {};
        if (es.type === 'electric') node.powerW = w;
        else if (es.type === 'burner') {
          node.fuelW = w / (es.effectivity || 1);
          node.fuelCategories = es.fuel_categories;
        }
      }
      if (a.beaconW) { node.beaconW = machines * a.beaconW; node.powerW += node.beaconW; }
      if (a.mineNotes) notes.push(...a.mineNotes);
      nodes.push(node);
    });

    const net = {};
    for (const n of nodes) {
      for (const [i, v] of Object.entries(n.outputs)) addTo(net, i, v);
      for (const [i, v] of Object.entries(n.inputs)) addTo(net, i, -v);
    }
    const raw = {}, external = {};
    for (const n of nodes) {
      if (n.kind === 'mine' || n.kind === 'pump') for (const [i, v] of Object.entries(n.outputs)) addTo(raw, i, v);
      if (n.kind === 'external') for (const [i, v] of Object.entries(n.outputs)) addTo(external, i, v);
    }
    for (const i of Object.keys(external)) {
      notes.push(`${i}: no modeled source with the current settings; ${external[i].toFixed(3)}/s is an external input`);
    }
    const surplus = {};
    for (const [i, v] of Object.entries(net)) {
      const s = i === target ? v - rate : v;
      if (s > 1e-7) surplus[i] = s;
    }

    // Links: split each item's supply across its consumers in proportion to their demand.
    // This is a presentation choice. The solver fixes only the totals.
    const links = [];
    const byItemProd = {}, byItemCons = {};
    for (const n of nodes) {
      for (const [i, v] of Object.entries(n.outputs)) (byItemProd[i] = byItemProd[i] || []).push([n.id, v]);
      for (const [i, v] of Object.entries(n.inputs)) (byItemCons[i] = byItemCons[i] || []).push([n.id, v]);
    }
    for (const i of Object.keys(byItemProd)) {
      const sinks = (byItemCons[i] || []).slice();
      if (i === target) sinks.push(['target', rate]);
      if (surplus[i]) sinks.push(['surplus', surplus[i]]);
      const total = byItemProd[i].reduce((s, p) => s + p[1], 0);
      const demand = sinks.reduce((s, p) => s + p[1], 0);
      for (const [pid, out] of byItemProd[i]) for (const [cid, need] of sinks) {
        const flow = out * need / (demand || total);
        if (flow > 1e-7) links.push({ item: i, from: pid, to: cid, rate: flow });
      }
    }

    const machineTotals = {};
    let powerW = 0, fuelW = 0;
    for (const n of nodes) {
      if (n.machine) machineTotals[n.machine] = (machineTotals[n.machine] || 0) + n.machinesCeil;
      powerW += n.powerW; fuelW += n.fuelW;
    }
    return {
      ok: true, target, rate, nodes, links, raw, external, surplus,
      machineTotals, powerW, fuelW, notes, settingsUsed: settings,
    };
  }

  const api = { solve, expectedAmount, conditionsOk, surfaceProps, DEFAULTS, candidateMachines, machineAvailable, defaultOn,
    DEFAULT_OFF_RECIPES, DEFAULT_OFF_CATEGORIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
