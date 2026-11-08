# Plan: automated testing of new firmware

Status as of 2026-10-20. This plan was first proposed on 2026-10-19 and has been updated with what is built since.

## Goal

The goal is one button in the app that takes a new firmware release through the whole cycle without manual steps:

download → verify → back up → flash → smoke test → revert to stock → retest stock → restore → report

Running it inside the app is preferred over having Claude drive each project's web installer. The Claude-driven route remains a stopgap: it needs an open session and tool approvals, and it is slower and less repeatable.

## What exists today

| Step | Status |
|---|---|
| Download a release file | Done: the Download button on the firmware cards |
| Verify its sha256 | Done: checked against the published checksums and the hash pinned in `firmware/validated.json` |
| Flash over USB MIDI | **Done for validated firmware.** The Install button on the Validated firmware list (`web/fm1flash.js`) runs the FM-1's own update protocol, written from FM-1-RE's notes (WTFPL). It was tested on a real FM-1 (stock → Felucca v1.6.1 → stock) on 2026-10-19. |
| Revert to stock V15 | **Done**: Install on the Stock V15 row. This works even from firmware whose installer has no way back. |
| Resume a cut-off write | Done: the FM-1 stays in update mode, and Install / Try again finishes the write |
| Log what is installed | Done: each Install is logged, and Sound check's mode follows the logged firmware |
| Back up and restore user data | Not started (milestone "Safe revert", issue #1) |
| Automated smoke test | Not started |
| Pipeline button and "auto-tested" tier | Not started |

## Answered by the research

- **One protocol for every `.fwsc`.** The firmware's own update code drives the update: the app sends the upgrade command (SysEx), the device asks for the package piece by piece, and the app answers each request. M-UPGRADE and the community installers all use this protocol. The only exception is FM-1 Open, which ships as a Workbench page and answers only to that page.
- **No button press needed.** The upgrade command alone puts the FM-1 into its update loader (USB 4D4A:4155, identity `ota-FM-1_...`).
- **The installed firmware can be identified.** After the restart, the device reports the firmware named in the package header, such as `FM-1_015` (stock) or `FM-1_916` (Felucca).
- **The device refuses a same-version update**, and the app reports it as "Nothing was written".
- **Licensing.** Felucca's installer code is GPL-3.0, so the app (MIT) uses its own implementation, written from FM-1-RE's protocol notes.

## Still to find out

- Does the FM-1's USB audio carry the synth sound? If it does, the smoke test can record notes and check pitch and level, so Sound check stops depending on the user's ears.
- Does the FM-1 run on a battery? If it does, cutting USB power won't reset a hung device.
- What MIDI port names do X0X and FM-1+VA use? The installer only probes FM-1-like port names, and if it finds nothing its error lists the ports it saw.
- What was the brief Windows "shared socket" pop-up during the first real install? It was harmless and its cause is unconfirmed.

## Remaining steps

These session counts are rough guesses, not measurements.

1. **Automated smoke test of the firmware currently installed** (1–2 sessions, low risk, no flashing):
   - send notes, program changes and CCs;
   - check MIDI clock and the identity reply;
   - if USB audio carries the sound, record each note and check it sounded.

   Results go into Sound check as "auto" answers next to the manual ones.
2. **Back up and restore user data** (issue #1, 2–3 sessions):
   - back up voices, patches and projects before flashing, and offer a restore after reverting;
   - stock voice banks come back via DX7 SysEx dumps, and firmware with its own backup feature uses that.

   This is needed because some firmware resets data; FM-1 Open's revert, for example, resets all four voice banks.
3. **Update-mode recovery** (about 1 session):
   - if the FM-1 comes back only as the update loader, offer Install stock automatically;
   - after any flash, check what kind of USB device came back, and stop if it is anything other than MIDI/audio.
4. **The pipeline button** (about 2 sessions): run download → verify → back up → flash → smoke test → revert → retest stock → restore, with a pass/fail per step in the card's history.
   - A passing run earns a separate **"auto-tested"** badge. The orange octopus stays reserved for hands-on validation.

## Limits automation can't remove

- **Screen, knobs, buttons, key bed:** the app can't see or press them. An automated pass is a strong smoke test, not a hands-on validation.
- **A device that never comes back** still needs a person (unplug, recovery). Recovery has worked so far, but there's no guarantee for every firmware.
- **Untrusted firmware:** firmware can make the FM-1 present itself as any USB device, including a keyboard. With nobody watching, that risk is higher, which is why step 3 checks the device class.

## Decisions needed before step 4

- **The flashing rule.** It currently allows flashing only the exact pinned file of a validated record, and only on the user's Install click. The pipeline would flash firmware that is *not yet validated*, so the rule has to change. For example: "on the user's click on a card's Test button, with the file's published checksum verified, supervised, never unattended loops".
- **Unattended runs**, such as overnight queues: yes or no.
- **The "auto-tested" tier:** its name and icon on the cards, and whether the homepage shows it.
