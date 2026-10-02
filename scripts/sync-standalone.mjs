// Copies the source files each standalone plugin needs from agent-toolkit (plugin/src) into the
// standalone plugin's own src/, at the same relative paths so their imports work unchanged.
// LM Studio installs each plugin folder on its own, so a standalone plugin cannot import from
// plugin/ directly; this keeps one copy of the code to edit. The copies are gitignored.
//
// Usage: node scripts/sync-standalone.mjs [plugin-name ...]   (default: all)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const repo = join(import.meta.dirname, "..");
const source = join(repo, "plugin", "src");
const standaloneDir = join(repo, "standalone");

export function standalonePlugins() {
  return existsSync(standaloneDir)
    ? readdirSync(standaloneDir).filter(name => existsSync(join(standaloneDir, name, "files.json")))
    : [];
}

/** Copies one plugin's listed files. Throws, naming the file, if one no longer exists in plugin/src. */
export function syncStandalone(name) {
  const { files } = JSON.parse(readFileSync(join(standaloneDir, name, "files.json"), "utf-8"));
  for (const file of files) {
    const from = join(source, file);
    if (!existsSync(from)) throw new Error(`standalone/${name}/files.json lists ${file}, which is not in plugin/src.`);
    const to = join(standaloneDir, name, "src", file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return files.length;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const wanted = process.argv.slice(2);
  const all = standalonePlugins();
  const unknown = wanted.filter(name => !all.includes(name));
  if (unknown.length) {
    console.error(`Unknown standalone plugin(s): ${unknown.join(", ")}. Available: ${all.join(", ")}`);
    process.exit(1);
  }
  for (const name of wanted.length ? wanted : all) {
    try {
      console.log(`Synced ${syncStandalone(name)} files into standalone/${name}.`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
}
