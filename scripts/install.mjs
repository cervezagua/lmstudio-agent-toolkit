// Installs a plugin into LM Studio from a clean staging copy (no node_modules, build output, or
// tests). LM Studio installs dependencies itself; handing it a local node_modules makes the install
// slow and it has been seen to hang.
//
// Usage: node scripts/install.mjs [plugin-name]   (default: agent-toolkit; "all" installs every one)
import { pluginNames, resolvePlugin, runLms, withStagedPlugin } from "./lib/staging.mjs";

const requested = process.argv[2];
const names = requested === "all" ? pluginNames() : [resolvePlugin(requested)];

let ok = true;
for (const name of names) {
  console.log(`=== Installing ${name}`);
  if (!withStagedPlugin(name, stage => runLms(["dev", "--install", "--yes"], stage))) {
    console.error(`Install of ${name} failed.`);
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
