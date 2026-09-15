import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../../shared/testing/fake-controller";
import { assertNotOption, repoPath } from "./lib/cli";
import { findExecutable } from "./shared/process";
import { toolsProvider } from "./toolsProvider";

const config = (repoDirectory: string, overrides: Record<string, unknown> = {}) => ({
  repoDirectory,
  allowPush: false,
  enableGitHub: true,
  maxOutputChars: 20000,
  ...overrides,
});

describe("cli helpers", () => {
  it("rejects option-looking values", () => {
    expect(() => assertNotOption("--output=/tmp/x", "ref")).toThrow(/must not start with "-"/);
    expect(assertNotOption(" main ", "ref")).toBe("main");
  });

  it("keeps pathspecs inside the repository", () => {
    const repo = join(tmpdir(), "repo");
    expect(repoPath(repo, "src/a.ts")).toBe(join("src", "a.ts"));
    expect(repoPath(repo, ".")).toBe(".");
    expect(() => repoPath(repo, "../other")).toThrow(/outside/);
  });
});

describe("git-tools toolsProvider", () => {
  let repo: string;
  let tools: any[];

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "git-tools-"));
    tools = await toolsProvider(fakeController({ config: config(repo), workingDirectory: tmpdir() }));
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("registers push and gh tools only when enabled/available", async () => {
    const names = tools.map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["git_status", "git_diff", "git_log", "git_show", "git_add", "git_commit", "git_branch", "git_init"]),
    );
    expect(names).not.toContain("git_push");
    expect(names.includes("gh_pr_list")).toBe(findExecutable("gh") !== null);

    const withPush = await toolsProvider(
      fakeController({ config: config(repo, { allowPush: true, enableGitHub: false }), workingDirectory: repo }),
    );
    expect(withPush.map(t => t.name)).toContain("git_push");
    expect(withPush.map(t => t.name).some(n => n.startsWith("gh_"))).toBe(false);
  });

  it("explains when the directory is not a repository", async () => {
    expect(await callTool(tools, "git_status", {})).toMatch(/is not a git repository/);
  });

  it("runs an init → add → commit → log → branch → diff workflow", async () => {
    expect(await callTool(tools, "git_init", {})).toMatch(/Initialized empty Git repository/);
    // Local identity so the test does not depend on global git config.
    const { runCli } = await import("./lib/cli");
    await runCli("git", ["config", "user.email", "test@example.com"], { cwd: repo, maxOutputChars: 1000 });
    await runCli("git", ["config", "user.name", "Test"], { cwd: repo, maxOutputChars: 1000 });

    await writeFile(join(repo, "a.txt"), "one\n");
    expect(await callTool(tools, "git_commit", { message: "nothing staged" })).toBe("Error: Nothing is staged. Use git_add first.");
    expect(await callTool(tools, "git_add", { paths: ["a.txt"] })).toBe("A  a.txt");
    expect(await callTool(tools, "git_diff", { staged: true })).toContain("+one");

    const commit = await callTool(tools, "git_commit", { message: 'Add "a"\n\nMulti-line body with $pecial chars' });
    expect(commit).toMatch(/Add "a"/);
    const log = await callTool(tools, "git_log", {});
    expect(log).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Test \(HEAD -> \w+\)  Add "a"$/);
    expect(await callTool(tools, "git_show", { ref: "HEAD" })).toContain("Multi-line body with $pecial chars");

    expect(await callTool(tools, "git_branch", { name: "feature/x" })).toBe('Created and switched to branch "feature/x".');
    expect(await callTool(tools, "git_status", {})).toMatch(/^## feature\/x/);
    expect(await callTool(tools, "git_branch", { name: "feature/x", switch: false })).toBe('Error: Branch "feature/x" already exists.');
    expect(await callTool(tools, "git_branch", {})).toMatch(/\* feature\/x/);

    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    expect(await callTool(tools, "git_diff", { path: "a.txt" })).toContain("+two");
    expect(await callTool(tools, "git_diff", { stat_only: true })).toMatch(/a\.txt \| 1 \+/);
    expect(await callTool(tools, "git_show", { ref: "--output=evil" })).toBe('Error: ref must not start with "-".');
    expect(await callTool(tools, "git_show", { ref: "nonexistent-ref" })).toMatch(/^Error: git show failed \(exit 128\)/);
  });
});
