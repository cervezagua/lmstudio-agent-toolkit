import { callsById, describeCall, isFailure, type Msg, type ToolCall } from "./history";

/** Results this short cost little and say a lot ("Edited x.ts: 1 replacement."); they are never hidden. */
const SHORT_RESULT_CHARS = 300;

/**
 * Stage 1 of compaction, with no model call: tool output older than the last `keepRounds` rounds of
 * tool calls becomes a one-line placeholder saying where the full text is, while the calls and the
 * assistant's own words stay (observation masking matched or beat LLM summaries at half the cost in
 * the JetBrains/TUM study). An older failed call's result becomes a one-line description of the
 * error: a small model shown its failed call again tends to repeat it.
 *
 * Results that are kept are cut to their head and tail when longer than `maxResultChars`.
 */
export function maskToolResults(msgs: Msg[], options: { keepRounds: number; maxResultChars: number }): { msgs: Msg[]; hidden: number } {
  const byId = callsById(msgs);
  // Rounds of tool calls, newest last: each assistant message that makes calls starts one.
  const roundStarts = msgs.map((m, i) => (m.role === "assistant" && m.calls.length > 0 ? i : -1)).filter(i => i >= 0);
  const keepFrom = roundStarts.length > options.keepRounds ? roundStarts[roundStarts.length - options.keepRounds] : 0;

  let hidden = 0;
  const masked = msgs.map((msg, index) => {
    if (msg.role !== "tool") return msg;
    const old = index < keepFrom;
    let changed = false;
    const results = msg.results.map((result, k) => {
      const call: ToolCall | undefined = (result.id && byId.get(result.id)) || precedingCall(msgs, index, k);
      if (old && isFailure(result.content)) {
        changed = true;
        hidden++;
        return { ...result, content: `[earlier failed call ${describeCall(call)}: ${firstLine(result.content)}]` };
      }
      if (old && result.content.length > SHORT_RESULT_CHARS) {
        changed = true;
        hidden++;
        // A message of the reply still being written (n 0) is not in the transcript yet.
        const where = msg.n > 0 ? `the full text is #m${msg.n} in the transcript` : "call the tool again if you need it";
        return { ...result, content: `[output of ${describeCall(call)} (${result.content.length} characters) hidden to save context; ${where}]` };
      }
      if (result.content.length > options.maxResultChars) {
        changed = true;
        return { ...result, content: headAndTail(result.content, options.maxResultChars, msg.n) };
      }
      return result;
    });
    return changed ? { ...msg, results, original: undefined } : msg;
  });
  return { msgs: masked, hidden };
}

/** The call a result answers when ids are missing: the k-th call of the nearest assistant message above. */
export function precedingCall(msgs: Msg[], index: number, k: number): ToolCall | undefined {
  for (let i = index - 1; i >= 0; i--) if (msgs[i].role === "assistant" && msgs[i].calls.length) return msgs[i].calls[k] ?? msgs[i].calls[0];
  return undefined;
}

const firstLine = (text: string) => {
  const line = text.replace(/^"?Error:\s*/, "").split(/\r?\n/)[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
};

/** The start and the end of a long text, where the useful part usually is (Codex learned errors sit at the end). */
export function headAndTail(text: string, maxChars: number, n?: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const where = n ? `; the full text is #m${n} in the transcript` : "";
  return `${text.slice(0, half)}\n[... ${text.length - 2 * half} characters left out${where} ...]\n${text.slice(-half)}`;
}
