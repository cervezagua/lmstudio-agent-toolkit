import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSnapshot } from "./gitSnapshot";
import { buildContextBlock } from "./instructions";
import { renderIndex, type Memory } from "./memoryStore";
import { completionNudge, type Todo } from "./todos";
import { runProcess } from "../shared/process";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memory-context-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const memory = (name: string, updated: string): Memory => ({
  name,
  description: `about ${name}`,
  type: "project",
  updated,
  content: "body",
});

describe("memory index", () => {
  const now = new Date("2026-09-16T00:00:00.000Z");

  it("marks memories older than a month as stale", () => {
    const index = renderIndex([memory("fresh", "2026-09-10T00:00:00.000Z"), memory("old", "2026-01-01T00:00:00.000Z")], now);
    expect(index).toContain("- [fresh](fresh.md) (project) — about fresh");
    expect(index).toContain("- [old](old.md) (project) (stale) — about old");
    expect(index).toContain("Keep each entry to a single line.");
  });

  it("caps a huge collection and says how many are hidden", () => {
    const many = Array.from({ length: 250 }, (_, i) => memory(`m${i}`, now.toISOString()));
    const index = renderIndex(many, now);
    expect(index.split("\n").filter(line => line.startsWith("- ")).length).toBe(200);
    expect(index).toContain("50 older memories are not listed; find them with memory_search.");
  });

  it("still handles an empty collection", () => {
    expect(renderIndex([], now)).toContain("(no memories saved yet)");
  });
});

describe("context block", () => {
  const base = { projectDirectory: "/p", instructions: [], memoryIndex: null, maxChars: 4000 };

  it("states today's date and includes the repository section", () => {
    const block = buildContextBlock({
      ...base,
      instructions: [{ name: "AGENTS.md", content: "Use tabs." }],
      gitSnapshot: "Branch: main\n\nUncommitted changes:\n M src/a.ts",
      today: new Date("2026-09-16T10:00:00.000Z"),
    })!;
    expect(block).toContain("Today is 2026-09-16.");
    expect(block).toContain("## Repository");
    expect(block).toContain("Branch: main");
  });

  it("adds nothing when there is nothing to say", () => {
    expect(buildContextBlock({ ...base, gitSnapshot: null })).toBeNull();
  });
});

describe("git snapshot", () => {
  it("returns null outside a repository", async () => {
    expect(await gitSnapshot(dir)).toBeNull();
  });

  it("reports the branch, changes and recent commits", async () => {
    const git = (args: string[]) => runProcess("git", args, { cwd: dir, timeoutMs: 15000 });
    await git(["init", "-b", "work"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(["add", "a.txt"]);
    await git(["commit", "-m", "add a"]);
    await writeFile(join(dir, "b.txt"), "two\n");

    const snapshot = await gitSnapshot(dir);
    expect(snapshot).toContain("Branch: work");
    expect(snapshot).toContain("?? b.txt");
    expect(snapshot).toContain("add a");
  }, 60000);

  it("says the tree is clean when it is", async () => {
    const git = (args: string[]) => runProcess("git", args, { cwd: dir, timeoutMs: 15000 });
    await git(["init"]);
    expect(await gitSnapshot(dir)).toContain("(working tree clean)");
  }, 60000);
});

describe("todo completion nudge", () => {
  const todo = (content: string, status: Todo["status"] = "completed"): Todo => ({ content, status });

  it("fires when a finished list never mentions checking the work", () => {
    expect(completionNudge([todo("write parser"), todo("wire it up"), todo("update docs")])).toMatch(/verify the change/);
  });

  it("stays quiet for short lists, unfinished lists, and lists that already verify", () => {
    expect(completionNudge([todo("a"), todo("b")])).toBeNull();
    expect(completionNudge([todo("a"), todo("b"), todo("c", "pending")])).toBeNull();
    expect(completionNudge([todo("write parser"), todo("wire it up"), todo("run the tests")])).toBeNull();
  });
});
