import { Chat, ChatMessage } from "@lmstudio/sdk";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromChat } from "./history";
import { openTasks } from "./pinned";
import { runReply, type ReplyOutput, type ReplySettings } from "./reply";
import { readSummaryState, writeSummaryState } from "./summary";
import { updateTranscript } from "./transcript";

let chatDir: string;
beforeEach(async () => {
  chatDir = await mkdtemp(join(tmpdir(), "reply-"));
});
afterEach(async () => {
  await rm(chatDir, { recursive: true, force: true });
});

const settings: ReplySettings = {
  usable: 100_000,
  high: 0.7,
  low: 0.45,
  keepRounds: 6,
  maxResultChars: 16_000,
  summarize: true,
  taskReminderEvery: 4,
  showNotices: true,
};

/** Records everything a reply shows, in order. */
function recorder() {
  const events: string[] = [];
  const out: ReplyOutput = {
    newRound: () => events.push("round"),
    text: t => events.push(`text:${t}`),
    reasoning: t => events.push(`think:${t}`),
    reasoningEnded: () => events.push("think-end"),
    toolRequest: (id, r) => events.push(`call#${id}:${r.name}`),
    toolResult: (id, _toolCallId, content) => events.push(`result#${id}:${content}`),
    notice: t => events.push(`notice:${t}`),
    sideAnswer: t => events.push(`btw:${t}`),
  };
  return { events, out };
}

const assistantCall = (id: string, name: string, args: Record<string, unknown>, text = "") =>
  ChatMessage.from({
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), { type: "toolCallRequest", toolCallRequest: { type: "function", id, name, arguments: args } }],
  } as any);
const toolResult = (id: string, content: string) => ChatMessage.from({ role: "tool", content: [{ type: "toolCallResult", toolCallId: id, content }] } as any);

/** A model whose act() plays a script, and whose token count is the rough length of the prompt. */
function fakeModel(script: (chat: any, opts: any, call: number) => Promise<void>) {
  const model = {
    actCalls: [] as any[],
    respondCalls: [] as any[],
    countTokens: async (text: string) => Math.ceil(text.length / 3.5),
    applyPromptTemplate: async (chat: any) => chat.getMessagesArray().map((m: any) => `${m.getRole()}: ${m.getText()}`).join("\n"),
    async act(chat: any, _tools: any[], opts: any) {
      this.actCalls.push(chat);
      await script(chat, opts, this.actCalls.length);
    },
    async respond(chat: any, opts: any) {
      this.respondCalls.push(chat);
      opts?.onPredictionFragment?.({ content: "A regex is a pattern.", reasoningType: "none" });
      return { content: "A regex is a pattern." };
    },
  };
  return model;
}

/** A chat from plain { role, content } entries and SDK messages (Chat.from takes only the former). */
const chatOf = (history: any[]) => {
  const chat = Chat.empty();
  for (const entry of history) {
    if (typeof entry.getRole === "function") chat.append(entry);
    else chat.append(entry.role, entry.content);
  }
  return chat;
};

const run = (model: any, history: any[], overrides: Partial<ReplySettings> = {}) => {
  const { events, out } = recorder();
  return runReply({
    sdk: { Chat },
    model,
    history: chatOf(history),
    tools: [],
    toolTokens: 0,
    chatDir,
    settings: { ...settings, ...overrides },
    out,
    signal: new AbortController().signal,
  }).then(() => events);
};

describe("runReply", () => {
  it("streams text and reasoning, drops LM Studio's start marker, and numbers tool calls", async () => {
    const model = fakeModel(async (_chat, opts) => {
      opts.onRoundStart(0);
      opts.onPredictionFragment({ content: "__LM_STUDIO_INTERNAL_START__", reasoningType: "reasoningStartTag" });
      opts.onPredictionFragment({ content: "Let me look.", reasoningType: "reasoning" });
      opts.onPredictionFragment({ content: "", reasoningType: "reasoningEndTag" });
      opts.onPredictionFragment({ content: "Reading it.", reasoningType: "none" });
      opts.onToolCallRequestEnd(0, 1, { toolCallRequest: { id: "call_abc", name: "read_file", arguments: { path: "a.js" } } });
      opts.onMessage(assistantCall("call_abc", "read_file", { path: "a.js" }, "Reading it."));
      opts.onMessage(toolResult("call_abc", "1\tconst a = 1;"));
    });
    const events = await run(model, [{ role: "system", content: "sys" }, { role: "user", content: "read a.js" }]);
    expect(events).toEqual(["round", "think:Let me look.", "think-end", "text:Reading it.", "call#1:read_file", "result#1:1\tconst a = 1;"]);
    expect(events.join()).not.toContain("LM_STUDIO_INTERNAL");
  });

  it("answers /btw from the conversation with no tools, and keeps earlier side questions out of the task", async () => {
    const model = fakeModel(async () => {
      throw new Error("act must not run for a side question");
    });
    const events = await run(model, [
      { role: "user", content: "fix the parser" },
      { role: "assistant", content: "Fixed." },
      { role: "user", content: "/btw what is a lexer?" },
      { role: "assistant", content: "It splits text into tokens." },
      { role: "user", content: "/btw what is a regex?" },
    ]);
    expect(events).toEqual(["btw:A regex is a pattern."]);
    const prompt = model.respondCalls[0].getMessagesArray().map((m: any) => m.getText());
    expect(prompt[0]).toBe("fix the parser");
    expect(prompt.at(-1)).toMatch(/Earlier side questions:\nQ: what is a lexer\?\nA: It splits text into tokens\.\n\nQuestion: what is a regex\?$/);
    expect(prompt.filter((t: string) => t.startsWith("/btw"))).toEqual([]);
  });

  it("leaves side questions out of a normal reply's prompt", async () => {
    const model = fakeModel(async () => {});
    await run(model, [
      { role: "user", content: "fix the parser" },
      { role: "user", content: "/btw what is a lexer?" },
      { role: "assistant", content: "It splits text into tokens." },
      { role: "user", content: "now add tests" },
    ]);
    const texts = model.actCalls[0].getMessagesArray().map((m: any) => m.getText());
    expect(texts).toEqual(["fix the parser", "now add tests"]);
  });

  // A remote model (a generator plugin such as remote-lmstudio) has act and respond but cannot count
  // tokens: sizes are estimated, and compaction and tools still work.
  it("works with a remote model that cannot count tokens", async () => {
    const model: any = fakeModel(async (_chat, opts) => {
      opts.onPredictionFragment({ content: "Done.", reasoningType: "none" });
    });
    delete model.countTokens;
    delete model.applyPromptTemplate;
    const events = await run(
      model,
      [{ role: "user", content: "start" }, { role: "assistant", content: "x".repeat(4000) }, { role: "user", content: "next" }],
      { usable: 1000 },
    );
    expect(events.some(e => e.startsWith("notice:Context: summarized"))).toBe(true);
    expect(events).toContain("text:Done.");
  });

  it("forgets side questions on /btw clear", async () => {
    const model = fakeModel(async () => {});
    expect(await run(model, [{ role: "user", content: "/btw clear" }])).toEqual(["btw:Earlier side questions are forgotten."]);
  });

  it("refuses a call that already failed twice exactly as written, and turns an unreadable call into a message", async () => {
    let denied = "";
    let invalid = "";
    const model = fakeModel(async (_chat, opts) => {
      for (const id of ["c1", "c2"]) {
        opts.onMessage(assistantCall(id, "edit_file", { path: "x.js", old_string: "a" }));
        opts.onMessage(toolResult(id, "Error: old_string was not found in the file."));
      }
      opts.guardToolCall(0, 3, {
        toolCallRequest: { name: "edit_file", arguments: { path: "x.js", old_string: "a" } },
        allow: () => {},
        deny: (reason: string) => (denied = reason),
      });
      invalid = opts.handleInvalidToolRequest(new Error("Unterminated string in JSON at position 208"), undefined);
    });
    await run(model, [{ role: "user", content: "edit it" }]);
    expect(denied).toBe("This exact call already failed twice (old_string was not found in the file.). Change the arguments, or try another way.");
    expect(invalid).toMatch(/^That tool call could not be used: Unterminated string in JSON at position 208\. Write it again/);
  });

  it("refuses a call that got the same result twice, unless a real change came in between", async () => {
    const decisions: string[] = [];
    const guard = (name: string, args: Record<string, unknown>, id?: string) => ({
      toolCallRequest: { id, name, arguments: args },
      allow: () => decisions.push(`allow ${name}`),
      deny: (reason: string) => decisions.push(`deny ${name}: ${reason}`),
    });
    const write = { path: "t.csv", content: "a,b" };
    const read = { path: "sum.js" };
    const model = fakeModel(async (_chat, opts) => {
      // The same file written again and again: the tool says nothing changed.
      for (const id of ["w1", "w2"]) {
        opts.onMessage(assistantCall(id, "write_file", write));
        opts.onMessage(toolResult(id, '"No change: t.csv already has exactly this content."'));
      }
      await opts.guardToolCall(0, 3, guard("write_file", write, "w3"));
      // The refusal is not a result of the call: asking again is refused again.
      opts.onMessage(assistantCall("w3", "write_file", write));
      opts.onMessage(toolResult("w3", '{"error":"You already made this exact call twice"}'));
      await opts.guardToolCall(0, 4, guard("write_file", write, "w4"));
      // The same file read twice, but with a real edit after: reading it again is news.
      for (const id of ["r1", "r2"]) {
        opts.onMessage(assistantCall(id, "read_file", read));
        opts.onMessage(toolResult(id, "1\tconst a = 1;"));
      }
      opts.onMessage(assistantCall("e1", "edit_file", { path: "other.js", old_string: "a", new_string: "b" }));
      opts.onMessage(toolResult("e1", "Edited other.js: 1 replacement."));
      await opts.guardToolCall(0, 5, guard("read_file", read));
      // Waiting on a task, or checking whether a server is up, repeats by design.
      for (const id of ["o1", "o2", "c1", "c2"]) {
        const [name, args] = id.startsWith("o") ? ["task_output", { id: "t1" }] : ["run_command", { command: "curl localhost:3000" }];
        opts.onMessage(assistantCall(id, name as string, args as any));
        opts.onMessage(toolResult(id, "exit_code: 7"));
      }
      await opts.guardToolCall(0, 6, guard("task_output", { id: "t1" }));
      await opts.guardToolCall(0, 7, guard("run_command", { command: "curl localhost:3000" }));
    });
    await run(model, [{ role: "user", content: "build it" }]);
    const refusal =
      "You already made this exact call twice and got the same result both times (No change: t.csv already has exactly this content.). Repeating it changes nothing: take the next step of the task.";
    expect(decisions).toEqual([`deny write_file: ${refusal}`, `deny write_file: ${refusal}`, "allow read_file", "allow task_output", "allow run_command"]);
  });

  it("asks the user before each call, and never runs one it could not ask about", async () => {
    const decisions: string[] = [];
    const guard = (args: Record<string, unknown>) => ({
      toolCallRequest: { id: `id-${JSON.stringify(args)}`, name: "run_command", arguments: args },
      tool: { pluginIdentifier: "local/agent-toolkit" },
      allow: () => decisions.push("allow"),
      allowAndOverrideParameters: (p: unknown) => decisions.push(`override ${JSON.stringify(p)}`),
      deny: (reason: string) => decisions.push(`deny: ${reason}`),
    });
    const model = fakeModel(async (_chat, opts) => {
      await opts.guardToolCall(0, 1, guard({ command: "ls" }));
      await opts.guardToolCall(0, 2, guard({ command: "rm -rf build" }));
      await opts.guardToolCall(0, 3, guard({ command: "echo hi" }));
      await opts.guardToolCall(0, 4, guard({ command: "boom" }));
    });
    const asked: string[] = [];
    const statuses: string[] = [];
    const { out } = recorder();
    out.toolStatus = (callId, status) => statuses.push(`${callId}:${status.type}`);
    await runReply({
      sdk: { Chat },
      model,
      history: chatOf([{ role: "user", content: "clean up" }]),
      tools: [],
      toolTokens: 0,
      chatDir,
      settings,
      out,
      signal: new AbortController().signal,
      confirm: async (_callId, request) => {
        asked.push(`${request.pluginIdentifier} ${request.name} ${request.arguments.command}`);
        if (request.arguments.command === "rm -rf build") return { allow: false, reason: "Not now." };
        if (request.arguments.command === "echo hi") return { allow: true, arguments: { command: "echo hello" } };
        if (request.arguments.command === "boom") throw new Error("the chat closed");
        return { allow: true };
      },
    });
    expect(asked[0]).toBe("local/agent-toolkit run_command ls");
    // Each call's status card is told it is waiting for the user, then what the user decided.
    expect(statuses).toEqual([
      "1:confirmingToolCall",
      "1:callingTool",
      "2:confirmingToolCall",
      "2:toolCallDenied",
      "3:confirmingToolCall",
      "3:callingTool",
      "4:confirmingToolCall",
      "4:toolCallDenied",
    ]);
    expect(decisions).toEqual([
      "allow",
      "deny: Not now.",
      'override {"command":"echo hello"}',
      "deny: The user could not be asked to approve this call (the chat closed), so it was not run.",
    ]);
  });

  it("restates the open tasks at the end of the prompt every few messages", async () => {
    const model = fakeModel(async () => {});
    const todos = { todos: [{ content: "write the parser", status: "completed" }, { content: "add tests", status: "pending" }] };
    await run(
      model,
      [{ role: "user", content: "plan it" }, assistantCall("t1", "todo_write", todos), toolResult("t1", "ok"), { role: "user", content: "go on" }],
      { taskReminderEvery: 2 },
    );
    const lastUser = model.actCalls[0].getMessagesArray().filter((m: any) => m.getRole() === "user").at(-1).getText();
    expect(lastUser).toBe("go on\n\n(Your task list ([>] in progress, [x] done):\n[x] write the parser\n[ ] add tests)");
  });

  it("restates the last task list the tool accepted, not one it refused", () => {
    const good = { todos: [{ content: "write the parser", status: "in_progress" }] };
    const bad = { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] };
    const msgs = fromChat(
      chatOf([
        { role: "user", content: "plan it" },
        assistantCall("t1", "todo_write", good),
        toolResult("t1", "ok"),
        assistantCall("t2", "todo_write", bad),
        toolResult("t2", "Error: only one task can be in progress."),
      ]).getMessagesArray(),
    );
    expect(openTasks(msgs)).toBe("Your task list ([>] in progress, [x] done):\n[>] write the parser");
  });

  it("compacts a prompt that is too big and says so", async () => {
    const model = fakeModel(async () => {});
    const events = await run(
      model,
      [{ role: "user", content: "start" }, { role: "assistant", content: "x".repeat(4000) }, { role: "user", content: "next" }],
      { usable: 1000 },
    );
    expect(events.find(e => e.startsWith("notice:"))).toMatch(/^notice:Context: summarized the earlier conversation, [\d,]+ → [\d,]+ tokens\./);
  });

  it("makes room and carries on when a reply outgrows the context between rounds", async () => {
    // Callbacks in the SDK's order: the prediction completes, the assistant message and the tool
    // results follow, then the round ends; only then may the reply stop to make room.
    const model = fakeModel(async (_chat, opts, call) => {
      if (call > 1) return;
      for (const [round, id] of [[0, "r1"], [1, "r2"]] as const) {
        opts.onRoundStart(round);
        opts.onToolCallRequestEnd(round, round + 1, { toolCallRequest: { id, name: "read_file", arguments: { path: `${id}.txt` } } });
        opts.onPredictionCompleted({ stats: { promptTokensCount: round ? 9000 : 2000, predictedTokensCount: 100 } });
        opts.onMessage(assistantCall(id, "read_file", { path: `${id}.txt` }));
        opts.onMessage(toolResult(id, "y".repeat(5000)));
        opts.onRoundEnd(round);
        if (opts.signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
      }
    });
    const events = await run(model, [{ role: "user", content: "read everything" }], { usable: 10_000, keepRounds: 3 });
    expect(model.actCalls).toHaveLength(2);
    expect(events).toContain("notice:Context: the reply was filling the context, so older tool output was hidden before it went on.");
    // Every call shown once, with the SDK's number, and every call has its result.
    expect(events.filter(e => e.startsWith("call#") || e.startsWith("result#"))).toEqual(["call#1:read_file", "result#1:" + "y".repeat(5000), "call#2:read_file", "result#2:" + "y".repeat(5000)]);
    const second = model.actCalls[1].getMessagesArray();
    expect(second.map((m: any) => m.getRole())).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(second[2].getToolCallResults()[0].content).toBe("[output of read_file r1.txt (5000 characters) hidden to save context; call the tool again if you need it]");
  });

  it("drops the summary when the user edited an earlier message", async () => {
    const msgs = (first: string) => fromChat(chatOf([{ role: "user", content: first }, { role: "assistant", content: "ok" }]).getMessagesArray());
    await updateTranscript(chatDir, msgs("fix the parser"));
    await writeSummaryState(chatDir, { coversUpTo: 2, summary: "Goal: fix the parser.", failures: 0, cutAt: 2 });
    await updateTranscript(chatDir, msgs("fix the parser"));
    expect((await readSummaryState(chatDir)).summary).toBe("Goal: fix the parser.");
    await updateTranscript(chatDir, msgs("fix the lexer"));
    expect(await readSummaryState(chatDir)).toEqual({ coversUpTo: 0, summary: "", failures: 0 });
    expect(await readFile(join(chatDir, ".agent-toolkit", "compaction", "transcript.md"), "utf-8")).not.toContain("parser");
  });

  it("keeps the summary when only a message after it was edited", async () => {
    const msgs = (latest: string) =>
      fromChat(chatOf([{ role: "user", content: "fix the parser" }, { role: "assistant", content: "ok" }, { role: "user", content: latest }]).getMessagesArray());
    await updateTranscript(chatDir, msgs("now add tests"));
    await writeSummaryState(chatDir, { coversUpTo: 2, summary: "Goal: fix the parser.", failures: 0, cutAt: 3 });
    await updateTranscript(chatDir, msgs("now add more tests"));
    expect((await readSummaryState(chatDir)).summary).toBe("Goal: fix the parser.");
    expect(await readFile(join(chatDir, ".agent-toolkit", "compaction", "transcript.md"), "utf-8")).toContain("now add more tests");
  });

  // LM Studio's chat only shows a call's confirmation if the call has a status card: without one a
  // reply sat waiting for an approval nobody could give.
  it("keeps a status for each call, from the moment it is written until its result", async () => {
    const model = fakeModel(async (_chat, opts) => {
      opts.onRoundStart(0);
      opts.onToolCallRequestStart(0, 5, {});
      opts.onToolCallRequestNameReceived(0, 5, "read_file");
      opts.onToolCallRequestEnd(0, 5, { toolCallRequest: { id: "a", name: "read_file", arguments: { path: "x.js" } } });
      await opts.guardToolCall(0, 5, { toolCallRequest: { id: "a", name: "read_file", arguments: { path: "x.js" } }, allow: () => {}, deny: () => {} });
      opts.onToolCallRequestStart(0, 6, {});
      opts.onToolCallRequestFailure(0, 6, new Error("Unterminated string in JSON"));
      opts.onMessage(assistantCall("a", "read_file", { path: "x.js" }));
      opts.onMessage(toolResult("a", "Error: x.js does not exist."));
    });
    const statuses: string[] = [];
    const { out } = recorder();
    out.toolStatus = (callId, status) => statuses.push(`${callId}:${status.type}${"name" in status && status.name ? ` ${status.name}` : ""}`);
    await runReply({ sdk: { Chat }, model, history: chatOf([{ role: "user", content: "read it" }]), tools: [], toolTokens: 0, chatDir, settings, out, signal: new AbortController().signal });
    expect(statuses).toEqual(["5:generatingToolCall", "5:generatingToolCall read_file", "5:callingTool", "6:generatingToolCall", "6:toolCallGenerationFailed", "5:toolCallFailed"]);
  });

  it("shows a call without an id once, with the SDK's number, and gives its result the same number", async () => {
    const model = fakeModel(async (_chat, opts) => {
      opts.onRoundStart(0);
      opts.onToolCallRequestEnd(0, 7, { toolCallRequest: { name: "list_dir", arguments: {} } });
      opts.onMessage(assistantCall(undefined as any, "list_dir", {}));
      opts.onMessage(toolResult(undefined as any, "a.js"));
    });
    const events = await run(model, [{ role: "user", content: "look" }]);
    expect(events.filter(e => e.startsWith("call#") || e.startsWith("result#"))).toEqual(["call#7:list_dir", "result#7:a.js"]);
  });

  it("answers a side question without asking the model for a summary", async () => {
    await writeSummaryState(chatDir, { coversUpTo: 0, summary: "", failures: 1, cutAt: 3 });
    const model = fakeModel(async () => {});
    const history = [
      { role: "user", content: "start " + "u".repeat(3000) },
      { role: "assistant", content: "a".repeat(3000) },
      { role: "user", content: "next" },
      { role: "assistant", content: "b".repeat(3000) },
      { role: "user", content: "/btw what is a lexer?" },
    ];
    await run(model, history, { usable: 2000 });
    // The one model call is the answer itself, and the chat's compaction state is as it was.
    expect(model.respondCalls).toHaveLength(1);
    expect(await readSummaryState(chatDir)).toEqual({ coversUpTo: 0, summary: "", failures: 1, cutAt: 3 });
  });

  // A model reasoning at length filled the context mid-sentence, and the reply simply stopped.
  it("carries on a reply that a full context cut off, after making room", async () => {
    const model = fakeModel(async (_chat, opts, call) => {
      if (call > 1) return;
      for (const [round, id] of [[0, "r1"], [1, "r2"], [2, "r3"]] as const) {
        opts.onRoundStart(round);
        opts.onPredictionCompleted({ stats: { promptTokensCount: 2000, predictedTokensCount: 100, stopReason: "toolCalls" } });
        opts.onMessage(assistantCall(id, "read_file", { path: `${id}.txt` }));
        opts.onMessage(toolResult(id, "y".repeat(5000)));
        opts.onRoundEnd(round);
      }
      opts.onRoundStart(3);
      opts.onPredictionCompleted({ stats: { promptTokensCount: 9000, predictedTokensCount: 1000, stopReason: "contextLengthReached" } });
      opts.onMessage(ChatMessage.from({ role: "assistant", content: [{ type: "text", text: "So the driver was never" }] } as any));
      opts.onRoundEnd(3);
    });
    const events = await run(model, [{ role: "user", content: "why is the GPU idle?" }], { usable: 100_000, keepRounds: 3 });
    expect(model.actCalls).toHaveLength(2);
    expect(events).toContain("notice:Context: the reply was cut off by a full context, so older tool output was hidden and it went on.");
    const second = model.actCalls[1].getMessagesArray();
    expect(second.at(-2).getText()).toBe("So the driver was never");
    expect(second.at(-1).getText()).toMatch(/^\(Your last message was cut off because the context was full/);
  });

  it("says so when a full context cut a reply off and there is nothing left to hide", async () => {
    const model = fakeModel(async (_chat, opts) => {
      opts.onRoundStart(0);
      opts.onPredictionCompleted({ stats: { promptTokensCount: 9000, predictedTokensCount: 1000, stopReason: "contextLengthReached" } });
      opts.onMessage(ChatMessage.from({ role: "assistant", content: [{ type: "text", text: "So" }] } as any));
      opts.onRoundEnd(0);
    });
    const events = await run(model, [{ role: "user", content: "why?" }]);
    expect(model.actCalls).toHaveLength(1);
    expect(events).toContain("notice:Context: the context is full, so the reply was cut off. Start a new chat, or raise the model's context length.");
  });

  // A reasoning model planned a command in its thinking and stopped: the user saw nothing happen.
  it("asks once for an answer when a reply ends inside the model's thinking", async () => {
    const model = fakeModel(async (_chat, opts, call) => {
      opts.onRoundStart(0);
      opts.onPredictionFragment({ content: "I should run nvidia-smi.", reasoningType: "reasoning" });
      opts.onPredictionFragment({ content: "", reasoningType: "reasoningEndTag" });
      if (call === 2) opts.onPredictionFragment({ content: "Running it now.", reasoningType: "none" });
      opts.onMessage(ChatMessage.from({ role: "assistant", content: [{ type: "text", text: call === 2 ? "Running it now." : "" }] } as any));
      opts.onRoundEnd(0);
    });
    const events = await run(model, [{ role: "user", content: "check the GPU" }]);
    expect(model.actCalls).toHaveLength(2);
    expect(model.actCalls[1].getMessagesArray().at(-1).getText()).toMatch(/^\(Your reply ended inside your thinking/);
    expect(events).toContain("text:Running it now.");
  });

  it("follows up an empty reply only once", async () => {
    const model = fakeModel(async (_chat, opts) => {
      opts.onRoundStart(0);
      opts.onPredictionFragment({ content: "Hmm.", reasoningType: "reasoning" });
      opts.onRoundEnd(0);
    });
    await run(model, [{ role: "user", content: "check the GPU" }]);
    expect(model.actCalls).toHaveLength(2);
  });

  it("does not restart when there is no old output to hide", async () => {
    const model = fakeModel(async (_chat, opts) => {
      opts.onRoundStart(0);
      opts.onPredictionCompleted({ stats: { promptTokensCount: 9000, predictedTokensCount: 100 } });
      opts.onMessage(assistantCall("r1", "read_file", { path: "big.txt" }));
      opts.onMessage(toolResult("r1", "y".repeat(5000)));
      opts.onRoundEnd(0);
    });
    await run(model, [{ role: "user", content: "read it" }], { usable: 10_000 });
    expect(model.actCalls).toHaveLength(1);
  });

  it("keeps a summarized prompt on the next message instead of summarizing again", async () => {
    const model: any = fakeModel(async () => {});
    let summaries = 0;
    model.respond = async () => {
      summaries++;
      return { content: "Goal: test." };
    };
    const long = (i: number) => [
      { role: "user", content: `step ${i} ` + "u".repeat(300) },
      { role: "assistant", content: "a".repeat(1200) },
    ];
    const history = [...[0, 1, 2, 3, 4, 5].flatMap(long), { role: "user", content: "go on" }];
    const first = await run(model, history, { usable: 2000, keepRounds: 1 });
    expect(summaries).toBe(1);
    expect(first.filter(e => e.startsWith("notice:"))).toHaveLength(1);
    const firstPrompt = model.actCalls[0].getMessagesArray()[0].getText();

    const second = await run(model, [...history, { role: "assistant", content: "ok" }, { role: "user", content: "and more" }], { usable: 2000, keepRounds: 1 });
    expect(summaries).toBe(1);
    expect(second.filter(e => e.startsWith("notice:"))).toEqual([]);
    expect(model.actCalls[1].getMessagesArray()[0].getText()).toBe(firstPrompt);
  });
});
