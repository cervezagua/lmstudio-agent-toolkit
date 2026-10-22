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
| `--self-test` | No model: checks that every task fails when nothing is done, so a check can't pass by accident. |

## Adding a task

Make a folder in `evals/tasks/` with:

- `project/`: the files the task starts with. Anything that can't be a plain file, such as a git history or a PDF, is made by `setup` instead.
- `task.ts`: exports an `EvalTask` (see [lib/task.ts](lib/task.ts)) with `area`, `prompt`, any `config` that differs from the defaults, an optional `setup`, and `check`, which returns what is wrong (nothing means a pass).
  - A list of prompts runs as separate chats on the same project and memory, to test what carries over (see `remember-preference`).
  - `afterCall` runs as each tool result comes back, to change things under the model, such as a teammate editing a file it just read (see `teammate-edit`).
  - Check behaviour with code the model never sees, rather than with the project's own tests, which a model can edit (see `python-durations`, `paging-bug`).

Then run `npm run eval -- --self-test` to make sure the new check fails when nothing is done.
