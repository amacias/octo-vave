"""cx_Freeze recipe for the Windows installer (Octo-Vave-<version>-win64.msi).

Run it through tools/build_msi.py, which sets up the build environment and the version:

    python tools/build_msi.py            # build dist/Octo-Vave-<version>-win64.msi
    python tools/build_msi.py --test     # build, then install, run, check and uninstall it

What the MSI does:
- installs Octo-Vave.exe (Python, server.py and the web app bundled) per user, into
  %LOCALAPPDATA%\\Programs\\Octo-Vave: no administrator prompt, no Python needed;
- adds Octo-Vave to the Start menu and the desktop; Octo-Vave.exe opens a small console
  window (close it to stop) and the app in the default browser at http://127.0.0.1:8765/;
- keeps what the app writes (settings, patches, downloaded firmware) in
  %LOCALAPPDATA%\\Octo-Vave, which upgrades and uninstalling leave alone;
- replaces an older Octo-Vave on install (same upgrade code, higher version).
"""
import json
import os
import subprocess
from pathlib import Path

from cx_Freeze import Executable, setup

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)  # include_files paths below are relative to the repository

VERSION = os.environ.get("OCTOVAVE_VERSION", "1.0.0")
# Never change: Windows Installer uses it to find and replace older Octo-Vave installs.
UPGRADE_CODE = "{171CB56E-EB47-4966-A662-F91CC6B0FC12}"
ICON = "packaging/octo.ico"

# The version the app shows in its header (server.app_version reads it from the install folder).
def _commit():
    try:
        return subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
    except OSError:
        return ""


VERSION_JSON = ROOT / "build" / "version.json"
VERSION_JSON.parent.mkdir(exist_ok=True)
VERSION_JSON.write_text(json.dumps({"version": VERSION, "commit": _commit()}) + "
", encoding="utf-8")

include_files = [
    ("web", "web"),
    ("firmware/catalog.json", "firmware/catalog.json"),
    ("firmware/directory.json", "firmware/directory.json"),
    ("firmware/validated.json", "firmware/validated.json"),
    ("firmware/formats", "firmware/formats"),
    ("docs/data/firmware.json", "docs/data/firmware.json"),  # published ranking + releases until the first Check for updates
    ("LICENSE", "LICENSE.txt"),
    ("build/version.json", "version.json"),
]

build_exe = {
    "include_files": include_files,
    "includes": ["ssl", "concurrent.futures", "http.server", "urllib.request", "hashlib"],
    "excludes": ["tkinter", "unittest", "pydoc_data", "test", "lib2to3", "idlelib", "turtledemo", "sqlite3"],
    "include_msvcr": True,  # the Visual C++ runtime, so it runs without the redistributable
    "optimize": 1,
    "silent_level": 1,
}

# Desktop shortcut (the Start menu one comes from the Executable below).
shortcuts = [
    ("DesktopShortcut", "DesktopFolder", "Octo-Vave", "TARGETDIR", "[TARGETDIR]Octo-Vave.exe",
     None, "Octo-Vave: firmware, patches and play for the M-VAVE FM-1", None, None, None, None, "TARGETDIR"),
]

bdist_msi = {
    "upgrade_code": UPGRADE_CODE,
    "all_users": False,
    "initial_target_dir": r"[LocalAppDataFolder]Programs\Octo-Vave",
    "install_icon": ICON,
    "add_to_path": False,
    "summary_data": {
        "author": "Artificial Music",
        "comments": "Octo-Vave: every free firmware for the M-VAVE FM-1, plus patches and play, in your browser.",
        "keywords": "M-VAVE FM-1 firmware synth MIDI",
    },
    "data": {"Shortcut": shortcuts},
}

setup(
    name="Octo-Vave",
    version=VERSION,
    description="Octo-Vave",
    author="Artificial Music",
    url="https://github.com/amacias/octo-vave",
    license="MIT",
    options={"build_exe": build_exe, "bdist_msi": bdist_msi},
    executables=[Executable(
        "server.py",
        base="console",
        target_name="Octo-Vave.exe",
        icon=ICON,
        shortcut_name="Octo-Vave",
        shortcut_dir="ProgramMenuFolder",
        copyright="Artificial Music · MIT License",
    )],
)

