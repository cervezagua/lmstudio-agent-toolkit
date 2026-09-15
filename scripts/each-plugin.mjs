// Runs a command in every plugins/<name> folder, e.g. `node scripts/each-plugin.mjs npm install`.
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/each-plugin.mjs <command> [args...]");
  process.exit(1);
}

const pluginsDir = join(import.meta.dirname, "..", "plugins");
let failed = false;
for (const name of readdirSync(pluginsDir)) {
  const dir = join(pluginsDir, name);
  if (!existsSync(join(dir, "manifest.json"))) continue;
  console.log(`\n=== ${name}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: dir, stdio: "inherit", shell: true });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
