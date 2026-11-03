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
