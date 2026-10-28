import { type ChatMessage, type PluginContext, type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics, makeConfigSchematics } from "./config";
import { attachmentContext, composeMessage } from "./shared/attachments";
import { listModelChoices } from "./shared/models";
import { allCommands, expandCommand } from "./shared/commands";
import { rewindCommand, startTurn } from "./shared/checkpoints";
import { resumeCommand } from "./shared/handoff";
import { projectRoot } from "./shared/projectFolder";
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
  // A side question belongs to agent-toolkit-loop, which recognises it by its first word and keeps it
  // out of the conversation; anything added here would hide that word and spend context on it.
  if (/^\s*\/btw\b/i.test(userMessage.getText())) return userMessage;

  let userText = userMessage.getText();
  const { root } = projectRoot(config.get("projectFolder"), () => ctl.getWorkingDirectory());

  // Each message is a turn the file tools keep checkpoints for; /rewind lists or restores them.
  if (config.get("enableFiles") && config.get("enableCheckpoints")) {
    const rewind = /^\s*\/rewind\b\s*(\S*)/i.exec(userText);
    if (rewind) {
      userText = await rewindCommand(ctl.getWorkingDirectory(), rewind[1].toLowerCase(), root);
      // A turn of its own, so anything changed while replying is not filed under a turn just undone.
      await startTurn(ctl.getWorkingDirectory(), `/rewind ${rewind[1]}`.trim()).catch(() => {});
      ctl.createStatus({ status: "done", text: rewind[1] && rewind[1] !== "list" ? `agent-toolkit ran /rewind ${rewind[1]}` : "agent-toolkit listed the checkpoints" });
    } else {
      await startTurn(ctl.getWorkingDirectory(), userText).catch(() => {});
    }
  }

  // /resume carries on from the note /handoff saved in an earlier chat.
  const resume = config.get("enableCommands") ? /^\s*\/resume\b\s*([\s\S]*)$/i.exec(userText) : null;
  if (resume) {
    const outcome = await resumeCommand(root, resume[1].trim(), { scan: config.get("scanLoadedFiles"), redact: config.get("redactSecrets") });
    userText = outcome.text;
    ctl.createStatus({ status: outcome.ok ? "done" : "error", text: outcome.status });
  } else if (config.get("enableCommands")) {
    const outcome = expandCommand(userText, await allCommands(root), { scan: config.get("scanLoadedFiles") });
    if (outcome.kind === "expanded") {
      userText = outcome.text;
      ctl.createStatus({ status: "done", text: `agent-toolkit ran /${outcome.name}${outcome.source ? ` ${outcome.source}` : ""}` });
    } else if (outcome.kind === "refused") {
      ctl.createStatus({ status: "error", text: `agent-toolkit did not run /${outcome.name}: ${outcome.reason}` });
    }
  }

  const added: string[] = [];
  // The context block is the Memory group's job, so it only comes while that group is on.
  if (config.get("enableMemory")) {
    const block = await memoryContext(ctl);
    if (block) added.push(block);
    const skills = await triggeredSkillContext(ctl, userText).catch(() => null);
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
  if (added.length === 0 && userText === userMessage.getText()) return userMessage;
  // replaceText keeps whatever files are left on the message (images, for a model that can see).
  userMessage.replaceText(added.length ? composeMessage(added, userText) : userText);
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
