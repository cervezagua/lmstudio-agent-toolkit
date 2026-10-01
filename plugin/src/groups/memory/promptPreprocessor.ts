import { type ChatMessage, type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics } from "../../config";
import { buildContextBlock, loadInstructionFiles } from "./lib/instructions";
import { defaultMemoryDirectory, INDEX_FILE, MemoryStore } from "./lib/memoryStore";
import { gitSnapshot } from "./lib/gitSnapshot";
import { defaultSkillsDirectory, listSkills, partitionSkills, renderSkillList } from "./lib/skills";
import { describeFinding, locateFinding, scanForInjection } from "../../shared/injectionScan";
import { PLANNING_NOTE, readMode } from "../../shared/mode";
import { projectRoot } from "../../shared/projectFolder";

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

  const { root: projectFolder } = projectRoot(config.get("projectFolder"), () => ctl.getWorkingDirectory());
  const scan = config.get("scanLoadedFiles");
  // What the model is told (where and why, never the text) and what the user is shown (with the text).
  const withheld: string[] = [];
  const notices: string[] = [];
  // An instruction file is text the model is told to follow, and in a cloned repository it is
  // someone else's text. One that looks written to steer the model is left out, and said so.
  const instructions = (await loadInstructionFiles(projectFolder, config.get("instructionFiles"))).filter(file => {
    const [finding] = scan ? scanForInjection(file.content) : [];
    if (!finding) return true;
    withheld.push(`${file.name}: ${locateFinding(finding)}`);
    notices.push(`${file.name}: ${describeFinding(finding)}`);
    return false;
  });

  let memoryIndex: string | null = null;
  if (config.get("injectMemoryIndex")) {
    const store = new MemoryStore(defaultMemoryDirectory(ctl.getGlobalPluginConfig(globalConfigSchematics).get("memoryDirectory")));
    const memories = await store.list();
    if (memories.length > 0) memoryIndex = await store.rebuildIndex();
  }

  let skillList: string | null = null;
  if (config.get("enableSkills")) {
    const all = await listSkills(defaultSkillsDirectory(ctl.getGlobalPluginConfig(globalConfigSchematics).get("skillsDirectory")));
    const { safe: skills, flagged } = scan ? await partitionSkills(all) : { safe: all, flagged: [] };
    for (const { skill, finding } of flagged) {
      withheld.push(`skill "${skill.name}": ${locateFinding(finding)}`);
      notices.push(`skill "${skill.name}": ${describeFinding(finding)}`);
    }
    if (skills.length > 0) skillList = renderSkillList(skills);
  }

  const snapshot = config.get("injectGitSnapshot") ? await gitSnapshot(projectFolder, ctl.abortSignal) : null;

  const block = buildContextBlock({
    projectFolder,
    instructions,
    memoryIndex,
    skillList,
    gitSnapshot: snapshot,
    withheld,
    maxChars: config.get("maxInjectedChars"),
  });
  for (const notice of notices) ctl.createStatus({ status: "error", text: `agent-toolkit did not load ${notice}` });
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
