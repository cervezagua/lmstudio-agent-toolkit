import { compact, type CompactOptions } from "./compact";
import { fromChat, isFailure, isSideQuestion, roughTokens, toMessageData, withoutSideQuestions, type Msg } from "./history";
import { maskToolResults } from "./mask";
import { openTasks } from "./pinned";
import { updateTranscript } from "./transcript";

/**
 * Where a reply goes. agent-toolkit-loop shows it in LM Studio's chat; the eval runner records it.
 * Text and tool requests of one round belong together, so `newRound` starts fresh blocks.
 */
export interface ReplyOutput {
  newRound(): void;
  text(content: string): void;
  reasoning(content: string): void;
  reasoningEnded(): void;
  toolRequest(callId: number, request: { id?: string; name: string; arguments?: Record<string, unknown> }): void;
  toolResult(callId: number, toolCallId: string | undefined, content: string): void;
  /** Shown to the user but kept out of what the model sees later. */
  notice(text: string): void;
  /** A side question's answer: shown, kept out of the conversation. */
  sideAnswer(content: string): void;
}

export interface ReplySettings extends CompactOptions {
  /** Every this many user messages, the open tasks are restated at the end of the prompt. */
  taskReminderEvery: number;
  showNotices: boolean;
}

/** Side questions answered from what is already known: at most this many earlier ones are kept. */
const MAX_SIDE_EXCHANGES = 20;
/** Times one reply may stop to make room between rounds of tool calls before it gives up trying. */
const MAX_RESTARTS = 3;

/**
 * One reply of agent-toolkit-loop: answers a /btw side question without tools, or runs the model on
 * a prompt made to fit (see compact), restating the open tasks at the end, refusing a call that
 * already failed twice exactly as it is, turning an unreadable tool call into a message the model
 * can fix instead of a dead reply, and making room between rounds when a long reply outgrows the
 * context.
 */
export async function runReply(input: {
  sdk: { Chat: any };
  model: any;
  history: any;
  tools: any[];
  /** Tokens the tool definitions take in every prompt. */
  toolTokens: number;
  chatDir: string;
  settings: ReplySettings;
  out: ReplyOutput;
  signal: AbortSignal;
}): Promise<void> {
  const { sdk, model, out, settings } = input;
  const all = fromChat(input.history.getMessagesArray());
  const system = all[0]?.role === "system" ? all[0].text : "";
  const msgs = all.filter(m => m.role !== "system");
  await updateTranscript(input.chatDir, all).catch(() => {});

  const build = (systemText: string, list: Msg[]) => {
    const chat = sdk.Chat.from(systemText ? [{ role: "system", content: systemText }] : []);
    for (const msg of list) chat.append(msg.original ?? toMessageData(msg));
    return chat;
  };
  const count = async (systemText: string, list: Msg[]) => {
    try {
      return (await model.countTokens(await model.applyPromptTemplate(build(systemText, list)))) + input.toolTokens;
    } catch {
      // Some templates refuse a prompt they did not make (no user turn, say); estimate instead.
      return roughTokens(systemText) + list.reduce((s, m) => s + roughTokens(m.text) + m.results.reduce((r, x) => r + roughTokens(x.content), 0), 0) + input.toolTokens;
    }
  };

  const last = msgs[msgs.length - 1];
  if (last && isSideQuestion(last)) return answerSideQuestion();

  // The conversation without side questions, made to fit.
  let compacted;
  try {
    compacted = await compact({ system, msgs: withoutSideQuestions(msgs), count, model, chatDir: input.chatDir, options: settings, signal: input.signal });
    if (compacted.stage > 0 && settings.showNotices) {
      const how = compacted.stage === 1 ? "hid older tool output" : "summarized the earlier conversation";
      out.notice(`Context: ${how}, ${compacted.before.toLocaleString("en-US")} → ${compacted.after.toLocaleString("en-US")} tokens.${compacted.note ? ` (${compacted.note})` : ""}`);
    }
  } catch (error: any) {
    if (input.signal.aborted) throw error;
    out.notice(`Context: could not compact (${error?.message ?? error}); the full conversation was sent.`);
    compacted = { system, msgs: withoutSideQuestions(msgs), stage: 0 as const, before: 0, after: 0 };
  }

  // The open tasks, restated at the very end where a small model attends most.
  let prompt = compacted.msgs;
  const userTurns = prompt.filter(m => m.role === "user").length;
  const tasks = openTasks(withoutSideQuestions(msgs));
  if (tasks && (compacted.stage > 0 || userTurns % Math.max(1, settings.taskReminderEvery) === 0)) {
    const index = prompt.map(m => m.role).lastIndexOf("user");
    if (index >= 0) prompt = prompt.map((m, i) => (i === index ? { ...m, text: `${m.text}\n\n(${tasks})`, original: undefined } : m));
  }

  // A call that failed twice exactly as written is refused the third time, with the reason.
  const failures = new Map<string, { count: number; reason: string }>();
  const keyOf = (name: string, args: unknown) => `${name} ${JSON.stringify(args ?? {})}`;
  const pendingKeys = new Map<string, string>();

  const callIds = new Map<string, number>();
  let nextCallId = 1;
  const numberFor = (id: string | undefined) => {
    if (!id) return nextCallId++;
    if (!callIds.has(id)) callIds.set(id, nextCallId++);
    return callIds.get(id)!;
  };

  let current = build(compacted.system, prompt);
  let produced: Msg[] = [];
  let producedTotal = 0;
  for (let restart = 0; ; restart++) {
    const stop = new AbortController();
    const signal = AbortSignal.any([input.signal, stop.signal]);
    let overflowing = false;
    try {
      await model.act(current, input.tools, {
        signal,
        onRoundStart: () => out.newRound(),
        onPredictionFragment: (fragment: any) => {
          if (fragment.reasoningType === "reasoning") out.reasoning(fragment.content);
          else if (fragment.reasoningType === "reasoningEndTag") out.reasoningEnded();
          else if (fragment.reasoningType === "none" || !fragment.reasoningType) out.text(fragment.content);
          // reasoningStartTag is dropped: its text is LM Studio's internal marker.
        },
        onMessage: (message: any) => {
          // Numbered after the conversation, as the transcript will number them next time.
          const msg = { ...fromChat([message])[0], n: all.length + ++producedTotal };
          produced.push(msg);
          for (const call of msg.calls) {
            out.toolRequest(numberFor(call.id), { id: call.id, name: call.name, arguments: call.args });
            if (call.id) pendingKeys.set(call.id, keyOf(call.name, call.args));
          }
          for (const result of msg.results) {
            out.toolResult(numberFor(result.id), result.id, result.content);
            const key = result.id ? pendingKeys.get(result.id) : undefined;
            if (key && isFailure(result.content)) {
              const seen = failures.get(key);
              failures.set(key, { count: (seen?.count ?? 0) + 1, reason: result.content.replace(/^"?Error:\s*/, "").split(/\r?\n/)[0].slice(0, 160) });
            }
          }
        },
        onPredictionCompleted: (result: any) => {
          const used = (result?.stats?.promptTokensCount ?? 0) + (result?.stats?.predictedTokensCount ?? 0);
          // Leave the next round room to write a whole tool call: running out mid-call ends the chat.
          if (used + 1500 > settings.usable && restart < MAX_RESTARTS) {
            overflowing = true;
            stop.abort();
          }
        },
        guardToolCall: (_round: number, _callId: number, guard: any) => {
          const failed = failures.get(keyOf(guard.toolCallRequest.name, guard.toolCallRequest.arguments));
          if (failed && failed.count >= 2) {
            guard.deny(`This exact call already failed twice (${failed.reason}). Change the arguments, or try another way.`);
          } else {
            guard.allow();
          }
        },
        handleInvalidToolRequest: (error: Error) =>
          `That tool call could not be used: ${error.message.split(/\r?\n/)[0].slice(0, 200)}. Write it again as one complete call with valid JSON arguments.`,
      });
      return;
    } catch (error) {
      if (!overflowing || input.signal.aborted) throw error;
    }
    // Make room and carry on from where the reply got to: older tool output is hidden (no model
    // call, so the pause is short), the reply's own messages so far included.
    const extended = [...prompt, ...produced];
    const { msgs: masked } = maskToolResults(extended, { keepRounds: Math.max(1, settings.keepRounds - 2), maxResultChars: settings.maxResultChars });
    prompt = masked;
    produced = [];
    current = build(compacted.system, prompt);
    if (settings.showNotices) out.notice("Context: the reply was filling the context, so older tool output was hidden before it went on.");
  }

  async function answerSideQuestion(): Promise<void> {
    const question = last.text.replace(/^\s*\/btw\b\s*/i, "").trim();
    // Side exchanges since the last "/btw clear", newest last, at most MAX_SIDE_EXCHANGES of them.
    const exchanges: string[] = [];
    for (let i = 0; i < msgs.length - 1; i++) {
      if (!isSideQuestion(msgs[i])) continue;
      const asked = msgs[i].text.replace(/^\s*\/btw\b\s*/i, "").trim();
      if (/^clear$/i.test(asked)) {
        exchanges.length = 0;
        continue;
      }
      const answer = msgs[i + 1]?.role === "assistant" ? msgs[i + 1].text : "";
      exchanges.push(`Q: ${asked}\nA: ${answer}`);
    }
    if (/^clear$/i.test(question)) {
      out.sideAnswer("Earlier side questions are forgotten.");
      return;
    }
    if (!question) {
      out.sideAnswer("Ask a side question after /btw, like: /btw what does this regex do? It is answered from what this chat already knows, and kept out of the conversation.");
      return;
    }
    const context = withoutSideQuestions(msgs.slice(0, -1));
    const fitted = await compact({ system, msgs: context, count, model, chatDir: input.chatDir, options: { ...settings, summarize: false }, signal: input.signal }).catch(
      () => ({ system, msgs: context }),
    );
    const recent = exchanges.slice(-MAX_SIDE_EXCHANGES);
    const ask = [
      "A side question, separate from the task. Answer it briefly from what this conversation already shows. No tools are available for it, and the task does not change.",
      recent.length ? `Earlier side questions:\n${recent.join("\n\n")}` : "",
      `Question: ${question}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const chat = build(fitted.system, [...fitted.msgs, { role: "user", text: ask, calls: [], results: [], n: 0 }]);
    let answer = "";
    await model.respond(chat, {
      signal: input.signal,
      onPredictionFragment: (fragment: any) => {
        if (fragment.reasoningType === "none" || !fragment.reasoningType) answer += fragment.content;
      },
    });
    if (/<tool_call>|"name"\s*:\s*"\w+"\s*,\s*"arguments"/.test(answer)) answer += "\n\n(Nothing was run: side questions have no tools.)";
    out.sideAnswer(answer.trim() || "(no answer)");
  }
}
