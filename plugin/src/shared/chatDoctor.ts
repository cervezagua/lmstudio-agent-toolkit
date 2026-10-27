/**
 * Finds the ways a reply in LM Studio's chat can look stuck or broken, from the steps LM Studio
 * saves for it (conversations/*.conversation.json): each one was a bug a user met in a real chat,
 * and none shows up in a test that only looks at what the model said. Used by `npm run chat-doctor`
 * on a saved chat, and by agent-toolkit-loop's tests on what a fake LM Studio recorded.
 */

export interface Finding {
  /** 1-based position of the message in the chat. */
  message: number;
  severity: "error" | "warning";
  rule: string;
  detail: string;
}

/** A step of an assistant message, as LM Studio saves it. Only the fields the rules read. */
export interface Step {
  type: string;
  callId?: number;
  style?: { type?: string; ended?: boolean };
  roleOverride?: string;
  content?: { type: string; text?: string; callId?: number; name?: string }[];
  statusState?: { status?: { type?: string } | string; text?: string };
  request?: { callId?: number; name?: string };
}

/** Tool card states that show an outcome; any other means the call never finished. */
const FINAL = new Set(["toolCallSucceeded", "toolCallFailed", "toolCallDenied", "toolCallGenerationFailed"]);

/**
 * The problems in one assistant reply. `last` says whether it is the chat's latest message, where
 * an unfinished call may also mean the reply is still running.
 */
export function checkReply(steps: Step[], message: number, last: boolean): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], rule: string, detail: string) => findings.push({ message, severity, rule, detail });

  if (steps.length === 0) {
    if (last) add("warning", "empty-reply", "The reply has nothing in it yet: it may still be starting, or it never began.");
    return findings;
  }

  const cards = new Map<number, string>();
  for (const step of steps) {
    if (step.type !== "toolStatus" || step.callId === undefined) continue;
    const status = step.statusState?.status;
    cards.set(step.callId, typeof status === "string" ? status : (status?.type ?? "unknown"));
  }
  const requests = new Map<number, string>();
  const results = new Set<number>();
  const visible: string[] = [];
  let thought = false;
  for (const step of steps) {
    if (step.type !== "contentBlock") continue;
    const isThinking = step.style?.type === "thinking";
    if (isThinking) thought = true;
    for (const part of step.content ?? []) {
      if (part.type === "toolCallRequest" && part.callId !== undefined) requests.set(part.callId, part.name ?? "a tool");
      else if (part.type === "toolCallResult" && part.callId !== undefined) results.add(part.callId);
      else if (part.type === "text" && !isThinking && step.style?.type !== "customLabel" && part.text) visible.push(part.text);
    }
  }

  // An approval LM Studio cannot show: its buttons live on the call's card (agent-toolkit-loop 0.7.0).
  for (const step of steps) {
    if (step.type !== "requestConfirmToolCall" || step.request?.callId === undefined) continue;
    if (!cards.has(step.request.callId)) {
      add("error", "approval-without-card", `An approval for ${step.request.name ?? "a tool call"} has no tool card, so LM Studio shows no Approve or Deny buttons.`);
    }
  }

  // A card that never reached an outcome: the reply looks busy, and Stop may be greyed out.
  for (const [callId, state] of cards) {
    if (FINAL.has(state)) continue;
    const name = requests.get(callId) ?? "a tool call";
    add(
      last ? "warning" : "error",
      "card-not-finished",
      `The card for ${name} still says "${state}"${last ? ": the reply is still running, or it is stuck." : ", though the reply ended."}`,
    );
  }

  // A call shown with neither a result nor a card that explains why.
  for (const [callId, name] of requests) {
    if (results.has(callId)) continue;
    const state = cards.get(callId);
    if (state && FINAL.has(state)) continue;
    if (state) continue; // reported above
    add(last ? "warning" : "error", "call-without-result", `The call to ${name} has no result and no card.`);
  }

  const said = visible.join("").trim();
  if (!said && requests.size === 0 && thought) {
    add("warning", "only-thinking", "The reply is only thinking: no answer and no tool call, so the chat seems to stop.");
  }
  if (/<\/?think>/.test(said)) {
    add("warning", "thinking-in-answer", "The answer contains a <think> tag: LM Studio did not separate this model's thinking from its answer.");
  }

  // A reply whose last words stop mid-sentence, with nothing after: the context may have run out.
  const lastStep = steps[steps.length - 1];
  const lastText = lastStep.type === "contentBlock" && lastStep.style?.type !== "thinking" && lastStep.style?.type !== "customLabel"
    ? (lastStep.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("").trimEnd()
    : "";
  if (lastText && /[\p{L}\p{N},;:\/(\-]$/u.test(lastText) && !/```$/.test(lastText)) {
    add("warning", "cut-off", `The reply stops mid-sentence ("…${lastText.slice(-40)}"): the context may have run out, or the model stopped early.`);
  }

  for (const step of steps) {
    if (step.type === "status" && typeof step.statusState?.status === "string" && step.statusState.status === "error") {
      add("warning", "error-status", `The reply shows an error: ${step.statusState.text ?? ""}`.trim());
    }
  }
  return findings;
}

/** The problems in a saved chat: its assistant messages, with the latest one marked as such. */
export function checkChat(conversation: { messages?: any[] }): Finding[] {
  const messages = conversation.messages ?? [];
  const findings: Finding[] = [];
  messages.forEach((message, index) => {
    const version = message?.versions?.[message?.currentlySelected ?? 0];
    if (version?.role !== "assistant") return;
    findings.push(...checkReply(version.steps ?? [], index + 1, index === messages.length - 1));
  });
  return findings;
}
