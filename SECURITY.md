# Security

## What these plugins can do

By design, these plugins let a language model act on your computer:

- **Files & Shell** reads and writes files inside the folder you choose and runs shell commands with your user account's permissions.
- **Git & GitHub** commits to repositories and, if you enable it, pushes to remotes.
- **Web** fetches web pages and drives a real browser; it can reach anything your computer can, including services on your local network.
- **Memory & Context** stores notes on disk in plain text.
- **Documents** reads documents and pictures inside the folder you choose, downloads pictures from web addresses the model gives it, sends images to a model running in LM Studio, and writes Word and PDF files into the folder.

Nothing is sent to an outside service except the web requests the model makes through the Web group and the pictures `view_image` downloads.

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
- **SQLite.** `sqlite_query` is off by default. It opens a database inside the project folder read-only and accepts a single reading statement; a query that runs longer than ten seconds is stopped.
- **Saved skills.** `skill_save` is off by default. A skill is loaded into every future chat, and the skills folder may be shared with other apps, so a saved skill reaches further than the chat that wrote it. Its content is shown to you for approval and goes through the same scan.
- **Past chats.** `chat_search` is off by default. It reads your earlier LM Studio conversations, which hold everything you typed there, and returns short excerpts to the model. It only reads.

For untrusted work, switch off **Allow Shell Commands**, or run LM Studio inside a virtual machine or container.

## Reporting a problem

If you find a way around a safeguard (escaping the root directory, bypassing plan mode, injecting arguments into git), please report it privately through GitHub's **Security → Report a vulnerability** on this repository rather than opening a public issue. Include steps to reproduce and the plugin version.
