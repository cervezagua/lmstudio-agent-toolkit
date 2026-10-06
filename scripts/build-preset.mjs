// Writes presets/<name>/preset.json from the system-prompt.md beside it, so the prompt is edited as
// markdown and never by hand inside a JSON string.
//
// Usage: node scripts/build-preset.mjs [--check]   (--check fails if preset.json is out of date)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const presetsDir = join(import.meta.dirname, "..", "presets");

export function presetNames() {
  return existsSync(presetsDir) ? readdirSync(presetsDir).filter(name => existsSync(join(presetsDir, name, "system-prompt.md"))) : [];
}

export function buildPreset(name) {
  const systemPrompt = readFileSync(join(presetsDir, name, "system-prompt.md"), "utf-8").replace(/\r\n/g, "\n").trim();
  const preset = {
    identifier: name,
    name,
    operation: { fields: [{ key: "llm.prediction.systemPrompt", value: systemPrompt }] },
    load: { fields: [] },
  };
  return JSON.stringify(preset, null, 2) + "\n";
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const check = process.argv.includes("--check");
  for (const name of presetNames()) {
    const file = join(presetsDir, name, "preset.json");
    const built = buildPreset(name);
    if (!check) {
      writeFileSync(file, built);
      console.log(`Wrote presets/${name}/preset.json.`);
    } else if (!existsSync(file) || readFileSync(file, "utf-8").replace(/\r\n/g, "\n") !== built) {
      console.error(`presets/${name}/preset.json is out of date. Run: node scripts/build-preset.mjs`);
      process.exit(1);
    }
  }
}
