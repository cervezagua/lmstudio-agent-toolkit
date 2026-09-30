import { type ChatMessage, type PluginContext, type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics, makeConfigSchematics } from "./config";
import { listModelChoices } from "./shared/models";
import { preprocess } from "./groups/memory/promptPreprocessor";
import { toolsProvider } from "./toolsProvider";

/** The context block is the memory group's job, so it only runs while that group is on. */
async function promptPreprocessor(ctl: PromptPreprocessorController, userMessage: ChatMessage) {
  if (!ctl.getPluginConfig(configSchematics).get("enableMemory")) return userMessage;
  return preprocess(ctl, userMessage);
}

export async function main(context: PluginContext) {
  // LM Studio waits for main() before finishing startup, so the model settings can be built as
  // dropdowns of the downloaded models. If the models cannot be listed they stay text fields.
  const choices = await listModelChoices();
  context.withConfigSchematics(choices ? makeConfigSchematics(choices) : configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);
  context.withPromptPreprocessor(promptPreprocessor);
  context.withToolsProvider(toolsProvider);
}
