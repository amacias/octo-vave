## What changes

<!-- e.g. "Validation: Felucca v1.7.0, clean" — link the validation report issue: Closes #N -->

## Checklist for firmware records

- [ ] Records were written with `python tools/fm1_validate.py add …` (not edited by hand).
- [ ] The `sha256` is the exact file that was flashed in the session.
- [ ] `python tools/fm1_validate.py check` passes (CI runs it too).
- [ ] No serial numbers, USB instance IDs, local paths or email addresses in `checks` / `notes`.
