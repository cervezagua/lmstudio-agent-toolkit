import { type ChatMessage, type PluginContext, type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics, makeConfigSchematics } from "./config";
import { attachmentContext, composeMessage } from "./shared/attachments";
import { listModelChoices } from "./shared/models";
import { memoryContext, triggeredSkillContext } from "./groups/memory/promptPreprocessor";
import { toolsProvider } from "./toolsProvider";

/** About how much text the chat holds already, so attached files leave room for the rest. */
async function historyChars(ctl: PromptPreprocessorController): Promise<number> {
  try {
    const history = await ctl.pullHistory();
    return history.getMessagesArray().reduce((sum, message) => sum + message.getText().length, 0);
  } catch {
    return 0;
  }
}

/**
 * Everything the plugin adds to a message, put in front of the user's own words with a clear line
 * between them: the Memory group's context block, and the text of any file the user attached.
 */
export async function promptPreprocessor(ctl: PromptPreprocessorController, userMessage: ChatMessage) {
  const config = ctl.getPluginConfig(configSchematics);
  const added: string[] = [];
  // The context block is the Memory group's job, so it only comes while that group is on.
  if (config.get("enableMemory")) {
    const block = await memoryContext(ctl);
    if (block) added.push(block);
    const skills = await triggeredSkillContext(ctl, userMessage.getText()).catch(() => null);
    if (skills) added.push(skills);
  }
  if (config.get("readAttachments")) {
    try {
      const attached = await attachmentContext(ctl as any, userMessage as any, {
        maxChars: config.get("maxAttachmentChars"),
        usedChars: (await historyChars(ctl)) + added.reduce((sum, block) => sum + block.length, 0),
        documentTools: config.get("enableDocuments"),
        fileTools: config.get("enableFiles"),
      });
      if (attached) added.push(attached);
    } catch (error: any) {
      // Never a reason to fail the user's message: it goes on without the file's text, and they are told.
      if (ctl.abortSignal.aborted) throw error;
      ctl.createStatus({ status: "error", text: `agent-toolkit could not read the attached files: ${String(error?.message ?? error)}` });
    }
  }
  if (added.length === 0) return userMessage;
  // replaceText keeps whatever files are left on the message (images, for a model that can see).
  userMessage.replaceText(composeMessage(added, userMessage.getText()));
  return userMessage;
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
