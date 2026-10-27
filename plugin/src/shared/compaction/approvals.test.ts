import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApprovals, wildcard } from "./approvals";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "approvals-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settings = (chat: Record<string, unknown>) => writeFile(join(home, "settings.json"), JSON.stringify({ language: "en", chat }));

// LM Studio's "Always allow" was ignored: the loop asked about every call, every few seconds.
describe("loadApprovals", () => {
  it("follows LM Studio's Always allow patterns for a whole plugin or one tool", async () => {
    await settings({ skipToolConfirmationPatterns: ["local/agent-toolkit:*", "lmstudio/js-code-sandbox:run_javascript"] });
    const allowed = await loadApprovals(home);
    expect(allowed("local/agent-toolkit", "run_command")).toBe(true);
    expect(allowed("lmstudio/js-code-sandbox", "run_javascript")).toBe(true);
    expect(allowed("lmstudio/js-code-sandbox", "other_tool")).toBe(false);
    // A plugin whose name only starts the same way is not covered.
    expect(allowed("local/agent-toolkit-loop", "anything")).toBe(false);
    expect(allowed(undefined, "run_command")).toBe(false);
  });

  it("never lets a * reach across the colon between plugin and tool", async () => {
    await settings({ skipToolConfirmationPatterns: ["local/agent-toolkit*", "local/*:read_file"] });
    const allowed = await loadApprovals(home);
    expect(allowed("local/agent-toolkit-loop", "run_command")).toBe(false);
    expect(allowed("local/agent-toolkit", "read_file")).toBe(true);
    expect(allowed("local/agent-toolkit", "read_file_and_run")).toBe(false);
  });

  it("allows everything when confirmation is switched off in LM Studio", async () => {
    await settings({ neverAskForToolConfirmation: true, skipToolConfirmationPatterns: [] });
    expect((await loadApprovals(home))("mcp/anything", "delete_all")).toBe(true);
  });

  it("asks when the settings cannot be read", async () => {
    expect((await loadApprovals(home))("local/agent-toolkit", "run_command")).toBe(false);
    await writeFile(join(home, "settings.json"), "{ not json");
    expect((await loadApprovals(home))("local/agent-toolkit", "run_command")).toBe(false);
  });

  it("keeps the choices it read when the file changes during a reply", async () => {
    await settings({ skipToolConfirmationPatterns: [] });
    const allowed = await loadApprovals(home);
    await settings({ neverAskForToolConfirmation: true });
    expect(allowed("local/agent-toolkit", "run_command")).toBe(false);
  });
});

describe("wildcard", () => {
  it("matches * as any run of characters", () => {
    expect(wildcard("*", "anything")).toBe(true);
    expect(wildcard("run_*", "run_command")).toBe(true);
    expect(wildcard("*_file", "read_file")).toBe(true);
    expect(wildcard("a*b*c", "aXbYc")).toBe(true);
    expect(wildcard("a*b*c", "aXcYb")).toBe(false);
    expect(wildcard("ab*ba", "aba")).toBe(false);
    expect(wildcard("read_file", "read_file")).toBe(true);
    expect(wildcard("read.file", "readXfile")).toBe(false);
  });

  // A pattern full of "*" made a regular expression backtrack for minutes and stall the loop.
  it("stays fast on a pattern full of stars", () => {
    const started = Date.now();
    expect(wildcard(`${"a*".repeat(10)}b`, "a".repeat(60))).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
