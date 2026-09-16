# coder-tools

*Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit) — five plugins for files and shell, memory, git, the web and documents. Install the others with `lms get cervezagua/<plugin>`.*

File and shell tools for LM Studio models: read, write and edit files, search a codebase, and run commands. The model works inside a single project folder you choose and can't reach anything outside it.

## Tools

| Tool | Parameters | What it does |
|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` | Returns lines prefixed with their line numbers. `offset` (1-based) and `limit` page through large files (default: first 2000 lines), and only the requested lines are read into memory. Binary files, and whole-file reads over **Max Read Bytes**, are refused. |
| `write_file` | `path`, `content` | Creates or overwrites a file. Missing parent folders are created. |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | Exact search-and-replace. `old_string` must appear exactly once unless `replace_all` is true. LF text matches Windows CRLF files. |
| `list_dir` | `path?` | Lists a folder, subfolders first (marked with `/`). |
| `glob` | `pattern`, `path?` | Finds files by pattern (`**/*.ts`), most recently modified first. |
| `grep` | `pattern`, `path?`, `glob?`, `ignore_case?`, `max_results?`, `context?`, `output_mode?`, `offset?` | Regex search of file contents. `output_mode` is `content` (default), `files_with_matches` (paths only, the cheapest way to answer "where is X used?") or `count`. `context` adds surrounding lines, `offset` pages through results. Uses ripgrep if installed, otherwise a built-in search. |
| `run_command` | `command`, `description?`, `cwd?`, `timeout_seconds?` | Runs a shell command and returns the exit code, stdout and stderr. `description` is one line saying what it does, shown while it runs. Output far past the limit is written to a file and its path returned, so nothing is lost. With **Persistent Shell Session** on, every command shares one shell, so `cd`, environment variables and activated virtualenvs carry over. Only present when **Allow Shell Commands** is on. |
| `shell_reset` | – | Restarts that shell session, clearing its directory and variables. Only with the session enabled. |

### Editing tools

| Tool | Parameters | What it does |
|---|---|---|
| `multi_edit` | `path`, `edits`, `preview?` | Several exact replacements in one file, applied in order. If any one fails, nothing is written. |
| `insert_lines` | `path`, `after_line`, `content`, `preview?` | Inserts text after a line number (0 = top of the file), without quoting the surrounding code. |
| `undo_edit` | `path` | Restores a file to its content before this chat's last change to it. |

`edit_file`, `multi_edit` and `insert_lines` all accept `preview: true`, which returns a diff and writes nothing.

### Background tasks (**Background Tasks** setting, on by default)

| Tool | Parameters | What it does |
|---|---|---|
| `task_run` | `command`, `cwd?`, `name?` | Starts a command in the background and returns a task id. For dev servers, watchers and long builds. |
| `task_list` | – | The chat's tasks with their status: running, exited with a code, or gone. |
| `task_output` | `id`, `offset?`, `max_chars?` | Output written after `offset`, plus the next offset, so the model can poll for new output only. |
| `task_stop` | `id` | Stops a task and its child processes. |

### Notebooks (**Jupyter Notebook Tools** setting, off by default)

| Tool | Parameters | What it does |
|---|---|---|
| `notebook_read` | `path` | Every cell of an `.ipynb` with its index, type, source and a summary of its outputs. |
| `notebook_edit` | `path`, `cell_index`, `mode`, `source?`, `cell_type?` | Replaces, inserts or deletes a cell. Editing a code cell clears its stale outputs. |

All tools skip `node_modules`, `.git`, `dist`, `build`, `.venv` and similar folders when searching. Output longer than **Max Output Characters** is shortened from the middle, keeping the start and the end.

## Settings (per chat)

| Setting | Default | Notes |
|---|---|---|
| Root Directory | *(empty = the chat's working directory)* | The project folder. Every path is resolved inside it; `..`, absolute paths elsewhere, other drives, and symlinks/junctions pointing outside are all rejected. |
| Allow Shell Commands | on | Off removes `run_command` from the model's tool list. |
| Shell | auto | `auto` = `pwsh` (or Windows PowerShell) on Windows, `bash` (or `sh`) elsewhere. |
| Default Command Timeout (seconds) | 60 | The model may ask for up to 10× this. Processes that time out are killed along with their child processes. |
| Max Output Characters | 20000 | Lower it for models with small context windows. Output far past this is saved to a file instead of being thrown away. |
| Max Read Bytes | 256 KB | Largest file `read_file` will read whole. Bigger files must be read with `offset`/`limit`, or searched with `grep`. |
| Extra Blocked Command Patterns | – | Regular expressions (case-insensitive), added to the built-in list. For example, `git\s+push` stops the model from pushing. |
| Persistent Shell Session | on | One shell for the whole chat, so `cd` and environment variables stick. Off runs each command in a fresh shell. |
| Background Tasks | on | Adds the four `task_*` tools. |
| Diagnostics | on | Adds `diagnostics`, which runs the project's own checkers (tsc, ESLint, Ruff, Pyright, cargo, go vet). |
| Research Sub-agent | off | Adds `run_subagent`, a read-only nested agent for search-heavy questions. Costs extra generation time. |
| Sub-agent Model | *(first loaded model)* | Which model the sub-agent runs on. |
| Jupyter Notebook Tools | off | Adds `notebook_read` and `notebook_edit`. Leave it off unless you work with notebooks: fewer tools means better tool choice by small models. |

## Plan mode

If memory-tools is enabled too, `enter_plan_mode` makes this plugin withhold every tool that changes things (`write_file`, `edit_file`, `multi_edit`, `insert_lines`, `undo_edit`, `notebook_edit`, `task_run`, `task_stop`) until `exit_plan_mode`. Reading, searching and `run_command` stay, and `run_command`'s description tells the model to keep to read-only commands. See memory-tools' README.

## Protecting your files

- **Read before edit.** A file must have been read in this chat before it can be edited, and if it changed on disk since that read, the edit is refused with a note to read it again. This stops a model overwriting work it cannot see. Antivirus and cloud-sync touching a file without changing it are tolerated. The record lives in the plugin process, so after LM Studio restarts the model is asked to read once more.
- **Atomic writes.** Files are written to a temporary file and renamed into place, so an interrupted write can't leave a half-written or empty file.
- **Undo.** `undo_edit` restores this chat's last change to a file, from a copy kept outside your project.
- **Diffs first.** Any edit can be run with `preview: true` to see the change before writing.

## Safety

1. **Root Directory**: the model can't read or write outside it.
2. **LM Studio's tool call confirmation**: keep it on, so you approve each call (especially `run_command`).
3. **Built-in blocked commands**: refuses catastrophic commands such as `rm -rf /`, `format C:`, `diskpart`, `Remove-Item -Recurse C:\`, `mkfs` and shutdown commands. This is a safety net, not a sandbox: a shell command can still do anything your user account can.

For a read-only assistant, turn **Allow Shell Commands** off and don't approve `write_file`/`edit_file` calls.

## Tips

- Pair it with **memory-tools** set to the same folder, so the model reads your project's `AGENTS.md` at the start of each chat.
- If a small model keeps rewriting whole files, remind it: "use edit_file for changes to existing files".
- Commands run without a terminal, so anything that waits for input hangs until the timeout. Ask for non-interactive flags (`--yes`, `-y`, `--no-pager`).
- Start dev servers and watchers with `task_run`, not `run_command`: a foreground server would just run into the timeout.
- Undo keeps one step per file per chat, stored outside your project (in the chat's working directory), so it never shows up in your repo.

## Development

```bash
npm install
```

```bash
lms dev
```

Tests live in the repository root (`npm test`). The `src/shared/` files are copied from the repository's `shared/` folder; edit them there.
