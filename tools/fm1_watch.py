#!/usr/bin/env python3
"""Watch for new firmware releases and grey out validations they supersede.

For every firmware with a validation record, look up its releases (GitHub, the project's
site or install page, or M-VAVE's release notes) the same way Octo-Vave does. When a
newer *stable* release than the validated version exists, the record gets
"supersededBy": "<that version>", and the dashboard shows its octopus grey until the new
release is validated too. Pre-releases never grey anything out. Records whose firmware
couldn't be checked are left alone.

    python tools/fm1_watch.py            # report only
    python tools/fm1_watch.py --write    # update firmware/validated.json

The nightly GitHub Action (.github/workflows/watch-releases.yml) runs it with --write
and commits the change. Standard library only; set GITHUB_TOKEN for a higher API limit.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  (release lookups shared with the app)
sys.path.insert(0, str(ROOT / "tools"))
import fm1_validate  # noqa: E402


def ver_key(v):
    """Same comparison as the app's verKey: "v1.6.0" == "1.6", "V15" == "15"."""
    s = str(v or "").strip().lower()
    m = re.search(r"(\d+(?:\.\d+)+)(.*)$", s)
    if not m:
        return re.sub(r"^[^0-9]*", "", s) or s
    return re.sub(r"(\.0+)+$", "", m.group(1)) + re.sub(r"[\s()\[\]]", "", m.group(2))


def releases_for(fw):
    """Newest-first releases for one catalog entry, or None when they couldn't be read."""
    src = fw.get("source", {})
    try:
        if src.get("type") == "github":
            data = json.loads(server.http_get(f"https://api.github.com/repos/{src['repo']}/releases?per_page=30",
                                              accept="application/vnd.github+json"))
            entry = server.release_entry({"rel": server._trim_releases(data)}, src.get("assetPatterns"))
            if src.get("site"):
                server.merge_site_releases(entry, src["site"])
        elif src.get("type") == "official":
            entry = server.official_release(src)
            if entry.get("error"):
                return None
        elif src.get("type") == "web":
            entry = server.web_release(src)
        else:
            return None
    except Exception as e:  # network trouble: leave this firmware alone tonight
        print(f"  {fw['id']}: not checked ({str(e)[:120]})")
        return None
    rels = [r for r in entry.get("releases", []) if r.get("version") and r["version"] != "latest"]
    return rels or None


def newer_stable(rels, version):
    """The newest stable release listed before the validated version (releases are newest first)."""
    keys = [ver_key(r["version"]) for r in rels]
    idx = keys.index(ver_key(version)) if ver_key(version) in keys else len(rels)
    return next((r for r in rels[:idx] if not r.get("prerelease")), None)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--write", action="store_true", help="update firmware/validated.json")
    args = p.parse_args()
    doc = fm1_validate.load(fm1_validate.VALIDATED, {})
    catalog = {f["id"]: f for f in fm1_validate.load(fm1_validate.CATALOG, {}).get("firmware", [])}
    records = doc.get("validations", [])
    changed = []
    for fid in sorted({v["id"] for v in records}):
        fw = catalog.get(fid)
        rels = releases_for(fw) if fw else None
        if rels is None:
            continue
        for v in (r for r in records if r["id"] == fid):
            newer = newer_stable(rels, v["version"])
            want = newer["version"] if newer else None
            if v.get("supersededBy") != want:
                if want:
                    v["supersededBy"] = want
                else:
                    v.pop("supersededBy", None)
                changed.append(f"{fid} {v['version']}: " + (f"superseded by {want} (grey)" if want else "current again"))
            print(f"  {fid} {v['version']}: " + (f"newer stable release {want}" if want else "current"))
    for c in changed:
        print("changed:", c)
    if changed and args.write:
        fm1_validate.save(doc)
        print(f"wrote {fm1_validate.VALIDATED.relative_to(ROOT)}")
    elif not changed:
        print("no change")


if __name__ == "__main__":
    main()
