/**
 * The conversation as plain data, for the compaction steps to work on without the SDK: each message
 * keeps its text, its tool calls or results, its number in the transcript (#m1, #m2, ...) and the
 * original SDK message, so an unchanged one goes back to the model exactly as it was (files included).
 */

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  content: string;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface Msg {
  role: Role;
  text: string;
  calls: ToolCall[];
  results: ToolResult[];
  /** 1-based position in the whole conversation; the transcript numbers messages the same way. */
  n: number;
  /** The SDK message this came from, sent as is while nothing about it changed. */
  original?: unknown;
}

/** Converts the SDK's history. Only the methods every SDK message has are used. */
export function fromChat(messages: any[]): Msg[] {
  return messages.map((message, index) => ({
    role: message.getRole() as Role,
    text: message.getText(),
    calls: (message.getToolCallRequests?.() ?? []).map((r: any) => ({ id: r.id, name: r.name, args: r.arguments ?? {} })),
    results: (message.getToolCallResults?.() ?? []).map((r: any) => ({ id: r.toolCallId, content: String(r.content) })),
    n: index + 1,
    original: message,
  }));
}

/** The SDK's plain message data for one message, for a message the compaction changed. */
export function toMessageData(msg: Msg): any {
  if (msg.role === "tool") {
    return { role: "tool", content: msg.results.map(r => ({ type: "toolCallResult", content: r.content, toolCallId: r.id })) };
  }
  if (msg.role === "assistant") {
    return {
      role: "assistant",
      content: [
        ...(msg.text ? [{ type: "text", text: msg.text }] : []),
        ...msg.calls.map(c => ({ type: "toolCallRequest", toolCallRequest: { type: "function", id: c.id, name: c.name, arguments: c.args } })),
      ],
    };
  }
  return { role: msg.role, content: [{ type: "text", text: msg.text }] };
}

/**
 * The message with new text and everything else kept: a user message's images and files stay, since
 * the SDK message is copied and only its text replaced. Without an SDK message, the text alone.
 */
export function withText(msg: Msg, text: string): Msg {
  const original = msg.original as any;
  if (typeof original?.asMutableCopy === "function") {
    try {
      const copy = original.asMutableCopy();
      copy.replaceText(text);
      return { ...msg, text, original: copy };
    } catch {
      // fall back to the text alone
    }
  }
  return { ...msg, text, original: undefined };
}

/** A side question, answered by agent-toolkit-loop but never part of the conversation. */
export const isSideQuestion = (msg: Msg) => msg.role === "user" && /^\s*\/btw\b/i.test(msg.text);

/**
 * The history without side questions and their answers: each `/btw` message, and the assistant
 * messages that follow it until the next user message.
 */
export function withoutSideQuestions(msgs: Msg[]): Msg[] {
  const kept: Msg[] = [];
  let skipping = false;
  for (const msg of msgs) {
    if (msg.role === "user") skipping = isSideQuestion(msg);
    if (!skipping) kept.push(msg);
  }
  return kept;
}

/** The tool call each result answers, by id, or by order within the round when ids are missing. */
export function callsById(msgs: Msg[]): Map<string, ToolCall> {
  const byId = new Map<string, ToolCall>();
  for (const msg of msgs) for (const call of msg.calls) if (call.id) byId.set(call.id, call);
  return byId;
}

/**
 * Where a cut may go: before a user message, or before an assistant message that follows a finished
 * round. Never between a tool call and its result, which most chat templates reject.
 */
export function safeCutPoints(msgs: Msg[]): number[] {
  const points: number[] = [];
  for (let i = 1; i < msgs.length; i++) {
    const before = msgs[i - 1];
    const at = msgs[i];
    if (at.role === "tool" || at.role === "system") continue;
    if (before.role === "assistant" && before.calls.length > 0) continue;
    points.push(i);
  }
  return points;
}

/** A tool call in a few words, for placeholders and the ledger. */
export function describeCall(call: ToolCall | undefined): string {
  if (!call) return "a tool call";
  const main = call.args.path ?? call.args.command ?? call.args.query ?? call.args.url ?? call.args.pattern ?? call.args.name;
  const shown = typeof main === "string" ? ` ${main.length > 80 ? main.slice(0, 77) + "..." : main}` : "";
  return `${call.name}${shown}`;
}

/** Whether a tool result reports a failure (the toolkit's convention, and most tools'). */
export const isFailure = (content: string) => /^"?Error\b/.test(content.trim());

/** About how many tokens a text is, for budgeting parts; the real count comes from the model. */
export const roughTokens = (text: string) => Math.ceil(text.length / 3.5);

/** About how many tokens a message takes: its text, its calls' arguments, its results, and the template's markers. */
export const roughSize = (msg: Msg) =>
  8 +
  roughTokens(msg.text) +
  msg.calls.reduce((sum, call) => sum + roughTokens(call.name + JSON.stringify(call.args)), 0) +
  msg.results.reduce((sum, result) => sum + roughTokens(result.content), 0);
