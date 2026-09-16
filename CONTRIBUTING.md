# Contributing

Thanks for helping. This file covers how the repository fits together and how to check a change.

## Layout

```
plugins/<name>/    one self-contained LM Studio plugin each
  manifest.json      LM Studio plugin manifest (owner, name, revision)
  README.md          tools and settings, shipped with the plugin
  src/index.ts       registers config, tools provider, preprocessor
  src/config.ts      settings shown in LM Studio
  src/toolsProvider.ts
  src/lib/           plugin-specific modules
  src/shared/        GENERATED copies of /shared — don't edit here
shared/            helpers used by several plugins, plus their tests
  testing/           fake LM Studio controller for tests
scripts/           install, sync, e2e and per-plugin helpers
searxng/           optional SearXNG setup for Windows + WSL
```

## Setup

```bash
npm install
```

```bash
npm run install:all
```

The first installs the test runner; the second runs `npm install` in every plugin.

## The shared folder

LM Studio installs each plugin from its own folder, so a plugin can't import from outside it. Common helpers live once in `shared/` and are **copied** into every `plugins/*/src/shared/`. After editing anything in `shared/`, run:

```bash
npm run sync-shared
```

`npm test` fails if a copy is out of date.

## Checks

```bash
npm test
```

```bash
npm run typecheck
```

Tests call each plugin's tools through a fake controller (`shared/testing/fake-controller.ts`), so they need neither LM Studio nor a model. Some tests only run where their dependency exists (PowerShell, Edge); a live-network test runs only with `LIVE_WEB=1`.

To try a plugin in LM Studio while editing, run `lms dev` in its folder: it rebuilds and reloads on save. Dev-mode plugins appear in LM Studio's chat UI, but API clients can only use installed plugins.

Install with `npm run setup` (or `node scripts/install-plugins.mjs <name>`), not `lms dev --install` inside a plugin folder: that uploads the local `node_modules` too, which has been seen to hang LM Studio's installer until LM Studio is fully restarted. The script installs from a clean copy and lets LM Studio fetch dependencies itself.

To check the tools with a real model, `scripts/e2e.mjs` has a model complete a task with each plugin and verifies the results on disk:

```bash
node scripts/e2e.mjs <model-key> --in-process
```

`--in-process` runs the tool code inside the script. Without it, the script uses the installed plugins through LM Studio, which only works if you've granted API clients permission to use plugins (otherwise you get `Permission denied ... plugins.use`).

## Publishing to LM Studio Hub

Maintainers only. Sign in once with `lms login` (it shows a code to enter at lmstudio.ai/pairing), then:

```bash
npm run hub:push -- --private --owner <your-hub-account>
```

It publishes each plugin from a clean staging copy, the same way the installer does. `--private` only has an effect the first time a plugin is pushed. Drop it to publish publicly, and add `--dry-run` to see what would happen.

## Writing tools

- Return recoverable problems as `Error: ...` strings: throw `ToolError` inside an implementation wrapped in `safe(...)`. Throw normal errors only for real failures.
- Call `ctx.status(...)` and `ctx.warn(...)` on the tool context object. Don't destructure them: they're methods that rely on `this`. The fake context behaves the same way, so tests catch it.
- Resolve every user-supplied path with `resolveSafe(root, path)`.
- Keep descriptions short and concrete; the model reads every one on every message.
- Put optional tool groups behind a config switch, since long tool lists make small models choose worse.
- PDF work goes through `plugins/ocr-tools/src/lib/pdf-worker.mjs` in a separate process; PDF.js doesn't work when bundled as CommonJS.

## Adding a plugin

1. Copy an existing plugin folder (git-tools is the smallest) and change `name` in `manifest.json` and `package.json`.
2. Run `npm run sync-shared` to give it the shared helpers.
3. Add tests under its `src/`; the root vitest config picks them up.
4. Document its tools and settings in its README, and add a row to the table in the main README.

## Commits and pull requests

Keep changes focused, include tests for new behavior, and describe what you checked. CI runs the tests and typecheck on Windows and Linux.
