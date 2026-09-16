import { type ChatMessage, type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics } from "./config";
import { buildContextBlock, loadInstructionFiles } from "./lib/instructions";
import { defaultMemoryDirectory, INDEX_FILE, MemoryStore } from "./lib/memoryStore";
import { gitSnapshot } from "./lib/gitSnapshot";
import { defaultSkillsDirectory, listSkills, renderSkillList } from "./lib/skills";
import { PLANNING_NOTE, readMode } from "./shared/mode";

/**
 * On the first user message of a chat, prepends project instructions (AGENTS.md etc.) and the
 * saved-memory index. Later messages pass through untouched, so the context is added only once.
 */
export async function preprocess(ctl: PromptPreprocessorController, userMessage: ChatMessage) {
  const history = await ctl.pullHistory();
  const hasEarlierUserMessage = history.getMessagesArray().some(message => message.getRole() === "user");
  const config = ctl.getPluginConfig(configSchematics);

  if (hasEarlierUserMessage) {
    // Later in a chat, the only thing worth repeating is that planning mode is still on.
    if (config.get("enablePlanMode") && (await readMode(ctl.getWorkingDirectory())).planning) {
      userMessage.replaceText(`<context source="memory-tools">${PLANNING_NOTE}</context>\n\n${userMessage.getText()}`);
    }
    return userMessage;
  }

  const projectDirectory = config.get("projectDirectory").trim() || ctl.getWorkingDirectory();
  const instructions = await loadInstructionFiles(projectDirectory, config.get("instructionFiles"));

  let memoryIndex: string | null = null;
  if (config.get("injectMemoryIndex")) {
    const store = new MemoryStore(defaultMemoryDirectory(ctl.getGlobalPluginConfig(globalConfigSchematics).get("memoryDirectory")));
    const memories = await store.list();
    if (memories.length > 0) memoryIndex = await store.rebuildIndex();
  }

  let skillList: string | null = null;
  if (config.get("enableSkills")) {
    const skills = await listSkills(defaultSkillsDirectory(ctl.getGlobalPluginConfig(globalConfigSchematics).get("skillsDirectory")));
    if (skills.length > 0) skillList = renderSkillList(skills);
  }

  const snapshot = config.get("injectGitSnapshot") ? await gitSnapshot(projectDirectory, ctl.abortSignal) : null;

  const block = buildContextBlock({
    projectDirectory,
    instructions,
    memoryIndex,
    skillList,
    gitSnapshot: snapshot,
    maxChars: config.get("maxInjectedChars"),
  });
  if (!block) return userMessage;

  const loaded = [
    ...instructions.map(i => i.name),
    ...(memoryIndex ? [INDEX_FILE] : []),
    ...(skillList ? ["skills"] : []),
    ...(snapshot ? ["git status"] : []),
  ];
  ctl.createStatus({ status: "done", text: `memory-tools loaded ${loaded.join(", ")}` });
  // replaceText keeps attached files/images on the message.
  userMessage.replaceText(`${block}\n\n${userMessage.getText()}`);
  return userMessage;
}
