<!-- Owner: index.ts, persona/character-state.ts -->

# cortico-bot-continuity

This Cortico bot package keeps its long-lived state inside the Persona Memory workspace. It
preserves the familiar workspace, Dream, rhythm, QQ drafting, and console contracts while adding
an idempotent state layer for external-event continuity.

## Install

Build the console bundle, then link the package from a Cortico checkout:

```powershell
pnpm build:console
Set-Location <cortico-repository>\extensions
corepack pnpm add --ignore-workspace <absolute-path-to-cortico-bot-continuity>
```

Set the deployment's `deployment.json` to `{ "bot": "cortico-bot-continuity" }`. The package
expects Cortico extension API 4 and uses `cortico/*` only for framework interfaces.

## Memory state

`memory/workspace/state/runtime.json` is Persona-owned, atomically written runtime data. It stores
the external-event cursor, update time, reproducible seed, social energy, and interaction momentum.
The Dream may maintain `memory/workspace/state/STATE.md`; the main Persona reads it only through an
injected cognitive frame. Git checkpoints and workspace backups include both files.

The runtime state derives tendencies from event timing and count only. It does not interpret user
text as social or emotional facts.

## Development checks

```powershell
pnpm test
pnpm typecheck
pnpm typecheck:web
pnpm build:console
pnpm check:extension <absolute-path-to-cortico-bot-continuity>
```
