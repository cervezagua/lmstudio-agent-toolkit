import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";

/** Every source file under plugin/src that is not a test, as a path relative to it with forward slashes. */
function sourceFiles(directory = __dirname): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|mjs)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [relative(__dirname, path).replace(/\\/g, "/")];
  });
}

describe("conventions from AGENTS.md", () => {
  it("spawns commands with commandEnv(), never with a copy of process.env", () => {
    // The plugin host's environment is not a terminal's: opened from the Dock on macOS it has no
    // Homebrew folders on PATH, and on Windows it can come without PATHEXT. commandEnv() puts those
    // back. A command given `{ ...process.env }` instead is looked for, and runs, without them: a
    // checker that was found a moment ago "is not installed", and git cannot find git-lfs or a hook's
    // node. Only commandEnv itself, in shared/process.ts, may copy process.env.
    const copies = sourceFiles()
      .filter(file => file !== "shared/process.ts")
      .filter(file => /\.\.\.\s*process\.env\b/.test(readFileSync(join(__dirname, file), "utf-8")));
    expect(copies).toEqual([]);
  });
});
