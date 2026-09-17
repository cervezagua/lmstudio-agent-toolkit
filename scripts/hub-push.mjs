// Publishes the plugin to LM Studio Hub from a clean staging copy. Run `lms login` first.
//
// Usage: node scripts/hub-push.mjs [--private] [--owner <hub-account>] [--dry-run]
//   --private   publish as private (only takes effect the first time it is pushed)
//   --owner     publish under this Hub account or organization instead of the manifest's owner
//   --yes       skip lms prompts (only works once this machine is already paired)
//   --dry-run   stage and show what would be pushed, without contacting the Hub
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLms, withStagedPlugin } from "./lib/staging.mjs";

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
};
const option = name => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = args.splice(index, 2);
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a value.`);
    process.exit(1);
  }
  return value;
};

const isPrivate = flag("--private");
const assumeYes = flag("--yes");
const dryRun = flag("--dry-run");
const owner = option("--owner");

const ok = withStagedPlugin(stage => {
  const manifestPath = join(stage, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (owner) {
    manifest.owner = owner;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  if (manifest.owner === "local") {
    console.error(`\nmanifest owner is "local". Pass --owner <your-hub-account> to publish.`);
    return false;
  }
  const target = `${manifest.owner}/${manifest.name}${isPrivate ? " (private)" : ""}`;
  if (dryRun) {
    console.log(`\n=== Would push ${target} from a clean copy of plugin/`);
    return true;
  }
  console.log(`\n=== Pushing ${target}`);
  // Without --yes, lms can show its pairing prompt the first time this machine publishes.
  return runLms(["push", ...(assumeYes ? ["--yes"] : []), ...(isPrivate ? ["--private"] : [])], stage);
});
process.exit(ok ? 0 : 1);
