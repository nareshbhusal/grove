#!/usr/bin/env python3
"""Build grove-<version>.xpi with nothing but Python 3 (no npm, no zip command).

    ./scripts/make-xpi.py              writes dist/grove-<version>.xpi
    ./scripts/make-xpi.py --out DIR    writes it into DIR instead

Install the result from about:addons -> gear -> "Install Add-on From File...".
Firefox calls a package "corrupt" unless manifest.json is at the TOP of the
archive, so this packs the files themselves, never the folder that holds them.
Unsigned packages only run on Firefox Developer Edition, Nightly and ESR with
xpinstall.signing.required set to false (see README.md for signing instead).
"""
import argparse
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Only these go into the package. Tests, scripts, docs and node_modules stay out.
INCLUDE = ["manifest.json", "icons", "src"]
SKIP_NAMES = {".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".swp", ".orig", ".rej", "~")
STAMP = (2026, 1, 1, 0, 0, 0)  # fixed, so the same files always give the same package


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def collect():
    files = []
    for entry in INCLUDE:
        path = ROOT / entry
        if not path.exists():
            fail(f"{entry} is missing from {ROOT}")
        candidates = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
        for p in candidates:
            rel = p.relative_to(ROOT)
            if p.name in SKIP_NAMES or p.name.endswith(SKIP_SUFFIXES) or "__pycache__" in rel.parts:
                continue
            files.append(rel)
    # manifest.json first, as the packaging tools do
    files.sort(key=lambda r: (r.as_posix() != "manifest.json", r.as_posix()))
    return files


def referenced(manifest):
    """Files the manifest points at: if any is missing the add-on is broken."""
    out = []
    bg = manifest.get("background", {})
    out += [bg["page"]] if "page" in bg else bg.get("scripts", [])
    for key in ("sidebar_action", "browser_action", "page_action"):
        block = manifest.get(key) or {}
        out += [block[k] for k in ("default_panel", "default_popup") if k in block]
    if "options_ui" in manifest:
        out.append(manifest["options_ui"]["page"])
    for icons in [manifest.get("icons", {})] + [(manifest.get(k) or {}).get("default_icon") for k in ("sidebar_action", "browser_action")]:
        if isinstance(icons, dict):
            out += list(icons.values())
        elif isinstance(icons, str):
            out.append(icons)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=str(ROOT / "dist"), help="folder to write the .xpi into (default: dist)")
    args = ap.parse_args()

    try:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        fail(f"manifest.json cannot be read: {err}")
    version = manifest.get("version")
    if not version:
        fail("manifest.json has no version")

    missing = sorted({r for r in referenced(manifest) if not (ROOT / r).is_file()})
    if missing:
        fail("manifest.json points at files that do not exist: " + ", ".join(missing))

    files = collect()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"grove-{version}.xpi"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            info = zipfile.ZipInfo(rel.as_posix(), STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, (ROOT / rel).read_bytes())

    # Read it back the way Firefox will.
    with zipfile.ZipFile(target) as z:
        bad = z.testzip()
        if bad:
            fail(f"{bad} is damaged in the package")
        names = z.namelist()
        if "manifest.json" not in names:
            fail("manifest.json is not at the top of the package")
        packed = json.loads(z.read("manifest.json"))
        if packed.get("version") != version:
            fail("the packed manifest differs from manifest.json")

    print(f"Built {target}  ({len(names)} files, {target.stat().st_size // 1024} KB, version {version})")


if __name__ == "__main__":
    main()
