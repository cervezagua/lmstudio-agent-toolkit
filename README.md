# LM Studio Agent Toolkit

[![CI](https://github.com/cervezagua/lmstudio-agent-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/cervezagua/lmstudio-agent-toolkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Five [LM Studio](https://lmstudio.ai) plugins that give local models the tools a coding agent has: files and a shell, memory that lasts between chats, Git and GitHub, the web with a real browser, and reading documents. Everything runs on your machine.

| Plugin | Tools | Also does |
|---|---|---|
| [`coder-tools`](plugins/coder-tools/README.md) | `read_file` `write_file` `edit_file` `multi_edit` `insert_lines` `undo_edit` `list_dir` `glob` `grep` `run_command` | Root-directory sandbox, blocked commands, persistent shell session, background tasks (`task_run`/`task_list`/`task_output`/`task_stop`), `diagnostics`, notebooks, optional `run_subagent` |
| [`memory-tools`](plugins/memory-tools/README.md) | `memory_save` `memory_read` `memory_search` `memory_list` `memory_delete` `save_session_summary` `todo_write` `todo_read` | Adds `AGENTS.md`/`CLAUDE.md`, the memory index and the skill list to the first message of every chat; skills (`skill_list`/`skill_read`) and plan mode (`enter_plan_mode`/`exit_plan_mode`) |
| [`git-tools`](plugins/git-tools/README.md) | `git_status` `git_diff` `git_log` `git_show` `git_add` `git_commit` `git_branch` `git_init` (+ `git_push` if enabled) | `gh_pr_list` `gh_pr_view` `gh_pr_diff` `gh_pr_checks` `gh_pr_create` `gh_issue_list` `gh_issue_view` when the GitHub CLI is installed |
| [`web-tools`](plugins/web-tools/README.md) | `web_search` `fetch_url` | PDF and paging support, automatic browser fallback, plus `browser_open` `browser_snapshot` `browser_click` `browser_type` `browser_back` `browser_screenshot` `browser_close` (Playwright + installed Edge/Chrome) |
| [`ocr-tools`](plugins/ocr-tools/README.md) | `read_document_text` `ocr_document` `pdf_to_images` | Reads scanned PDFs and images with a vision model you already run in LM Studio |

Each plugin is separate, so you can enable only what a chat needs; small models choose tools better from a short list. Each plugin's README documents its tools and every setting.

## Install

**Requirements:** LM Studio with plugin support and its `lms` CLI, Node.js 22 or newer, and `git`. Optional: [GitHub CLI](https://cli.github.com) for the `gh_*` tools, [ripgrep](https://github.com/BurntSushi/ripgrep) for faster search, Edge or Chrome for the browser tools.

With LM Studio running:

```bash
git clone https://github.com/cervezagua/lmstudio-agent-toolkit.git
```

```bash
cd lmstudio-agent-toolkit
```

```bash
npm run setup
```

That installs all five plugins into LM Studio; LM Studio downloads each plugin's dependencies itself. To install only some, name them: `node scripts/install-plugins.mjs coder-tools memory-tools`. Run the same command again after `git pull` to update.

## Use

1. Load a model that supports tool use (LM Studio marks these "Tool use"; Qwen 3.x and Nemotron models work well).
2. In the chat's sidebar, enable the plugins you want.
3. Set the project folder in the chat's plugin settings: **coder-tools → Root Directory**, and the same folder for **memory-tools → Project Directory** and **git-tools → Repository Directory**.
4. Keep LM Studio's **tool call confirmation** on, and approve calls as the model makes them.
5. Ask for work: "explain this project", "fix the failing test", "add a README".

Load the model with at least ~32k context; file contents and command output fill a window quickly.

## Safety

These plugins exist to let a model act on your computer: they read and write files, run shell commands, browse the web and commit to git. Treat approving a tool call like running that command yourself.

- File tools can't leave the Root Directory (checked after resolving symlinks and junctions).
- A built-in list refuses catastrophic commands such as `rm -rf /` or `format C:`. It's a safety net, not a sandbox: a shell command can still do anything your user account can.
- `git_push` is off by default and never force-pushes.
- In plan mode, the tools that change things are removed from the model's tool list until it presents a plan.

See [SECURITY.md](SECURITY.md) for more, and for how to report a problem.

## Web search

web-tools searches through [SearXNG](https://github.com/searxng/searxng) at `http://localhost:8888` when it's running, and falls back to DuckDuckGo otherwise. DuckDuckGo often answers automated requests with a bot check; the tool reports that rather than trying to get around it. For dependable search, run SearXNG: [`searxng/`](searxng/README.md) sets it up in WSL on Windows, and any other SearXNG instance with the JSON format enabled works too. A Brave Search API key is the third option.

## How it works

- Tools return recoverable problems (a bad path, non-unique edit text, a git error) as `Error: ...` text, so the model can fix its call and retry instead of the chat failing.
- `edit_file` is an exact search-and-replace that must match once, so models don't rewrite whole files. It handles Windows CRLF files when the model sends LF text, and every edit can be previewed or undone.
- `run_command` reports the real exit code; PowerShell's `-Command` normally collapses every failure to 1.
- git-tools runs `git` and `gh` directly, not through a shell, rejects refs that look like options, and never opens an editor or credential prompt.
- memory-tools rebuilds `MEMORY.md` from the memory files each time, so the index can't drift from them.
- The browser snapshot numbers each visible interactive element (`[3] link "Docs" -> /docs`), and the model clicks or types by number.
- Plan mode is stored in a small file in the chat's working directory, which every plugin in the chat shares; coder-tools and git-tools read it each time they build their tool list.

### Limitations

- LM Studio plugins can't rewrite earlier chat history, so there's no automatic context compaction. When a chat gets long, have the model call `save_session_summary`, then continue in a new chat.
- All chats share one browser instance.
- Tool quality depends on the model. Larger tool-use models plan multi-step work far better than small ones.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the layout, tests and how to add a plugin.

## License

[MIT](LICENSE)
