# agent-toolkit

**Turn a local model into a working coding agent.** It reads and edits your code, runs your tests, remembers your project, uses git, searches the web and reads your documents. It all runs on your machine: no API keys, nothing uploaded.

[Project home](https://github.com/cervezagua/lmstudio-agent-toolkit) · [Tips & tricks](https://github.com/cervezagua/lmstudio-agent-toolkit#-tips--tricks) · [Report a problem](https://github.com/cervezagua/lmstudio-agent-toolkit/issues)

---

## At a glance

| | Group | Default | In one line |
|---|---|:---:|---|
| 📁 | [Files & Shell](#-files--shell) | on | Read, write and edit files, search the project, run commands |
| 🧠 | [Memory & Context](#-memory--context) | on | Remember things between chats, follow your `AGENTS.md`, plan before changing |
| 🌿 | [Git & GitHub](#-git--github) | on | Status, diffs, commits, branches, pull requests and issues |
| 🌐 | [Web](#-web) | off | Search, read pages and feeds, video transcripts, a real browser |
| 📄 | [Documents](#-documents) | off | Read PDFs, scans and images, with OCR when needed |

Each group is a switch in the plugin's settings. Leave on only what you need, because small models choose better from a short tool list.

## Getting started

1. **Load a tool-capable model**, with 32k context or more.
2. **Enable agent-toolkit** in the chat. It's a chip under the message box.
3. **Click the chip and set Project Folder** to the folder you want the model to work in.
4. **Ask for work**, and approve each tool call as it comes.

Without a Project Folder, the model works in the chat's own empty folder and is told so.

---

## 📁 Files & Shell

| Tool | What it does |
|---|---|
| `read_file` | Reads a file with line numbers; `offset` and `limit` page through big ones. |
| `write_file` | Creates or overwrites a file. |
| `edit_file` | Replaces one exact piece of text. It must match once, so nothing else changes. |
| `multi_edit` | Several replacements in one file; if any fails, none are written. |
| `insert_lines` | Inserts text after a line number. |
| `undo_edit` | Puts a file back as it was before the chat's last change to it. |
| `list_dir` · `glob` | List a folder, or find files by pattern. |
| `grep` | Searches file contents, returning lines, just file names, or counts. |
| `run_command` | Runs a shell command and returns its real exit code and output. |
| `shell_reset` | Starts the shell session afresh. |
| `task_run` · `task_list` · `task_output` · `task_stop` | Run dev servers, watchers and long builds in the background. |
| `diagnostics` | Runs the project's own checkers: tsc, ESLint, Ruff, Pyright, cargo, go vet. |
| `notebook_read` · `notebook_edit` | Read and change Jupyter notebook cells. Off by default. |
| `run_subagent` | Answers a search-heavy question in a read-only helper agent. Off by default. |

Long command output is saved to a file and its path returned, so nothing is lost. `grep` gives the same results whether or not [ripgrep](https://github.com/BurntSushi/ripgrep) is installed; ripgrep just makes it faster.

## 🧠 Memory & Context

Every new chat starts with today's date, your `AGENTS.md` (or `CLAUDE.md`), your saved memories, your skills and, in a git repository, the branch, uncommitted changes and recent commits.

| Tool | What it does |
|---|---|
| `memory_save` · `memory_read` · `memory_search` · `memory_list` · `memory_delete` | Facts that last between chats. |
| `save_session_summary` | Saves where a long chat got to, so a new chat can pick it up. |
| `todo_write` · `todo_read` | A todo list for work with several steps. |
| `skill_list` · `skill_read` | Your skills: written instructions for kinds of task. |
| `skill_save` | Lets the model save a new skill. Off by default. |
| `chat_search` | Searches your earlier LM Studio chats. Off by default. |
| `enter_plan_mode` · `exit_plan_mode` | Plan first: the tools that change files disappear until the plan is presented. |

Skills use the standard `SKILL.md` layout, the same as Claude Code, Codex and LM Studio Bionic. Point **Skills Directory** at `~/.lmstudio/skills` or `~/.claude/skills` and the skills you already have work here.

## 🌿 Git & GitHub

| Tool | What it does |
|---|---|
| `git_status` · `git_diff` · `git_log` · `git_show` | See what changed, and when. |
| `git_add` · `git_commit` · `git_branch` · `git_init` | Stage, commit, branch, start a repository. |
| `git_push` | Pushes the current branch. Off by default, and never forced. |
| `gh_pr_list` · `gh_pr_view` · `gh_pr_diff` · `gh_pr_checks` · `gh_pr_create` | Pull requests, through the [GitHub CLI](https://cli.github.com). |
| `gh_issue_list` · `gh_issue_view` | Issues. |

`git` and `gh` run directly, never through a shell. The `gh_*` tools appear once `gh` is installed and logged in.

## 🌐 Web

| Tool | What it does |
|---|---|
| `web_search` | Searches the web through your SearXNG, DuckDuckGo or Brave. |
| `fetch_url` | Reads a page as clean markdown, or a PDF page by page. Give it a CSS `selector` to read just one part, like a single table. |
| `read_feed` | The latest items of an RSS or Atom feed. A site's home page works too. |
| `video_transcript` | What's said in a YouTube or other video, through [yt-dlp](https://github.com/yt-dlp/yt-dlp). |
| `browser_open` · `browser_click` · `browser_type` · `browser_back` · `browser_snapshot` · `browser_screenshot` · `browser_close` | Drives your own Edge or Chrome. Pages run their JavaScript, and the model clicks by number. |
| `web_doctor` | Checks what's set up (SearXNG, the browser, yt-dlp) and says how to fix what isn't. |

Search works best with a private [SearXNG](https://github.com/searxng/searxng). Without one it falls back to DuckDuckGo, which often turns automated requests away with a bot check. `video_transcript` appears once yt-dlp is installed.

`read_feed` and `video_transcript` also come as small plugins of their own: [feed-reader](https://github.com/cervezagua/lmstudio-agent-toolkit/tree/main/standalone/feed-reader) and [video-transcripts](https://github.com/cervezagua/lmstudio-agent-toolkit/tree/main/standalone/video-transcripts).

## 📄 Documents

**Your chat model doesn't need vision.** A PDF's text is read without any model, and OCR uses a separate vision model only for scanned pages.

| Tool | What it does |
|---|---|
| `read_document_text` | Reads a PDF's text, and says when a page looks scanned. |
| `ocr_document` | Reads a scanned PDF or an image with a vision model. |
| `pdf_to_images` | Saves PDF pages as images. |

---

## Settings

**Everywhere**

| Setting | Default | |
|---|---|---|
| Project Folder | *(empty)* | The folder every group works in. |
| Max Output Characters | 20000 | Longer results keep their beginning and end. |

**Files & Shell**

| Setting | Default | |
|---|---|---|
| Allow Shell Commands | on | Offers `run_command`. |
| Shell | auto | PowerShell on Windows, bash elsewhere. |
| Default Command Timeout | 60 s | The model can ask for up to ten times this. |
| Extra Blocked Command Patterns | *(none)* | Your own patterns to refuse. |
| Persistent Shell Session | on | `cd` and variables carry over between commands. |
| Max Read Bytes | 256 KB | Bigger files are read in parts. |
| Background Tasks · Diagnostics | on | |
| Jupyter Notebook Tools · Research Sub-agent | off | |
| Sub-agent Model | Auto | Chosen from a list of your models. |

**Memory & Context**

| Setting | Default | |
|---|---|---|
| Instruction Files | `AGENTS.md`, `CLAUDE.md`, `.lmstudio/instructions.md` | Loaded into each new chat. |
| Inject Memory Index · Git Snapshot · Skills · Plan Mode | on | |
| Scan Loaded Files | on | Leaves out files written to steer the model. |
| Let the Model Save Skills · Search Past Chats | off | |
| Max Injected Characters | 12000 | |

**Git & GitHub:** Allow Push *(off)* · Enable GitHub Tools *(on)*.

**Web:** Search Backend *(auto)* · SearXNG URL *(`http://localhost:8888`)* · Default Search Results *(8)* · Max Page Characters *(15000)* · Browser Fallback *(on)* · Enable Browser Tools *(on)* · Browser *(Edge on Windows, Chrome elsewhere)* · Headless *(on)*.

**Documents:** Vision Model *(Auto, chosen from your models)* · PDF Render Scale *(2)* · Max Pages Per Call *(10)*.

**Shared by every chat:** Memory Directory · Skills Directory · Brave Search API Key.

## Safety

Approving a tool call is the same as running that command yourself, so keep LM Studio's confirmation on.

- **Stays in the Project Folder.** File paths can't leave it, not even through links.
- **Reads before it edits.** A file must be read before it's changed, and the change is refused if the file changed in the meantime.
- **Never half-writes a file.** Writes go to a temporary file first, then replace the original.
- **Refuses disasters.** `rm -rf /`, `format C:`, `diskpart` and similar are blocked. This is a seatbelt, not a sandbox.
- **Risky things are opt-in.** Pushing, saving skills and searching past chats are off until you switch them on.
- **Checks what it loads.** An `AGENTS.md` or skill that tries to steer the model ("ignore previous instructions", hidden characters, sending keys away) is left out, and you're shown why.

---

MIT licensed · [Source](https://github.com/cervezagua/lmstudio-agent-toolkit) · [Security](https://github.com/cervezagua/lmstudio-agent-toolkit/blob/main/SECURITY.md)
