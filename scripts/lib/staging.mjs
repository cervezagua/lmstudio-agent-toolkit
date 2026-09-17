// Shared by install.mjs and hub-push.mjs: stage a clean copy of the plugin (no node_modules, build
// output or tests) that LM Studio can install or publish.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const repo = join(import.meta.dirname, "..", "..");
export const pluginDir = join(repo, "plugin");

/** Copies the plugin to a temporary folder, calls `action(stageDir)`, then cleans up. */
export function withStagedPlugin(action) {
  const stageRoot = mkdtempSync(join(tmpdir(), "lms-plugin-stage-"));
  const stage = join(stageRoot, "agent-toolkit");
  try {
    cpSync(pluginDir, stage, {
      recursive: true,
      filter: source => {
        const base = basename(source);
        return base !== "node_modules" && base !== ".lmstudio" && base !== "dist" && !base.endsWith(".test.ts");
      },
    });
    return action(stage);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

/** Runs the lms CLI in a folder; returns true on success. */
export function runLms(args, cwd) {
  const result = spawnSync("lms", args, { cwd, stdio: "inherit", shell: true, timeout: 600_000 });
  if (result.status !== 0 && result.error) console.error(result.error.message);
  return result.status === 0;
}
