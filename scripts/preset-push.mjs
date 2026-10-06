// Publishes a preset to LM Studio Hub from a clean staging copy. Run `lms login` first.
//
// Usage: node scripts/preset-push.mjs <preset-name> --owner <hub-account> [--yes] [--dry-run]
//   --owner     the Hub account or organization to publish under
//   --yes       skip lms prompts (only works once this machine is already paired)
//   --dry-run   stage and show what would be pushed, without contacting the Hub
//
// The Hub accepts exactly two files for a preset, manifest.json and preset.json, and the preset's
// identifier must be "@lmstudio-hub:<owner>/<name>", so both are written into the staging copy.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreset, presetNames } from "./build-preset.mjs";
import { repo, runLms } from "./lib/staging.mjs";

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
};
const assumeYes = flag("--yes");
const dryRun = flag("--dry-run");
const ownerIndex = args.indexOf("--owner");
const owner = ownerIndex === -1 ? undefined : args.splice(ownerIndex, 2)[1];
const name = args[0];

if (!name || !presetNames().includes(name)) {
  console.error(`Unknown preset "${name ?? ""}". Available: ${presetNames().join(", ")}`);
  process.exit(1);
}
if (!owner || owner.startsWith("--")) {
  console.error("Pass --owner <your-hub-account> to publish.");
  process.exit(1);
}

const stageRoot = mkdtempSync(join(tmpdir(), "lms-preset-stage-"));
let ok = false;
try {
  const stage = join(stageRoot, name);
  mkdirSync(stage);
  const manifest = JSON.parse(readFileSync(join(repo, "presets", name, "manifest.json"), "utf-8"));
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ ...manifest, owner }, null, 2) + "\n");
  const preset = JSON.parse(buildPreset(name));
  writeFileSync(join(stage, "preset.json"), JSON.stringify({ ...preset, identifier: `@lmstudio-hub:${owner}/${name}` }, null, 2) + "\n");

  if (dryRun) {
    console.log(`Would push ${owner}/${name}: manifest.json and preset.json.`);
    ok = true;
  } else {
    console.log(`=== Pushing ${owner}/${name}`);
    ok = runLms(["push", ...(assumeYes ? ["--yes"] : [])], stage);
  }
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
