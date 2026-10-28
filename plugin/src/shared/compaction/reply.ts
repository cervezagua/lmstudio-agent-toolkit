import { compact, type CompactOptions } from "./compact";
import { fromChat, isFailure, isSideQuestion, roughSize, roughTokens, toMessageData, withoutSideQuestions, withoutThinking, withText, type Msg } from "./history";
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
  toolRequest(callId: number, request: { id?: string; name: string; arguments?: Record<string, unknown>; pluginIdentifier?: string }): void;
  /**
   * The state of one call, as LM Studio's own loop shows it: generating, confirming, calling, then
   * succeeded, failed or denied. LM Studio's chat shows a confirmation only for a call it has a status for.
   */
  toolStatus?(callId: number, status: ToolStatus): void;
  toolResult(callId: number, toolCallId: string | undefined, content: string): void;
  /** Shown to the user but kept out of what the model sees later. */
  notice(text: string): void;
  /** A side question's answer: shown, kept out of the conversation. */
  sideAnswer(content: string): void;
}

/** The SDK's ToolStatusStepStateStatus, kept here so the eval runner needs no SDK types. */
export type ToolStatus =
  | { type: "generatingToolCall"; name?: string; pluginIdentifier?: string }
  | { type: "toolCallGenerationFailed"; error: string }
  | { type: "confirmingToolCall" }
  | { type: "toolCallDenied"; denyReason?: string }
  | { type: "callingTool" }
  | { type: "toolCallFailed"; error: string }
  | { type: "toolCallSucceeded"; timeMs: number };

export interface ReplySettings extends CompactOptions {
  /** Every this many user messages, the open tasks are restated at the end of the prompt; 0 only when compacting. */
  taskReminderEvery: number;
  showNotices: boolean;
}

/** Side questions answered from what is already known: at most this many earlier ones are kept. */
const MAX_SIDE_EXCHANGES = 20;
/** Times one reply may stop to make room between rounds of tool calls before it gives up trying. */
const MAX_RESTARTS = 3;
/** Tokens kept free of tool results: the template's markers around them, and a start on the next message. */
const RESULT_MARGIN = 1000;

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
  /**
   * Asks the user to approve a tool call before it runs. agent-toolkit-loop passes LM Studio's
   * confirmation dialog; left out, every call runs (the eval runner, which has no user).
   */
  confirm?: (
    callId: number,
    request: { name: string; arguments: Record<string, unknown>; pluginIdentifier?: string },
  ) => Promise<{ allow: true; arguments?: Record<string, unknown> } | { allow: false; reason?: string }>;
  /** Most rounds of tool calls in the whole reply, restarts included (none: the SDK's default). */
  maxRounds?: number;
  /** Called when older output was hidden mid-reply, so capped tools may hand out their full share again. */
  refillToolBudget?: () => void;
  /** Called after each prediction with the tokens left for tool results, so capped tools hand out no more. */
  fitToolResults?: (tokens: number) => void;
  /** For the eval runner: every message the reply produces, and every prediction's stats. */
  hooks?: { onMessage?: (message: any) => void; onPredictionCompleted?: (result: any) => void };
}): Promise<void> {
  const { sdk, model, out, settings } = input;
  const all = fromChat(input.history.getMessagesArray());
  const system = all[0]?.role === "system" ? all[0].text : "";
  const msgs = all.filter(m => m.role !== "system");
  await updateTranscript(input.chatDir, all).catch(() => {});

  const build = (systemText: string, list: Msg[]) => {
    const chat = sdk.Chat.from(systemText ? [{ role: "system", content: systemText }] : []);
    for (const msg of list.map(withoutThinking)) chat.append(msg.original ?? toMessageData(msg));
    return chat;
  };
  const estimate = (systemText: string, list: Msg[]) => roughTokens(systemText) + list.reduce((s, m) => s + roughSize(m), 0) + input.toolTokens;
  // The estimate is fair for English text and code only: images, files and other scripts (Chinese
  // runs near one character a token) are counted exactly whatever the size.
  const estimateIsFair = (systemText: string, list: Msg[]) => {
    if (list.some(m => (m.original as any)?.hasFiles?.())) return false;
    const text = systemText + list.map(m => m.text).join("");
    return (text.match(/[^\x00-\x7f]/g)?.length ?? 0) < text.length * 0.1;
  };
  const count = async (systemText: string, list: Msg[]) => {
    const rough = estimate(systemText, list);
    // Counting exactly renders and tokenizes the whole prompt; not worth it far below the high mark.
    if (rough < settings.usable * settings.high * 0.5 && estimateIsFair(systemText, list)) return rough;
    try {
      return (await model.countTokens(await model.applyPromptTemplate(build(systemText, list)))) + input.toolTokens;
    } catch {
      // Some templates refuse a prompt they did not make (no user turn, say); estimate instead.
      return rough;
    }
  };

  const last = msgs[msgs.length - 1];
  if (last && isSideQuestion(last)) return answerSideQuestion();

  // The conversation without side questions, made to fit.
  let compacted;
  try {
    compacted = await compact({ system, msgs: withoutSideQuestions(msgs), count, model, chatDir: input.chatDir, options: settings, signal: input.signal });
    if (compacted.fresh && settings.showNotices) {
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
  const reminderDue = settings.taskReminderEvery > 0 && userTurns % settings.taskReminderEvery === 0;
  if (tasks && (compacted.stage > 0 || reminderDue)) {
    const index = prompt.map(m => m.role).lastIndexOf("user");
    if (index >= 0) prompt = prompt.map((m, i) => (i === index ? withText(m, `${m.text}\n\n(${tasks})`) : m));
  }

  // A call that failed twice exactly as written is refused the third time, with the reason.
  const failures = new Map<string, { count: number; reason: string }>();
  const keyOf = (name: string, args: unknown) => `${name} ${JSON.stringify(args ?? {})}`;
  const pendingKeys = new Map<string, string>();
  // And so is a call that already got the very same result twice: a small model can rewrite the same
  // files until it runs out of rounds, each call "working". Waiting on a task, or checking whether a
  // server is up, is meant to repeat.
  const repeats = new Map<string, { content: string; count: number }>();
  const MEANT_TO_REPEAT = new Set(["task_output", "task_wait", "task_list", "run_command"]);
  const CHANGES = new Set(["write_file", "edit_file", "multi_edit", "insert_lines", "undo_edit", "notebook_edit"]);
  // A refusal's text is not a result of the call, and must not reset or feed either count.
  const refused = new Set<string>();

  // The SDK numbers each call (callId) when the model finishes writing it; the request block, the
  // confirmation and the result all use that number, matched to the result by the request's id.
  const callIds = new Map<string, number>();
  const shown = new Set<number>();
  let nextOwnId = 1_000_000;
  const numberFor = (id: string | undefined) => {
    if (!id) return nextOwnId++;
    if (!callIds.has(id)) callIds.set(id, nextOwnId++);
    return callIds.get(id)!;
  };
  // Which plugin each tool comes from, for the request block and the status, as LM Studio shows them.
  // The SDK runs the last tool of a name, so the last one names the plugin, identifier or not.
  const pluginOf = new Map<string, string | undefined>(input.tools.map(t => [t?.name, t?.pluginIdentifier]));
  const showRequest = (callId: number, request: { id?: string; name: string; arguments?: Record<string, unknown> }) => {
    if (shown.has(callId)) return;
    shown.add(callId);
    if (!statusOf.has(callId)) setStatus(callId, { type: "generatingToolCall", name: request.name, pluginIdentifier: pluginOf.get(request.name) });
    out.toolRequest(callId, { id: request.id, name: request.name, arguments: request.arguments, pluginIdentifier: pluginOf.get(request.name) });
  };
  // Each call's state, and when it started running, for the time LM Studio shows once it is done.
  const statusOf = new Map<number, ToolStatus["type"]>();
  const startedAt = new Map<number, number>();
  const setStatus = (callId: number, status: ToolStatus) => {
    statusOf.set(callId, status.type);
    if (status.type === "callingTool") startedAt.set(callId, Date.now());
    out.toolStatus?.(callId, status);
  };
  const finish = (callId: number, content: string) => {
    const state = statusOf.get(callId);
    if (state === "toolCallDenied" || state === "toolCallSucceeded" || state === "toolCallFailed") return;
    // MCP tools report a failure as {"isError": true, ...} rather than with "Error:".
    if (isFailure(content) || /^\s*\{[\s\S]*"isError"\s*:\s*true/.test(content)) {
      setStatus(callId, { type: "toolCallFailed", error: content.replace(/^"?Error:\s*/, "").split(/\r?\n/)[0].slice(0, 300) });
    } else {
      setStatus(callId, { type: "toolCallSucceeded", timeMs: Date.now() - (startedAt.get(callId) ?? Date.now()) });
    }
  };

  const restartMask = { keepRounds: Math.max(1, settings.keepRounds - 2), maxResultChars: settings.maxResultChars };
  const headroom = Math.min(8000, Math.max(1500, Math.floor(settings.usable * 0.15)));
  let current = build(compacted.system, prompt);
  let produced: Msg[] = [];
  let roundsDone = 0;
  // The SDK's numbers for this round's calls, in order, and those of the last assistant message.
  let roundCallIds: number[] = [];
  let lastCallNumbers: number[] = [];
  // A reply that ended with nothing but thinking is followed up once, not again and again.
  let nudgedEmpty = false;
  // A reply cut off with nothing to hide is tried once more, asked to fit in the room there is.
  let askedToFit = false;
  // The prompt is rebuilt without earlier thinking at most once per reply just for that.
  let shedThinking = false;
  const carriedThinking = (list: Msg[]) => list.reduce((sum, m) => sum + roughTokens(m.text) - roughTokens(withoutThinking(m).text), 0);
  const writesInParts = input.tools.some(t => t?.name === "write_file");
  for (let restart = 0; ; restart++) {
    if (input.maxRounds !== undefined && roundsDone >= input.maxRounds) return;
    const stop = new AbortController();
    const signal = AbortSignal.any([input.signal, stop.signal]);
    let overflowing = false;
    // Tokens the last prediction filled, plus the rough size of the results that came after it.
    let used = 0;
    let promptTokens = 0;
    let roundResults = 0;
    // Whether the restart about to happen hides old tool output (rather than only leaving out thinking).
    let hidesOutput = false;
    // Whether the last prediction stopped because the context was full, cut off mid-sentence.
    let cutOff = false;
    // What the model wrote outside its thinking in the latest round, and whether it thought at all.
    let roundSaid = "";
    let roundThought = false;
    try {
      await model.act(current, input.tools, {
        signal,
        ...(input.maxRounds !== undefined ? { maxPredictionRounds: input.maxRounds - roundsDone } : {}),
        onRoundStart: () => {
          roundsDone++;
          roundResults = 0;
          roundCallIds = [];
          roundSaid = "";
          roundThought = false;
          out.newRound();
        },
        onPredictionFragment: (fragment: any) => {
          if (fragment.reasoningType === "reasoning") {
            roundThought = true;
            out.reasoning(fragment.content);
          } else if (fragment.reasoningType === "reasoningEndTag") out.reasoningEnded();
          else if (fragment.reasoningType === "none" || !fragment.reasoningType) {
            roundSaid += fragment.content;
            out.text(fragment.content);
          }
          // reasoningStartTag is dropped: its text is LM Studio's internal marker.
        },
        // A status for each call from the moment the model starts writing it, as LM Studio's own loop
        // keeps; the chat shows a confirmation only for a call that has one.
        onToolCallRequestStart: (_round: number, callId: number) => setStatus(callId, { type: "generatingToolCall" }),
        onToolCallRequestNameReceived: (_round: number, callId: number, name: string) =>
          setStatus(callId, { type: "generatingToolCall", name, pluginIdentifier: pluginOf.get(name) }),
        onToolCallRequestFailure: (_round: number, callId: number, error: any) =>
          setStatus(callId, { type: "toolCallGenerationFailed", error: String(error?.message ?? error).split(/\r?\n/)[0].slice(0, 300) }),
        // Shown as soon as the call is written, so a confirmation never names a call the chat has not shown.
        onToolCallRequestEnd: (_round: number, callId: number, info: any) => {
          const request = info?.toolCallRequest;
          if (!request) return;
          if (request.id) callIds.set(request.id, callId);
          roundCallIds.push(callId);
          showRequest(callId, request);
        },
        onMessage: (message: any) => {
          input.hooks?.onMessage?.(message);
          // Not numbered: the transcript gets this reply's messages next time, as LM Studio saved them.
          const msg = { ...fromChat([message])[0], n: 0 };
          produced.push(msg);
          if (msg.calls.length) {
            // A call without an id is matched to the SDK's number by its place in the round.
            lastCallNumbers = msg.calls.map((call, k) => (call.id ? numberFor(call.id) : (roundCallIds[k] ?? numberFor(undefined))));
          }
          msg.calls.forEach((call, k) => {
            showRequest(lastCallNumbers[k], { id: call.id, name: call.name, arguments: call.args });
            if (call.id) pendingKeys.set(call.id, keyOf(call.name, call.args));
          });
          for (const [k, result] of msg.results.entries()) {
            roundResults += roughTokens(result.content);
            const resultCallId = result.id ? numberFor(result.id) : (lastCallNumbers[k] ?? numberFor(undefined));
            finish(resultCallId, result.content);
            out.toolResult(resultCallId, result.id, result.content);
            if (result.id && refused.has(result.id)) continue;
            const key = result.id ? pendingKeys.get(result.id) : undefined;
            if (key && isFailure(result.content)) {
              const seen = failures.get(key);
              failures.set(key, { count: (seen?.count ?? 0) + 1, reason: result.content.replace(/^"?Error:\s*/, "").split(/\r?\n/)[0].slice(0, 160) });
            } else if (key) {
              // After a real change, the same tests failing the same way is news, not a loop.
              if (CHANGES.has(key.split(" ")[0]) && !/^"?No change/.test(result.content)) {
                for (const other of [...repeats.keys()]) if (other !== key) repeats.delete(other);
              }
              const seen = repeats.get(key);
              repeats.set(key, { content: result.content, count: seen?.content === result.content ? seen.count + 1 : 1 });
            }
          }
        },
        onPredictionCompleted: (result: any) => {
          input.hooks?.onPredictionCompleted?.(result);
          promptTokens = result?.stats?.promptTokensCount ?? 0;
          used = promptTokens + (result?.stats?.predictedTokensCount ?? 0);
          cutOff = result?.stats?.stopReason === "contextLengthReached";
          // The round's results must fit what is left, or the next prediction is refused outright
          // (a web page or PDF can be larger than the whole context). Room past the headroom is
          // still made by hiding older output, between rounds.
          input.fitToolResults?.(settings.usable - used - RESULT_MARGIN);
        },
        // Checked once the round's tools have finished and their results are in: stopping earlier
        // would abort the tools mid-run and leave calls without results.
        onRoundEnd: () => {
          // Leave the next round room to think and write a whole tool call: running out mid-call ends
          // the chat, and a model that reasons at length spends thousands of tokens before it writes.
          if (!roundResults || used + roundResults + headroom <= settings.usable || restart >= MAX_RESTARTS) return;
          // Only worth a restart (the model re-reads the prompt) if there is old output to hide, or,
          // once per reply, thinking from earlier rounds that the SDK sends back and a rebuilt prompt
          // leaves out. Some templates drop that thinking anyway, so once is enough.
          hidesOutput = maskToolResults([...prompt, ...produced], restartMask).hidden > 0;
          if (!hidesOutput && (shedThinking || carriedThinking(produced) < 500)) return;
          if (!hidesOutput) shedThinking = true;
          overflowing = true;
          stop.abort();
        },
        guardToolCall: async (_round: number, callId: number, guard: any) => {
          const request = guard.toolCallRequest;
          const deny = (reason: string) => {
            if (request.id) refused.add(request.id);
            setStatus(callId, { type: "toolCallDenied", denyReason: reason });
            guard.deny(reason);
          };
          const allow = (args?: Record<string, unknown>) => {
            setStatus(callId, { type: "callingTool" });
            if (args) guard.allowAndOverrideParameters(args);
            else guard.allow();
          };
          const failed = failures.get(keyOf(request.name, request.arguments));
          if (failed && failed.count >= 2) {
            deny(`This exact call already failed twice (${failed.reason}). Change the arguments, or try another way.`);
            return;
          }
          const repeated = repeats.get(keyOf(request.name, request.arguments));
          if (repeated && repeated.count >= 2 && !MEANT_TO_REPEAT.has(request.name)) {
            const said = repeated.content.replace(/^"|"$/g, "").split(/\r?\n/)[0].slice(0, 160);
            deny(`You already made this exact call twice and got the same result both times (${said}). Repeating it changes nothing: take the next step of the task.`);
            return;
          }
          if (!input.confirm) {
            allow();
            return;
          }
          // The user approves each call, as in LM Studio's own loop. If asking fails, the call does not run.
          try {
            setStatus(callId, { type: "confirmingToolCall" });
            const decision = await untilAborted(
              input.confirm(callId, {
                name: request.name,
                arguments: request.arguments ?? {},
                pluginIdentifier: guard.tool?.pluginIdentifier,
              }),
              signal,
            );
            if (!decision.allow) deny(decision.reason ?? "The user declined this tool call.");
            else allow(decision.arguments);
          } catch (error: any) {
            deny(`The user could not be asked to approve this call (${error?.message ?? error}), so it was not run.`);
          }
        },
        handleInvalidToolRequest: (error: Error) =>
          `That tool call could not be used: ${error.message.split(/\r?\n/)[0].slice(0, 200)}. Write it again as one complete call with valid JSON arguments.`,
      });
      if (input.signal.aborted) return;
      // A reply that ends inside the model's thinking, with no answer and no tool call, shows the
      // user nothing (a reasoning model can plan a command in its thinking and stop there). The
      // model is asked once to give its answer or make the call.
      const lastCalls = produced.at(-1)?.role === "assistant" ? produced.at(-1)!.calls.length : 0;
      if (!cutOff && roundThought && !roundSaid.trim() && roundCallIds.length === 0 && lastCalls === 0 && !nudgedEmpty) {
        nudgedEmpty = true;
        prompt = [
          ...prompt,
          ...produced,
          { role: "user", text: "(Your reply ended inside your thinking, with no answer and no tool call. Give your answer now, or make a tool call if one is still needed.)", calls: [], results: [], n: 0 },
        ];
        produced = [];
        current = build(compacted.system, prompt);
        if (settings.showNotices) out.notice("Context: the reply ended inside the model's thinking, so it was asked for its answer.");
        continue;
      }
      // The context filled while the model was still writing: its message stops mid-sentence and,
      // left alone, the reply just ends. It goes on instead, if older output can make room.
      if (!cutOff) return;
      const room = maskToolResults([...prompt, ...produced], restartMask);
      // Nothing to hide, typically on a small context with many tools: the model spent the room on
      // thinking, or on one big file in a single call. It goes again, told how much room there is;
      // the cut-off message is dropped, as its thinking would fill the context again.
      const free = settings.usable - promptTokens;
      if (room.hidden === 0 && !askedToFit && restart < MAX_RESTARTS && free >= 1000) {
        askedToFit = true;
        const last = produced.at(-1);
        const kept = last?.role === "assistant" && last.calls.length === 0 ? produced.slice(0, -1) : produced;
        const parts = writesInParts ? " Write a long file in parts: write_file with the first part, then write_file with append: true for each next part." : "";
        prompt = [
          ...prompt,
          ...kept,
          {
            role: "user",
            text: `(Your last message was cut off because the context was full: only about ${free} tokens are left for each reply, thinking included. Think briefly and keep each message short.${parts} Carry on.)`,
            calls: [],
            results: [],
            n: 0,
          },
        ];
        produced = [];
        current = build(compacted.system, prompt);
        if (settings.showNotices) out.notice("Context: the reply was cut off by a full context, so the model was asked to go on in smaller steps.");
        continue;
      }
      if (restart >= MAX_RESTARTS || room.hidden === 0) {
        out.notice("Context: the context is full, so the reply was cut off. Start a new chat, or raise the model's context length.");
        return;
      }
      prompt = [
        ...room.msgs,
        { role: "user", text: "(Your last message was cut off because the context was full. Older tool output was hidden to make room: carry on from where you stopped.)", calls: [], results: [], n: 0 },
      ];
      produced = [];
      repeats.clear();
      current = build(compacted.system, prompt);
      input.refillToolBudget?.();
      if (settings.showNotices) out.notice("Context: the reply was cut off by a full context, so older tool output was hidden and it went on.");
      continue;
    } catch (error) {
      if (!overflowing || input.signal.aborted) throw error;
    }
    // Make room and carry on from where the reply got to: older tool output is hidden (no model
    // call, so the pause is short), the reply's own messages so far included.
    prompt = maskToolResults([...prompt, ...produced], restartMask).msgs;
    produced = [];
    current = build(compacted.system, prompt);
    if (hidesOutput) {
      // Output just hidden may need reading again, as its placeholder says.
      repeats.clear();
      // Room was made, so the results that follow may take their share again.
      input.refillToolBudget?.();
    }
    if (settings.showNotices) {
      out.notice(
        hidesOutput
          ? "Context: the reply was filling the context, so older tool output and thinking were left out before it went on."
          : "Context: the reply was filling the context, so the model's earlier thinking was left out before it went on.",
      );
    }
  }

  /** The promise's outcome, or a rejection as soon as the signal aborts (a confirmation left open). */
  function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error("the reply was stopped"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("the reply was stopped"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
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
    const fitted = await compact({
      system,
      msgs: context,
      count,
      model,
      chatDir: input.chatDir,
      options: { ...settings, summarize: false },
      signal: input.signal,
      readOnly: true,
    }).catch(
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
