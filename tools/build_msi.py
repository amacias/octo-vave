#!/usr/bin/env python3
"""Build the Windows installer: dist/Octo-Vave-<version>-win64.msi (recipe: packaging/setup_msi.py).

    python tools/build_msi.py                    # build, version 1.0.<number of commits>
    python tools/build_msi.py --version 1.2.0    # build with a chosen version (must be higher than the last)
    python tools/build_msi.py --test             # build, then install it, run it, check it, uninstall it
    python tools/build_msi.py --test-only dist/Octo-Vave-1.0.300-win64.msi
    python tools/build_msi.py --allow-dirty      # build from uncommitted changes (for trying things out)
    python tools/build_msi.py --publish dist/Octo-Vave-1.0.300-win64.msi --dry-run   # show the release
    python tools/build_msi.py --publish dist/Octo-Vave-1.0.300-win64.msi             # GitHub release

--publish puts a built MSI on a GitHub release v<version> as Octo-Vave-win64.msi (+ .sha256),
the fixed name behind the README and homepage links .../releases/latest/download/Octo-Vave-win64.msi.
It only publishes an MSI built from committed, pushed code that passed --test (see the
<msi>.build.json written next to it); --untested allows one whose install test couldn't run here.

The MSI bundles Python, server.py and web/, so users install with a double-click: no Python,
no start.cmd. It installs per user (no administrator prompt) into
%LOCALAPPDATA%\\Programs\\Octo-Vave; the app keeps its data in %LOCALAPPDATA%\\Octo-Vave.

The first run sets up build/venv with a pinned cx_Freeze from PyPI. Needs Windows and Python
3.12 or older for the MSI step (it uses the standard library's msilib, removed in 3.13).
build/ and dist/ are git-ignored.
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DIST = ROOT / "dist"
VENV = BUILD / "venv"
VPY = VENV / "Scripts" / "python.exe"
CX_FREEZE = "cx_Freeze==8.7.4"  # tested with Python 3.12.3 on 2026-11-07
INSTALL_DIR = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Octo-Vave"
REPO = "amacias/octo-vave"
ASSET = "Octo-Vave-win64.msi"  # the release asset name the download links point at; never change


def run(cmd, **kw):
    return subprocess.run([str(c) for c in cmd], cwd=ROOT, **kw)


def step(msg):
    print(f"\n== {msg}", flush=True)


def fail(msg, code=1):
    print(f"FAILED: {msg}", flush=True)
    sys.exit(code)


def ensure_venv():
    if sys.platform != "win32":
        fail("the MSI can only be built on Windows")
    if not VPY.exists():
        step(f"setting up {VENV.relative_to(ROOT)} (first build only)")
        run([sys.executable, "-m", "venv", VENV], check=True)
        run([VPY, "-m", "pip", "install", "-q", "--upgrade", "pip"], check=True)
    have = run([VPY, "-c", "import cx_Freeze; print(cx_Freeze.__version__)"], capture_output=True, text=True)
    if have.returncode or have.stdout.strip() != CX_FREEZE.split("==")[1]:
        step(f"installing {CX_FREEZE}")
        run([VPY, "-m", "pip", "install", "-q", CX_FREEZE], check=True)
    if run([VPY, "-c", "import msilib"], capture_output=True).returncode:
        fail(f"{VPY} has no msilib (Python 3.13+). Delete build/venv and rerun this script with Python 3.12.")


def git(*args):
    r = run(["git", *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def pick_version(args):
    if args.version:
        parts = args.version.split(".")
        if len(parts) != 3 or not all(p.isdigit() for p in parts) or int(parts[0]) > 255 or int(parts[1]) > 255 or int(parts[2]) > 65535:
            fail("--version must be major.minor.build (up to 255.255.65535), e.g. 1.2.0")
        return args.version
    count = git("rev-list", "--count", "HEAD")
    if not count:
        fail("couldn't count commits for the version; pass --version")
    return f"1.0.{count}"


def check_tree(args):
    dirty = [l for l in git("status", "--porcelain").splitlines() if l.strip()]
    if dirty and not args.allow_dirty:
        print("Uncommitted changes:\n  " + "\n  ".join(dirty[:15]))
        fail("commit first (the version number comes from the commit count), or pass --allow-dirty")
    return bool(dirty)


def build(version):
    step(f"building Octo-Vave {version}")
    for p in list(BUILD.glob("exe.win-*")) + list(BUILD.glob("bdist.win-*")):
        shutil.rmtree(p)
    msi = DIST / f"Octo-Vave-{version}-win64.msi"
    msi.unlink(missing_ok=True)
    log = BUILD / "msi-build.log"
    with log.open("w", encoding="utf-8") as f:
        r = run([VPY, "packaging/setup_msi.py", "bdist_msi", "--dist-dir", DIST],
                env={**os.environ, "OCTOVAVE_VERSION": version}, stdout=f, stderr=subprocess.STDOUT)
    if r.returncode or not msi.exists():
        print("".join(log.read_text(encoding="utf-8", errors="replace").splitlines(True)[-30:]))
        fail(f"cx_Freeze failed; full log in {log.relative_to(ROOT)}")
    shutil.rmtree(ROOT / "Octo_Vave.egg-info", ignore_errors=True)  # setuptools leaves it at the root
    exe = next(BUILD.glob("exe.win-*")) / "Octo-Vave.exe"
    return msi, exe


def selftest(exe):
    step("self-test of the built app")
    with tempfile.TemporaryDirectory() as home:
        r = subprocess.run([str(exe), "--selftest"], capture_output=True, text=True, timeout=60,
                           env={**os.environ, "OCTOVAVE_HOME": home})
    print("  " + (r.stdout.strip() or r.stderr.strip()))
    if r.returncode:
        fail("the built Octo-Vave.exe failed its self-test (HTTPS, web files, catalog, validations, formats)")


def checksum(msi):
    sha = hashlib.sha256(msi.read_bytes()).hexdigest()
    (msi.parent / (msi.name + ".sha256")).write_text(f"{sha}  {msi.name}\n", encoding="utf-8")
    return sha


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def msiexec(action, msi, log):
    r = run(["msiexec", action, msi, "/qn", "/l*v", log])
    return r.returncode


def install_test(msi):
    """Install the MSI for this user, start the installed app on a spare port with a throwaway
    data folder, check it answers, then stop it and uninstall. Refuses when Octo-Vave is already
    installed here: the test would replace that install and then remove it."""
    step(f"install test of {msi.name}")
    if (INSTALL_DIR / "Octo-Vave.exe").exists():
        print(f"  Octo-Vave is installed on this computer ({INSTALL_DIR}); the test would replace it and then")
        print("  uninstall it. Uninstall it first (Settings > Apps), or test this MSI by hand.")
        return False
    results, proc, home = [], None, Path(tempfile.mkdtemp(prefix="octovave-test-"))
    def check(name, ok, detail=""):
        results.append(ok)
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}", flush=True)
    try:
        code = msiexec("/i", msi, BUILD / "msi-install.log")
        check("installs for this user without an administrator prompt (msiexec /i /qn)", code == 0, f"exit {code}")
        exe = INSTALL_DIR / "Octo-Vave.exe"
        check("Octo-Vave.exe in %LOCALAPPDATA%\\Programs\\Octo-Vave", exe.exists())
        start_menu = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Octo-Vave.lnk"
        desktop = Path(os.environ["USERPROFILE"]) / "Desktop" / "Octo-Vave.lnk"
        check("Start menu and desktop shortcuts", start_menu.exists() and desktop.exists())
        if exe.exists():
            port = free_port()
            proc = subprocess.Popen([str(exe), "--no-browser"], env={**os.environ, "FM1_PORT": str(port), "OCTOVAVE_HOME": str(home)},
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
            up = False
            for _ in range(60):
                try:
                    up = json.loads(get(f"http://127.0.0.1:{port}/api/health")).get("ok") is True
                    break
                except OSError:
                    time.sleep(0.5)
            check("the installed app starts and answers", up, f"port {port}")
            if up:
                fw = json.loads(get(f"http://127.0.0.1:{port}/api/firmware", timeout=30))
                check("firmware data: catalog, validations, ranking", bool(fw.get("catalog")) and bool(fw.get("validated")) and bool(fw.get("ranked")),
                      f"{len(fw.get('catalog', []))} cards, {len(fw.get('validated', []))} validations, {len(fw.get('ranked', []))} ranked")
                page = get(f"http://127.0.0.1:{port}/").decode("utf-8", "replace")
                check("serves the app page", "<title>Octo-Vave" in page)
                check("writes its data to the user data folder", (home / "data" / "patches").is_dir() and (home / "firmware" / "library").is_dir())
                status = home / "data" / "live" / "status.json"
                fetched = json.loads(status.read_text(encoding="utf-8")).get("fetched", []) if status.is_file() else []
                check("fetches the latest firmware lists from GitHub", len(fetched) == 3, ", ".join(fetched) or "nothing fetched")
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if (INSTALL_DIR / "Octo-Vave.exe").exists() or results:
            code = msiexec("/x", msi, BUILD / "msi-uninstall.log")
            check("uninstalls cleanly (msiexec /x /qn)", code == 0 and not INSTALL_DIR.exists(), f"exit {code}")
        shutil.rmtree(home, ignore_errors=True)
    return all(results)


def build_info_path(msi):
    return msi.parent / (msi.name + ".build.json")


def write_build_info(msi, version, dirty, sha, tested=None):
    build_info_path(msi).write_text(json.dumps({
        "version": version, "commit": git("rev-parse", "HEAD"), "dirty": dirty, "sha256": sha, "tested": tested,
    }, indent=2), encoding="utf-8")


def release_notes(info, prev_tag):
    lines = [
        f"Octo-Vave {info['version']} for Windows 10 and 11 (64-bit).",
        "",
        f"**Install:** download `{ASSET}`, double-click it, then open Octo-Vave from the Start menu or the desktop.",
        "It installs for your Windows user only: no administrator prompt, no Python. A small window keeps it",
        "running (close it to stop) and the app opens in your browser at http://127.0.0.1:8765/ (use Chrome or Edge).",
        "",
        "The installer isn't code-signed yet, so Windows may say *Windows protected your PC*: click",
        "**More info**, then **Run anyway**. A newer installer replaces an older one; your settings, patches",
        r"and downloaded firmware stay in `%LOCALAPPDATA%\Octo-Vave`. Uninstall from Settings → Apps.",
        "",
        f"SHA256 (`{ASSET}`): `{info['sha256']}`",
        "",
        f"Built from {info['commit'][:7]}.",
    ]
    if prev_tag:
        log = git("log", "--format=- %s", f"{prev_tag}..{info['commit']}")
        if log:
            lines += ["", f"Changes since {prev_tag}:", "", *log.splitlines()[:40]]
    return "\n".join(lines) + "\n"


def publish(msi, dry_run, untested):
    step(f"publish {msi.name}")
    info_file = build_info_path(msi)
    if not msi.is_file() or not info_file.is_file():
        fail(f"{msi} or its {info_file.name} is missing: build it with this script first")
    info = json.loads(info_file.read_text(encoding="utf-8"))
    head = git("rev-parse", "HEAD")
    if info["dirty"]:
        fail("that MSI was built from uncommitted changes (--allow-dirty); commit, then build again")
    if info["commit"] != head:
        fail(f"that MSI was built from {info['commit'][:7]}, but HEAD is {head[:7]}; build again")
    if hashlib.sha256(msi.read_bytes()).hexdigest() != info["sha256"]:
        fail("the MSI changed since it was built")
    if info["tested"] is False:
        fail("that MSI failed its install test")
    if info["tested"] is None and not untested:
        fail("that MSI hasn't passed --test; test it (or install it by hand), then pass --untested")
    run(["git", "fetch", "-q", "origin"])
    if not git("branch", "-r", "--contains", head):
        fail("HEAD isn't pushed to GitHub yet; push first, so the release's tag points at published code")
    tag = f"v{info['version']}"
    if run(["gh", "release", "view", tag, "-R", REPO], capture_output=True).returncode == 0:
        fail(f"release {tag} already exists")
    prev = run(["gh", "release", "view", "-R", REPO, "--json", "tagName", "-q", ".tagName"], capture_output=True, text=True)
    notes = release_notes(info, prev.stdout.strip() if prev.returncode == 0 else "")
    out = DIST / "release"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    shutil.copy2(msi, out / ASSET)
    (out / (ASSET + ".sha256")).write_text(f"{info['sha256']}  {ASSET}\n", encoding="utf-8")
    (out / "notes.md").write_text(notes, encoding="utf-8")
    print(f"  tag      {tag} at {head[:7]}")
    print(f"  title    Octo-Vave {info['version']}")
    print(f"  assets   {ASSET}, {ASSET}.sha256")
    print("  notes    (dist/release/notes.md)\n")
    print("    " + notes.rstrip().replace("\n", "\n    "))
    if dry_run:
        print("\ndry run: nothing published")
        return
    r = run(["gh", "release", "create", tag, out / ASSET, out / (ASSET + ".sha256"), "-R", REPO, "--target", head,
             "--title", f"Octo-Vave {info['version']}", "--notes-file", out / "notes.md", "--latest"])
    if r.returncode:
        fail("gh release create failed")
    print(f"\npublished: https://github.com/{REPO}/releases/tag/{tag}")
    print(f"download:  https://github.com/{REPO}/releases/latest/download/{ASSET}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", help="major.minor.build; default 1.0.<commit count>")
    p.add_argument("--test", action="store_true", help="after building: install, run, check and uninstall the MSI")
    p.add_argument("--test-only", metavar="MSI", help="only run the install test on an MSI already built")
    p.add_argument("--allow-dirty", action="store_true", help="build even with uncommitted changes")
    p.add_argument("--publish", metavar="MSI", help="put a built, tested MSI on a GitHub release")
    p.add_argument("--dry-run", action="store_true", help="with --publish: show the release, publish nothing")
    p.add_argument("--untested", action="store_true", help="with --publish: allow an MSI whose --test didn't run")
    args = p.parse_args()
    sys.stdout.reconfigure(errors="replace")  # a cp1252 console can't print every character

    if args.publish:
        return publish(Path(args.publish).resolve(), args.dry_run, args.untested)
    if args.test_only:
        sys.exit(0 if install_test(Path(args.test_only).resolve()) else 1)
    ensure_venv()
    dirty = check_tree(args)
    version = pick_version(args)
    msi, exe = build(version)
    selftest(exe)
    sha = checksum(msi)
    write_build_info(msi, version, dirty, sha)
    step("built")
    print(f"  {msi.relative_to(ROOT)}  ({msi.stat().st_size / 1048576:.1f} MB)")
    print(f"  version {version}{'  (includes uncommitted changes)' if dirty else ''}")
    print(f"  SHA256  {sha}  (also in {msi.name}.sha256)")
    if args.test:
        passed = install_test(msi)
        write_build_info(msi, version, dirty, sha, tested=passed)
        if not passed:
            fail("install test")
    print("\nOK")


if __name__ == "__main__":
    main()
