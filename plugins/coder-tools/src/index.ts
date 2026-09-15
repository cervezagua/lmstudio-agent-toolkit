import { type PluginContext } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider } from "./toolsProvider";

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withToolsProvider(toolsProvider);
}
