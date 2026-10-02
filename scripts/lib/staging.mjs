// Shared by install.mjs and hub-push.mjs: stage a clean copy of a plugin (no node_modules, build
// output or tests) that LM Studio can install or publish.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { standalonePlugins, syncStandalone } from "../sync-standalone.mjs";

export const repo = join(import.meta.dirname, "..", "..");
export const pluginDir = join(repo, "plugin");

/** agent-toolkit lives in plugin/; the standalone plugins in standalone/<name>/. */
export function pluginNames() {
  return ["agent-toolkit", ...standalonePlugins()];
}

export function pluginPath(name) {
  return name === "agent-toolkit" ? pluginDir : join(repo, "standalone", name);
}

/** Checks a requested plugin name, exiting with the list of valid ones if it is not one of them. */
export function resolvePlugin(name = "agent-toolkit") {
  if (!pluginNames().includes(name) || !existsSync(pluginPath(name))) {
    console.error(`Unknown plugin "${name}". Available: ${pluginNames().join(", ")}`);
    process.exit(1);
  }
  return name;
}

/**
 * Copies the plugin to a temporary folder, calls `action(stageDir)`, then cleans up. A standalone
 * plugin first gets fresh copies of the agent-toolkit files it is built from.
 */
export function withStagedPlugin(name, action) {
  if (name !== "agent-toolkit") syncStandalone(name);
  const stageRoot = mkdtempSync(join(tmpdir(), "lms-plugin-stage-"));
  const stage = join(stageRoot, name);
  try {
    cpSync(pluginPath(name), stage, {
      recursive: true,
      filter: source => {
        const base = basename(source);
        return (
          base !== "node_modules" &&
          base !== ".lmstudio" &&
          base !== "dist" &&
          base !== "files.json" &&
          !base.endsWith(".test.ts")
        );
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
