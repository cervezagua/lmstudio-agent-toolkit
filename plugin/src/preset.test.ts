import { execFileSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const repo = join(__dirname, "..", "..");
const presetDir = join(repo, "presets", "agent-toolkit-prompt");

/** Every tool name declared in the plugin's source, whether or not its group is switched on. */
function declaredToolNames(dir = __dirname): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) declaredToolNames(path).forEach(name => names.add(name));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      for (const match of readFileSync(path, "utf-8").matchAll(/^\s*name: "([a-z_]+)"/gm)) names.add(match[1]);
    }
  }
  return names;
}

describe("agent-toolkit-prompt preset", () => {
  const prompt = readFileSync(join(presetDir, "system-prompt.md"), "utf-8");

  it("names only tools the plugin has", () => {
    const tools = declaredToolNames();
    // Backticked words with an underscore are tool names; plain words like `cat` and `git` are not.
    const mentioned = [...prompt.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(match => match[1]);
    expect(mentioned.length).toBeGreaterThan(5);
    expect(mentioned.filter(name => !tools.has(name))).toEqual([]);
  });

  it("has a preset.json built from system-prompt.md", () => {
    // Throws, with the command to run, when preset.json is out of date.
    execFileSync(process.execPath, [join(repo, "scripts", "build-preset.mjs"), "--check"], { stdio: "pipe" });
    const preset = JSON.parse(readFileSync(join(presetDir, "preset.json"), "utf-8"));
    expect(preset.operation.fields).toEqual([{ key: "llm.prediction.systemPrompt", value: prompt.replace(/\r\n/g, "\n").trim() }]);
  });

  it("stays short enough for small context windows", () => {
    expect(prompt.split(/\s+/).length).toBeLessThan(500);
  });
});
