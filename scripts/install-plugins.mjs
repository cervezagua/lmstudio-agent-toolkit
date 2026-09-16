// Installs plugins into LM Studio from a clean staging copy (no node_modules, build output, or tests).
// LM Studio installs dependencies itself; handing it a local node_modules makes the install slow and
// it has been seen to hang. Usage: node scripts/install-plugins.mjs [plugin-name ...]  (default: all)
import { runLms, selectPlugins, syncShared, withStagedPlugins } from "./lib/staging.mjs";

const plugins = selectPlugins(process.argv.slice(2));
syncShared();

const ok = withStagedPlugins(plugins, (name, stage) => {
  console.log(`\n=== Installing ${name}`);
  const success = runLms(["dev", "--install", "--yes"], stage);
  if (!success) console.error(`Install of ${name} failed.`);
  return success;
});
process.exit(ok ? 0 : 1);
