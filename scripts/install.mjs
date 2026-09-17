// Installs the plugin into LM Studio from a clean staging copy (no node_modules, build output, or
// tests). LM Studio installs dependencies itself; handing it a local node_modules makes the install
// slow and it has been seen to hang. Usage: node scripts/install.mjs
import { runLms, withStagedPlugin } from "./lib/staging.mjs";

console.log("=== Installing agent-toolkit");
const ok = withStagedPlugin(stage => runLms(["dev", "--install", "--yes"], stage));
if (!ok) console.error("Install failed.");
process.exit(ok ? 0 : 1);
