"""Trim a Factorio data-raw-dump.json to the fields the planner needs.

Usage:
    python -I tools/trim_data.py <path to data-raw-dump.json> [output path] [game version]

Make the dump with: factorio --dump-data
The dump is written to <user data>/script-output/data-raw-dump.json.

Output: one data.json (default: data/data.json) plus a report on stdout.
The report lists values the script could not find. Nothing is invented.
Fields that are absent in the dump stay absent in the output. Engine
defaults are NOT applied here. They are listed under _meta.engine_defaults
so the solver applies them in one visible place.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

# Prototype types that can be crafting machines.
MACHINE_TYPES = ("assembling-machine", "furnace", "rocket-silo")

# Fields copied as-is from a crafting machine prototype, when present.
MACHINE_FIELDS = (
    "crafting_speed", "crafting_categories", "energy_usage", "module_slots",
    "allowed_effects", "allowed_module_categories", "effect_receiver",
    "surface_conditions", "ingredient_count", "fixed_recipe", "fixed_quantity",
    "rocket_parts_required", "drain", "quality_affects_module_slots",
    "quality_affects_energy_usage", "max_item_product_count",
)

ITEM_FIELDS = (
    "stack_size", "weight", "fuel_value", "fuel_category", "fuel_acceleration_multiplier",
    "fuel_emissions_multiplier", "spoil_ticks", "spoil_result", "spoil_to_trigger_result",
    "place_result", "burnt_result", "plant_result", "subgroup", "order", "hidden",
    "send_to_orbit_mode",
)

FLUID_FIELDS = (
    "default_temperature", "max_temperature", "heat_capacity", "fuel_value",
    "emissions_multiplier", "subgroup", "order", "hidden",
)

ENERGY_UNITS = {
    "W": 1, "kW": 1e3, "MW": 1e6, "GW": 1e9, "TW": 1e12,
    "J": 1, "kJ": 1e3, "MJ": 1e6, "GJ": 1e9, "TJ": 1e12,
}

# Defaults the engine applies when a field is missing. Taken from the
# Factorio prototype docs, NOT from the dump. Check them against the wiki.
ENGINE_DEFAULTS = {
    "recipe.energy_required": 0.5,
    "recipe.enabled": True,
    "recipe.categories": ["crafting"],
    "recipe.allow_productivity": False,
    "recipe.allow_quality": True,
    "recipe.maximum_productivity": 3.0,
    "result.probability": 1,
    "mining_drill.base_productivity": 0,
    "resource.category": "basic-solid",
    "result.amount_when_resource_has_single_result": 1,
    "belt.items_per_second": "speed * 480 (derived: 2 lanes x 4 items per tile x 60 ticks)",
}

# The dump writes an empty Lua table as {}. These keys are lists, so {} means [].
LIST_KEYS = {
    "ingredients", "results", "categories", "allowed_effects", "allowed_module_categories",
    "crafting_categories", "resource_categories", "prerequisites", "effects",
    "surface_conditions", "fuel_categories",
}


def fix_empty_lists(node):
    if isinstance(node, dict):
        return {k: ([] if k in LIST_KEYS and v == {} else fix_empty_lists(v))
                for k, v in node.items()}
    if isinstance(node, list):
        return [fix_empty_lists(v) for v in node]
    return node


problems = []


def flag(msg):
    problems.append(msg)


def parse_energy(value, where):
    """Parse '375kW' or '1.8MW' into a plain number (W or J). Return None on failure."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = re.fullmatch(r"\s*([0-9.]+(?:[eE][-+]?[0-9]+)?)\s*([kMGT]?[WJ])\s*", str(value))
    if not m:
        flag(f"energy not parsed: {where} = {value!r}")
        return None
    return float(m.group(1)) * ENERGY_UNITS[m.group(2)]


def pick(src, fields):
    return {k: src[k] for k in fields if k in src}


def energy_source(proto, where):
    es = proto.get("energy_source")
    if not es:
        return None
    out = {"type": es.get("type")}
    for k in ("fuel_categories", "effectivity", "fuel_inventory_size"):
        if k in es:
            out[k] = es[k]
    if "emissions_per_minute" in es:
        out["emissions_per_minute"] = es["emissions_per_minute"]
    if "drain" in es:
        out["drain"] = parse_energy(es["drain"], where + ".energy_source.drain")
    return out


def count_fluid_boxes(proto):
    """Count input and output fluid boxes (a recipe needs enough of each)."""
    n_in = n_out = 0
    for fb in proto.get("fluid_boxes", []) or []:
        if isinstance(fb, dict):
            pt = fb.get("production_type")
            if pt == "input":
                n_in += 1
            elif pt == "output":
                n_out += 1
    for key, kind in (("input_fluid_box", "in"), ("output_fluid_box", "out")):
        if key in proto:
            if kind == "in":
                n_in += 1
            else:
                n_out += 1
    return n_in, n_out


def trim_machine(proto):
    name = proto["name"]
    m = {"type": proto["type"]}
    m.update(pick(proto, MACHINE_FIELDS))
    m["energy_usage"] = parse_energy(proto.get("energy_usage"), name + ".energy_usage")
    if "drain" in m:
        m["drain"] = parse_energy(m["drain"], name + ".drain")
    m["energy_source"] = energy_source(proto, name)
    m["fluid_inputs"], m["fluid_outputs"] = count_fluid_boxes(proto)
    for k in proto:
        if "quality" in k and k not in MACHINE_FIELDS:
            m.setdefault("_quality_keys_seen", []).append(k)
    return m


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data") / "data.json"
    raw = json.loads(src.read_text(encoding="utf-8"))

    # Items: every prototype type whose entries carry stack_size is an item.
    item_types = [t for t, v in raw.items()
                  if isinstance(v, dict) and v and "stack_size" in next(iter(v.values()))]
    items = {}
    for t in item_types:
        for name, p in raw[t].items():
            it = {"type": t}
            it.update(pick(p, ITEM_FIELDS))
            items[name] = it

    fluids = {n: pick(p, FLUID_FIELDS) for n, p in raw.get("fluid", {}).items()}

    modules = {}
    for n, p in raw.get("module", {}).items():
        modules[n] = {"category": p.get("category"), "tier": p.get("tier"),
                      "effect": p.get("effect", {})}
        if n not in items:
            flag(f"module {n} has no item entry")

    beacons = {}
    for n, p in raw.get("beacon", {}).items():
        b = pick(p, ("module_slots", "allowed_effects", "allowed_module_categories",
                     "distribution_effectivity", "distribution_effectivity_bonus_per_quality_level",
                     "profile", "beacon_counter", "supply_area_distance", "effect_receiver",
                     "surface_conditions"))
        b["energy_usage"] = parse_energy(p.get("energy_usage"), n + ".energy_usage")
        b["energy_source"] = energy_source(p, n)
        beacons[n] = b

    machines = {}
    for t in MACHINE_TYPES:
        for n, p in raw.get(t, {}).items():
            machines[n] = trim_machine(p)

    # Mining drills and resources.
    drills = {}
    for n, p in raw.get("mining-drill", {}).items():
        d = pick(p, ("mining_speed", "resource_categories", "module_slots", "allowed_effects",
                     "effect_receiver", "surface_conditions", "base_productivity", "output_fluid_box"))
        if "output_fluid_box" in d:
            d["output_fluid_box"] = True
        d["energy_usage"] = parse_energy(p.get("energy_usage"), n + ".energy_usage")
        d["energy_source"] = energy_source(p, n)
        drills[n] = d

    resources = {}
    for n, p in raw.get("resource", {}).items():
        r = {"category": p.get("category")}
        r["minable"] = pick(p.get("minable", {}), (
            "mining_time", "result", "results", "required_fluid", "fluid_amount"))
        if "infinite" in p:
            r["infinite"] = p["infinite"]
        for k in ("infinite_depletion_amount", "normal", "minimum"):
            if k in p:
                r[k] = p[k]
        resources[n] = r

    pumps = {}
    for n, p in raw.get("offshore-pump", {}).items():
        pumps[n] = {"pumping_speed": p.get("pumping_speed"),
                    "energy_usage": parse_energy(p.get("energy_usage"), n + ".energy_usage"),
                    "fluid": p.get("fluid")}

    belts = {}
    for n, p in raw.get("transport-belt", {}).items():
        if "speed" in p:
            belts[n] = {"speed": p["speed"], "items_per_second": p["speed"] * 480}

    # Recipes.
    recipes = {}
    cats = Counter()
    for n, p in raw["recipe"].items():
        r = {k: p[k] for k in (
            "energy_required", "ingredients", "results", "enabled", "hidden", "parameter",
            "allow_productivity", "allow_quality", "maximum_productivity", "main_product",
            "surface_conditions", "auto_recycle", "preserve_products_in_machine_output",
            "result_is_always_fresh", "subgroup", "order") if k in p}
        categories = list(p.get("categories", []))
        categories += p.get("additional_categories", [])
        if "category" in p:
            flag(f"recipe {n} uses legacy 'category': {p['category']}")
            categories.append(p["category"])
        r["categories"] = categories
        for c in categories:
            cats[c] += 1
        recipes[n] = r

    recipe_categories = sorted(raw.get("recipe-category", {}))

    # Cross-checks: names that recipes use must exist as items or fluids.
    unresolved = set()
    for n, r in recipes.items():
        for side in ("ingredients", "results"):
            for e in r.get(side, []) or []:
                pool = fluids if e.get("type") == "fluid" else items
                if e.get("name") not in pool:
                    unresolved.add((n, e.get("type"), e.get("name")))
    for u in sorted(unresolved):
        flag(f"unresolved recipe reference: {u}")

    # Recipes with no machine that can craft them.
    cat_to_machines = {}
    for mn, m in machines.items():
        for c in m.get("crafting_categories", []):
            cat_to_machines.setdefault(c, []).append(mn)
    default_cats = ENGINE_DEFAULTS["recipe.categories"]
    no_machine = [n for n, r in recipes.items()
                  if not any(c in cat_to_machines for c in (r["categories"] or default_cats))]
    print(f"  recipes with no 'categories' (engine default {default_cats} applies): "
          f"{sum(1 for r in recipes.values() if not r['categories'])}")
    mining_cats = {c for d in drills.values() for c in d.get("resource_categories", [])}

    # Planets and surfaces.
    props = {n: p.get("default_value") for n, p in raw.get("surface-property", {}).items()}
    planets = {}
    for n, p in raw.get("planet", {}).items():
        mg = p.get("map_gen_settings", {})
        found = set(mg.get("autoplace_controls", {}))
        for k in mg.get("property_expression_names", {}):
            parts = k.split(":")
            if parts[0] == "entity" and len(parts) == 3:
                found.add("entity:" + parts[1])
        aps = mg.get("autoplace_settings", {})
        planets[n] = {"surface_properties": p.get("surface_properties", {}),
                      # Stated in the dump: what the map generator can place on this planet.
                      "tiles": sorted(aps.get("tile", {}).get("settings", {})),
                      "entities": sorted(aps.get("entity", {}).get("settings", {})),
                      # INFERRED from map generation settings, not a stated rule.
                      "autoplace_hints": sorted(found)}
    surfaces = {n: {"surface_properties": p.get("surface_properties", {})}
                for n, p in raw.get("surface", {}).items()}

    # Fluids an offshore pump can take, by tile. The dump does not say which
    # tiles exist on which planet, so planet limits for pumps are unknown.
    tile_fluids = sorted({t["fluid"] for t in raw.get("tile", {}).values() if "fluid" in t})
    tiles_by_fluid = {}
    for tn, t in raw.get("tile", {}).items():
        if "fluid" in t:
            tiles_by_fluid.setdefault(t["fluid"], []).append(tn)

    quality = {}
    for n, p in raw.get("quality", {}).items():
        quality[n] = {k: v for k, v in p.items()
                      if k not in ("type", "name", "icon", "icon_size", "order", "color",
                                   "draw_sprite_by_default", "localised_name",
                                   "localised_description", "hidden")}

    # Technologies: keep what matters for filtering and for bonuses.
    techs = {}
    keep_effects = ("unlock-recipe", "change-recipe-productivity",
                    "mining-drill-productivity-bonus", "laboratory-productivity",
                    "laboratory-speed")
    for n, p in raw.get("technology", {}).items():
        effects = [e for e in p.get("effects", []) if e.get("type") in keep_effects]
        techs[n] = {"prerequisites": p.get("prerequisites", []), "effects": effects}
        for k in ("max_level", "hidden", "enabled", "research_trigger"):
            if k in p:
                techs[n][k] = p[k]
    unlocked_by = {}
    for tn, t in techs.items():
        for e in t["effects"]:
            if e["type"] == "unlock-recipe":
                unlocked_by.setdefault(e["recipe"], []).append(tn)
    locked = [n for n, r in recipes.items()
              if r.get("enabled") is False and n not in unlocked_by and not r.get("hidden")]

    out = {
        "_meta": {
            "source_game_version": sys.argv[3] if len(sys.argv) > 3 else None,
            "engine_defaults": ENGINE_DEFAULTS,
            "note": "Values come from data-raw-dump.json. Missing fields stay missing.",
        },
        "recipes": recipes, "recipe_categories": recipe_categories,
        "items": items, "fluids": fluids, "modules": modules,
        "machines": machines, "beacons": beacons,
        "mining_drills": drills, "resources": resources, "offshore_pumps": pumps,
        "pumpable_fluids": tiles_by_fluid,
        "belts": belts, "quality": quality,
        "surface_properties": props, "planets": planets, "surfaces": surfaces,
        "technologies": techs, "recipe_unlocked_by": unlocked_by,
    }
    out = fix_empty_lists(out)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, separators=(",", ":"), sort_keys=True), encoding="utf-8")

    # Report.
    print(f"wrote {dst} ({dst.stat().st_size / 1024:.0f} KB) from {src.name}")
    for k in ("recipes", "items", "fluids", "modules", "machines", "beacons", "mining_drills",
              "resources", "offshore_pumps", "belts", "quality", "planets", "surfaces",
              "technologies"):
        print(f"  {k}: {len(out[k])}")
    print(f"  item prototype types: {sorted(item_types)}")
    print(f"  recipes enabled=false: {sum(1 for r in recipes.values() if r.get('enabled') is False)}")
    print(f"  recipes hidden: {sum(1 for r in recipes.values() if r.get('hidden'))}")
    print(f"  recipes with surface_conditions: {sum(1 for r in recipes.values() if 'surface_conditions' in r)}")
    print(f"  machines with surface_conditions: {[n for n, m in machines.items() if 'surface_conditions' in m]}")
    print(f"  recipes by category: {dict(cats)}")
    print(f"  recipes no crafting machine (category): {len(no_machine)}")
    miss = Counter(c for n in no_machine for c in (recipes[n]["categories"] or default_cats))
    print(f"    categories lacking a machine: {dict(miss)}")
    print(f"  resource categories with no drill: "
          f"{sorted({r['category'] or 'basic-solid' for r in resources.values()} - mining_cats)}")
    print(f"  enabled=false recipes with no unlocking tech (not hidden): {locked}")
    qk = {n: m['_quality_keys_seen'] for n, m in machines.items() if '_quality_keys_seen' in m}
    print(f"  machine keys that mention quality: {qk or 'none'}")
    print(f"PROBLEMS ({len(problems)}):")
    for p in problems:
        print("  - " + p)


if __name__ == "__main__":
    main()
