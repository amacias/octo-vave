# Firmware validation

A firmware gets an **octopus** on its card once it has been tested on a real FM-1: **installed**,
**run**, and the device **reverted to stock V15**. The colour is the outcome:

| Octopus | `result` | Meaning |
|---|---|---|
| 🟠 orange | `clean` | All three steps worked as expected. |
| 🟣 purple | `issues` | All three steps done, but something needed a workaround (described in `notes`). |
| 🔴 red | `failed` | The firmware failed a step; `steps` shows which ones worked. |
| grey | | A newer stable release appeared after the test; it stays grey until retested. |

Validation is done hands-on (for example in a Claude Code session with the FM-1 on USB), never
by the dashboard itself. The dashboard only reads `firmware/validated.json`.

## Procedure

Run one firmware at a time. The person at the synth does every flash; the session only guides
and checks. Ask for each action as one clearly marked prompt, separate from status updates.

1. **Baseline.** The FM-1 runs stock V15. In the dashboard's Sound check, *Stock M-VAVE* mode,
   step 1 (notes) works.
2. **Download.** On the Firmware tab, download the firmware's `.fwsc` so it is in the library
   with its SHA256 (verified when the project publishes checksums).
3. **Release MIDI.** Play & MIDI → *Release MIDI port* (or close the dashboard tab).
4. **Install.** Flash with the project's own web installer (Chrome/Edge over USB). Keep USB
   and power connected. Rescue: hold OCT− while switching on.
5. **Run.** The firmware boots and its screen matches the project's docs. In the dashboard,
   Sound check *Generic MIDI* mode: at least step 1 (notes) and step 2 (channel scan). Play
   the FM-1's own keys and knobs. Note anything odd.
6. **Revert.** Return to stock with the installer's *Return to official V15*, or with
   M-UPGRADE and the library's `FM-1.fwsc`. Confirm the stock screen, then Sound check
   *Stock M-VAVE* steps 1 and 6 (notes and SysEx voice) work again.
7. **Record.**

   ```
   python tools/fm1_validate.py add <id> <version> --checks "generic 1-2, stock 1+6 after revert" --notes "..."
   python tools/fm1_validate.py add <id> <version> --result issues --notes "what needed a workaround"
   python tools/fm1_validate.py add <id> <version> --result failed --steps install --notes "what failed"
   ```

   The person who did the test decides the outcome; the session proposes the record and
   writes it only after they confirm.

   `firmware/validated.json` is published with the project: keep device serials, USB instance
   IDs, local paths and email addresses out of `--checks`/`--notes` (the tool refuses them).
   The tool takes the file name and SHA256 from the library, so the record pins the exact
   file that was tested. Use `--steps install,run` for a partial result (shown nowhere as
   validated) and `list` / `remove` to review or undo.

## Record format (`firmware/validated.json`)

```json
{
  "id": "felucca",
  "version": "v1.6.1",
  "file": "felucca-1.6.1.fwsc",
  "sha256": "…",
  "date": "2026-10-18",
  "steps": { "install": true, "run": true, "revert": true },
  "result": "clean",
  "checks": "generic 1-2, stock 1+6 after revert",
  "notes": ""
}
```

`id` matches `firmware/catalog.json`. A card shows a full-color octopus when its latest release
is validated, and a faded one when only an older release is. The nightly watcher
(`tools/fm1_watch.py`, run by `.github/workflows/watch-releases.yml`) adds
`"supersededBy": "<version>"` when a newer stable release appears, so the octopus greys out even
where the app has no live release data, and removes it again if that changes.

## Contributing a validation

Validations from other FM-1 owners are welcome. The flow:

1. **Run the session** above on your own FM-1: install with the project's installer, play it, run the
   Sound check, revert to stock V15.
2. **Open a [validation report](https://github.com/amacias/octo-vave/issues/new?template=validation-report.yml).**
   It asks for the firmware, version, the file you flashed and its SHA256, the result, the steps that
   worked, and what you checked. Everything in it is public: no serial numbers, USB instance IDs,
   local paths or email addresses.
3. **Pull request** (by you or a maintainer): download the same file in Octo-Vave (its SHA256 must
   match the report), then
   ```
   python tools/fm1_validate.py add <id> <version> --result clean|issues|failed --checks "…" --notes "…"
   python tools/fm1_validate.py check
   ```
   and open a pull request that changes `firmware/validated.json`, with `Closes #<issue>` in the
   description. CI runs the same `check` on it.
4. A maintainer reviews it and merges; the octopus shows up on the card and on the homepage.

A report with `issues` or `failed` is just as useful: it warns the next person.
