import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alwaysAllowed } from "./approvals";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "approvals-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settings = (chat: Record<string, unknown>) => writeFile(join(home, "settings.json"), JSON.stringify({ language: "en", chat }));

// LM Studio's "Always allow" was ignored: the loop asked about every call, every few seconds.
describe("alwaysAllowed", () => {
  it("follows LM Studio's Always allow patterns for a whole plugin or one tool", async () => {
    await settings({ skipToolConfirmationPatterns: ["local/agent-toolkit:*", "lmstudio/js-code-sandbox:run_javascript"] });
    expect(await alwaysAllowed("local/agent-toolkit", "run_command", home)).toBe(true);
    expect(await alwaysAllowed("lmstudio/js-code-sandbox", "run_javascript", home)).toBe(true);
    expect(await alwaysAllowed("lmstudio/js-code-sandbox", "other_tool", home)).toBe(false);
    // A plugin whose name only starts the same way is not covered.
    expect(await alwaysAllowed("local/agent-toolkit-loop", "anything", home)).toBe(false);
    expect(await alwaysAllowed(undefined, "run_command", home)).toBe(false);
  });

  it("allows everything when confirmation is switched off in LM Studio", async () => {
    await settings({ neverAskForToolConfirmation: true, skipToolConfirmationPatterns: [] });
    expect(await alwaysAllowed("mcp/anything", "delete_all", home)).toBe(true);
  });

  it("asks when the settings cannot be read", async () => {
    expect(await alwaysAllowed("local/agent-toolkit", "run_command", home)).toBe(false);
    await writeFile(join(home, "settings.json"), "{ not json");
    expect(await alwaysAllowed("local/agent-toolkit", "run_command", home)).toBe(false);
  });
});
