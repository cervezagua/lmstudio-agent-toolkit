# git-tools

*Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit) — five plugins for files and shell, memory, git, the web and documents. Install the others with `lms get cervezagua/<plugin>`.*

Git and GitHub tools for LM Studio models: inspect changes, stage and commit, manage branches, and work with pull requests and issues through the GitHub CLI.

## Requirements

- `git` on PATH
- Optional: the [GitHub CLI](https://cli.github.com), logged in with `gh auth login`. The `gh_*` tools only appear when `gh` is installed.

## Tools

| Tool | Parameters | What it does |
|---|---|---|
| `git_status` | – | Branch, upstream state, and changed/untracked files |
| `git_diff` | `staged?`, `ref?`, `path?`, `stat_only?` | Unstaged changes by default; `staged` for what will be committed; `ref` to compare against a commit or branch |
| `git_log` | `count?`, `ref?`, `path?` | Recent commits: hash, date, author, refs, subject (default 15) |
| `git_show` | `ref`, `stat_only?` | A commit's message and changes |
| `git_add` | `paths` | Stages files (`["."]` for everything), then shows the short status |
| `git_commit` | `message` | Commits what's staged; refuses when nothing is staged. Multi-line messages are fine. |
| `git_branch` | `name?`, `base?`, `switch?` | Lists branches, or creates/switches to `name` (optionally from `base`) |
| `git_init` | – | Creates a repository in the Repository Directory |
| `git_push` | `remote?` | Pushes the current branch and sets its upstream. **Only present when Allow Push is on. Never force-pushes.** |
| `gh_pr_list` | `state?`, `limit?`, `search?` | Lists pull requests |
| `gh_pr_view` | `number?` | A PR's description, status and comments (defaults to the current branch's PR) |
| `gh_pr_diff` | `number?` | A PR's diff |
| `gh_pr_checks` | `number?` | CI check results, including pending ones |
| `gh_pr_create` | `title`, `body`, `base?`, `draft?` | Opens a PR from the current branch (push first) |
| `gh_issue_list` | `state?`, `limit?`, `search?` | Lists issues |
| `gh_issue_view` | `number` | An issue with its comments |

## Settings (per chat)

| Setting | Default | Notes |
|---|---|---|
| Repository Directory | *(empty = chat working directory)* | Use the same folder as coder-tools' Root Directory. |
| Allow Push | off | Adds `git_push`. |
| Enable GitHub Tools | on | Adds the `gh_*` tools when `gh` is on PATH. |
| Max Output Characters | 20000 | Long diffs and logs are shortened from the middle. |

## Plan mode

If memory-tools is enabled too, `enter_plan_mode` makes this plugin offer only the read-only git tools (`git_status`, `git_diff`, `git_log`, `git_show` and the `gh_*` viewers) until `exit_plan_mode`. See memory-tools' README.

## Safety

- `git` and `gh` are run directly, not through a shell, so text from the model can't inject other commands.
- Refs, branch names and remotes that start with `-` are rejected, so they can't be read as options (e.g. `--output=...`).
- File paths must be inside the repository.
- Git never opens an editor, pager or credential prompt. If authentication is needed, the tool returns an error rather than hanging.
- There are no tools for destructive history changes (reset, rebase, force-push, deleting branches). If you enable coder-tools' shell, those remain possible through `run_command`; approve such calls carefully.

## Tips

- If `git_commit` fails with "Please tell me who you are", set your identity once in a terminal: `git config --global user.name "..."` and `git config --global user.email "..."`.
- A typical flow to ask the model for: `git_status` → `git_diff` → `git_add` → `git_diff staged=true` → `git_commit`.

## Development

```bash
npm install
```

```bash
lms dev
```

Tests live in the repository root (`npm test`). The `src/shared/` files are copied from the repository's `shared/` folder; edit them there.
