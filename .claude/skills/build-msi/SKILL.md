---
name: build-msi
description: Build (and test) the Windows installer for Octo-Vave, dist/Octo-Vave-<version>-win64.msi, which bundles Python, server.py and the web app so people install with a double-click instead of installing Python and running start.cmd. Use when the user asks to build, make, package, release or test the MSI or installer, or says they made a major update and want a new installer.
---

# Build the Octo-Vave MSI

The MSI is built by `tools/build_msi.py` from the recipe in `packaging/setup_msi.py` (cx_Freeze).
It installs per user, without an administrator prompt, into `%LOCALAPPDATA%\Programs\Octo-Vave`,
with Start menu and desktop shortcuts. Octo-Vave.exe opens a small console window (close it to
stop) and the app in the default browser at http://127.0.0.1:8765/, the same address as
`python server.py`, so Chrome's MIDI permission carries over. The installed app keeps its data
(settings, patches, downloaded firmware) in `%LOCALAPPDATA%\Octo-Vave`; upgrades and uninstalling
leave that folder alone. A newer MSI replaces an older install (fixed upgrade code, higher version).

## Steps

1. **Check the tree.** Run `git status --short` and `git log origin/main..HEAD --oneline`.
   The version is `1.0.<number of commits>`, so the MSI should come from committed code.
   If there are uncommitted changes, ask whether to commit them first (don't commit on your own).
   Use `--allow-dirty` only for a throwaway trial build, and say so in the report.

2. **Offline ranking (optional).** A fresh install shows the ranking from `firmware/directory.json`
   until its first Check for updates. If that file's `"updated"` date is more than ~2 weeks old,
   offer to refresh it first with `python tools/fm1_discover.py --write` (anonymous GitHub API,
   see the github-api-anonymous memory) and commit it. Skip if the user doesn't want it.

3. **Build and test.**
   ```
   python tools/build_msi.py --test
   ```
   This sets up `build/venv` with the pinned cx_Freeze on the first run (needs internet once),
   builds the MSI, runs the built app's `--selftest` (HTTPS, web files, catalog, validations),
   writes `dist/<msi>.sha256`, then installs the MSI for this user, starts the installed app on a
   spare port with a throwaway data folder, checks the API, the page and the data folder,
   stops it and uninstalls it. Every check prints PASS or FAIL. It also checks that the
   installed app fetched the repository's current `validated.json`, `catalog.json` and
   `directory.json` (the installed app does this at start and on Check for updates, into
   `data/live/`), so this check needs internet and the files pushed to GitHub.
   - If Octo-Vave is installed on this computer, `--test` refuses (it would replace and then
     remove that install). Build without `--test` and tell the user to test by installing over it.
   - A chosen version: `--version 1.2.0`. It must be higher than any MSI already handed out,
     or Windows Installer won't upgrade over it (the default from the commit count always rises).

4. **Report** the MSI path, version, size, SHA256 and the test results. Remind the user:
   - The MSI isn't code-signed: Windows SmartScreen shows "Windows protected your PC"; people
     click **More info → Run anyway**. Signing needs a code-signing certificate (offer, don't buy).
   - Only one Octo-Vave runs at a time on port 8765. Starting it while `python server.py` (or
     another copy) runs just opens the browser on the running one.
   - Uninstall: Settings → Apps → Octo-Vave. Data stays in `%LOCALAPPDATA%\Octo-Vave`.

5. **Publishing (only when the user asks).** A GitHub release is public. The README's Quick start
   and the homepage's "Install the Full Featured App" button both link to
   `https://github.com/amacias/octo-vave/releases/latest/download/Octo-Vave-win64.msi`, so
   publishing a new release is all it takes to update them.
   - The code must be committed and pushed (`git log origin/main..HEAD` empty; push recipe in the
     fm1-project memory), and the MSI built from that HEAD with `--test` passing.
   - `python tools/build_msi.py --publish dist/Octo-Vave-<version>-win64.msi --dry-run` shows the
     tag (`v<version>`), title and notes (in `dist/release/notes.md`). Show them to the user and
     wait for an OK, unless the user's request already approved publishing this build.
   - Then the same command without `--dry-run`. It uploads `Octo-Vave-win64.msi` and its `.sha256`
     (fixed names: never rename, the download links depend on them) and marks the release latest.
   - Check the download link answers (`curl -sIL <link> | grep -i "^http\|content-length"`).
   - `--untested` publishes an MSI whose install test couldn't run here (Octo-Vave installed on this
     computer); only after the user has installed and tried it by hand.

## When something breaks

- **`no msilib`**: the MSI step needs Python 3.12 or older (msilib left the standard library in
  3.13). Delete `build/venv` and run the script with a 3.12 interpreter.
- **cx_Freeze errors**: the full log is `build/msi-build.log`. The pin is `CX_FREEZE` in
  `tools/build_msi.py`; change it only together with a successful `--test` run.
- **Install test fails**: msiexec logs are `build/msi-install.log` and `build/msi-uninstall.log`.
- **A new data or asset folder in the app**: files the app reads must be listed in
  `include_files` in `packaging/setup_msi.py`; anything it writes must live under `HOME` in
  `server.py` (not `ROOT`, which is read-only once installed).
- **Firmware lists**: if `catalog.json` or `validated.json` ever change format
  incompatibly, raise their `schema_version`: installed apps then ignore the new files and keep
  the copies they came with (`fetch_live` in `server.py`), instead of breaking. New card art in
  `web/img/fw/` shows in older installs straight from raw.githubusercontent.com.
- **Icon**: `packaging/octo.ico`, drawn from `docs/img/octo.svg` by `python packaging/make_icon.py`.
- Never change `UPGRADE_CODE` in `packaging/setup_msi.py`: installs made with the old code
  would no longer be replaced by new versions.
