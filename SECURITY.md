# Security

## What these plugins can do

By design, these plugins let a language model act on your computer:

- **Files & Shell** reads and writes files inside the folder you choose and runs shell commands with your user account's permissions.
- **Git & GitHub** commits to repositories and, if you enable it, pushes to remotes.
- **Web** fetches web pages and drives a real browser; it can reach anything your computer can, including services on your local network.
- **Memory & Context** stores notes on disk in plain text.
- **Documents** reads documents inside the folder you choose and sends page images to a model running in LM Studio.

Nothing is sent to an outside service except the web requests the model makes through the Web group.

## Safeguards, and their limits

- **Approve tool calls.** Keep LM Studio's tool call confirmation on. It's the main protection, because you see each command before it runs.
- **Root directory.** File tools can't leave the configured folder; paths are checked after resolving symlinks and junctions. Shell commands are not confined this way.
- **Blocked commands.** A short list refuses catastrophic commands (`rm -rf /`, `format C:`, `diskpart` and similar). It's a safety net, not a sandbox.
- **Plan mode.** Tools that change things are withheld until the model presents a plan.
- **Prompt injection.** Web pages, documents and files can contain text written to manipulate a model. A model that reads such content may attempt harmful tool calls, which is another reason to review calls before approving them.

For untrusted work, switch off **Allow Shell Commands**, or run LM Studio inside a virtual machine or container.

## Reporting a problem

If you find a way around a safeguard (escaping the root directory, bypassing plan mode, injecting arguments into git), please report it privately through GitHub's **Security → Report a vulnerability** on this repository rather than opening a public issue. Include steps to reproduce and the plugin version.
