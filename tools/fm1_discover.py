#!/usr/bin/env python3
"""Run the Firmware tab's discovery from the command line and print the live ranking.

    python tools/fm1_discover.py            # check now (same as "Check for updates")
    python tools/fm1_discover.py --cached   # print the cached ranking, no network
    python tools/fm1_discover.py --write    # also store it as the offline fallback
                                            # (firmware/directory.json, tracked)

Uses the anonymous GitHub API unless GITHUB_TOKEN is set or FM1_USE_GH=1.
"""
import importlib.util
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("fm1_server", ROOT / "server.py")
server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)


def main():
    if "--cached" not in sys.argv:
        r = server.refresh_releases()
        st = r["stats"]
        print(f"checked {r['checked']}: {st['scanned']} repos due, {st['requests']} API requests "
              f"({st['notModified']} unchanged), {st['skipped']} kept old data")
        for n in r["notes"]:
            print("  note:", n)
    ranked, _, _ = server.build_ranking()
    for p in ranked:
        mark = "" if p["curated"] else "  (not curated)"
        live = "" if p["live"] else "  [snapshot]"
        print(f"#{p['rank']:<3}{p['name'][:26]:<27}{p['repo'][:40]:<41}★{p['stars']:<5}⬇{p['downloads']:<6}"
              f"{p['score']:.3f}{mark}{live}")
    if "--write" in sys.argv:
        server.write_json(server.DIRECTORY, {
            "source": server.discovery_config()["awesomePage"],
            "updated": time.strftime("%Y-%m-%d"),
            "note": "Offline fallback for the Firmware tab: the 30 most popular free, open-source FM-1 firmwares "
                    "(cards #1-10, list #11-30) by ln(1+stars) + ln(1+.fwsc downloads). Regenerate with "
                    "python tools/fm1_discover.py --write.",
            "projects": [{k: p[k] for k in ("rank", "id", "repo", "name", "url", "desc", "license", "stars",
                                            "downloads", "score", "curated")} for p in ranked],
        })
        print("wrote", server.DIRECTORY.relative_to(ROOT))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
