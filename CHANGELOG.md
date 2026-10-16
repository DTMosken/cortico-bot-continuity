# Changelog

## 0.5.0 - 2026-10-16

- Target Cortico 0.2.1 and bot contract 7.
- Rename browser contributions, imports and bundles to WebUI.
- Add extension self-description, official index tags and publishing guidance.

The built-in chat World is `console`. Migrate deployment `worlds.terminal` to `worlds.console`, move `worlds/terminal/ENV_PROMPT.md` to `worlds/console/ENV_PROMPT.md`, and rename `logging.console` to `logging.stdout` when present. Update the prompt variable `terminal.pin` to `console.pin` and subagent permission keys `terminal` / `terminal_send` to `console` / `console_send`. Existing `terminal.*` event records remain stored but do not appear on the Console page.

## 0.4.2

- Last release using the previous Cortico extension contract.
