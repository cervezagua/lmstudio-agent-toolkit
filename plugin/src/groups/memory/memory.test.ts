import { Chat, ChatMessage } from "@lmstudio/sdk";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { buildContextBlock, loadInstructionFiles } from "./lib/instructions";
import { MemoryStore, parseMemory, serializeMemory, slugify } from "./lib/memoryStore";
import { readTodos, renderTodos } from "./lib/todos";
import { preprocess } from "./promptPreprocessor";
import { toolsProvider } from "./toolsProvider";

let base: string;
let memoryDir: string;
let projectDir: string;
let chatDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "memory-tools-"));
  memoryDir = join(base, "memory");
  projectDir = join(base, "project");
  chatDir = join(base, "chat");
  await mkdir(projectDir);
  await mkdir(chatDir);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const chatConfig = () => ({
  projectFolder: projectDir,
  instructionFiles: ["AGENTS.md", "CLAUDE.md", "../outside.md"],
  injectMemoryIndex: true,
  enableSkills: false,
  enablePlanMode: true,
  injectGitSnapshot: false,
  maxInjectedChars: 12000,
});

describe("memory store", () => {
  it("slugifies names", () => {
    expect(slugify("Prefers PNPM over npm!")).toBe("prefers-pnpm-over-npm");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(() => slugify("!!!")).toThrow();
  });

  it("round-trips frontmatter, including colons and newlines in the description", () => {
    const memory = {
      name: "db",
      description: "Postgres: port 5433\nnot default",
      type: "project" as const,
      updated: "2026-09-15T00:00:00.000Z",
      content: "Use port 5433.",
    };
    expect(parseMemory(serializeMemory(memory), "x")).toEqual({ ...memory, description: "Postgres: port 5433 not default" });
  });

  it("saves, lists, searches, and deletes with an index kept in sync", async () => {
    const store = new MemoryStore(memoryDir);
    await store.save({ name: "prefers-pnpm", description: "User uses pnpm", content: "Always run pnpm, never npm.", type: "feedback" });
    await store.save({ name: "api-host", description: "Staging API", content: "https://staging.example.com", type: "reference" });
    expect((await store.save({ name: "Prefers PNPM", description: "User uses pnpm", content: "Updated.", type: "feedback" })).existed).toBe(true);

    expect((await store.list()).map(m => m.name)).toEqual(["api-host", "prefers-pnpm"]);
    const index = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
    expect(index).toContain("- [prefers-pnpm](prefers-pnpm.md) (feedback) — User uses pnpm");

    const results = await store.search("pnpm");
    expect(results.map(r => r.memory.name)).toEqual(["prefers-pnpm"]);
    expect(await store.search("zzz")).toEqual([]);

    expect(await store.delete("api-host")).toBe(true);
    expect(await store.delete("api-host")).toBe(false);
    expect(await readFile(join(memoryDir, "MEMORY.md"), "utf-8")).not.toContain("api-host");
  });
});

describe("instructions", () => {
  it("loads existing files only and never reads outside the project", async () => {
    await writeFile(join(projectDir, "AGENTS.md"), "Use tabs.");
    await writeFile(join(base, "outside.md"), "secret");
    expect(await loadInstructionFiles(projectDir, chatConfig().instructionFiles)).toEqual([{ name: "AGENTS.md", content: "Use tabs." }]);
  });

  it("builds nothing when there is nothing to inject and caps long content", () => {
    expect(buildContextBlock({ projectFolder: projectDir, instructions: [], memoryIndex: null, maxChars: 1000 })).toBeNull();
    const block = buildContextBlock({
      projectFolder: projectDir,
      instructions: [{ name: "AGENTS.md", content: "x".repeat(5000) }],
      memoryIndex: "# Memory index\n\n- [a](a.md) (user) — A",
      maxChars: 2000,
    })!;
    expect(block.length).toBeLessThan(2600);
    expect(block).toContain("characters truncated");
    expect(block).toContain("- [a](a.md) (user) — A");
  });
});

describe("prompt preprocessor", () => {
  it("injects instructions and memory index into the first message only", async () => {
    await writeFile(join(projectDir, "AGENTS.md"), "Always answer in French.");
    await new MemoryStore(memoryDir).save({ name: "name", description: "User is Sam", content: "Sam", type: "user" });

    const first = ChatMessage.from({ role: "user", content: "hello" });
    const ctl = fakeController({
      config: chatConfig(),
      globalConfig: { memoryDirectory: memoryDir, skillsDirectory: "" },
      workingDirectory: chatDir,
      history: Chat.from([{ role: "system", content: "sys" }]),
    });
    const result = (await preprocess(ctl, first)) as ChatMessage;
    const text = result.getText();
    expect(text).toMatch(/^<context source="memory-tools"/);
    expect(text).toContain("Always answer in French.");
    expect(text).toContain("User is Sam");
    expect(text.endsWith("\n\nhello")).toBe(true);
    expect(ctl.statuses[0]).toMatchObject({ text: "memory-tools loaded AGENTS.md, MEMORY.md" });

    const later = ChatMessage.from({ role: "user", content: "second" });
    const laterCtl = fakeController({
      config: chatConfig(),
      globalConfig: { memoryDirectory: memoryDir, skillsDirectory: "" },
      workingDirectory: chatDir,
      history: Chat.from([
        { role: "user", content: "hello" },
        { role: "assistant", content: "bonjour" },
      ]),
    });
    expect(((await preprocess(laterCtl, later)) as ChatMessage).getText()).toBe("second");
  });

  it("leaves the message untouched when there is nothing to load", async () => {
    const message = ChatMessage.from({ role: "user", content: "hi" });
    const ctl = fakeController({
      config: chatConfig(),
      globalConfig: { memoryDirectory: memoryDir, skillsDirectory: "" },
      workingDirectory: chatDir,
      history: Chat.empty(),
    });
    expect(((await preprocess(ctl, message)) as ChatMessage).getText()).toBe("hi");
  });
});

describe("memory-tools toolsProvider", () => {
  const tools = () =>
    toolsProvider(fakeController({ config: chatConfig(), globalConfig: { memoryDirectory: memoryDir, skillsDirectory: "" }, workingDirectory: chatDir }));

  it("exposes memory and todo tools that work end to end", async () => {
    const t = await tools();
    expect(t.map(x => x.name)).toEqual([
      "memory_save",
      "memory_read",
      "memory_search",
      "memory_list",
      "memory_delete",
      "save_session_summary",
      "todo_write",
      "todo_read",
      "enter_plan_mode",
      "exit_plan_mode",
    ]);

    expect(await callTool(t, "memory_save", { name: "deploy-steps", description: "How to deploy", content: "Run make deploy", type: "project" })).toBe(
      'Saved memory "deploy-steps".',
    );
    expect(await callTool(t, "memory_read", { name: "deploy-steps" })).toContain("Run make deploy");
    expect(await callTool(t, "memory_read", { name: "deploy" })).toMatch(/^Error: No memory named "deploy". Similar: deploy-steps/);
    expect(await callTool(t, "memory_search", { query: "deploy" })).toContain("> Run make deploy");
    expect(await callTool(t, "memory_list", {})).toContain("deploy-steps");
    expect(await callTool(t, "save_session_summary", { title: "Auth refactor", summary: "Done: login. Next: logout." })).toMatch(
      /^Saved session summary as "session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-auth-refactor"/,
    );
    expect(await callTool(t, "memory_delete", { name: "deploy-steps" })).toBe('Deleted memory "deploy-steps".');
    expect(await callTool(t, "memory_save", { name: "x", description: "d", content: "  ", type: "user" })).toBe(
      "Error: Memory content must not be empty.",
    );
  });

  it("keeps a per-chat todo list and validates it", async () => {
    const t = await tools();
    expect(await callTool(t, "todo_read", {})).toBe("No todos.");
    const todos = [
      { content: "Write tests", status: "completed" },
      { content: "Fix bug", status: "in_progress" },
      { content: "Update docs", status: "pending" },
    ];
    const rendered = "1. [x] Write tests\n2. [>] Fix bug\n3. [ ] Update docs\n(1/3 completed)";
    expect(await callTool(t, "todo_write", { todos })).toBe(rendered);
    expect(await callTool(t, "todo_read", {})).toBe(rendered);
    expect(renderTodos(await readTodos(chatDir))).toBe(rendered);
    expect(
      await callTool(t, "todo_write", {
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      }),
    ).toMatch(/^Error: Only one todo may be in_progress/);
    expect(() => t.find(x => x.name === "todo_write").checkParameters({ todos: [{ content: "a", status: "doing" }] })).toThrow();
  });
});
