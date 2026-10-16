# Changelog

## Unreleased

- Target Cortico 0.2.1 and bot contract 7.
- Rename browser contributions, imports and bundles to WebUI.
- Add extension self-description, official index tags and publishing guidance.

The built-in chat World is `console`. Migrate deployment `worlds.terminal` to `worlds.console`, move `prompts/worlds/terminal/ENV_PROMPT.md` to `prompts/worlds/console/ENV_PROMPT.md`, and rename `logging.console` to `logging.stdout` when present. Existing `terminal.*` event records remain stored but do not appear on the Console page.

## 0.4.2

- Last release using the previous Cortico extension contract.
