# agent-toolkit-loop

**Keeps a long chat going past the model's context limit, in the same window, and answers `/btw` side questions.** A companion to [agent-toolkit](https://lmstudio.ai/cervezagua/agent-toolkit): enable both in a chat.

```bash
lms get cervezagua/agent-toolkit-loop
```

## What it does

A plugin cannot make a loaded model's context bigger, and it cannot delete messages from a chat. But what the chat shows and what the model is sent are different things. This plugin builds the prompt for each reply, so it can send the model less while every message stays on screen and in the saved chat.

- **It does as little as it can.** Nothing changes until the prompt passes 70% of the context (**Compact At**). Then:
  1. **Old tool output is hidden first.** It's replaced by a one-line note saying where the full text is, with no model call needed. Tool calls and the assistant's own words stay. Studies of coding agents found this matches a model-written summary at half the cost.
  2. **A summary, only if that's not enough.** Everything before the recent turns is replaced by:
     - your own messages, word for word (instructions spread over many turns are what summaries lose first);
     - a list of the files changed, commands run and attempts that failed, read from the tool calls rather than recalled by the model;
     - a short running summary the model keeps up to date.
- **Nothing is lost for good.** Every message is written to `.agent-toolkit/compaction/transcript.md` in the chat's folder. The model is told to `grep` it when the summary lacks a detail, and agent-toolkit's tools can read it.
- **Your task list stays in view.** The open tasks from `todo_write` are restated at the end of the prompt every few messages, where small models pay most attention.
- **A failed call isn't repeated forever.** A call that failed twice exactly as written is refused the third time, with the reason. Older failed calls are described in a line instead of being shown again.
- **A garbled tool call doesn't end the reply.** The model is told what was wrong and writes it again.
- **A long reply can make room as it goes.** If a reply's own tool results fill the context, older output is hidden and the reply carries on, instead of dying in the middle of a tool call.
- **Huge tool results are cut,** keeping their start and end, so one big result from any plugin or MCP server cannot fill the context.

## `/btw`: side questions

Start a message with `/btw` to ask something on the side without derailing the task:

> /btw what does the `?<=` in that regex do?

- **It's answered from what the chat already knows,** without tools.
- **It's shown with a "btw" label,** and left out of the task's prompts from then on. A later `/btw` can see the earlier side questions.
- **`/btw clear`** forgets them.

LM Studio still saves `/btw` messages in the chat, and its context meter counts them. If you switch this plugin off, the model sees them again.

## Settings

| Setting | Default | |
|---|---|---|
| Compact At | 0.7 | Start making room once the prompt passes this share of the context. |
| Compact To | 0.45 | Aim for this share. A wide gap compacts rarely, which keeps replies fast. |
| Usable Context | 0 | Treat the context as at most this many tokens; 0 uses the loaded size (32768 for a remote model). Small models often get worse long before their limit. |
| Recent Tool Rounds Kept | 6 | Rounds of tool calls whose results stay whole. |
| Summarize When Needed | on | Off: only hide old output. |
| Max Tool Result | 4000 | Most tokens one tool result may take. |
| Task Reminder Every | 4 | Restate the open tasks every this many messages (0: only after compacting). |
| Show Notices | on | Say in the chat when the prompt was compacted. The notices aren't sent to the model. |

## When not to use it

- **Bulk data doesn't compress.** If a chat is about analysing big files or logs, the old output *is* what the model needs. Hiding it makes the model read it again, which fills the context again. Switch the plugin off for that kind of work.
- **Short chats never reach the limit,** so it does nothing there; the other features still apply.

## Good to know

- **It takes over LM Studio's reply loop** for the chats it's enabled in, and rebuilds what the default loop does: text, thinking blocks, tool calls and results. Switch it off and LM Studio's own loop is back exactly as before.
- **Tool confirmations still work.** Tools come from the other enabled plugins through LM Studio, and the plugin asks for your approval of each call through LM Studio's own confirmation. "Always allow" works as usual. A call it cannot ask about is not run.
- **Remote models work too.** A model served by a generator plugin such as LM Studio's remote-lmstudio or openai-compat-endpoint runs through the same loop, with the tools. Such a model cannot say how big its context is or count tokens, so set **Usable Context** to its real size (otherwise 32768 is assumed); sizes are estimated from the text. Compaction works before each reply, but a long reply can't make room as it goes, since a remote model doesn't report how full its context is.
- **Everything is kept on disk.** The whole conversation, tool output included, is written to `.agent-toolkit/compaction/transcript.md` in the chat's folder, so the model can look up output that was hidden. The folder gets a `.gitignore`.
- **It relies on LM Studio APIs marked experimental.** An LM Studio update could break it; if the tools can't be reached, it says so in the chat and answers without them.
- **Summaries are written by your model.** A small model writes a small-model summary, which is why your own words and the list of steps are kept verbatim beside it.
- **Tool definitions are a fixed cost** on every message, and no compaction reduces them. Switch off the agent-toolkit groups you don't need.
