# memory-tools

Gives LM Studio models memory that lasts between chats, loads your project instructions automatically, and adds a todo list for multi-step work.

## What happens automatically

On the **first message of every new chat**, the plugin adds a context block before your message containing:

- the project instruction files it finds (by default `AGENTS.md`, `CLAUDE.md`, `.lmstudio/instructions.md` in the Project Directory)
- the index of saved memories (names and one-line descriptions), so the model knows what it can look up

Later messages are left alone, so this costs context once per chat. Attached files and images are kept. The status line shows which files were loaded.

## Tools

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

## Skills

A skill is a written set of instructions for one kind of task: a workflow, a house style, a checklist. They live in `~/.lmstudio-agent-skills` (configurable), as either:

```
~/.lmstudio-agent-skills/
  release-checklist/
    SKILL.md          # instructions, with optional frontmatter (name, description)
    template.md       # supporting files the model can read with coder-tools
  commit-style.md     # or just a single markdown file
```

`SKILL.md` can start with frontmatter; without it, the file name is the skill name and the first real line becomes the description:

```markdown
---
name: release-checklist
description: Steps to cut a release
---

1. Run the tests
2. Tag the commit
```

The names and descriptions of installed skills are added at the start of each chat, so the model knows what exists; it then loads the full text with `skill_read` only when it's relevant.

## Plan mode

`enter_plan_mode` switches the chat into research mode, and this is enforced, not just advice: **coder-tools and git-tools stop offering the tools that change things** (`write_file`, `edit_file`, `multi_edit`, `insert_lines`, `undo_edit`, `notebook_edit`, `task_run`, `git_add`, `git_commit`, `git_branch`, `git_init`, `git_push`, `gh_pr_create`) until `exit_plan_mode` is called. Reading, searching and running commands stay available, and `run_command`'s description tells the model to keep to read-only commands.

The mode is stored in `.agent-mode.json` in the chat's working directory, which all plugins in a chat share. It takes effect from the model's next message, since LM Studio builds the tool list once per message.

### Memory types

| Type | Use it for |
|---|---|
| `user` | Who you are, your role, your preferences |
| `feedback` | Corrections and confirmed ways of working, with the reason |
| `project` | Goals, decisions and deadlines (absolute dates) |
| `reference` | Links and where things live |
| `session` | Summaries written by `save_session_summary` |

## Storage

Each memory is a markdown file with a small frontmatter header:

```markdown
---
name: prefers-pnpm
description: User uses pnpm, never npm
type: feedback
updated: 2026-09-15T18:30:00.000Z
---

Always run pnpm. Why: the repo has a pnpm lockfile.
```

The files live in `~/.lmstudio-agent-memory/` (configurable), next to a `MEMORY.md` index. The index is rebuilt from the files each time, so it never goes stale. You can edit or delete the files by hand. Todo lists are stored in each chat's working directory, so each chat has its own list.

## Settings

| Setting | Scope | Default | Notes |
|---|---|---|---|
| Project Directory | chat | *(empty = chat working directory)* | Use the same folder as coder-tools' Root Directory. |
| Instruction Files | chat | `AGENTS.md`, `CLAUDE.md`, `.lmstudio/instructions.md` | Paths relative to the Project Directory; files outside it are ignored. |
| Inject Memory Index | chat | on | |
| Skills | chat | on | Adds `skill_list`/`skill_read` and lists installed skills at chat start. |
| Plan Mode | chat | on | Adds `enter_plan_mode`/`exit_plan_mode`. |
| Max Injected Characters | chat | 12000 | Cap for instructions plus index plus skill list. Lower it for small context windows. |
| Memory Directory | global | `~/.lmstudio-agent-memory` | Shared by all chats. |
| Skills Directory | global | `~/.lmstudio-agent-skills` | Shared by all chats. |

## Working with long chats

LM Studio plugins can't rewrite earlier messages, so there's no automatic context compaction. When a chat gets long:

1. Ask: "save a session summary".
2. Start a new chat and ask: "read the latest session memory and continue".

## Development

```bash
npm install
```

```bash
lms dev
```

Tests live in the repository root (`npm test`). The `src/shared/` files are copied from the repository's `shared/` folder; edit them there.
