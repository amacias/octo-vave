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
| FM-1 Home | Everything FM-1 on one page. **Perform**: connection and logged firmware, voice program ◀▶, MIDI clock, Panic, and an **FX ▾** pull-down (six FX units, FX channel, Send all, Save to Library). Favorite patches and notes. The **FM-1 key bed**: 27 pill keys F–G with the device's OP1–OP6 / PIT / GLO / MONO / POLY labels in black and teal, OCT− / OCT+ (or ← →; at octave 4 it spans F3–G5). The **Voice editor**: full DX7-layout SysEx editor (`F0 43 10 pp qq vv F7`), 6 operators, algorithm, feedback, LFO, pitch EG, name, operator on/off, `.syx` import/export, randomize. **About the FM-1** at the bottom: specs, MIDI implementation, things to try, firmware history, sources. Sections fold up; pick sections, theme and accent under **Customize**. |
| Play & MIDI | A generic MIDI I/O utility for any device or firmware: ports, note channel, SysEx spacing, controllers (mod, bend, aftertouch, sustain), Program Change with bank and any CC, a raw hex sender with Identity request, and a classic 3-octave keyboard (computer keys Z–M / Q–U). The **MIDI monitor** uses standard CC and SysEx manufacturer names, filters by type and exports the log as text. **CC discovery** shows each controller's standard name, last value and range; click a row to resend it. |
| Sound check | Guided listening tests with BEFORE/AFTER captions and Heard / Didn't hear / Not sure answers. **Stock M-VAVE** mode (8 steps) tests the stock map: FX CCs, SysEx voice editing, Program Change. **Generic MIDI** mode (11 steps) uses only standard MIDI, for community firmware: channel scan, velocity, sustain, mod wheel, bend, aftertouch, Program Change, clock sync, All Notes Off and a configurable CC probe. Auto mode picks by the logged firmware. Results are stored per mode and firmware in `data/settings.json`. |
| Library | Firmware-aware patches in `data/patches/*.json` (schema v2): each records the firmware it was made for (`firmware: {id, version}`) and a `format`. The list shows both, filters by firmware (default: the one logged on the device), sorts or groups by firmware. Sending a patch made for another firmware asks for confirmation on the card; formats with no known transport can be stored but not sent. Star a patch to pin it on FM-1 Home. Older patches load as stock patches and are upgraded when saved. |
| Firmware | The exploration hub. **Check for updates** rescans the [awesome-fm-1](https://github.com/cicloid/awesome-fm-1) list and GitHub search and ranks every free, open-source firmware with a `.fwsc` release by ln(1+stars) + ln(1+downloads): top 10 as cards, #11–#30 under **Also popular**. Official cards: Stock V15, FM-1 Open. Curated cards lead with a real screen capture from the project (`web/img/fw/`, credited in `catalog.json`); a project that enters the top 10 without a curated entry gets a card from its GitHub metadata with a placeholder screen and a *not curated yet* marker. Results are cached in `data/discovery-cache.json` with ETags; when the GitHub limit runs out, cards keep their last numbers and the header shows *partial*. `firmware/directory.json` is the offline fallback (`python tools/fm1_discover.py --write` refreshes it). Downloads go into `firmware/library/` with SHA256 checks. First installs stay manual, through each project's installer. |

## Patch formats

Patch formats live in `firmware/formats/<firmwareId>.json`: how a patch is sent (DX7 SysEx, CC list,
parameters at CC / NRPN / SysEx addresses, raw SysEx, or not yet) and its known parameters, each
marked `confirmed` / `discovered` / `unknown`. Supporting a newly tested firmware is a new file, no
code change; see `firmware/formats/_example.json`. `official.json` describes the stock DX7 voice +
FX patch, and `midi-cc.json` captures CCs, SysEx and a program number for any firmware.
`GET /api/formats` serves the registry.

## Validated firmware (orange octopus)

A firmware card gets the orange octopus once that firmware has been **installed, run and reverted
to stock V15 on a real FM-1**. If the project then publishes a newer stable release, the octopus
stays but turns grey until that release is revalidated. That validation happens hands-on, not in the app: follow
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
editor and FX on FM-1 Home only target the stock firmware, and a banner warns you otherwise.
Loading validated firmware from the Firmware tab is planned once validation sessions have defined
the process.

## Layout

```
server.py               local server + JSON API (127.0.0.1 only, origin-checked)
web/                    dashboard (index.html, app.js, dx7.js, fm1keys.js, style.css, css/<feature>.css)
firmware/catalog.json   curated firmware cards + discovery settings
firmware/formats/       patch format registry (one file per firmware)
firmware/validated.json validated firmware records (orange octopus)
firmware/library/       downloaded firmware files (per id/version)
data/                   settings, patches, firmware state, discovery/release caches (not committed)
tools/fm1_test.py       interactive command-line MIDI tester
tools/fm1_validate.py   record firmware validations (firmware/validated.json)
tools/fm1_discover.py   run firmware discovery from the command line
```

## Notes

- The FM-1 doesn't send its current voice back over MIDI, so the voice editor starts from INIT, an
  import or a saved patch, and shows what was last sent. Save on the device to keep edits there.
- The DX7 parameter map comes from the official MIDI guide's SysEx description (0–155). The `.syx` import
  uses the standard DX7 VCED/VMEM formats.
