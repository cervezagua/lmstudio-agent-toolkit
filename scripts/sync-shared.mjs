// Copies shared/*.ts (except tests) into every plugins/<name>/src/shared/ folder.
// Each plugin must be self-contained so `lms push` / `lms dev --install` can package it on its own.
// Usage: node scripts/sync-shared.mjs [--check]   (--check exits 1 if any copy is stale)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const sharedDir = join(repo, "shared");
const pluginsDir = join(repo, "plugins");
const check = process.argv.includes("--check");
const header = "// GENERATED: copied from /shared by scripts/sync-shared.mjs. Edit the original there.\n";

const sources = readdirSync(sharedDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
let stale = [];

for (const plugin of readdirSync(pluginsDir)) {
  const pluginDir = join(pluginsDir, plugin);
  if (!existsSync(join(pluginDir, "manifest.json"))) continue;
  const target = join(pluginDir, "src", "shared");
  mkdirSync(target, { recursive: true });
  for (const file of sources) {
    const expected = header + readFileSync(join(sharedDir, file), "utf-8");
    const destination = join(target, file);
    const actual = existsSync(destination) ? readFileSync(destination, "utf-8") : null;
    if (actual === expected) continue;
    if (check) stale.push(`${plugin}/src/shared/${file}`);
    else writeFileSync(destination, expected);
  }
}

if (check && stale.length > 0) {
  console.error(`Stale shared copies (run npm run sync-shared):\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
console.log(check ? "Shared copies are up to date." : `Synced ${sources.length} shared files.`);
