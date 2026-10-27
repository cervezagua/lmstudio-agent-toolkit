import { type Approvals } from "./approvals";
import { type ReplyOutput, type ToolStatus } from "./reply";

/**
 * The parts of LM Studio's PredictionLoopHandlerController that show a reply, written out here so
 * the code that uses them can be tested against a fake that records what LM Studio would save.
 */
export interface ChatController {
  abortSignal: AbortSignal;
  createContentBlock(options?: { roleOverride?: "tool"; includeInContext?: boolean; style?: any }): {
    appendText(text: string): void;
    appendToolRequest(request: { callId: number; toolCallRequestId?: string; name: string; parameters: Record<string, any>; pluginIdentifier?: string }): void;
    appendToolResult(result: { callId: number; toolCallRequestId?: string; content: string }): void;
    setStyle(style: any): void;
  };
  createToolStatus(callId: number, status: ToolStatus): { setStatus(status: ToolStatus): void };
  createStatus(status: { status: "waiting" | "loading" | "done" | "error" | "canceled"; text: string }): unknown;
  requestConfirmToolCall(request: {
    callId: number;
    pluginIdentifier?: string;
    name: string;
    parameters: Record<string, any>;
  }): Promise<{ type: "allow"; toolArgsOverride?: Record<string, any> } | { type: "deny"; denyReason?: string }>;
}

/** Statuses that show a call's outcome; any other leaves its card looking busy. */
const FINAL = new Set(["toolCallSucceeded", "toolCallFailed", "toolCallDenied", "toolCallGenerationFailed"]);

/**
 * Shows a reply in LM Studio's chat. Blocks are made when there is something to put in them: an
 * empty block shows as "This message contains no content". Every call is guarded, since the chat
 * may already be gone when a late fragment arrives.
 */
export function chatOutput(ctl: ChatController): ReplyOutput & { closeOpenCalls(reason: string): void } {
  let text: ReturnType<ChatController["createContentBlock"]> | undefined;
  let thinking: ReturnType<ChatController["createContentBlock"]> | undefined;
  const statuses = new Map<number, ReturnType<ChatController["createToolStatus"]>>();
  // Calls whose card does not show an outcome yet: a reply that ends early must close them.
  const open = new Set<number>();
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

/** Asks the user about a call through LM Studio's confirmation, unless they chose "Always allow". */
export function confirmInChat(ctl: ChatController, approved: Approvals) {
  return async (callId: number, request: { name: string; arguments: Record<string, unknown>; pluginIdentifier?: string }) => {
    if (approved(request.pluginIdentifier, request.name)) return { allow: true as const };
    const answer = await ctl.requestConfirmToolCall({
      callId,
      pluginIdentifier: request.pluginIdentifier,
      name: request.name,
      parameters: request.arguments,
    });
    return answer.type === "allow" ? { allow: true as const, arguments: answer.toolArgsOverride } : { allow: false as const, reason: answer.denyReason };
  };
}

/**
 * Runs a reply in LM Studio's chat, so that it always ends cleanly. A failure ends here, with its
 * reason in the chat: thrown on to LM Studio, it left a reply that looked busy, with a greyed-out
 * Stop button and no way out. Cards of calls that never got a result are closed either way.
 */
export async function replyInChat(ctl: ChatController, run: (out: ReturnType<typeof chatOutput>) => Promise<void>): Promise<void> {
  const out = chatOutput(ctl);
  try {
    await run(out);
  } catch (error: any) {
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
    out.closeOpenCalls(ctl.abortSignal.aborted ? "The reply was stopped." : "The reply ended before this call finished.");
  }
}
