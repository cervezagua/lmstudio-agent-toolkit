import { Chat, type PluginContext, type PredictionLoopHandlerController } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { capTools } from "./shared/compaction/capTools";
import { runReply, type ReplyOutput } from "./shared/compaction/reply";

/** About as many characters as a token holds, for caps set in tokens. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Shows a reply in LM Studio's chat. Blocks are made when there is something to put in them: an
 * empty block shows as "This message contains no content". Every call is guarded, since the chat
 * may already be gone when a late fragment arrives.
 */
function chatOutput(ctl: PredictionLoopHandlerController): ReplyOutput {
  let text: ReturnType<typeof ctl.createContentBlock> | undefined;
  let thinking: ReturnType<typeof ctl.createContentBlock> | undefined;
  const safely = (action: () => void) => {
    try {
      action();
    } catch {
      // the chat closed, or the block was already finished
    }
  };
  const label = (name: string, color: "blue" | "purple", inContext: boolean, content: string) =>
    safely(() => ctl.createContentBlock({ includeInContext: inContext, style: { type: "customLabel", label: name, color } }).appendText(content));
  return {
    newRound: () => {
      text = undefined;
      thinking = undefined;
    },
    text: content => safely(() => (text ??= ctl.createContentBlock()).appendText(content)),
    reasoning: content => safely(() => (thinking ??= ctl.createContentBlock({ includeInContext: false, style: { type: "thinking" } })).appendText(content)),
    reasoningEnded: () => safely(() => thinking?.setStyle({ type: "thinking", ended: true })),
    toolRequest: (callId, request) =>
      safely(() =>
        (text ??= ctl.createContentBlock()).appendToolRequest({
          callId,
          toolCallRequestId: request.id,
          name: request.name,
          parameters: request.arguments ?? {},
        }),
      ),
    toolResult: (callId, toolCallRequestId, content) =>
      safely(() => ctl.createContentBlock({ roleOverride: "tool" }).appendToolResult({ callId, toolCallRequestId, content })),
    notice: content => label("Context", "blue", false, content),
    // Kept in the saved chat so a later side question can see it; agent-toolkit-loop leaves it out of the task.
    sideAnswer: content => label("btw", "purple", true, content),
  };
}

async function handlePrediction(ctl: PredictionLoopHandlerController) {
  const config = ctl.getPluginConfig(configSchematics);
  const history = await ctl.pullHistory();
  const model: any = await ctl.tokenSource();

  // A generator plugin chosen as the model cannot count tokens, so there is nothing to fit: pass it on.
  if (typeof model.applyPromptTemplate !== "function" || typeof model.act !== "function") {
    await ctl.createContentBlock().pipeFrom(model.respond(history, { signal: ctl.abortSignal }));
    return;
  }

  let session: Awaited<ReturnType<typeof ctl.startToolUseSession>> | undefined;
  let tools: any[] = [];
  try {
    session = await ctl.startToolUseSession();
    tools = session.tools;
  } catch (error: any) {
    ctl.createStatus({ status: "error", text: `agent-toolkit-loop could not get the tools of the enabled plugins (${error?.message ?? error}); answering without them.` });
  }

  try {
    const loaded: number = await model.getContextLength();
    const cap = config.get("usableContext");
    const usable = cap > 0 ? Math.min(loaded, cap) : loaded;
    const definitions = JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parametersJsonSchema ?? {} })));
    const toolTokens = tools.length ? await model.countTokens(definitions).catch(() => Math.ceil(definitions.length / CHARS_PER_TOKEN)) : 0;
    const maxResultChars = Math.floor(config.get("maxToolResultTokens") * CHARS_PER_TOKEN);
    await runReply({
      sdk: { Chat },
      model,
      history,
      // All results in one reply share half the context, so a run of big results cannot fill it.
      tools: capTools(tools, { perResult: maxResultChars, budget: Math.floor(usable * 0.5 * CHARS_PER_TOKEN) }),
      toolTokens,
      chatDir: ctl.getWorkingDirectory(),
      settings: {
        usable,
        high: config.get("compactAt"),
        low: Math.min(config.get("compactTo"), config.get("compactAt") - 0.1),
        keepRounds: config.get("keepToolRounds"),
        maxResultChars,
        summarize: config.get("summarize"),
        taskReminderEvery: config.get("taskReminderEvery"),
        showNotices: config.get("showNotices"),
      },
      out: chatOutput(ctl),
      signal: ctl.abortSignal,
      // LM Studio's own loop asks before each tool call; a loop that replaces it has to ask too.
      confirm: async (callId, request) => {
        const answer = await ctl.requestConfirmToolCall({
          callId,
          pluginIdentifier: request.pluginIdentifier,
          name: request.name,
          parameters: request.arguments,
        });
        return answer.type === "allow" ? { allow: true, arguments: answer.toolArgsOverride } : { allow: false, reason: answer.denyReason };
      },
    });
  } finally {
    session?.[Symbol.dispose]();
  }
}

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withPredictionLoopHandler(handlePrediction);
}
