# Contributing

Thanks for helping. This file covers how the repository fits together and how to check a change.

## Layout

```
plugin/              the LM Studio plugin (this is what gets installed and published)
  manifest.json        owner, name, revision
  README.md            tools and settings, shipped with the plugin
  src/index.ts         registers the config, tools provider and preprocessor
  src/config.ts        every setting, including the group toggles
  src/toolsProvider.ts offers the groups that are switched on
  src/groups/files/      read, write, edit, search, shell, tasks, diagnostics
  src/groups/memory/     memory, todos, skills, plan mode, the context block
  src/groups/git/        git and GitHub
  src/groups/web/        search, fetch, browser
  src/groups/documents/  PDFs, scans and images
  src/shared/          helpers used by several groups, plus their tests
  src/shared/testing/  fake LM Studio controller for tests
scripts/             install, publish and end-to-end helpers
searxng/             optional SearXNG setup for Windows + WSL
```

One plugin, five groups. A group is a folder under `src/groups/` plus a toggle in `src/config.ts`; `src/toolsProvider.ts` calls the ones that are on and concatenates their tools.

## Setup

```bash
npm install
```

```bash
npm run deps
```

The first installs the test runner; the second installs the plugin's own dependencies.

## Checks

```bash
npm test
```

```bash
npm run typecheck
```

Tests call the tools through a fake controller (`plugin/src/shared/testing/fake-controller.ts`), so they need neither LM Studio nor a model. Some tests only run where their dependency exists (PowerShell, Edge); a live-network test runs only with `LIVE_WEB=1`.

To try the plugin in LM Studio while editing, run `lms dev` in `plugin/`: it rebuilds and reloads on save. Dev-mode plugins appear in LM Studio's chat UI, but API clients can only use installed plugins.

Install with `npm run setup`, not `lms dev --install` inside `plugin/`: that uploads the local `node_modules` too, which has been seen to hang LM Studio's installer until LM Studio is fully restarted. The script installs from a clean copy and lets LM Studio fetch dependencies itself.

To check the tools with a real model, `scripts/e2e.mjs` has a model complete a task with each group and verifies the results on disk:

```bash
node scripts/e2e.mjs <model-key> --in-process
```

`--in-process` runs the tool code inside the script. Without it, the script uses the installed plugin through LM Studio, which only works if you've granted API clients permission to use plugins (otherwise you get `Permission denied ... plugins.use`).

## Publishing to LM Studio Hub

Maintainers only. Sign in once with `lms login` (it shows a code to enter at lmstudio.ai/pairing), then:

```bash
npm run hub:push -- --owner <your-hub-account>
```

It publishes from a clean staging copy, the same way the installer does. Add `--private` to keep it private the first time it's pushed, and `--dry-run` to see what would happen.

## Writing tools

- Return recoverable problems as `Error: ...` strings: throw `ToolError` inside an implementation wrapped in `safe(...)`. Throw normal errors only for real failures.
- Call `ctx.status(...)` and `ctx.warn(...)` on the tool context object. Don't destructure them: they're methods that rely on `this`. The fake context behaves the same way, so tests catch it.
- Resolve every user-supplied path with `resolveSafe(root, path)`, and anything a tool is about to change with `resolveWritable`, so the toolkit's own chat state files stay off limits.
- Keep descriptions short and concrete; the model reads every one on every message.
- Put optional tools behind a config switch, since long tool lists make small models choose worse.
- The plugin host's environment is not your terminal's. LM Studio runs plugins in an Electron utility process, which on Windows has been seen to supply no `PATHEXT` — enough to make every shell command fail with "is not recognized". Spawn with `commandEnv()` from `src/shared/process.ts` instead of `process.env`, and don't assume a variable exists just because your shell has it. Tests call tool code directly in a normal environment, so they cannot catch this class of bug; it only shows up inside LM Studio.
- PDF work goes through `src/groups/documents/lib/pdf-worker.mjs` in a separate process; PDF.js doesn't work when bundled as CommonJS.
- Keep heavy dependencies behind `await import(...)` inside the code that needs them, so a group that is switched off costs nothing at startup.

## Adding a group

1. Create `plugin/src/groups/<name>/toolsProvider.ts` exporting `toolsProvider(ctl)`.
2. Add an `enable<Name>` boolean to `src/config.ts`, and give the group's own settings `dependencies: onlyWhen("enable<Name>")` so they only show while it's on.
3. Add it to the list in `src/toolsProvider.ts`.
4. Add tests beside the code; the root vitest config picks up `plugin/src/**/*.test.ts`.
5. Document its tools and settings in `plugin/README.md`, and add a row to the table in the main README.

## Commits and pull requests

Keep changes focused, include tests for new behavior, and describe what you checked. CI runs the tests and typecheck on Windows and Linux.
