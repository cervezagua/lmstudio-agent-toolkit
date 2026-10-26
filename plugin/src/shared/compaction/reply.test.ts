import { Chat, ChatMessage } from "@lmstudio/sdk";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReply, type ReplyOutput, type ReplySettings } from "./reply";

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
    const { out } = recorder();
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
    const model = fakeModel(async (_chat, opts, call) => {
      if (call === 1) {
        opts.onMessage(assistantCall("r1", "read_file", { path: "big.txt" }));
        opts.onMessage(toolResult("r1", "y".repeat(5000)));
        opts.onPredictionCompleted({ stats: { promptTokensCount: 9000, predictedTokensCount: 100 } });
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
    });
    const events = await run(model, [{ role: "user", content: "read everything" }], { usable: 10_000, keepRounds: 1 });
    expect(model.actCalls).toHaveLength(2);
    expect(events).toContain("notice:Context: the reply was filling the context, so older tool output was hidden before it went on.");
    const second = model.actCalls[1].getMessagesArray().map((m: any) => m.getRole());
    expect(second).toEqual(["user", "assistant", "tool"]);
  });
});
