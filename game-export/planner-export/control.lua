-- Writes script-output/planner-export.json once, on the first tick after a load.
-- Read only: it changes nothing in the game. It still marks a save as modded, so run it on a COPY.
-- API names were checked against the Factorio 2.1.24 runtime docs (lua-api.factorio.com/latest).
--
-- Output (version 1):
--   game_version, tick, mods
--   machines: one entry per group of identical machines
--     { surface, name, type, quality, recipe, recipe_quality, modules = {"name@quality=count"},
--       beacons, status = {status_name = count}, count, products_finished, speed_bonus_avg,
--       productivity_bonus_avg, mining_target }
--   stats[surface] = { items = {name = {produced, consumed, produced_per_s, consumed_per_s}}, window_s }
--     produced and consumed are totals since the save began. The per second values average the last
--     10 minutes (get_flow_count with count = true, divided by 600).
--   failures: names of API calls that raised an error, so a missing value is not a silent zero.

local MACHINE_TYPES = { "assembling-machine", "furnace", "rocket-silo", "mining-drill", "offshore-pump" }
local STATS_WINDOW_S = 600

local status_name = {}
for name, id in pairs(defines.entity_status) do status_name[id] = name end

local failures = {}
local function note_failure(what, err)
  if not failures[what] then failures[what] = tostring(err) end
end

local function module_key(entity)
  local ok, inv = pcall(function() return entity.get_module_inventory() end)
  if not ok then note_failure("get_module_inventory", inv); return "" end
  if not inv then return "" end
  local ok2, contents = pcall(function() return inv.get_contents() end)
  if not ok2 then note_failure("get_contents", contents); return "" end
  local parts = {}
  for _, c in pairs(contents) do
    parts[#parts + 1] = string.format("%s@%s=%d", c.name, c.quality or "normal", c.count)
  end
  table.sort(parts)
  return table.concat(parts, ",")
end

local function export()
  local out = {
    version = 1,
    game_version = (script.active_mods and script.active_mods["base"]) or "unknown",
    tick = game.tick,
    mods = script.active_mods,
    machines = {},
    stats = {},
    failures = failures,
  }

  local groups = {}
  for _, surface in pairs(game.surfaces) do
    local list = surface.find_entities_filtered { force = "player", type = MACHINE_TYPES }
    for _, e in pairs(list) do
      local recipe_name, recipe_quality = "", ""
      if e.type == "assembling-machine" or e.type == "furnace" or e.type == "rocket-silo" then
        local ok, r, q = pcall(function() return e.get_recipe() end)
        if ok and r then recipe_name = r.name; recipe_quality = q and q.name or "normal"
        elseif not ok then note_failure("get_recipe", r) end
        -- A furnace with no recipe set has a previous recipe, which is not what it is making now.
      end
      local mods = module_key(e)
      local target = ""
      if e.type == "mining-drill" then
        local ok, t = pcall(function() return e.mining_target end)
        if ok and t then target = t.name elseif not ok then note_failure("mining_target", t) end
      end
      local key = table.concat({ surface.name, e.name, e.quality.name, recipe_name, recipe_quality, mods, target }, "|")
      local g = groups[key]
      if not g then
        g = {
          surface = surface.name, name = e.name, type = e.type, quality = e.quality.name,
          recipe = recipe_name, recipe_quality = recipe_quality, modules = mods,
          mining_target = target, status = {}, count = 0, products_finished = 0,
          speed_bonus_sum = 0, productivity_bonus_sum = 0, beacons = 0,
        }
        groups[key] = g
        out.machines[#out.machines + 1] = g
      end
      g.count = g.count + 1
      local s = status_name[e.status] or "unknown"
      g.status[s] = (g.status[s] or 0) + 1
      if e.type == "assembling-machine" or e.type == "furnace" or e.type == "rocket-silo" then
        local ok, pf = pcall(function() return e.products_finished end)
        if ok then g.products_finished = g.products_finished + pf else note_failure("products_finished", pf) end
      end
      local ok_s, sb = pcall(function() return e.speed_bonus end)
      if ok_s then g.speed_bonus_sum = g.speed_bonus_sum + sb else note_failure("speed_bonus", sb) end
      local ok_p, pb = pcall(function() return e.productivity_bonus end)
      if ok_p then g.productivity_bonus_sum = g.productivity_bonus_sum + pb else note_failure("productivity_bonus", pb) end
      local ok_b, bc = pcall(function() return e.beacons_count end)
      if ok_b and bc then g.beacons = g.beacons + bc elseif not ok_b then note_failure("beacons_count", bc) end
    end
  end
  for _, g in pairs(out.machines) do
    g.speed_bonus_avg = g.speed_bonus_sum / g.count
    g.productivity_bonus_avg = g.productivity_bonus_sum / g.count
    g.beacons_avg = g.beacons / g.count
    g.speed_bonus_sum, g.productivity_bonus_sum, g.beacons = nil, nil, nil
  end

  local force = game.forces["player"]
  for _, surface in pairs(game.surfaces) do
    local items = {}
    local ok, stat = pcall(function() return force.get_item_production_statistics(surface) end)
    if ok and stat then
      for name, v in pairs(stat.input_counts) do items[name] = { produced = v, consumed = 0 } end
      for name, v in pairs(stat.output_counts) do
        items[name] = items[name] or { produced = 0 }
        items[name].consumed = v
      end
      for name, rec in pairs(items) do
        local ok1, p = pcall(function()
          return stat.get_flow_count { name = name, category = "input", count = true,
            precision_index = defines.flow_precision_index.ten_minutes }
        end)
        local ok2, c = pcall(function()
          return stat.get_flow_count { name = name, category = "output", count = true,
            precision_index = defines.flow_precision_index.ten_minutes }
        end)
        if ok1 then rec.produced_per_s = p / STATS_WINDOW_S else note_failure("get_flow_count", p) end
        if ok2 then rec.consumed_per_s = c / STATS_WINDOW_S end
      end
      out.stats[surface.name] = { items = items, window_s = STATS_WINDOW_S }
    elseif not ok then
      note_failure("get_item_production_statistics", stat)
    end
  end

  helpers.write_file("planner-export.json", helpers.table_to_json(out), false)
  log("planner-export: wrote " .. #out.machines .. " machine groups")
end

-- Run once per load, after WAIT_TICKS ticks. Machine status needs a few seconds to settle after a
-- load, so the first ticks can show power and ingredient states that are not real.
-- A local counter resets on every load, so it runs again if the save is reloaded.
local WAIT_TICKS = 300
local ticks, done = 0, false
script.on_event(defines.events.on_tick, function()
  if done then return end
  ticks = ticks + 1
  if ticks < WAIT_TICKS then return end
  done = true
  local ok, err = pcall(export)
  if not ok then
    helpers.write_file("planner-export-error.txt", tostring(err), false)
    log("planner-export: failed: " .. tostring(err))
  end
end)
