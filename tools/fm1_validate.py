#!/usr/bin/env python3
"""Record firmware validations for the FM-1 Dashboard (firmware/validated.json).

A firmware counts as validated when it was installed on a real FM-1, ran, and was
reverted to stock. See VALIDATION.md for the procedure. Standard library only.

    python tools/fm1_validate.py list
    python tools/fm1_validate.py add felucca v1.6.1 --checks "generic sound check 11/11" --notes "..."
    python tools/fm1_validate.py add felucca v1.6.1 --steps install,run      # partial: not shown as validated
    python tools/fm1_validate.py remove felucca v1.6.1
"""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VALIDATED = ROOT / "firmware" / "validated.json"
CATALOG = ROOT / "firmware" / "catalog.json"
FW_STATE = ROOT / "data" / "firmware-state.json"
STEPS = ("install", "run", "revert")


def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(doc):
    tmp = VALIDATED.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(VALIDATED)


def norm(v):
    return str(v).strip().lower().lstrip("v")


def library_file(fid, version, name=None):
    """The downloaded file for this firmware/version, from the dashboard's library."""
    files = [m for m in load(FW_STATE, {}).get("files", {}).values()
             if m["id"] == fid and norm(m["version"]) == norm(version) and (not name or m["name"] == name)]
    fwsc = [m for m in files if m["name"].lower().endswith(".fwsc")]
    return (fwsc or files or [None])[0]


def cmd_list(doc, _args):
    rows = doc.get("validations", [])
    if not rows:
        print("no validations recorded")
    for v in rows:
        ok = all(v.get("steps", {}).get(s) for s in STEPS)
        steps = ",".join(s for s in STEPS if v.get("steps", {}).get(s)) or "-"
        print(f"{'VALID  ' if ok else 'partial'}  {v['id']:<12} {v['version']:<14} {v.get('date', ''):<10}  steps={steps}  {v.get('file') or ''}")


# validated.json is published: keep local paths, device instance IDs and emails out of it.
PRIVATE = re.compile(r"[A-Za-z]:\\|/Users/|/home/|\d&[0-9A-Fa-f]{6,}|USB\\|VID_[0-9A-F]{4}&PID|\S+@\S+\.\w+")


def cmd_add(doc, args):
    for field in ("checks", "notes"):
        hit = PRIVATE.search(getattr(args, field) or "")
        if hit:
            sys.exit(f"--{field} contains {hit.group(0)!r}, which looks like a local path, device ID or email; "
                     "firmware/validated.json is published, so leave it out")
    ids = {f["id"] for f in load(CATALOG, {}).get("firmware", [])}
    if args.id not in ids:
        sys.exit(f"unknown firmware id {args.id!r}; known: {', '.join(sorted(ids))}")
    steps = {s: s in args.steps.split(",") for s in STEPS}
    lib = library_file(args.id, args.version, args.file)
    if not lib and not args.no_library:
        sys.exit("no matching file in the dashboard library; download it there first, or pass --no-library")
    rec = {
        "id": args.id,
        "version": args.version,
        "file": (lib or {}).get("name") or args.file,
        "sha256": (lib or {}).get("sha256"),
        "date": args.date or datetime.date.today().isoformat(),
        "steps": steps,
        "checks": args.checks,
        "notes": args.notes,
    }
    rows = [v for v in doc.setdefault("validations", [])
            if not (v["id"] == args.id and norm(v["version"]) == norm(args.version))]
    rows.append(rec)
    doc["validations"] = sorted(rows, key=lambda v: (v["id"], v["date"]))
    save(doc)
    state = "VALIDATED" if all(steps.values()) else "recorded as partial"
    pin = f"{rec['file']}, sha256 {rec['sha256'][:12]}..." if rec["sha256"] else "no library file pinned"
    print(f"{args.id} {args.version}: {state} ({pin})")


def cmd_remove(doc, args):
    before = len(doc.get("validations", []))
    doc["validations"] = [v for v in doc.get("validations", [])
                          if not (v["id"] == args.id and norm(v["version"]) == norm(args.version))]
    save(doc)
    print(f"removed {before - len(doc['validations'])} record(s)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    a = sub.add_parser("add", help="record a validation")
    a.add_argument("id"); a.add_argument("version")
    a.add_argument("--file", help="file name in the library (default: the version's .fwsc)")
    a.add_argument("--steps", default="install,run,revert", help="completed steps, comma separated")
    a.add_argument("--checks", default="", help="what was checked while running, e.g. 'generic sound check 11/11'")
    a.add_argument("--notes", default="")
    a.add_argument("--date", help="YYYY-MM-DD (default today)")
    a.add_argument("--no-library", action="store_true", help="record without a library file / checksum")
    r = sub.add_parser("remove", help="delete a record")
    r.add_argument("id"); r.add_argument("version")
    args = p.parse_args()
    doc = load(VALIDATED, {"validations": []})
    {"list": cmd_list, "add": cmd_add, "remove": cmd_remove}[args.cmd](doc, args)


if __name__ == "__main__":
    main()
