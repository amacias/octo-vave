# FM-1 Dashboard

A local dashboard for the M-VAVE FM-1 pocket FM synthesizer: explore it, edit and store
configurations, manage official and community firmware files, and play it from the browser.

## Run

```
python server.py        # or double-click start.cmd
```

This opens http://127.0.0.1:8765 in your browser. Use **Chrome or Edge**, which have Web MIDI with
SysEx. Press **Connect** and allow MIDI + SysEx access. The FM-1 is picked automatically
(it shows up as `FM-1 Midi`). Python 3 standard library only; nothing to install.
Set `FM1_PORT` to change the port. Update checks use the anonymous GitHub API (60 requests/hour); set `GITHUB_TOKEN`, or `FM1_USE_GH=1` to use your GitHub CLI login, for a higher limit.

## Tabs

| Tab | What it does |
|---|---|
| Home | Customizable widgets: device status, program change, MIDI clock, favorite patches, quick FX switches, keyboard, notes, recent MIDI in. Pick widgets, theme and accent color under **Customize**. |
| Play & MIDI | Port and channel setup, mod wheel, bend, aftertouch, sustain, a raw hex sender, a 3-octave keyboard (computer keys Z–M / Q–U, octave with arrow keys), a MIDI monitor and **CC discovery** (turn knobs, see what they send). |
| Sound check | Guided listening tests with BEFORE/AFTER captions and Heard / Didn't hear / Not sure answers. **Stock M-VAVE** mode (8 steps) tests the stock map: FX CCs, SysEx voice editing, Program Change. **Generic MIDI** mode (11 steps) uses only standard MIDI, for community firmware: channel scan, velocity, sustain, mod wheel, bend, aftertouch, Program Change, clock sync, All Notes Off and a configurable CC probe. Auto mode picks by the logged firmware. Results are stored per mode and firmware in `data/settings.json`. |
| Voice | Full DX7-layout voice editor over SysEx (`F0 43 10 pp qq vv F7`): 6 operators, algorithm, feedback, LFO, pitch EG, name, operator on/off. Import DX7 `.syx` (single voice or 32-voice bank), export `.syx`, randomize. |
| FX | All 24 FX CCs (filter, reverb, delay, distortion, chorus, phaser) on the FX channel (default ch 2). |
| Library | Saved patches (voice + FX + program + notes + tags) in `data/patches/*.json`. Star a patch to pin it on Home. |
| Firmware | Cards for Official (Stock V15, FM-1 Open) and the **community top 10 free, open-source firmwares**, ranked live by GitHub stars × firmware downloads. Each card leads with a real screen capture from the project's repo or docs (`web/img/fw/`, source in `catalog.json` → `art.credit`), then rank, stars, downloads, latest version, status (ON DEVICE / UPDATE / NEW) and Download / Install / Try; details live under **More**. At the bottom, **Also popular** lists the next 20 projects (#11–#30, same ranking) in one line each (`firmware/directory.json`, built from awesome-fm-1 and GitHub stats on 2026-10-18). Downloads go into `firmware/library/` with SHA256 checks (`SHA256SUMS` or per-file `.sha256` when published). |
| Explore | Specs, the MIDI implementation, things to try, firmware history, sources. |

## Validated firmware (orange octopus)

A firmware card gets the orange octopus once that firmware has been **installed, run and reverted
to stock V15 on a real FM-1**. That validation happens hands-on, not in the app: follow
[VALIDATION.md](VALIDATION.md) and record the result with `python tools/fm1_validate.py add …`,
which writes `firmware/validated.json` and pins the tested file's SHA256. The bottom of the
Firmware tab lists every validated firmware under **Validated firmware in Library**.

## Firmware: what this does and doesn't do

The dashboard **downloads and organizes** firmware files and links to each project's installer.
It does **not flash** firmware itself. Flash with:

- **Stock / rollback:** M-UPGRADE (download `M-UPGRADE.zip` from the Official card) with `FM-1.fwsc` (V15).
- **Community firmware:** each project's web installer (Chrome/Edge over USB). Melodee and TransitFM1
  add interrupted-write protection; TransitFM1 is meant as a stop between firmwares.

Windows MIDI ports are exclusive. Press **Release MIDI port** (Play & MIDI tab) or close the
dashboard before running M-UPGRADE. USB rescue: hold **OCT−** while switching on.
After flashing, log it with **Log installed** so the dashboard knows what's on the device. The Voice
and FX editors only target the stock firmware, and a banner warns you otherwise.

## Layout

```
server.py               local server + JSON API (127.0.0.1 only, origin-checked)
web/                    dashboard (index.html, app.js, dx7.js, style.css)
firmware/catalog.json   firmware sources; edit to add projects
firmware/library/       downloaded firmware files (per id/version)
data/                   settings, patches, firmware state, release cache
tools/fm1_test.py       interactive command-line MIDI tester
tools/fm1_validate.py   record firmware validations (firmware/validated.json)
```

## Notes

- The FM-1 doesn't send its current voice back over MIDI, so the voice editor starts from INIT, an
  import or a saved patch, and shows what was last sent. Save on the device to keep edits there.
- The DX7 parameter map comes from the official MIDI guide's SysEx description (0–155). The `.syx` import
  uses the standard DX7 VCED/VMEM formats.
