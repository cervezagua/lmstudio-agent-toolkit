import { type ChatMessage, type PluginContext, type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics } from "./config";
import { preprocess } from "./groups/memory/promptPreprocessor";
import { toolsProvider } from "./toolsProvider";

/** The context block is the memory group's job, so it only runs while that group is on. */
async function promptPreprocessor(ctl: PromptPreprocessorController, userMessage: ChatMessage) {
  if (!ctl.getPluginConfig(configSchematics).get("enableMemory")) return userMessage;
  return preprocess(ctl, userMessage);
}

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);
  context.withPromptPreprocessor(promptPreprocessor);
  context.withToolsProvider(toolsProvider);
}
