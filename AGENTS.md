# Working in this repository

Instructions for anyone — person or model — changing this toolkit. The Memory & Context group loads this file at the start of a chat, so keep it short.

## Layout

- `plugin/` — the one LM Studio plugin. `src/groups/<name>/` holds each group (files, memory, git, web, documents); `src/config.ts` has every setting, including the group toggles; `src/toolsProvider.ts` offers the groups that are on.
- `plugin/src/shared/` — helpers used by several groups.
- `scripts/` — install, publish and end-to-end helpers.
- `searxng/` — optional local search setup (Windows + WSL).

## Before you finish

```bash
npm test
```

```bash
npm run typecheck
```

Both must pass. Add tests for new behavior; they run against a fake LM Studio controller, so they need neither the app nor a model.

## Conventions

- Recoverable problems are returned as `Error: …` strings (throw `ToolError` inside `safe(...)`), so the model can retry. Throw real errors only for genuine failures.
- Call `ctx.status(...)` and `ctx.warn(...)` on the context object — never destructure them, they rely on `this`.
- Resolve every path from the model with `resolveSafe(root, path)`, and anything about to be changed with `resolveWritable`.
- Spawn commands with `commandEnv()`, not `process.env`: the plugin host's environment is not your shell's.
- Put optional tool groups behind a config switch: long tool lists make small models choose worse.
- Tool descriptions are read by the model on every message. Keep them short and concrete.

## Don't

- Don't commit or push unless asked.
- Don't add a dependency without a reason that outweighs the install cost for users.
- Don't put machine-specific paths, model names or personal details in code or docs.
