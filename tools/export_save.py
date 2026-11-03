"""Export machines and production stats from a COPY of a Factorio save.

Usage:
    python -I tools/export_save.py <save.zip> [output.json] [--factorio <factorio.exe>]

What it does, and what it does not touch:
  1. Copies the save into a new temporary folder. The original is only read.
  2. Writes a private game config in that folder. Its "write-data" path is the temporary folder,
     so saves, autosaves, logs and script-output stay there. Your real Factorio user data folder
     (saves, mods, settings) is not used and not changed.
  3. Puts the planner-export mod in that folder's mods directory, enabled together with the
     official mods (base, elevated-rails, quality, recycler, space-age).
  4. Runs the game in benchmark mode for a few ticks, which loads the save with no window, runs
     the mod once, and quits. Nothing is saved back.
  5. Copies planner-export.json to the output path and deletes the temporary folder.

The copy is loaded with a script mod, which is what disables achievements in a normal session.
Only the copy is affected. Do not point this at a save in a running game session.

Not verified: saves made with other mods. The mod list below is the five official mods. If the
save needs others, the game stops with an error and this script shows its log.
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
MOD_SRC = ROOT / "game-export" / "planner-export"
OFFICIAL_MODS = ["base", "elevated-rails", "quality", "recycler", "space-age"]
BENCH_TICKS = 330   # a little more than WAIT_TICKS in control.lua


def find_factorio(explicit):
    cands = []
    if explicit:
        cands.append(explicit)
    if os.environ.get("FACTORIO_EXE"):
        cands.append(os.environ["FACTORIO_EXE"])
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base:
            cands.append(os.path.join(base, "Steam", "steamapps", "common", "Factorio", "bin", "x64", "factorio.exe"))
    cands.append(os.path.expanduser("~/.steam/steam/steamapps/common/Factorio/bin/x64/factorio"))
    cands.append(shutil.which("factorio") or "")
    for c in cands:
        if c and os.path.isfile(c):
            return c
    sys.exit("Could not find factorio. Pass --factorio <path> or set FACTORIO_EXE.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("save")
    ap.add_argument("output", nargs="?", default="planner-export.json")
    ap.add_argument("--factorio")
    ap.add_argument("--keep", action="store_true", help="keep the temporary folder for debugging")
    a = ap.parse_args()

    save = pathlib.Path(a.save)
    if not save.is_file() or save.suffix != ".zip":
        sys.exit("Save must be a .zip file: " + a.save)
    exe = find_factorio(a.factorio)

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="planner-export-"))
    try:
        write = tmp / "write"
        mods = write / "mods"
        mods.mkdir(parents=True)
        shutil.copytree(MOD_SRC, mods / "planner-export_0.1.0")
        (mods / "mod-list.json").write_text(json.dumps(
            {"mods": [{"name": n, "enabled": True} for n in OFFICIAL_MODS + ["planner-export"]]}), encoding="utf-8")
        copy = tmp / "save-copy.zip"
        shutil.copy2(save, copy)
        cfg = tmp / "config.ini"
        cfg.write_text("[path]\nread-data=__PATH__system-read-data__\nwrite-data=" + str(write) + "\n", encoding="utf-8")

        cmd = [exe, "--config", str(cfg), "--benchmark", str(copy), "--benchmark-ticks", str(BENCH_TICKS),
               "--disable-audio"]
        print("running:", " ".join(cmd))
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        result = write / "script-output" / "planner-export.json"
        if r.returncode != 0 or not result.is_file():
            print("game exit code:", r.returncode)
            log = write / "factorio-current.log"
            print((r.stdout or "")[-2000:], (r.stderr or "")[-2000:])
            if log.is_file():
                print("--- log tail ---")
                print(log.read_text(encoding="utf-8", errors="replace")[-3000:])
            err = write / "script-output" / "planner-export-error.txt"
            if err.is_file():
                print("--- mod error ---", err.read_text(encoding="utf-8", errors="replace"))
            sys.exit(1)
        out = pathlib.Path(a.output)
        shutil.copy2(result, out)
        data = json.loads(out.read_text(encoding="utf-8"))
        print(f"wrote {out}: {len(data['machines'])} machine groups, tick {data['tick']}, failures: {data.get('failures') or 'none'}")
    finally:
        if a.keep:
            print("kept", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
