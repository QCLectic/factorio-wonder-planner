# CLAUDE.md

## Project

Build a Factorio production planner. It runs in the browser as a single HTML file.
The model is the top Satisfactory planners (for example satisfactory-calculator.com).
The first user is Q. The later goal is a public web tool for sharing.

## Scope for v1

- Factorio 2.x with Space Age. No mods.
- Output: one self-contained HTML file. No server. No build step unless Q asks for one.
- State lives in the URL. Add JSON export and import for backups.
- Keep the code ready for a public release later. Do not hard-code Q's machine paths or data.

## Core features

1. Input: target item and rate (per second, per minute, per hour).
2. Output: full production tree with machine counts, raw inputs, power use, and item rates on each link.
3. Settings: modules, beacons, quality, machine tier per recipe, available machines, alternate recipes.
4. Oil: balance basic and advanced processing, and cracking, to match the needed rates.
5. Belts: show belt counts per link. Belt layout is not needed.
6. Groups: the main feature. See below.
7. Planets: each group has a planet tag. See below.
8. Spoilage (Gleba): out of scope for v1. Note it in the UI as unsupported.

## Groups (main feature)

- A group is a named set of machines. It shows its own inputs and outputs with rates.
- The tool proposes groups. The user can accept, move machines between groups, split, merge, and rename.
- Group inputs link to the outputs of other groups, or to raw resources, or to imports from another planet.
- Show groups on a canvas or flow view. The user does not need belt-level detail.
- Decided (step 6): two proposal rules. "Product chain": a machine joins the group of its only consumer, and a machine with two or more consumers starts its own group. Mines and pumps join the group that takes most of their output. "Machine type": one group per kind of work. Groups follow the plan automatically until the user edits them. After an edit the user's assignments stay, and new machines stay ungrouped until Propose is pressed.

## Planets

- Each group has a planet tag (Nauvis, Vulcanus, Gleba, Fulgora, Aquilo, or space platform).
- An item that crosses planets shows as an import for the receiving group.
- Recipe data may include surface conditions. If it does, use them for default planet suggestions. Check this in the data first. Do not assume.
- Checked in the dump (step 7): 36 recipes and 5 machines have surface conditions (pressure, gravity, magnetic field). The dump also lists, per planet, the tiles and entities the map generator can place. `tools/trim_data.py` now copies these into `planets.<name>.tiles` and `.entities`.
- Decided (step 7): a group fits a planet when every member can run there. A recipe needs its own and its machine's surface conditions to hold. A mine needs the resource in the planet's entities. A pump needs a tile of that fluid on the planet. The tag is the user's choice, else the only planet that fits, else the fit planet with the most linked flow (a heuristic that adds items and fluids as plain numbers), else Nauvis. A group that fits nowhere shows its problems. The proposal rules start a new group when a machine would leave a group with no valid planet.
- Decided (step 7): the header "Sources" setting is "Any planet" (default) or one planet. Any planet uses `settings.home = nauvis`: raw sources off Nauvis cost 10 times more, so they are used only when Nauvis has no route. This factor is a judgement call, not game data. One planet filters recipes, resources and pumps to that planet.
- A link between groups on different planets is drawn red and dotted and is an import for the receiving group. The Plan tab lists imports and totals by planet.
- Not modeled: how items travel (rockets, platforms), Gleba stromatolites, and Aquilo crude oil yield. Holmium ore has no modeled source and stays an external input. The solver does not optimize where machines go. It plans first, then tags groups.

## Game import and troubleshooter (later, not v1)

- Goal: read Q's current factory from a save and compare it to the plan.
- Route: run a Lua script on a copy of the save. The script writes JSON to `script-output`. The planner reads that file.
- Never run it on the original save. Console commands and mods can disable achievements. Q tests on a copy only.
- Data to read: machines with recipe, modules, and status (working, no ingredients, output full, no power). Production statistics per item. Power use.
- Troubleshooter ideas: compare actual machine counts to solver counts. Flag starved machines and trace them to the missing item. Compare measured flow to planned flow on each link.
- Limit: the script sees machines and flows. It does not see belt or train bottlenecks.
- Not yet verified: whether a script on a save copy affects achievements. Not yet verified: the exact Lua API calls on 2.1.24. Check the API docs before writing the script.
- Also feeds group proposals (step 6): machines in the save can seed groups.

## Data

- Source: dump game data from a Space Age install. The `--dump-data` flag may do this. Verify on the installed version.
- Trim the dump to the fields the tool needs. Embed the result in the HTML or load it from one JSON file.
- Do not invent recipe values. If a value is missing from the dump, flag it.
- Check Wube's terms before the public release. Icons and data may have redistribution limits. Treat this as open until checked.

## Solver notes

- A simple tree walk is not enough when there are alternate recipes, byproducts, or cracking.
- Plan to use a linear-programming solver for these cases. This is a design assessment. Test it against known ratios.
- Validate results against a trusted source. Examples: the Factorio wiki, Factorio Lab, or the Google Sheet by ignatio.
- Handle productivity, speed bonuses, and quality in the machine count math. Document each formula in the code.

## Build order

1. Data dump and trimmed JSON.
2. Solver for target item to tree, with machine counts and raw inputs.
3. Flow view with item rates.
4. Settings: machines, modules, beacons, quality, alternate recipes.
5. Oil balancing.
6. Groups: manual first, then proposals.
7. Planet tags and imports.
8. URL state, JSON export and import.
9. Public release prep.
10. Game import and troubleshooter (after step 8, on a save copy only).

## Open items

- Step 4 is built: machine tiers, research checklist, alternate recipe picker, modules, beacons, machine and module quality.
- Step 4 unverified values: quality bonus of +30% per level for modules and crafting machines is from the wiki, not the dump. Beacon power is counted per machine with no sharing, so it is an upper bound. Quality module output (higher quality items) is not modeled. Mining drill quality is not modeled.
- Compared to Factorio Lab 4.14.10 (Space Age 2.0 data), 2026-11-03, with `node tools/compare_lab.js`. Lab preset "2 Beacons": productivity module 3 in machines (speed module 3 where productivity is disallowed), 2 beacons with 2 speed module 3. Lab's beacon profile is 1, 0.7071, 0.5773 and so on, the same as ours. 10 of 12 recipe rows match within Lab's 0.1 rounding once we use Lab's machine picks (electromagnetic plant for circuits, cryogenic plant for plastic) and Lab's +10% research productivity on plastic bar and steel casting. This checks speed, module, beacon, base productivity and recipe time math. It does not check planet rules, oil balancing, or the LP choices.
- Two open differences from the Lab check. (1) Ours is about 0.1% lower than Lab on some rows (chemical science pack 271.97 vs Lab 272.2, engine unit 161.89 vs 162.0). Cause unknown, small. (2) Casting pipe: the recipe disallows productivity. Lab still applies the foundry's +50% base productivity (Lab 3.32 machines, ours 4.98). We apply none. Which is right in the game is unverified. Q can test it: a foundry making pipes with no modules, then compare output to input. Do not change the solver until that is known.
- Design note from the Lab check: our default machine uses the recipe's primary category, so circuits get assembling machine 3 and plastic gets a chemical plant. Lab picks the best machine across all categories, which is an electromagnetic plant (Fulgora only) and a cryogenic plant. A group tagged Fulgora could suggest those machines. Not built.
- Lab's data is the 2.0 data and ours is 2.1.24. Lab's /data/spa/data.json can be fetched from the Lab page for a full recipe diff. Not done.
- Step 5 is built: the LP balances refining and cracking. The UI adds a refining mode (auto, basic only, advanced only), a cracking switch, and an oil balance panel. Surplus oil fluids are flagged. Not modeled: oil field yield other than 100%, and steam for coal liquefaction (boilers).
- Not yet confirmed: Factorio is installed on Q's computer. If it is not, ask Q for a data file.
- Step 7 is built (see Planets). Checked against the game: nothing yet. Two results need Q's eye. The foundry machine has no surface condition in the dump (only the foundry item recipe has one), so casting recipes are allowed on every planet. And Any planet imports sulfuric acid to Vulcanus instead of using the local geyser, because of the Nauvis preference.
- Step 8 is built: one state object (item, rate, unit, settings, view, sources, edited groups with planet tags) is saved in the URL hash as `#s=` plus deflate-raw base64url. Falls back to plain JSON when the browser has no CompressionStream. Export and Import JSON use the same object (`v: 1`). Everything read from a link or file is cleaned: unknown keys and names not in the game data are dropped, and group names are HTML-escaped. Checked in the browser only. No automated test, because the code lives inside the app script. Not handled: a state version change (only `v: 1` exists), and the pan and zoom position is not saved.
- Step 9 is mostly built. Wube's terms of service (read 2026-11-03 at factorio.com/terms-of-service) say nothing about recipe values or tools. They restrict distributing art assets, and commercial use needs Wube's consent (factorio@factorio.com). So: no icons or art, free tool, credit and trademark note in the About dialog. This is not legal advice. Open: Q should email Wube to confirm, especially before icons or any ads. Done: MIT LICENSE, README, About dialog (limits, privacy, data version 2.1.24), no local paths in the code, Factorio-like dark and orange theme (colors only). Open: the LICENSE holder reads "Factorio Planner authors", so Q picks a name. Not hosted yet. GitHub Pages needs a repo, and this folder is not a git repo. `AGENTS.md` is a copy of CLAUDE.md that is now out of date.
- `--dump-data` works on the installed version, and the dump has surface conditions (see Planets).

## Working rules

- Ask Q questions before any large build step. Wait for answers.
- Say clearly what is known, what is inferred, and what is unknown. Never invent facts, numbers, or sources.
- Keep replies short. Lead with the answer.
- Preserve Q's own wording when editing his text.
- If an idea is weak, say so and explain why.
- Do not use em dashes in written output.
- Write in simple technical English: short sentences, active voice, one topic per sentence.
- Test each step before the next one. Show Q what changed after each step.

## Reference tools

- Factorio Lab (factoriolab.github.io): web planner with a flow diagram.
- Kirk McDonald's calculator: simple ratio tool.
- Production Calculator Google Sheet by ignatio: production graph, Space Age support.
- Helmod and Factory Planner: in-game mods. They are not usable here because Q wants to keep achievements.
