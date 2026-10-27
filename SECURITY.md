# Security

## What these plugins can do

By design, these plugins let a language model act on your computer:

- **Files & Shell** reads and writes files inside the folder you choose and runs shell commands with your user account's permissions.
- **Git & GitHub** commits to repositories and, if you enable it, pushes to remotes.
- **Web** fetches web pages and drives a real browser; it can reach anything your computer can, including services on your local network.
- **Memory & Context** stores notes on disk in plain text.
- **Documents** reads documents and pictures inside the folder you choose, downloads pictures from web addresses the model gives it, sends images to a model running in LM Studio, and writes Word and PDF files into the folder.

Nothing is sent to an outside service except the web requests the model makes through the Web group and the pictures `view_image` downloads. Two of those requests go to fixed places: `wikipedia` asks Wikipedia, and `web_doctor` asks GitHub whether a newer release exists, only when the model runs it. Nothing is checked at start-up.

## Safeguards, and their limits

- **Approve tool calls.** Keep LM Studio's tool call confirmation on. It's the main protection, because you see each command before it runs.
- **Project folder.** File tools can't leave the configured folder; paths are checked after resolving symlinks and junctions. Shell commands are not confined this way.
- **Blocked commands.** A short list refuses catastrophic commands (`rm -rf /`, `format C:`, `diskpart` and similar). It's a safety net, not a sandbox.
- **Plan mode.** Tools that change things are withheld until the model presents a plan.
- **Prompt injection.** Web pages, documents and files can contain text written to manipulate a model. A model that reads such content may attempt harmful tool calls, which is another reason to review calls before approving them.
- **Scan loaded files.** Instruction files (`AGENTS.md`, `CLAUDE.md`) and skills are loaded into a chat as things to follow, so they are checked first for blunt attempts to steer the model: "ignore previous instructions" and similar, invisible characters, commands that send keys or `.env` files away, and download-and-run one-liners. A match is left out and shown to you with its line. These are simple pattern checks: they miss anything subtle, they do not cover text the model reads with a tool (files, web pages, command output), and they can flag an honest document that quotes one of these phrases. Switch **Scan Loaded Files** off if that happens.
- **Redact secrets.** What a tool returns is checked for API keys, access tokens, private keys, passwords inside web addresses, and `.env`-style lines whose name says secret. Each is replaced by a marker before the model or the saved chat sees it, and you're told how many were hidden. The files themselves are never changed. Only well-known formats are recognised: a password in an unusual place, or a key in a format the check doesn't know, still gets through, so don't treat it as permission to point a model at a folder of credentials. A model that rewrites a whole file it has only seen with markers will write the markers over the real values; `undo_edit` brings the file back. Switch **Redact Secrets** off if it hides something the model needs.
- **Written documents.** `write_document` turns the model's markdown into a Word or PDF file. Raw HTML in it is written as plain text, pictures are left out, and the browser that prints a PDF runs with scripts off and no network access, so a document can't run or fetch anything while it is made.
- **Pictures from the web.** `view_image` downloads an image (10 MB at most) to a temporary folder, shows it to your vision model and deletes it. Like the Web group, it can reach addresses on your local network.
- **Attached files.** The text of a document you attach is put into your message, marked as material to work with rather than instructions; like a web page, it can still try to steer the model. The tools can open files attached in that chat, by name, and only if the file is in LM Studio's own folder for attachments, whatever the chat's list of attachments says. The file tools refuse to change the toolkit's own state in the chat's folder (that list, background tasks, backups, plan mode), under any spelling: on Windows a path with a `:` stream name or a trailing dot or space is refused, and 8.3 short names are compared by their real path.
- **SQLite.** `sqlite_query` is off by default. It opens a database inside the project folder read-only and accepts a single reading statement; a query that runs longer than ten seconds is stopped.
- **Saved skills.** `skill_save` is off by default. A skill is loaded into every future chat, and the skills folder may be shared with other apps, so a saved skill reaches further than the chat that wrote it. Its content is shown to you for approval and goes through the same scan.
- **Syntax checks after edits.** With **Check Edits** on, a JavaScript, Python or JSON file the model writes is checked right away with `node --check` or Python's `compile()`. Neither runs the file. Python runs isolated (`-I`) from a neutral folder, so a project's own `tokenize.py` or the like cannot stand in for the standard module. No shell is involved.
- **Commands.** A project can ship its own `/commands` in `.agent-toolkit/commands/`, so a cloned repository can too. They're scanned like `AGENTS.md` (descriptions included), only regular files are read (no links), and the status line names the file a command came from. They cannot take a built-in name such as `/review` or `/commit`. The file tools refuse to write there, so a model steered by a web page cannot plant a command for a later chat.
- **Checkpoints and `/rewind`.** The earlier content of each file the tools change is kept in the chat's own folder, which the tools cannot write. `/rewind` restores only paths inside the project folder, compared by real path, and counts a file as new only if it truly did not exist. Changes made by shell commands are not tracked. A rewind cannot itself be undone.
- **agent-toolkit-loop.** For the chats it's enabled in, it runs the reply loop in place of LM Studio's own, and asks for your approval of each tool call through LM Studio's confirmation; a call it cannot ask about is not run. It follows the "Always allow" choices and the "never ask" switch saved in LM Studio's settings, as LM Studio's own loop does, and asks if it cannot read them. It writes the whole conversation, tool output included, to `.agent-toolkit/compaction/transcript.md` in the chat's folder. That folder and the other state folders get a `.gitignore`, so `git add .` in a chat without a Project Folder cannot stage them. When it compacts a chat, the record of the earlier conversation is labelled as information, not instructions, and stays out of the system prompt, because the summary is written by the model from tool output too. A web page can still try to plant text in that summary, so keep reviewing tool calls.
- **Past chats.** `chat_search` is off by default. It reads your earlier LM Studio conversations, which hold everything you typed there, and returns short excerpts to the model. It only reads.

For untrusted work, switch off **Allow Shell Commands**, or run LM Studio inside a virtual machine or container.

## Reporting a problem

If you find a way around a safeguard (escaping the root directory, bypassing plan mode, injecting arguments into git), please report it privately through GitHub's **Security → Report a vulnerability** on this repository rather than opening a public issue. Include steps to reproduce and the plugin version.
