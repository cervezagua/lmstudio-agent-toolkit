import { type PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";

export async function main(context: PluginContext) {
  context.withToolsProvider(toolsProvider);
}
