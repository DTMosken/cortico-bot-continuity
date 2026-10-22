# Changelog

## 0.6.0 - 2026-10-22

- Add `list_wakes` and `cancel_wake` for scheduled wakes and their delivery blocks.
- Support `schedule_wake(at, note, repeat=true)` at the same local time each day, with a persistent wake ID and timezone. Relative wakes remain one-shot.
- Process Dream materials oldest first in input-sized batches and continue after confirmed progress, up to `dream.maxBatches` (default 3).
- Return actionable `surface` validation errors and preserve pending future tasks when all materials in the current batch have been processed.
- Fix worker deadline tests and Dream test receipts containing context-budget reminders.

`surface(processedMaterials="all")` now confirms the active batch and is valid with `status="partial"`. Set `dream.maxBatches=1` to retain one batch per handoff or manual continuation. Existing materials and run records remain readable.

## 0.5.1 - 2026-10-17

- Retain the question, speech calls and actual receipts from the batch crossing the soft context threshold in the recent handoff note.
- Keep startup available when Dream run history, saved context or pending-task notes are damaged or unreadable.
- Preserve malformed state files beside the original path and report recovery in the log; retain unconfirmed materials.

## 0.5.0 - 2026-10-16

- Target Cortico 0.2.1 and bot contract 7.
- Rename browser contributions, imports and bundles to WebUI.
- Add extension self-description, official index tags and publishing guidance.

The built-in chat World is `console`. Migrate deployment `worlds.terminal` to `worlds.console`, move `worlds/terminal/ENV_PROMPT.md` to `worlds/console/ENV_PROMPT.md`, and rename `logging.console` to `logging.stdout` when present. Update the prompt variable `terminal.pin` to `console.pin` and subagent permission keys `terminal` / `terminal_send` to `console` / `console_send`. Existing `terminal.*` event records remain stored but do not appear on the Console page.

## 0.4.2

- Last release using the previous Cortico extension contract.
