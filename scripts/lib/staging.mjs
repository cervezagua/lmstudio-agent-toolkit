// Shared by install-plugins.mjs and hub-push.mjs: pick plugins, sync shared files, and stage clean
// copies (no node_modules, build output or tests) that LM Studio can install or publish.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const repo = join(import.meta.dirname, "..", "..");
const pluginsDir = join(repo, "plugins");

/** All plugin folders, or only the requested ones; exits with a message if none match. */
export function selectPlugins(requested) {
  const all = readdirSync(pluginsDir).filter(name => existsSync(join(pluginsDir, name, "manifest.json")));
  const plugins = requested.length === 0 ? all : all.filter(name => requested.includes(name));
  const unknown = requested.filter(name => !all.includes(name));
  if (unknown.length > 0 || plugins.length === 0) {
    console.error(`Unknown plugin(s): ${unknown.join(", ") || "(none given)"}. Available: ${all.join(", ")}`);
    process.exit(1);
  }
  return plugins;
}

export function syncShared() {
  const result = spawnSync(process.execPath, [join(repo, "scripts", "sync-shared.mjs")], { stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
}

/** Copies each plugin to a temporary folder, calls `action(name, stageDir)`, then cleans up. */
export function withStagedPlugins(plugins, action) {
  const stageRoot = mkdtempSync(join(tmpdir(), "lms-plugin-stage-"));
  let failed = false;
  try {
    for (const name of plugins) {
      const stage = join(stageRoot, name);
      cpSync(join(pluginsDir, name), stage, {
        recursive: true,
        filter: source => {
          const base = basename(source);
          return base !== "node_modules" && base !== ".lmstudio" && !base.endsWith(".test.ts");
        },
      });
      if (!action(name, stage)) failed = true;
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  return !failed;
}

/** Runs the lms CLI in a folder; returns true on success. */
export function runLms(args, cwd) {
  const result = spawnSync("lms", args, { cwd, stdio: "inherit", shell: true, timeout: 600_000 });
  if (result.status !== 0 && result.error) console.error(result.error.message);
  return result.status === 0;
}
