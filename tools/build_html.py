"""Bundle the planner into one self-contained HTML file.

Usage: python -I tools/build_html.py [output]
Default output: dist/factorio-planner.html
Inlines data/data.json, src/lp.js, src/solver.js, src/layout.js and src/app.js
into src/index.template.html. No network access is needed to open the result.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def script_safe(text):
    # Stop a literal "</script" in the content from ending the inline script.
    return text.replace("</script", "<\\/script")


def main():
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "factorio-planner.html"
    page = read("src/index.template.html")
    data = json.dumps(json.loads(read("data/data.json")), separators=(",", ":"))
    parts = {
        "/*DATA*/": "window.FACTORIO_DATA=" + data + ";",
        "/*LP*/": read("src/lp.js"),
        "/*SOLVER*/": read("src/solver.js"),
        "/*LAYOUT*/": read("src/layout.js"),
        "/*GROUPS*/": read("src/groups.js"),
        "/*SEED*/": read("src/seed.js"),
        "/*APP*/": read("src/app.js"),
    }
    for marker, body in parts.items():
        if page.count(marker) != 1:
            sys.exit("template marker missing or repeated: " + marker)
        page = page.replace(marker, script_safe(body))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
