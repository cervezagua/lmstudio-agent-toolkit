import { Chat, type PluginContext, type PredictionLoopHandlerController } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { realpathSync } from "fs";
import { loadApprovals } from "./shared/compaction/approvals";
import { lmStudioHome } from "./shared/lmStudioHome";
import { capTools } from "./shared/compaction/capTools";
import { runReply, type ReplyOutput } from "./shared/compaction/reply";

/** About as many characters as a token holds, for caps set in tokens. */
const CHARS_PER_TOKEN = 3.5;

/**
 * LM Studio's folder, found once when the plugin loads, as LM Studio itself does: a pointer file
 * changed later (by a tool, say) cannot send the approval settings somewhere else.
 */
const LM_STUDIO_HOME = (() => {
  const home = lmStudioHome();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
})();

/**
 * Shows a reply in LM Studio's chat. Blocks are made when there is something to put in them: an
 * empty block shows as "This message contains no content". Every call is guarded, since the chat
 * may already be gone when a late fragment arrives.
 */
function chatOutput(ctl: PredictionLoopHandlerController): ReplyOutput & { closeOpenCalls(reason: string): void } {
  let text: ReturnType<typeof ctl.createContentBlock> | undefined;
  let thinking: ReturnType<typeof ctl.createContentBlock> | undefined;
  const statuses = new Map<number, ReturnType<typeof ctl.createToolStatus>>();
  // Calls whose card does not show an outcome yet: a reply that ends early must close them.
  const open = new Set<number>();
  const FINAL = new Set(["toolCallSucceeded", "toolCallFailed", "toolCallDenied", "toolCallGenerationFailed"]);
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
          pluginIdentifier: request.pluginIdentifier,
        }),
      ),
    // LM Studio's chat ties a call's confirmation to its status card: without one, the approval
    // request is saved but no buttons are shown, and the reply waits forever.
    toolStatus: (callId, status) =>
      safely(() => {
        if (FINAL.has(status.type)) open.delete(callId);
        else open.add(callId);
        const existing = statuses.get(callId);
        if (existing) return existing.setStatus(status);
        statuses.set(callId, ctl.createToolStatus(callId, status));
        // The request goes in a block of its own after the card, as in LM Studio's own loop.
        text = undefined;
      }),
    toolResult: (callId, toolCallRequestId, content) =>
      safely(() => ctl.createContentBlock({ roleOverride: "tool" }).appendToolResult({ callId, toolCallRequestId, content })),
    notice: content => label("Context", "blue", false, content),
    // Kept in the saved chat so a later side question can see it; agent-toolkit-loop leaves it out of the task.
    sideAnswer: content => label("btw", "purple", true, content),
    // A card left on "calling tool" makes LM Studio show a reply that is not running and cannot be stopped.
    closeOpenCalls: reason => {
      for (const callId of open) safely(() => statuses.get(callId)?.setStatus({ type: "toolCallFailed", error: reason }));
      open.clear();
    },
  };
}

async function handlePrediction(ctl: PredictionLoopHandlerController) {
  const config = ctl.getPluginConfig(configSchematics);
  const history = await ctl.pullHistory();
  const model: any = await ctl.tokenSource();

  // A remote model, through a generator plugin such as LM Studio's remote-lmstudio or
  // openai-compat-endpoint, runs the same loop. It cannot count tokens or say its context size, so
  // sizes are estimated from the text and the context is the Usable Context setting (or 32k).
  const remote = typeof model.countTokens !== "function" || typeof model.getContextLength !== "function";

  let session: Awaited<ReturnType<typeof ctl.startToolUseSession>> | undefined;
  let tools: any[] = [];
  try {
    session = await ctl.startToolUseSession();
    tools = session.tools;
  } catch (error: any) {
    ctl.createStatus({ status: "error", text: `agent-toolkit-loop could not get the tools of the enabled plugins (${error?.message ?? error}); answering without them.` });
  }

  const out = chatOutput(ctl);
  // The user's "Always allow" choices as they stand when the reply starts.
  const approved = await loadApprovals(LM_STUDIO_HOME);
  try {
    const cap = config.get("usableContext");
    const loaded: number = remote ? cap || 32_768 : await model.getContextLength();
    const usable = cap > 0 ? Math.min(loaded, cap) : loaded;
    const definitions = JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parametersJsonSchema ?? {} })));
    const estimate = Math.ceil(definitions.length / CHARS_PER_TOKEN);
    const toolTokens = !tools.length ? 0 : remote ? estimate : await model.countTokens(definitions).catch(() => estimate);
    const maxResultChars = Math.floor(config.get("maxToolResultTokens") * CHARS_PER_TOKEN);
    // All results in one reply share half the context, so a run of big results cannot fill it.
    const capped = capTools(tools, { perResult: maxResultChars, budget: Math.floor(usable * 0.5 * CHARS_PER_TOKEN) });
    await runReply({
      sdk: { Chat },
      model,
      history,
      tools: capped,
      refillToolBudget: capped.refill,
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
      out,
      signal: ctl.abortSignal,
      // LM Studio's own loop asks before each tool call; a loop that replaces it has to ask too.
      confirm: async (callId, request) => {
        // "Always allow" and "never ask" in LM Studio hold here too.
        if (approved(request.pluginIdentifier, request.name)) return { allow: true };
        const answer = await ctl.requestConfirmToolCall({
          callId,
          pluginIdentifier: request.pluginIdentifier,
          name: request.name,
          parameters: request.arguments,
        });
        return answer.type === "allow" ? { allow: true, arguments: answer.toolArgsOverride } : { allow: false, reason: answer.denyReason };
      },
    });
  } catch (error: any) {
    // Ended here, the reply finishes like any other, with the reason in the chat. Thrown on to
    // LM Studio, it left a reply that looked busy, with a greyed-out Stop button and no way out.
    if (!ctl.abortSignal.aborted) {
      const reason = String(error?.message ?? error).split(/\r?\n/)[0].slice(0, 300);
      out.closeOpenCalls(reason);
      try {
        ctl.createStatus({ status: "error", text: `agent-toolkit-loop stopped this reply: ${reason}` });
      } catch {
        // the chat is gone
      }
    }
  } finally {
    // A call whose result never came (the reply was stopped, say) is not left "calling tool".
    out.closeOpenCalls(ctl.abortSignal.aborted ? "The reply was stopped." : "The reply ended before this call finished.");
    session?.[Symbol.dispose]();
  }
}

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withPredictionLoopHandler(handlePrediction);
}
