# Working in this repository

Instructions for anyone — person or model — changing this toolkit. memory-tools loads this file at the start of a chat, so keep it short.

## Layout

- `plugins/<name>/` — one LM Studio plugin each, self-contained (LM Studio installs them individually).
- `shared/` — helpers used by several plugins. They are **copied** into `plugins/*/src/shared/`; edit the originals in `shared/` and run `npm run sync-shared`. `npm test` fails if a copy is stale.
- `scripts/` — install, publish, sync and end-to-end helpers.
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
- Resolve every path from the model with `resolveSafe(root, path)`.
- Put optional tool groups behind a config switch: long tool lists make small models choose worse.
- Tool descriptions are read by the model on every message. Keep them short and concrete.

## Don't

- Don't commit or push unless asked.
- Don't add a dependency without a reason that outweighs the install cost for users.
- Don't put machine-specific paths, model names or personal details in code or docs.
