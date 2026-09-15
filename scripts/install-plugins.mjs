// Installs plugins into LM Studio from a clean staging copy (no node_modules, build output, or tests).
// LM Studio installs dependencies itself; handing it a local node_modules makes the install slow and
// it has been seen to hang. Usage: node scripts/install-plugins.mjs [plugin-name ...]  (default: all)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const repo = join(import.meta.dirname, "..");
const pluginsDir = join(repo, "plugins");
const requested = process.argv.slice(2);
const plugins = readdirSync(pluginsDir).filter(
  name => existsSync(join(pluginsDir, name, "manifest.json")) && (requested.length === 0 || requested.includes(name)),
);
if (plugins.length === 0) {
  console.error(`No matching plugins. Available: ${readdirSync(pluginsDir).join(", ")}`);
  process.exit(1);
}

const sync = spawnSync(process.execPath, [join(repo, "scripts", "sync-shared.mjs")], { stdio: "inherit" });
if (sync.status !== 0) process.exit(1);

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
    console.log(`\n=== Installing ${name}`);
    const result = spawnSync("lms", ["dev", "--install", "--yes"], { cwd: stage, stdio: "inherit", shell: true, timeout: 600_000 });
    if (result.status !== 0) {
      failed = true;
      console.error(`Install of ${name} failed${result.error ? `: ${result.error.message}` : ""}.`);
    }
  }
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
