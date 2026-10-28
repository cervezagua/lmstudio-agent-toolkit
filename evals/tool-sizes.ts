// Prints how big each tool's definition is, as the model sees it on every message, with every group on.
//
// Usage: npx tsx evals/tool-sizes.ts
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigSchematics, makeConfigSchematics } from "../plugin/src/config";
import { fakeController } from "../plugin/src/shared/testing/fake-controller";
import { toolsProvider } from "../plugin/src/toolsProvider";

const pluginRequire = createRequire(join(__dirname, "..", "plugin", "package.json"));
const sdk = pluginRequire("@lmstudio/sdk");
const { zodToJsonSchema } = createRequire(pluginRequire.resolve("@lmstudio/sdk"))("zod-to-json-schema");

const defaults = (schematics: any) =>
  Object.fromEntries([...schematics.fields.entries()].map(([key, field]: [string, any]) => [key, field.defaultValue]));

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "tool-sizes-"));
  const base = defaults(makeConfigSchematics());
  // Every switch whose name says it turns something on.
  const everything = Object.fromEntries(Object.keys(base).filter(k => /^(enable|allow)/.test(k)).map(k => [k, true]));
  const config = { ...base, projectFolder: dir, ...everything };
  const globalConfig = { ...defaults(globalConfigSchematics), memoryDirectory: dir, skillsDirectory: dir };
  const ctl = fakeController({ config, globalConfig, workingDirectory: dir, history: sdk.Chat.empty() });
  const tools: any[] = await toolsProvider(ctl);
  const rows = tools.map(t => {
    const parameters = t.parametersJsonSchema ?? (t.parametersSchema ? zodToJsonSchema(t.parametersSchema) : {});
    const json = JSON.stringify({ name: t.name, description: t.description, parameters });
    return { name: t.name, description: t.description.length, total: json.length };
  });
  rows.sort((a, b) => b.total - a.total);
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  console.log(`${rows.length} tools, ${total} characters (about ${Math.round(total / 3.5)} tokens)\n`);
  for (const r of rows) console.log(`${String(r.total).padStart(6)}  ${String(r.description).padStart(5)}  ${r.name}`);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

main();
