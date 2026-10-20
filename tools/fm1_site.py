#!/usr/bin/env python3
"""Publish the Firmware page to the homepage (GitHub Pages, docs/).

The homepage shows the same cards as the app's Firmware tab. It renders them with the
app's own code from a snapshot of the data the tab uses, without anything from this
computer (library, installed firmware, history):

    docs/data/firmware.json   server.public_firmware() + schema_version, generated_at
    docs/js/fwcards.js        copy of web/fwcards.js      (card rendering)
    docs/js/fm1flash.js       copy of web/fm1flash.js     (Install button of the Validated list)
    docs/css/firmware.css     copy of web/css/firmware.css (card styles)
    docs/img/fw/*             copies of web/img/fw/*      (firmware screens)

    python tools/fm1_site.py --write            # snapshot from the local caches in data/ (no network; never older releases)
    python tools/fm1_site.py --refresh --write  # run Check for updates first, caches in a temp folder
    python tools/fm1_site.py --check            # copies match web/ and the snapshot is readable (CI)

The nightly GitHub Action (.github/workflows/watch-releases.yml) runs it with --refresh --write
and commits the result. A firmware whose releases couldn't be read tonight keeps the last
published ones, marked as cached. The snapshot is only rewritten when something besides the
timestamps changed. Standard library only; set GITHUB_TOKEN for a higher API limit.
"""
import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  (the app's own discovery, ranking and release lookups)

DOCS = ROOT / "docs"
SNAPSHOT = DOCS / "data" / "firmware.json"
SCHEMA_VERSION = 1
COPIES = [  # (source in web/, copy in docs/)
    (ROOT / "web" / "fwcards.js", DOCS / "js" / "fwcards.js"),
    (ROOT / "web" / "fm1flash.js", DOCS / "js" / "fm1flash.js"),
    (ROOT / "web" / "css" / "firmware.css", DOCS / "css" / "firmware.css"),
]
IMG_SRC, IMG_DST = ROOT / "web" / "img" / "fw", DOCS / "img" / "fw"


def copy_pairs():
    imgs = sorted(p for p in IMG_SRC.iterdir() if p.is_file())
    return COPIES + [(p, IMG_DST / p.name) for p in imgs]


def sync_copies():
    changed = []
    for src, dst in copy_pairs():
        if not dst.exists() or dst.read_bytes() != src.read_bytes():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            changed.append(dst.relative_to(ROOT).as_posix())
    wanted = {dst.name for _, dst in copy_pairs() if dst.parent == IMG_DST}
    for p in IMG_DST.iterdir():
        if p.is_file() and p.name not in wanted:
            p.unlink()
            changed.append(p.relative_to(ROOT).as_posix() + " (removed)")
    return changed


def build(previous):
    """public_firmware() as published: no auth details, failed sources carried over from last time."""
    data = server.public_firmware()
    data["discovery"].pop("auth", None)
    prev_sources = (previous or {}).get("releases", {}).get("sources", {})
    kept = []
    for fid, entry in data["releases"].get("sources", {}).items():
        old = prev_sources.get(fid)
        if not entry.get("releases") and old and old.get("releases"):
            why = entry.get("error") or "no release data"
            data["releases"]["sources"][fid] = {**old, "stale": f"Couldn't check on {time.strftime('%Y-%m-%d')} ({why}); showing the last published data"}
            kept.append(fid)
    return {"schema_version": SCHEMA_VERSION, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **data}, kept


def comparable(snap):
    """The snapshot without the fields that change on every run."""
    s = json.loads(json.dumps(snap))
    s.pop("generated_at", None)
    for k in ("checked", "stats"):
        s.get("discovery", {}).pop(k, None)
    s.get("releases", {}).pop("checked", None)
    return s


def check():
    problems = []
    for src, dst in copy_pairs():
        if not dst.exists() or dst.read_bytes() != src.read_bytes():
            problems.append(f"{dst.relative_to(ROOT).as_posix()} differs from {src.relative_to(ROOT).as_posix()}: run python tools/fm1_site.py --write")
    try:
        snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        problems.append(f"{SNAPSHOT.relative_to(ROOT).as_posix()}: {e}")
    else:
        if snap.get("schema_version") != SCHEMA_VERSION:
            problems.append(f"snapshot schema_version {snap.get('schema_version')!r}, expected {SCHEMA_VERSION}")
        for key in ("catalog", "ranked", "validated", "releases", "discovery"):
            if key not in snap:
                problems.append(f"snapshot is missing {key!r}")
        for key in ("library", "installed", "history", "libraryPath"):
            if key in snap:
                problems.append(f"snapshot must not carry this computer's {key!r}")
    for p in problems:
        print("  " + p)
    print("site OK" if not problems else f"{len(problems)} problem(s)")
    return not problems


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="run Check for updates first (network; caches in a temp folder)")
    ap.add_argument("--write", action="store_true", help="write the snapshot and sync the copies into docs/")
    ap.add_argument("--check", action="store_true", help="verify the copies and the snapshot; exit 1 on problems")
    a = ap.parse_args()
    if a.check:
        sys.exit(0 if check() else 1)

    previous = server.read_json(SNAPSHOT, None)
    if a.refresh:
        tmp = Path(tempfile.mkdtemp(prefix="fm1-site-"))
        server.DISCOVERY_CACHE, server.RELEASE_CACHE = tmp / "discovery-cache.json", tmp / "releases-cache.json"
        r = server.refresh_releases()
        print(f"Checked: {r['stats'].get('scanned')} projects, {r['stats'].get('requests')} GitHub requests")
        for n in r["notes"]:
            print("  note: " + n)
    snap, kept = build(previous)
    for fid in kept:
        print(f"  {fid}: not checked, kept the last published releases")
    print(f"Snapshot: {len(snap['catalog'])} firmware, {len(snap['ranked'])} ranked, "
          f"{len(snap['validated'])} validation records")
    if not a.write:
        return
    older = not a.refresh and previous and str(snap["releases"].get("checked", "")) < str(previous["releases"].get("checked", ""))
    if older:
        # This computer's caches predate the published list: keep its releases, ranking and cards
        # (the catalog includes cards built from discovery), but take validated.json as it is now.
        snap = {**previous, "generated_at": snap["generated_at"], "validated": snap["validated"]}
        print("  local caches are older than the published list: kept its releases and cards, updated validations (use --refresh for new releases)")
    if previous and comparable(previous) == comparable(snap):
        print(f"{SNAPSHOT.relative_to(ROOT).as_posix()}: nothing changed besides timestamps, left as is")
    else:
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(json.dumps(snap, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        print(f"wrote {SNAPSHOT.relative_to(ROOT).as_posix()} ({SNAPSHOT.stat().st_size // 1024} KB)")
    for c in sync_copies():
        print("synced " + c)


if __name__ == "__main__":
    main()
