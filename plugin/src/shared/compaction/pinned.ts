import { callsById, describeCall, isFailure, roughTokens, type Msg } from "./history";

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
  for (const msg of msgs) {
    if (msg.role !== "tool") continue;
    for (const result of msg.results) {
      const call = result.id ? byId.get(result.id) : undefined;
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
  const users = msgs.filter(m => m.role === "user");
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

/**
 * The open tasks from the latest todo_write call, or "" when there are none or all are done. They go
 * at the very end of the prompt, where small models attend most (Manus, Cline's Focus Chain).
 */
export function openTasks(msgs: Msg[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const call = [...msgs[i].calls].reverse().find(c => c.name === "todo_write");
    if (!call) continue;
    const todos = Array.isArray(call.args.todos) ? (call.args.todos as { content?: unknown; status?: unknown }[]) : [];
    if (!todos.some(t => t.status !== "completed")) return "";
    const mark = (status: unknown) => (status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]");
    return `Your task list ([>] in progress, [x] done):\n${todos.map(t => `${mark(t.status)} ${String(t.content ?? "")}`).join("\n")}`;
  }
  return "";
}
