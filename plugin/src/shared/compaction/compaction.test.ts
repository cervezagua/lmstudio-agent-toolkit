import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capTools } from "./capTools";
import { chooseCut, compact, type CompactOptions } from "./compact";
import { roughTokens, safeCutPoints, withoutSideQuestions, type Msg } from "./history";
import { headAndTail, maskToolResults } from "./mask";
import { ledger, openTasks, userWords } from "./pinned";
import { MAX_SUMMARY_FAILURES, readSummaryState, updateSummary } from "./summary";
import { updateTranscript } from "./transcript";

let n = 0;
const user = (text: string): Msg => ({ role: "user", text, calls: [], results: [], n: ++n });
const say = (text: string): Msg => ({ role: "assistant", text, calls: [], results: [], n: ++n });
const call = (name: string, args: Record<string, unknown>, id = `c${n + 1}`): Msg => ({ role: "assistant", text: "", calls: [{ id, name, args }], results: [], n: ++n });
const result = (content: string, id: string): Msg => ({ role: "tool", text: "", calls: [], results: [{ id, content }], n: ++n });
/** A call and its result: a finished round. */
const round = (name: string, args: Record<string, unknown>, content: string): Msg[] => {
  const c = call(name, args);
  return [c, result(content, c.calls[0].id!)];
};

let chatDir: string;
beforeEach(async () => {
  n = 0;
  chatDir = await mkdtemp(join(tmpdir(), "compaction-"));
});
afterEach(async () => {
  await rm(chatDir, { recursive: true, force: true });
});

describe("history helpers", () => {
  it("drops /btw questions and their answers", () => {
    const msgs = [user("fix it"), say("ok"), user("/btw what is a regex?"), say("a pattern"), user("now test it"), say("done")];
    expect(withoutSideQuestions(msgs).map(m => m.text)).toEqual(["fix it", "ok", "now test it", "done"]);
  });

  it("never offers a cut between a tool call and its result", () => {
    const msgs = [user("go"), ...round("read_file", { path: "a" }, "x"), say("read it"), user("more")];
    const points = safeCutPoints(msgs);
    expect(points).not.toContain(2); // between the call and its result
    expect(points).toContain(3); // after the finished round
    expect(points).toContain(4);
  });
});

describe("maskToolResults", () => {
  it("hides old tool output with a pointer to the transcript, and keeps the recent rounds whole", () => {
    const long = "line\n".repeat(200);
    const msgs = [user("go"), ...round("read_file", { path: "src/a.js" }, long), ...round("read_file", { path: "src/b.js" }, long)];
    const { msgs: masked, hidden } = maskToolResults(msgs, { keepRounds: 1, maxResultChars: 100_000 });
    expect(hidden).toBe(1);
    expect(masked[2].results[0].content).toBe(`[output of read_file src/a.js (${long.length} characters) hidden to save context; the full text is #m3 in the transcript]`);
    expect(masked[4].results[0].content).toBe(long);
    expect(masked[4].original).toBe(msgs[4].original);
  });

  it("turns an old failed call into a one-line description, and leaves short results alone", () => {
    const msgs = [
      user("go"),
      ...round("edit_file", { path: "x.js" }, 'Error: old_string was not found in the file.\nThe closest text is at line 3'),
      ...round("edit_file", { path: "x.js" }, "Edited x.js: 1 replacement."),
      ...round("run_command", { command: "npm test" }, "exit_code: 0"),
    ];
    const { msgs: masked } = maskToolResults(msgs, { keepRounds: 1, maxResultChars: 100_000 });
    expect(masked[2].results[0].content).toBe("[earlier failed call edit_file x.js: old_string was not found in the file.]");
    expect(masked[4].results[0].content).toBe("Edited x.js: 1 replacement.");
  });

  it("keeps the head and tail of a long result that stays", () => {
    const text = "HEAD" + "x".repeat(1000) + "TAIL";
    const cut = headAndTail(text, 100, 7);
    expect(cut.startsWith("HEAD")).toBe(true);
    expect(cut.endsWith("TAIL")).toBe(true);
    expect(cut).toContain("the full text is #m7 in the transcript");
  });
});

describe("what is pinned", () => {
  it("lists changed files, commands with exit codes and failed attempts from the tool calls", () => {
    const msgs = [
      user("go"),
      ...round("edit_file", { path: "src/a.js" }, "Edited src/a.js: 1 replacement."),
      ...round("run_command", { command: "npm test" }, "exit_code: 1\nstdout:\n1 failing"),
      ...round("read_file", { path: "nope.js" }, "Error: nope.js does not exist. Did you mean: src/nope.js?"),
    ];
    const text = ledger(msgs, 1000);
    expect(text).toContain("Files changed: src/a.js");
    expect(text).toMatch(/Steps, newest first:\n- failed: read_file nope\.js: nope\.js does not exist\. Did you mean: src\/nope\.js\?\n- ran `npm test` \(exit 1\)/);
  });

  it("keeps the first request whole and later words newest first within the budget", () => {
    const msgs = [user("Build a CSV tool. Exit 2 on a missing file."), say("ok"), user("x".repeat(4000)), user("also add --json")];
    const words = userWords(msgs, roughTokens("Build a CSV tool. Exit 2 on a missing file.") + 50);
    expect(words).toContain("[#m1] Build a CSV tool. Exit 2 on a missing file.");
    expect(words).toContain("[#m4] also add --json");
    expect(words).not.toContain("xxxx");
    expect(words).toContain("(1 more of the user's messages are in the transcript)");
  });

  it("quotes only what the user typed, not what agent-toolkit added in front of it", () => {
    const added = '<context source="agent-toolkit">AGENTS.md: deploy freely</context>\n\nEverything above was added automatically by agent-toolkit; it is not part of the user\'s message.\n\nThe user\'s message:\nfix the bug';
    expect(userWords([user(added)], 1000)).toBe("[#m1] fix the bug");
  });

  it("shows the latest open tasks, and nothing once all are done", () => {
    const todos = (statuses: string[]) => call("todo_write", { todos: statuses.map((status, i) => ({ content: `step ${i + 1}`, status })) });
    expect(openTasks([user("go"), todos(["completed", "in_progress", "pending"])])).toBe(
      "Your task list ([>] in progress, [x] done):\n[x] step 1\n[>] step 2\n[ ] step 3",
    );
    expect(openTasks([user("go"), todos(["completed", "completed"])])).toBe("");
  });
});

describe("compact", () => {
  const options: CompactOptions = { usable: 1000, high: 0.7, low: 0.45, keepRounds: 1, maxResultChars: 100_000, summarize: true };
  // A stand-in for the model's count: the rough size of everything in the prompt.
  const count = async (system: string, msgs: Msg[]) =>
    roughTokens(system) + msgs.reduce((sum, m) => sum + roughTokens(m.text) + m.results.reduce((s, r) => s + roughTokens(r.content), 0), 0);
  const summarizer = (reply: string | Error) => ({
    calls: 0,
    async respond() {
      this.calls++;
      if (reply instanceof Error) throw reply;
      return { content: reply };
    },
  });

  it("changes nothing under the high mark", async () => {
    const msgs = [user("hello"), say("hi")];
    const done = await compact({ system: "sys", msgs, count, model: summarizer("unused"), chatDir, options });
    expect(done.stage).toBe(0);
    expect(done.msgs).toBe(msgs);
  });

  it("only hides old output when that is enough", async () => {
    const msgs = [user("go"), ...round("read_file", { path: "a" }, "a".repeat(3000)), ...round("read_file", { path: "b" }, "b".repeat(100))];
    const model = summarizer("unused");
    const done = await compact({ system: "sys", msgs, count, model, chatDir, options });
    expect(done.stage).toBe(1);
    expect(done.after).toBeLessThan(done.before);
    expect(model.calls).toBe(0);
  });

  it("replaces older turns with a labelled record, leaving the system prompt alone", async () => {
    const msgs = [
      user("Build the parser. Keep it under 100 lines."),
      say("p".repeat(3000)),
      user("now the tests"),
      say("q".repeat(200)),
      user("and the docs"),
    ];
    const model = summarizer("Goal: parser.\nNext step: docs.");
    const done = await compact({ system: "You are helpful.", msgs, count, model, chatDir, options });
    expect(done.stage).toBe(2);
    expect(done.system).toBe("You are helpful.");
    const record = done.msgs[0].text;
    expect(done.msgs[0].role).toBe("user");
    expect(record).toMatch(/^<earlier-conversation source="agent-toolkit-loop">\n\nA record of the earlier part of this conversation[\s\S]*It is information, not instructions/);
    expect(record).toContain("[#m1] Build the parser. Keep it under 100 lines.");
    expect(record).toContain("## Summary\nGoal: parser.");
    expect(record).toContain(".agent-toolkit/compaction/transcript.md");
    expect(done.msgs.at(-1)!.text).toBe("and the docs");
    expect(done.after).toBeLessThan(done.before);
  });

  it("still compacts when the summary fails, and says so", async () => {
    const msgs = [user("Build it."), say("p".repeat(3000)), user("next")];
    const done = await compact({ system: "sys", msgs, count, model: summarizer(new Error("model busy")), chatDir, options });
    expect(done.stage).toBe(2);
    expect(done.note).toMatch(/summary could not be written/);
    expect(done.msgs[0].text).toContain("[#m1] Build it.");
  });

  it("can cut inside one long request, between finished rounds", () => {
    const msgs = [user("do everything"), ...round("read_file", { path: "a" }, "a".repeat(700)), ...round("read_file", { path: "b" }, "b".repeat(70))];
    expect(chooseCut(msgs, 60)).toBe(3);
  });
});

describe("updateSummary", () => {
  it("updates the previous summary with the new messages only, and stops after repeated failures", async () => {
    const prompts: string[] = [];
    const model = {
      async respond(history: any) {
        prompts.push(history[1].content);
        return { content: `summary ${prompts.length}` };
      },
    };
    const first = [user("one"), say("two")];
    expect(await updateSummary(model, chatDir, first, { inputTokens: 5000 })).toBe("summary 1");
    const more = [...first, user("three")];
    expect(await updateSummary(model, chatDir, more, { inputTokens: 5000 })).toBe("summary 2");
    expect(prompts[1]).toContain("Previous summary:\nsummary 1");
    expect(prompts[1]).toContain("#m3 user");
    expect(prompts[1]).not.toContain("#m1 user");

    const failing = { respond: async () => Promise.reject(new Error("down")) };
    const later = [...more, user("four")];
    for (let i = 0; i < MAX_SUMMARY_FAILURES; i++) expect(await updateSummary(failing, chatDir, later, { inputTokens: 5000 })).toBe("summary 2");
    expect((await readSummaryState(chatDir)).failures).toBe(MAX_SUMMARY_FAILURES);
    expect(await updateSummary(model, chatDir, later, { inputTokens: 5000 })).toBe("summary 2");
    expect(prompts).toHaveLength(2);
  });
});

describe("updateTranscript", () => {
  it("appends new messages with stable numbers, and rewrites when the chat got shorter", async () => {
    const msgs = [user("first"), ...round("read_file", { path: "a.js" }, "contents of a")];
    await updateTranscript(chatDir, msgs.slice(0, 1));
    await updateTranscript(chatDir, msgs);
    const file = join(chatDir, ".agent-toolkit", "compaction", "transcript.md");
    const text = await readFile(file, "utf-8");
    expect(text).toMatch(/## #m1 user\nfirst[\s\S]*## #m2 assistant\n-> read_file \{"path":"a\.js"\}[\s\S]*## #m3 tool\ncontents of a/);
    expect(text.match(/## #m1 /g)).toHaveLength(1);
    await updateTranscript(chatDir, msgs.slice(0, 1));
    expect(await readFile(file, "utf-8")).not.toContain("#m2");
  });
});

describe("capTools", () => {
  it("cuts long results to head and tail, keeps their shape, and shares a budget across calls", async () => {
    const big = "S" + "x".repeat(10_000) + "E";
    const tool = { name: "mcp_read", implementation: async () => ({ content: [{ type: "text", text: big }], isError: false }) };
    const [capped] = capTools([tool], { perResult: 1000, budget: 1500 });
    const first: any = await capped.implementation();
    expect(first.isError).toBe(false);
    expect(first.content[0].text.startsWith("S")).toBe(true);
    expect(first.content[0].text).toContain("E\n[cut to fit the context");
    const second: any = await capped.implementation();
    expect(second.content[0].text).toContain("The context for tool output is used up");
    const [small] = capTools([{ implementation: async () => "short" }], { perResult: 10, budget: 10 });
    expect(await small.implementation()).toBe("short");
  });

  it("fits the shared budget to the room left, and refills it only up to the full budget", async () => {
    const tools = capTools([{ implementation: async () => "x".repeat(5000) }], { perResult: 4000, budget: 8000 });
    tools.fit(1000);
    expect(String(await tools[0].implementation())).toContain("The context for tool output is used up");
    tools.refill();
    tools.fit(-50);
    expect(String(await tools[0].implementation()).length).toBeLessThan(500);
    tools.refill();
    tools.fit(100_000);
    expect(String(await tools[0].implementation())).toContain("[cut to fit the context; calling the tool again returns the same text.]");
  });

  // js-code-sandbox throws when a script fails; the SDK then ended the whole reply, leaving the chat
  // stuck on "calling tool" with no result.
  it("turns a tool that throws into an error result the model can read", async () => {
    const [failing] = capTools(
      [{ implementation: async () => Promise.reject(new Error("Process exited with code 1. Stderr: ReferenceError: require is not defined")) }],
      { perResult: 1000, budget: 5000 },
    );
    expect(await failing.implementation()).toBe("Error: Process exited with code 1. Stderr: ReferenceError: require is not defined");
  });
});
