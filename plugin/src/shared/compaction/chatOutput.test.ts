import { Chat, ChatMessage } from "@lmstudio/sdk";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReply, type Step } from "../chatDoctor";
import { capTools } from "./capTools";
import { type ChatController, confirmInChat, replyInChat } from "./chatOutput";
import { runReply, type ReplySettings } from "./reply";

/**
 * agent-toolkit-loop's reply, run against a fake LM Studio that records the steps LM Studio would
 * save, and checked by the same rules `npm run chat-doctor` applies to a real chat. Each bug users met
 * in LM Studio in 0.7.x (an approval with no buttons, a card left "calling tool", a greyed-out Stop)
 * broke one of these rules, and no test that only looked at the model's words could see it.
 */

let chatDir: string;
beforeEach(async () => {
  chatDir = await mkdtemp(join(tmpdir(), "chat-output-"));
});
afterEach(async () => {
  await rm(chatDir, { recursive: true, force: true });
});

type Decision = { type: "allow" } | { type: "deny"; denyReason?: string } | "never";

/** A fake LM Studio: what the loop shows is kept as LM Studio saves it. */
function fakeLmStudio(decide: (name: string) => Decision = () => ({ type: "allow" })) {
  const steps: Step[] = [];
  const abort = new AbortController();
  const ctl: ChatController = {
    abortSignal: abort.signal,
    createContentBlock(options = {}) {
      const step: Step = { type: "contentBlock", content: [], style: options.style, roleOverride: options.roleOverride };
      steps.push(step);
      return {
        appendText: text => {
          const last = step.content!.at(-1);
          if (last?.type === "text") last.text += text;
          else step.content!.push({ type: "text", text });
        },
        appendToolRequest: request => step.content!.push({ type: "toolCallRequest", callId: request.callId, name: request.name }),
        appendToolResult: result => step.content!.push({ type: "toolCallResult", callId: result.callId }),
        setStyle: style => {
          step.style = style;
        },
      };
    },
    createToolStatus(callId, status) {
      const step: Step = { type: "toolStatus", callId, statusState: { status } };
      steps.push(step);
      return { setStatus: next => void (step.statusState = { status: next }) };
    },
    createStatus(status) {
      steps.push({ type: "status", statusState: { status: status.status, text: status.text } });
    },
    async requestConfirmToolCall(request) {
      steps.push({ type: "requestConfirmToolCall", request: { callId: request.callId, name: request.name } });
      const decision = decide(request.name);
      // A user who never answers: the confirmation waits until the reply is stopped.
      if (decision === "never") return new Promise(() => {});
      return decision;
    },
  };
  return { ctl, steps, abort };
}

interface Call {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * A model whose act() calls back in the SDK's order for each round: the calls stream in and are
 * guarded, the prediction completes, the assistant message comes, the allowed tools run and their
 * results follow, then the round ends.
 */
function fakeModel(rounds: { thinking?: string; text?: string; calls?: Call[]; failAfterGuard?: boolean }[][]) {
  let next = 0;
  const model = {
    actCalls: 0,
    countTokens: async (text: string) => Math.ceil(text.length / 3.5),
    applyPromptTemplate: async (chat: any) => chat.getMessagesArray().map((m: any) => m.getText()).join("\n"),
    async act(_chat: any, tools: any[], opts: any) {
      this.actCalls++;
      const script = rounds[next++] ?? [];
      for (const [round, step] of script.entries()) {
        opts.signal.throwIfAborted();
        opts.onRoundStart(round);
        if (step.thinking) {
          opts.onPredictionFragment({ content: step.thinking, reasoningType: "reasoning" });
          opts.onPredictionFragment({ content: "", reasoningType: "reasoningEndTag" });
        }
        if (step.text) opts.onPredictionFragment({ content: step.text, reasoningType: "none" });
        const decisions: { call: Call; callId: number; allowed: boolean; reason?: string }[] = [];
        for (const [k, call] of (step.calls ?? []).entries()) {
          const callId = 100 * (round + 1) + k;
          opts.onToolCallRequestStart(round, callId, {});
          opts.onToolCallRequestNameReceived(round, callId, call.name);
          const request = { id: call.id, name: call.name, arguments: call.arguments ?? {} };
          opts.onToolCallRequestEnd(round, callId, { toolCallRequest: request });
          const decided: { allowed: boolean; reason?: string } = { allowed: false };
          await opts.guardToolCall(round, callId, {
            toolCallRequest: request,
            tool: tools.find(t => t.name === call.name),
            allow: () => (decided.allowed = true),
            allowAndOverrideParameters: () => (decided.allowed = true),
            deny: (reason: string) => Object.assign(decided, { allowed: false, reason }),
          });
          if (step.failAfterGuard) throw new Error("The model crashed while the tool was running");
          decisions.push({ call, callId, ...decided });
        }
        opts.onPredictionCompleted({ stats: { promptTokensCount: 500, predictedTokensCount: 50, stopReason: decisions.length ? "toolCalls" : "eosFound" } });
        const content: any[] = [...(step.text ? [{ type: "text", text: step.text }] : [])];
        for (const { call } of decisions) content.push({ type: "toolCallRequest", toolCallRequest: { type: "function", id: call.id, name: call.name, arguments: call.arguments ?? {} } });
        opts.onMessage(ChatMessage.from({ role: "assistant", content } as any));
        if (decisions.length) {
          const results = [];
          for (const { call, allowed, reason } of decisions) {
            const tool = tools.find(t => t.name === call.name);
            const output = allowed ? await tool.implementation(call.arguments ?? {}) : JSON.stringify({ error: reason });
            results.push({ type: "toolCallResult", toolCallId: call.id, content: typeof output === "string" ? output : JSON.stringify(output) });
          }
          opts.onMessage(ChatMessage.from({ role: "tool", content: results } as any));
        }
        opts.onRoundEnd(round);
      }
    },
  };
  return model;
}

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

const tool = (name: string, implementation: () => unknown) => ({ name, pluginIdentifier: "local/agent-toolkit", implementation: async () => implementation() });

/** One reply as agent-toolkit-loop runs it in LM Studio; returns the steps and what the rules find. */
async function reply(lmStudio: ReturnType<typeof fakeLmStudio>, model: ReturnType<typeof fakeModel>, tools: any[]) {
  const history = Chat.empty();
  history.append("user", "check the GPU");
  await replyInChat(lmStudio.ctl, out =>
    runReply({
      sdk: { Chat },
      model,
      history,
      tools: capTools(tools, { perResult: 10_000, budget: 50_000 }),
      toolTokens: 0,
      chatDir,
      settings,
      out,
      signal: lmStudio.ctl.abortSignal,
      confirm: confirmInChat(lmStudio.ctl, () => false),
    }),
  );
  return checkReply(lmStudio.steps, 1, false);
}

const cardOf = (steps: Step[], callId: number) => {
  const status = steps.find(step => step.type === "toolStatus" && step.callId === callId)?.statusState?.status;
  return typeof status === "string" ? status : status?.type;
};

describe("agent-toolkit-loop in LM Studio's chat", () => {
  it("shows an approved call with its card, its approval and its result", async () => {
    const lmStudio = fakeLmStudio();
    const model = fakeModel([[{ calls: [{ id: "a", name: "run_command" }] }, { text: "The driver is 616.92." }]]);
    expect(await reply(lmStudio, model, [tool("run_command", () => "exit_code: 0\nstdout:\n616.92")])).toEqual([]);
    expect(cardOf(lmStudio.steps, 100)).toBe("toolCallSucceeded");
    // The card comes before the approval, which LM Studio shows on it.
    const card = lmStudio.steps.findIndex(step => step.type === "toolStatus");
    const approval = lmStudio.steps.findIndex(step => step.type === "requestConfirmToolCall");
    expect(card).toBeLessThan(approval);
  });

  it("closes the card of a call the user declined", async () => {
    const lmStudio = fakeLmStudio(() => ({ type: "deny", denyReason: "Not now." }));
    const model = fakeModel([[{ calls: [{ id: "a", name: "run_command" }] }, { text: "Understood." }]]);
    expect(await reply(lmStudio, model, [tool("run_command", () => "never runs")])).toEqual([]);
    expect(cardOf(lmStudio.steps, 100)).toBe("toolCallDenied");
  });

  it("gives the model a tool's error and marks the card failed, without ending the reply", async () => {
    const lmStudio = fakeLmStudio();
    const model = fakeModel([[{ calls: [{ id: "a", name: "run_javascript" }] }, { text: "Deno has no require; using the shell." }]]);
    const throwing = tool("run_javascript", () => {
      throw new Error("Process exited with code 1. ReferenceError: require is not defined");
    });
    expect(await reply(lmStudio, model, [throwing])).toEqual([]);
    expect(cardOf(lmStudio.steps, 100)).toBe("toolCallFailed");
  });

  it("ends a reply that failed mid-call with its reason, and no card left running", async () => {
    const lmStudio = fakeLmStudio();
    const model = fakeModel([[{ calls: [{ id: "a", name: "run_command" }], failAfterGuard: true }]]);
    const findings = await reply(lmStudio, model, [tool("run_command", () => "ok")]);
    expect(findings.map(finding => finding.rule)).toEqual(["error-status"]);
    expect(cardOf(lmStudio.steps, 100)).toBe("toolCallFailed");
  });

  it("closes the card when the reply is stopped while an approval is waiting", async () => {
    const lmStudio = fakeLmStudio(() => "never");
    const model = fakeModel([[{ calls: [{ id: "a", name: "run_command" }] }]]);
    setTimeout(() => lmStudio.abort.abort(), 20);
    expect(await reply(lmStudio, model, [tool("run_command", () => "ok")])).toEqual([]);
    expect(cardOf(lmStudio.steps, 100)).toMatch(/toolCallDenied|toolCallFailed/);
  });

  it("does not leave a reply that is only thinking", async () => {
    const lmStudio = fakeLmStudio();
    const model = fakeModel([[{ thinking: "I should run nvidia-smi." }], [{ text: "Running nvidia-smi now." }]]);
    expect(await reply(lmStudio, model, [])).toEqual([]);
    expect(model.actCalls).toBe(2);
  });
});

describe("the chat rules", () => {
  // The 0.7.0 bug, as LM Studio saved it in a user's chat.
  it("catches an approval without a card, and a card left calling a tool", () => {
    const steps: Step[] = [
      { type: "contentBlock", content: [{ type: "toolCallRequest", callId: 1, name: "edit_file" }] },
      { type: "requestConfirmToolCall", request: { callId: 1, name: "edit_file" } },
    ];
    expect(checkReply(steps, 6, true).map(finding => finding.rule)).toEqual(["approval-without-card", "call-without-result"]);
    const stuck: Step[] = [
      { type: "toolStatus", callId: 2, statusState: { status: { type: "callingTool" } } },
      { type: "contentBlock", content: [{ type: "toolCallRequest", callId: 2, name: "run_javascript" }] },
    ];
    expect(checkReply(stuck, 8, false)).toEqual([
      { message: 8, severity: "error", rule: "card-not-finished", detail: 'The card for run_javascript still says "callingTool", though the reply ended.' },
    ]);
  });

  it("notices a reply cut off mid-sentence, one that is only thinking, and thinking in the answer", () => {
    const cut: Step[] = [{ type: "contentBlock", content: [{ type: "text", text: "the nv_dispwi folders get created/" }] }];
    expect(checkReply(cut, 3, true).map(finding => finding.rule)).toEqual(["cut-off"]);
    const thinking: Step[] = [{ type: "contentBlock", style: { type: "thinking", ended: true }, content: [{ type: "text", text: "run nvidia-smi" }] }];
    expect(checkReply(thinking, 3, true).map(finding => finding.rule)).toEqual(["only-thinking"]);
    const leaked: Step[] = [{ type: "contentBlock", content: [{ type: "text", text: "Fine. </think> The answer is 4." }] }];
    expect(checkReply(leaked, 3, true).map(finding => finding.rule)).toEqual(["thinking-in-answer"]);
    const done: Step[] = [{ type: "contentBlock", content: [{ type: "text", text: "All done." }] }];
    expect(checkReply(done, 3, true)).toEqual([]);
  });
});
