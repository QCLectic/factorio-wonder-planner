# Factorio Planner

An unofficial production planner for Factorio 2.x with Space Age (no mods). It runs in the browser as one self-contained HTML file. No server and no network access are needed.

Not made by or affiliated with Wube Software. Factorio is a trademark of Wube Software Ltd.

## Use

Open `dist/factorio-planner.html`. Pick an item and a rate. The page shows the production tree, machine counts, raw inputs, power, and item rates on each link.

- **Settings tab:** machine tiers, research limits, alternate recipes, modules, beacons, quality.
- **Groups tab and Groups view:** named sets of machines with their own inputs and outputs. The tool proposes groups. You can move machines, merge, and rename.
- **Planets:** each group has a planet tag. Items that cross planets show as imports.
- **Several targets:** "+ Target" adds more items. All are planned together, and shared ingredients are counted once.
- **Sharing:** the URL holds the whole plan. Copy link, Export JSON, and Import JSON are in the header.

## Build

Needs Python 3 and Node.js. No packages.

```bash
python -I tools/build_html.py
node tests/solver.test.js
node tests/layout.test.js
node tests/groups.test.js
```

The build inlines `data/data.json` and the files in `src/` into `dist/factorio-planner.html`. For GitHub Pages, build to `docs/index.html` with `python -I tools/build_html.py docs/index.html` and commit it.

## Compare with your factory (Factory tab)

The planner can compare a plan with a real save. It needs Factorio installed and Python 3.

```bash
python -I tools/export_save.py "path/to/save.zip" export.json
```

Then open the Factory tab and import `export.json`. The tab shows planned and built machines per recipe, their status (working, starved, output full, low power, depleted), a trace of the inputs for starved machines, and measured production against the plan.

After you import an export, the Groups tab has **Seed from my save**. It cuts your machines into blocks by distance (default 25 tiles, adjustable), gives each plan recipe to the block that holds most of its machines, and names each group from its main recipes. Each group takes the planet of the surface its block is on. Plan nodes you have not built follow their consumer.

How it stays safe: the script copies the save, runs the game in benchmark mode with a private config and a private data folder, and deletes everything afterward. Your saves, mods and settings are not used or changed. The copy loads with a small script mod, which would disable achievements in a normal session, so only ever use this tool, not that mod, on a save you play. The file stays in the page and is not put in the link. Saves with mods other than the five official ones are not supported yet.

## Use it from Claude (MCP server)

`mcp/server.js` lets Claude run the same planner. No packages. It needs Node 18 or later.

Tools, all read only:
- `search_items`: find exact item names.
- `get_recipe`: recipe data, machines, and the research that unlocks it.
- `plan`: targets and rates in, machines, raw inputs, power and oil balance out. Settings cover planet, machine tiers, modules, beacons, alternate recipes and research.
- `propose_groups`: groups with planet tags and imports between planets. With `export_path` it seeds groups from a save export.
- `compare_factory`: compare a plan with a save export (`export_path`).

Setup in Claude Code: the repo has a `.mcp.json`, so open Claude Code in this folder and approve the `factorio-planner` server. For another folder or for Claude desktop, register the server with an absolute path:

```bash
claude mcp add factorio-planner -- node /full/path/to/mcp/server.js
```

Then ask for example: "Plan 1 chemical science pack per second, with productivity modules, and tell me how many machines I need on each planet." The server reads a file only when you give `export_path`, and only a planner export under 30 MB. It writes nothing. Test it with `node tests/mcp.test.js`.

## Update the game data

1. Run `factorio --dump-data`. It writes `script-output/data-raw-dump.json` in the Factorio user data folder.
2. Run `python -I tools/trim_data.py <path to data-raw-dump.json> data/data.json <game version>`.
3. Read the report it prints. It lists values it could not find. Nothing is invented.
4. Rebuild and run the tests.

## Known limits

- Gleba spoilage is not supported.
- Not modeled: quality module output, drill quality, boiler steam, uranium mining acid, oil field yield other than 100%, and how items travel between planets.
- Quality bonuses (+30% per level) are from the wiki, not the data dump. Beacon power is an upper bound.
- Results are checked against hand-derived ratios. They are not yet compared with Factorio Lab or the wiki.

## Legal

The planner code is MIT licensed (see `LICENSE`). The game data in `data/data.json` is numeric recipe, machine, and technology data taken from the game's own data dump. It belongs to Wube Software. Wube's terms of service do not mention tools that use game values. They do restrict distributing the game's art. This project ships no art, icons, or sounds. This is not legal advice. Ask Wube (factorio@factorio.com) before any commercial use or before adding icons.
