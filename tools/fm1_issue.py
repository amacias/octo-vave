#!/usr/bin/env python3
"""Turn an accepted validation report (the GitHub issue form) into a validated.json record.

Run by .github/workflows/validation-record.yml when a maintainer labels a "validation" issue
"accepted". The report comes in through the environment (ISSUE_BODY, ISSUE_NUMBER), never on a
command line, and is treated as untrusted text:
  0. community firmware must be on the top 30 leaderboard the homepage publishes (docs/data/firmware.json);
     M-VAVE's own firmware (catalog kind stock or official) is always accepted;
  1. the record's fields come from the form; the ones a link can't fill in (Firmware, Result,
     the step boxes) come from the "Record from Octo-Vave" JSON the app's Submit button adds;
  2. the reported file is looked up in the firmware's own release list and downloaded: its
     SHA256 must match the report, so the record pins the real release file;
  3. tools/fm1_validate.py add writes the record, with the same rules as every other record,
     marked "method": "manual".
It only changes firmware/validated.json; the workflow puts that on a branch for the maintainer
to review. On a problem it exits 1 and writes the reason to --message-file for the issue.

    python tools/fm1_issue.py --body-file report.md [--dry-run]     # try a report locally
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlencode

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  (the app's own release lookups and download rules)

STEP_WORDS = (("install", "installed"), ("run", "ran"), ("revert", "reverted"))
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,47}$")
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,95}\.fwsc$")


class Problem(Exception):
    pass


def sections(body):
    """The issue form's answers by label: '### Label' then the answer ('_No response_' = empty)."""
    out, label, lines = {}, None, []
    for line in (body or "").replace("\r\n", "\n").split("\n") + ["### "]:
        if line.startswith("### "):
            if label is not None:
                text = "\n".join(lines).strip()
                out[label] = "" if text == "_No response_" else text
            label, lines = line[4:].strip(), []
        else:
            lines.append(line)
    return out


def app_record(text):
    """The JSON the app put in "Record from Octo-Vave" (in a code fence or not), or {}."""
    text = re.sub(r"^```[a-z]*\s*|\s*```$", "", (text or "").strip())
    if not text:
        return {}
    try:
        rec = json.loads(text)
    except json.JSONDecodeError as e:
        raise Problem(f"The 'Record from Octo-Vave' field isn't valid JSON ({e.msg}). Send it again from the app, or clear it.")
    if not isinstance(rec, dict):
        raise Problem("The 'Record from Octo-Vave' field should hold one record.")
    return rec


def report(body):
    """The record's fields from the form, completed from the app's record."""
    s = sections(body)
    for label in ("Firmware", "Result"):  # a dropdown left unpicked comes through as "None"
        if s.get(label) == "None":
            s[label] = ""
    rec = app_record(s.get("Record from Octo-Vave"))
    fid = s.get("Firmware", "") or str(rec.get("id", ""))
    if fid == "other":
        raise Problem("Firmware 'other' needs a catalog entry first (firmware/catalog.json); then the report can be accepted again.")
    known = {f["id"]: f for f in server.catalog()["firmware"]}
    if fid not in known:
        raise Problem(f"Unknown firmware {fid!r}: pick it in the Firmware list.")
    if known[fid].get("kind") == "community" and fid not in top_ids():  # M-VAVE's own (stock, official) always pass
        raise Problem(f"{fid} isn't on the top 30 leaderboard (the homepage ranking), and reports are only accepted for "
                      "firmware on it. If it makes the leaderboard later, remove and add the label to try again.")
    version = s.get("Version", "").strip() or str(rec.get("version", ""))
    file = s.get("File you flashed", "").strip() or str(rec.get("file", ""))
    sha = (s.get("SHA256 of that file", "").strip() or str(rec.get("sha256", ""))).lower()
    if not VERSION_RE.match(version):
        raise Problem(f"Version {version!r} doesn't look like a release name.")
    if not FILE_RE.match(file):
        raise Problem(f"File {file!r} should be the .fwsc file name from the release.")
    if not SHA_RE.match(sha):
        raise Problem("SHA256 should be 64 hex digits.")
    result = (s.get("Result", "").split(" ", 1)[0] or str(rec.get("result", ""))).lower()
    if result not in ("clean", "issues", "failed"):
        raise Problem("Pick a Result: clean, issues or failed.")
    ticked = [ln.lower() for ln in s.get("Steps completed", "").splitlines() if re.match(r"\s*- \[[xX]\]", ln)]
    if ticked:
        steps = [k for k, word in STEP_WORDS if any(word in ln for ln in ticked)]
    else:
        steps = [k for k, _ in STEP_WORDS if (rec.get("steps") or {}).get(k) is True]
    date = str(rec.get("date", ""))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        date = datetime.date.today().isoformat()
    # the stock the test installed from and reverted to (#19): "V16", "v16", "16", "Stock V16"; empty = V15
    said = s.get("Stock firmware before installing", "").strip() or str(rec.get("stock") or "")
    m = re.fullmatch(r"(?:stock\s*)?v?\s*(\d{1,3})", said.strip(), re.I)
    if said and not m:
        raise Problem(f"Stock firmware before installing {said!r} should be a stock version like V15 or V16.")
    return {"id": fid, "version": version, "file": file, "sha256": sha, "result": result, "steps": steps,
            "checks": s.get("What you checked", ""), "notes": s.get("Notes", ""), "date": date,
            "stock": f"V{int(m.group(1))}" if m else ""}


def top_ids():
    """Ids on the published top 30 leaderboard: the homepage snapshot's ranking (docs/data/firmware.json,
    refreshed by tools/fm1_site.py --write), so the list is the one the maintainer committed."""
    snap = json.loads((ROOT / "docs" / "data" / "firmware.json").read_text(encoding="utf-8"))
    return {p["id"] for p in snap.get("ranked", [])[:server.TOP_LIST] if p.get("id")}


def norm(v):
    return str(v).strip().lower().lstrip("v")


def release_files(fid):
    """(version, name, url, published sha256 or None) for every file the firmware's releases list."""
    src = server.catalog_entry(fid).get("source", {})
    rels = []
    if src.get("type") == "github":
        for page in range(1, 4):
            data = json.loads(server.http_get(f"https://api.github.com/repos/{src['repo']}/releases?per_page=100&page={page}",
                                              accept="application/vnd.github+json"))
            rels += [{"version": r["tag_name"], "assets": [{"name": a["name"], "url": a["browser_download_url"]}
                                                           for a in r.get("assets", [])]} for r in data if not r.get("draft")]
            if len(data) < 100:
                break
        if src.get("site"):
            rels += server.site_releases(src["site"])
    elif src.get("type") == "official":
        rels = server.official_release(src)["releases"]
    elif src.get("type") == "web":
        rels = server.web_release(src)["releases"]
    return [(r["version"], a["name"], a["url"], a.get("sha256")) for r in rels for a in r.get("assets", [])]


def verify(rec):
    """Download the reported file from its release and compare checksums."""
    try:
        files = release_files(rec["id"])
    except Exception as e:
        raise Problem(f"Couldn't read the {rec['id']} release list ({e}); try again later (remove and add the label).")
    match = [f for f in files if f[1] == rec["file"] and norm(f[0]) == norm(rec["version"])]
    if not match:
        named = sorted({f[0] for f in files if f[1] == rec["file"]})
        raise Problem(f"{rec['file']} isn't in the {rec['version']} release" + (f" (it is in {', '.join(named)})" if named else "") +
                      ". Check the version and file name in the report.")
    _, _, url, published = match[0]
    try:
        data = server.http_get(url)
    except Exception as e:
        raise Problem(f"Couldn't download {rec['file']} from its release ({e}); check the file by hand.")
    got = hashlib.sha256(data).hexdigest()
    if got != rec["sha256"]:
        raise Problem(f"The release's {rec['file']} has SHA256 {got[:12]}…, the report says {rec['sha256'][:12]}…: "
                      "the tested file isn't the release file (or the checksum was copied wrong).")
    if published and published.lower() != got:
        raise Problem(f"{rec['file']} doesn't match the checksum its project publishes.")
    return url


def add(rec, dry_run):
    args = [sys.executable, "-I", str(ROOT / "tools" / "fm1_validate.py"), "add", rec["id"], rec["version"],
            "--file", rec["file"], "--sha256", rec["sha256"], "--result", rec["result"], "--steps", ",".join(rec["steps"]),
            "--checks", rec["checks"], "--notes", rec["notes"], "--date", rec["date"], "--method", "manual"]
    if rec.get("stock"):
        args += ["--stock", rec["stock"]]
    if dry_run:
        return "dry run: " + " ".join(args[3:7]) + " ..."
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        raise Problem((r.stderr or r.stdout).strip())
    return r.stdout.strip()


def pr_comment(rec, summary, url, number):
    repo = os.environ.get("GITHUB_REPOSITORY", "amacias/octo-vave")
    branch = f"validation/issue-{number}"
    title = f"Validation: {rec['id']} {rec['version']} ({rec['result']})"
    body = (f"Record from #{number}, prepared by the validation workflow. The reported file was downloaded from its "
            f"release and its SHA256 matches.\n\nCloses #{number}")
    link = f"https://github.com/{repo}/compare/main...{quote(branch)}?" + urlencode({"expand": 1, "title": title, "body": body})
    return (f"The record is ready on branch `{branch}`:\n\n```\n{summary}\n```\n"
            f"The reported file matches the release ({url}).\n\n"
            f"**[Open the pull request]({link})**, review it and merge it to publish the octopus. "
            "Nothing changes on `main` until then.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--body-file", help="read the report from this file instead of ISSUE_BODY")
    p.add_argument("--message-file", help="write the problem (or the PR comment) here for the issue")
    p.add_argument("--dry-run", action="store_true", help="check the report and the file, don't write the record")
    a = p.parse_args()
    body = Path(a.body_file).read_text(encoding="utf-8") if a.body_file else os.environ.get("ISSUE_BODY", "")
    number = os.environ.get("ISSUE_NUMBER", "0")
    try:
        rec = report(body)
        url = verify(rec)
        summary = add(rec, a.dry_run)
    except Problem as e:
        print(e, file=sys.stderr)
        if a.message_file:
            Path(a.message_file).write_text(str(e), encoding="utf-8")
        sys.exit(1)
    print(summary)
    if a.message_file:
        Path(a.message_file).write_text(pr_comment(rec, summary, url, number), encoding="utf-8")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"title=Validation record from #{number}: {rec['id']} {rec['version']} ({rec['result']})\n")


if __name__ == "__main__":
    main()
