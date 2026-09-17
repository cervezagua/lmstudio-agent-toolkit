# agent-toolkit

*Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit).*

Coding-agent tools for LM Studio models: files and a shell, memory that survives between chats, git and GitHub, the web with a real browser, and documents. Everything runs on your machine — no API keys, nothing uploaded.

## Setup

1. Enable **agent-toolkit** in the chat (the chip under the message box).
2. Click the chip and set **Project Folder** to the folder you want the model to work in. Every group below uses it, and file paths cannot escape it. Leave it empty to use the chat's own working directory.
3. Switch on the groups you want. **Files & Shell**, **Memory & Context** and **Git & GitHub** start on; **Web** and **Documents** start off, because a long tool list makes small models choose worse.
4. Keep LM Studio's tool call confirmation on, and approve calls as they come.

## Files & Shell

| Tool | Parameters | What it does |
|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` | Returns lines prefixed with their line numbers. `offset` (1-based) and `limit` page through large files (default: first 2000 lines), and only the requested lines are read into memory. Binary files, and whole-file reads over **Max Read Bytes**, are refused. |
| `write_file` | `path`, `content` | Creates or overwrites a file. Missing parent folders are created. |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | Exact search-and-replace. `old_string` must appear exactly once unless `replace_all` is true. LF text matches Windows CRLF files. |
| `multi_edit` | `path`, `edits`, `preview?` | Several exact replacements in one file, applied in order. If any one fails, nothing is written. |
| `insert_lines` | `path`, `after_line`, `content`, `preview?` | Inserts text after a line number (0 = top of the file), without quoting the surrounding code. |
| `undo_edit` | `path` | Restores a file to its content before this chat's last change to it. |
| `list_dir` | `path?` | Lists a folder, subfolders first (marked with `/`). |
| `glob` | `pattern`, `path?` | Finds files by pattern (`**/*.ts`), most recently modified first. |
| `grep` | `pattern`, `path?`, `glob?`, `ignore_case?`, `max_results?`, `context?`, `output_mode?`, `offset?` | Regex search of file contents. `output_mode` is `content` (default), `files_with_matches` (paths only, the cheapest way to answer "where is X used?") or `count`. `context` adds surrounding lines, `offset` pages through results. Uses ripgrep if installed, otherwise a built-in search. |
| `run_command` | `command`, `description?`, `cwd?`, `timeout_seconds?` | Runs a shell command and returns the exit code, stdout and stderr. `description` is one line saying what it does, shown while it runs. Output far past the limit is written to a file and its path returned, so nothing is lost. With **Persistent Shell Session** on, every command shares one shell, so `cd`, environment variables and activated virtualenvs carry over. Only present when **Allow Shell Commands** is on. |
| `shell_reset` | – | Restarts that shell session, clearing its directory and variables. Only with the session enabled. |

With **Background Tasks** on, for dev servers, watchers and long builds:

| Tool | Parameters | What it does |
|---|---|---|
| `task_run` | `command`, `cwd?`, `name?` | Starts a command in the background and returns a task id. |
| `task_list` | – | The chat's tasks with their status: running, exited with a code, or gone. |
| `task_output` | `id`, `offset?`, `max_chars?` | Output written after `offset`, plus the next offset, so the model can poll for new output only. |
| `task_stop` | `id` | Stops a task and its child processes. |

With **Diagnostics** on, a `diagnostics` tool runs the project's own checkers (tsc, ESLint, Ruff, Pyright, cargo, go vet). With **Jupyter Notebook Tools** on, `notebook_read` and `notebook_edit` read and change `.ipynb` cells. With **Research Sub-agent** on, `run_subagent` answers a search-heavy question in a read-only nested agent.

## Memory & Context

On the **first message of every chat**, this group adds today's date, your instruction files (`AGENTS.md` by default), the memory index, the installed skills, and — in a git repository — the branch, uncommitted changes and recent commits.

| Tool | Parameters | What it does |
|---|---|---|
| `memory_save` | `name`, `description`, `content`, `type` | Saves one fact. `type` is `user`, `feedback`, `project`, `reference` or `session`. Saving an existing name replaces it. |
| `memory_read` | `name` | Returns a memory's full content; suggests similar names if there's no exact match. |
| `memory_search` | `query`, `limit?` | Keyword search over names, descriptions and content, with a snippet for each match. |
| `memory_list` | – | The full index. |
| `memory_delete` | `name` | Deletes a memory that is wrong or outdated. |
| `save_session_summary` | `title`, `summary` | Saves a summary of this chat (goal, work done, decisions, next steps) as a `session` memory, so you can continue in a new chat. |
| `todo_write` | `todos` (list of `{content, status}`) | Replaces this chat's todo list. `status` is `pending`, `in_progress` or `completed`; only one item may be `in_progress`. |
| `todo_read` | – | Shows the current list. |
| `skill_list` | – | Lists the skills installed on your computer (name and one-line description). |
| `skill_read` | `name` | Loads a skill's full instructions to follow for the task at hand. |
| `enter_plan_mode` | – | Switches the chat into planning mode: research only. |
| `exit_plan_mode` | `plan` | Presents the plan and re-enables the tools that make changes. |

Skills use the standard Agent Skills layout — `<skill>/SKILL.md` with `name:` and `description:` frontmatter, or a single `<name>.md`. It's the same layout Claude Code, Codex and LM Studio Bionic use, so point **Skills Directory** at `~/.claude/skills` and your existing skills work unchanged.

## Git & GitHub

`git` and `gh` are run directly, never through a shell, so nothing is word-split or interpreted.

| Tool | Parameters | What it does |
|---|---|---|
| `git_status` | – | Branch, upstream state, and changed/untracked files |
| `git_diff` | `staged?`, `ref?`, `path?`, `stat_only?` | Unstaged changes by default; `staged` for what will be committed; `ref` to compare against a commit or branch |
| `git_log` | `count?`, `ref?`, `path?` | Recent commits: hash, date, author, refs, subject (default 15) |
| `git_show` | `ref`, `stat_only?` | A commit's message and changes |
| `git_add` | `paths` | Stages files (`["."]` for everything), then shows the short status |
| `git_commit` | `message` | Commits what's staged; refuses when nothing is staged. Multi-line messages are fine. |
| `git_branch` | `name?`, `base?`, `switch?` | Lists branches, or creates/switches to `name` (optionally from `base`) |
| `git_init` | – | Creates a repository in the Project Folder |
| `git_push` | `remote?` | Pushes the current branch and sets its upstream. **Only present when Allow Push is on. Never force-pushes.** |
| `gh_pr_list` | `state?`, `limit?`, `search?` | Lists pull requests |
| `gh_pr_view` | `number?` | A PR's description, status and comments (defaults to the current branch's PR) |
| `gh_pr_diff` | `number?` | A PR's diff |
| `gh_pr_checks` | `number?` | CI check results, including pending ones |
| `gh_pr_create` | `title`, `body`, `base?`, `draft?` | Opens a PR from the current branch (push first) |
| `gh_issue_list` | `state?`, `limit?`, `search?` | Lists issues |
| `gh_issue_view` | `number` | An issue with its comments |

The `gh_*` tools appear only when the [GitHub CLI](https://cli.github.com) is installed and logged in.

## Web

| Tool | Parameters | What it does |
|---|---|---|
| `web_search` | `query`, `count?` | Titles, URLs and snippets from the configured search backend |
| `fetch_url` | `url`, `max_chars?`, `offset?`, `refresh?` | Downloads a page and returns its main content as markdown (Readability + Turndown), with absolute links. Also reads PDFs page by page; plain text and JSON come back as-is. `offset` continues a long document where the last call stopped. Results are cached for ten minutes unless `refresh` is set, and a redirect to another host is reported in the result. Downloads are capped at 5 MB with a 30 s timeout, and retried on temporary failures. |
| `browser_open` | `url` | Opens the URL in a real browser (runs JavaScript) and returns a snapshot |
| `browser_snapshot` | – | A fresh snapshot of the current page |
| `browser_click` | `ref` | Clicks element `[ref]` from the latest snapshot, then returns the new snapshot |
| `browser_type` | `ref`, `text`, `submit?` | Fills an input or textarea (or picks a `<select>` option by label); `submit` presses Enter |
| `browser_back` | – | Goes back in history |
| `browser_screenshot` | `full_page?` | Saves a PNG to `<chat working directory>/screenshots/` and returns its path |
| `browser_close` | – | Closes the browser |

Search uses [SearXNG](https://github.com/searxng/searxng) at `http://localhost:8888` when it's running and falls back to DuckDuckGo, which often answers automated requests with a bot check. A Brave Search API key is the third option. The browser drives your installed Edge or Chrome through Playwright; all chats share one browser.

## Documents

**Your chat model does not need vision.** A PDF's text layer is read with no model at all, and OCR runs on a separate vision model only when the page is a scan.

| Tool | Parameters | What it does |
|---|---|---|
| `read_document_text` | `path`, `pages?` | Reads a PDF's text layer: fast, exact, no model needed. Says when a PDF looks scanned and needs OCR. |
| `ocr_document` | `path`, `pages?`, `instructions?` | Reads a scanned PDF or an image (png, jpg, webp, gif, bmp) with a vision model and returns its text. |
| `pdf_to_images` | `path`, `pages?`, `output_directory?` | Renders pages as PNG files and returns their paths, without reading them. |

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Project Folder** | empty | The folder every group works in. Empty = the chat's working directory. |
| **Max Output Characters** | 20000 | Longer tool results are truncated, keeping head and tail. |
| **Files & Shell** | on | The group above. |
| → Allow Shell Commands | on | Exposes `run_command`. |
| → Shell | auto | `pwsh`/PowerShell on Windows, `bash`/`sh` elsewhere. |
| → Default Command Timeout | 60 s | The model may ask for up to 10× this. |
| → Extra Blocked Command Patterns | empty | Case-insensitive regexes refused on top of the built-in ones. |
| → Persistent Shell Session | on | One shell for the chat, so `cd` and variables carry over. |
| → Max Read Bytes | 262144 | Largest whole-file read; bigger files need `offset`/`limit` or `grep`. |
| → Background Tasks | on | Adds the `task_*` tools. |
| → Diagnostics | on | Adds the `diagnostics` tool. |
| → Jupyter Notebook Tools | off | Adds `notebook_read` / `notebook_edit`. |
| → Research Sub-agent | off | Adds `run_subagent`, and a model to run it. |
| **Memory & Context** | on | The group above. |
| → Instruction Files | `AGENTS.md`, `CLAUDE.md`, `.lmstudio/instructions.md` | Loaded from the Project Folder into each new chat. |
| → Inject Memory Index | on | Also lists saved memories. |
| → Git Snapshot | on | Adds branch, changes and recent commits. |
| → Skills | on | Adds `skill_list` / `skill_read`. |
| → Plan Mode | on | Adds `enter_plan_mode` / `exit_plan_mode`. |
| → Max Injected Characters | 12000 | Cap on what's added to the first message. |
| **Git & GitHub** | on | The group above. |
| → Allow Push | off | Exposes `git_push`. |
| → Enable GitHub Tools | on | Exposes `gh_*` when `gh` is installed. |
| **Web** | off | The group above. |
| → Search Backend | auto | `auto`, `searxng`, `duckduckgo` or `brave`. |
| → SearXNG URL | `http://localhost:8888` | Your instance. |
| → Default Search Results | 8 | |
| → Max Page Characters | 15000 | Cap on fetched pages and snapshots. |
| → Browser Fallback for fetch_url | on | Renders JavaScript-only pages in the browser. |
| → Enable Browser Tools | on | Exposes `browser_*`. |
| → Browser | msedge | `msedge`, `chrome` or `chromium`. |
| → Headless Browser | on | Turn off to watch it work. |
| **Documents** | off | The group above. |
| → Vision Model | empty | Model key for OCR. Empty = the first loaded vision model. |
| → PDF Render Scale | 2 | Larger reads small print better and costs more tokens. |
| → Max Pages Per Call | 10 | |

Global settings (shared by every chat): **Memory Directory**, **Skills Directory**, **Brave Search API Key**.

## Safety

Approving a tool call is the same as running that command yourself.

- **Project Folder** — file paths resolve inside it, after following symlinks and junctions. `read_file` may also open this plugin's own output files in the chat folder.
- **Read before edit** — a file must have been read in this chat before it can be edited, and the edit is refused if it changed since.
- **Atomic writes** — files are written to a temp file and renamed, so an interrupted write can't truncate your work.
- **Blocked commands** — catastrophic ones (`rm -rf /`, `format C:`, `diskpart`) are refused. A seatbelt, not a sandbox: a shell command can still do anything your account can.
- **Opt-in danger** — `git_push` is off by default and never force-pushes; the shell can be switched off entirely.
- **Plan mode** — while planning, every tool that changes a file is withheld. `run_command` stays available for read-only checks, with a reminder that planning is on.
