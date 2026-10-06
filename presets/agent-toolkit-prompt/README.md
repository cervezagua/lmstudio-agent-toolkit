# agent-toolkit-prompt

**A system prompt that teaches a local model to work with agent-toolkit's tools:** look before editing, keep a task list, check its work, and stop instead of repeating a call that already failed.

[Project home](https://github.com/cervezagua/lmstudio-agent-toolkit) · [Report a problem](https://github.com/cervezagua/lmstudio-agent-toolkit/issues)

---

## When to use it

Small models often know how to call a tool but not when to stop. This preset is for the cases where the model:

- calls the same failing command again and again
- insists a tool is available after you switched its group off
- rewrites a whole file to change one line
- says it is done without running anything

## What it sets

| Setting | Value |
|---|---|
| System Prompt | About 400 words: how to work, which tool to prefer, what to do when a call fails, and what not to do without being asked. |

It sets nothing else. Temperature, sampling and the prompt template stay as your model has them, because the right values differ from model to model.

## Using it

1. Enable [agent-toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit) in the chat and set its **Project Folder**.
2. Get the preset from the [Hub](https://lmstudio.ai/cervezagua/agent-toolkit-prompt) and pick it in the chat's preset menu. Or paste the contents of [`system-prompt.md`](system-prompt.md) into the chat's **System Prompt** box.

The prompt names agent-toolkit's tools, so it is of little use without the plugin. If you already have a system prompt you like, paste this one below it.

## Editing it

The prompt lives in `system-prompt.md`. After changing it, run `node scripts/build-preset.mjs` from the repository root to rewrite `preset.json`; a test fails if the two differ, or if the prompt names a tool the plugin doesn't have.

---

MIT licensed · Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit)
