# Evals

Measures how well a local model gets real tasks done through agent-toolkit, so a change can be judged by whether it helps, not by guessing.

```bash
npm run eval -- --model <model-key> --runs 3
```

- **Tasks are asked the way a user would**, without naming a tool, and checked by their outcome: the tests pass, the right file is committed, the answer has the right number.
- **Each task runs several times** (`--runs`, 3 by default): local models vary from run to run, so a task gets a pass rate.
- **The setup is the one a user has:** the plugin's default settings plus the groups the task needs, the [agent-toolkit-prompt](../presets/agent-toolkit-prompt/) system prompt, the prompt preprocessor (instruction files, memory), and the task's project set as the Project Folder.
- **The plugin runs from source**, so a change can be measured before it is installed.

Results go to `evals/results/` (ignored by git, since they name your models). Each report compares with the previous run on the same model and says what went wrong in each failed run: which tools were used, how many calls failed, and how often the model repeated a call that had already failed.

It needs LM Studio running with the model available, so it is not part of `npm test` or CI. A full run takes a while: each task is a real conversation.

## Options

| Option | |
|---|---|
| `--only <names>` | Only these tasks, or areas (`code`, `git`, `documents`...), comma-separated. |
| `--runs <n>` | Runs per task. |
| `--minutes <n>` | Stops a run after this long (10). |
| `--subagent-model <key>` | The model for `run_subagent` and `research`; the plugin's Auto otherwise. |
| `--all-groups` | Every group and optional tool on, whatever the task asks for: the long tool list some users run. About 7,900 tokens of tool definitions on every message, against 4,500 with the defaults. |
| `--context <n>` | Loads a separate copy of the model with this context length for the run, then unloads it. Try 16384 to see how a small context copes. |
| `--installed` | Uses the plugin LM Studio has installed (`npm run setup`) instead of the source, to catch what breaks only once packaged. Needs an API token that may use plugins in `LM_API_TOKEN` (LM Studio: Developer > Server Settings > Manage Tokens). The API can't set the plugin's global settings, so its memory folder would be your real one: memory, saved skills and past-chat search are switched off, and the memory task is skipped. |
| `--loop <off\|mask\|full>` | Puts agent-toolkit-loop's reply loop in front of the model: `mask` only hides old tool output, `full` also summarizes. Compare with `off` (the default) under `--context 16384` to see what compaction buys. |
| `--self-test` | No model: checks that every task fails when nothing is done, so a check can't pass by accident. |

Each report also has an **After an error** table: for each kind of error a tool gives, how often the model's next call to that tool worked and how many calls it took. A hint that helps (the closest text, a likely path) shows as better numbers than the plain error of the same sort. Results are compared only with earlier runs under the same options.

## Adding a task

Make a folder in `evals/tasks/` with:

- `project/`: the files the task starts with. Anything that can't be a plain file, such as a git history or a PDF, is made by `setup` instead.
- `task.ts`: exports an `EvalTask` (see [lib/task.ts](lib/task.ts)) with `area`, `prompt`, any `config` that differs from the defaults, an optional `setup`, and `check`, which returns what is wrong (nothing means a pass).
  - A list of prompts runs as separate chats on the same project and memory, to test what carries over (see `remember-preference`).
  - `afterCall` runs as each tool result comes back, to change things under the model, such as a teammate editing a file it just read (see `teammate-edit`).
  - Check behaviour with code the model never sees, rather than with the project's own tests, which a model can edit (see `python-durations`, `paging-bug`).

Then run `npm run eval -- --self-test` to make sure the new check fails when nothing is done.
