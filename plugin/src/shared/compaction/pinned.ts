import { callsById, describeCall, isFailure, roughTokens, type Msg } from "./history";
import { precedingCall } from "./mask";

/** Tools whose calls change a file, and the argument that names it. */
const WRITES = new Set(["write_file", "edit_file", "multi_edit", "insert_lines", "undo_edit", "notebook_edit", "write_document"]);

/**
 * What happened, read from the tool calls by code rather than recalled by a model: the files that
 * were changed, the commands run and how they ended, commits, and the attempts that failed. A small
 * model's summary loses exactly these; this list cannot, and is rebuilt the same way every time.
 */
export function ledger(msgs: Msg[], maxTokens: number): string {
  const byId = callsById(msgs);
  const changed = new Set<string>();
  const lines: string[] = [];
  for (const [index, msg] of msgs.entries()) {
    if (msg.role !== "tool") continue;
    for (const [k, result] of msg.results.entries()) {
      const call = (result.id && byId.get(result.id)) || precedingCall(msgs, index, k);
      if (!call) continue;
      if (isFailure(result.content)) {
        lines.push(`- failed: ${describeCall(call)}: ${result.content.replace(/^"?Error:\s*/, "").split(/\r?\n/)[0].slice(0, 140)}`);
      } else if (WRITES.has(call.name) && typeof call.args.path === "string") {
        changed.add(call.args.path);
      } else if (call.name === "run_command" && typeof call.args.command === "string") {
        const exit = /exit_code:\s*(-?\d+)/.exec(result.content)?.[1];
        lines.push(`- ran \`${call.args.command.slice(0, 120)}\`${exit !== undefined ? ` (exit ${exit})` : ""}`);
      } else if (call.name === "git_commit") {
        lines.push(`- committed: ${String(call.args.message ?? "").split(/\r?\n/)[0].slice(0, 100)}`);
      }
    }
  }
  const parts: string[] = [];
  if (changed.size) parts.push(`Files changed: ${[...changed].join(", ")}`);
  // Newest first, so the budget keeps what is most likely to matter next.
  const budgeted: string[] = [];
  let used = roughTokens(parts.join("\n"));
  for (const line of lines.reverse()) {
    used += roughTokens(line);
    if (used > maxTokens) break;
    budgeted.push(line);
  }
  if (budgeted.length) parts.push(`Steps, newest first:\n${budgeted.join("\n")}`);
  return parts.join("\n");
}

/**
 * The user's own words, verbatim: the first request whole, then later messages newest first within
 * the budget. Instructions spread over many turns are the first thing a summary drops (Laban et al.
 * measured a 39% drop); restating them is what recovered it.
 */
export function userWords(msgs: Msg[], maxTokens: number): string {
  // Only what the user typed: agent-toolkit puts AGENTS.md, attachments and skills in front of it,
  // under a "The user's message:" line, and those are not the user's words.
  const users = msgs.filter(m => m.role === "user").map(m => ({ ...m, text: ownWords(m.text) }));
  if (users.length === 0) return "";
  const [first, ...later] = users;
  const picked: Msg[] = [];
  let used = roughTokens(first.text);
  for (const msg of later.reverse()) {
    used += roughTokens(msg.text);
    if (used > maxTokens) break;
    picked.push(msg);
  }
  const shown = [first, ...picked.reverse()];
  const left = users.length - shown.length;
  return [
    ...shown.map(m => `[#m${m.n}] ${m.text}`),
    ...(left > 0 ? [`(${left} more of the user's messages are in the transcript)`] : []),
  ].join("\n\n");
}

/** The part of a user message the user typed, after agent-toolkit's "The user's message:" line. */
export function ownWords(text: string): string {
  const marker = text.lastIndexOf("The user's message:\n");
  return marker >= 0 ? text.slice(marker + "The user's message:\n".length).trim() : text;
}

/**
 * The open tasks from the latest todo_write call that worked, or "" when there are none or all are
 * done. They go at the very end of the prompt, where small models attend most (Manus, Cline's Focus
 * Chain).
 */
export function openTasks(msgs: Msg[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const k = msgs[i].calls.map(c => c.name).lastIndexOf("todo_write");
    if (k < 0) continue;
    const call = msgs[i].calls[k];
    // A list the tool refused (two tasks in progress, say) is not the list.
    const reply = msgs[i + 1]?.role === "tool" ? msgs[i + 1].results : [];
    const result = (call.id && reply.find(r => r.id === call.id)) || reply[k];
    if (result && isFailure(result.content)) continue;
    const todos = Array.isArray(call.args.todos) ? (call.args.todos as { content?: unknown; status?: unknown }[]) : [];
    if (!todos.some(t => t.status !== "completed")) return "";
    const mark = (status: unknown) => (status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]");
    return `Your task list ([>] in progress, [x] done):\n${todos.map(t => `${mark(t.status)} ${String(t.content ?? "")}`).join("\n")}`;
  }
  return "";
}
