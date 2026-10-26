import { type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics } from "../../config";
import { buildContextBlock, loadInstructionFiles } from "./lib/instructions";
import { defaultMemoryDirectory, INDEX_FILE, MemoryStore } from "./lib/memoryStore";
import { gitSnapshot } from "./lib/gitSnapshot";
import { readFile } from "fs/promises";
import { defaultSkillsDirectory, listSkills, MAX_SKILL_CHARS, partitionSkills, renderSkillList, triggeredSkills } from "./lib/skills";
import { fenced, shownName } from "../../shared/attachments";
import { describeFinding, locateFinding, scanForInjection } from "../../shared/injectionScan";
import { PLANNING_NOTE, readMode } from "../../shared/mode";
import { describeRedaction, redactSecrets } from "../../shared/redact";
import { projectRoot } from "../../shared/projectFolder";

/**
 * What the Memory group adds to a message, or null. On the first user message of a chat: project
 * instructions (AGENTS.md etc.), the saved-memory index, skills and the git snapshot, so the context
 * is added only once. On later ones only a reminder while planning mode is on. The plugin's prompt
 * preprocessor (src/index.ts) puts it in front of the user's words, with anything else it adds.
 */
export async function memoryContext(ctl: PromptPreprocessorController): Promise<string | null> {
  const history = await ctl.pullHistory();
  const hasEarlierUserMessage = history.getMessagesArray().some(message => message.getRole() === "user");
  const config = ctl.getPluginConfig(configSchematics);

  if (hasEarlierUserMessage) {
    // Later in a chat, the only thing worth repeating is that planning mode is still on.
    if (config.get("enablePlanMode") && (await readMode(ctl.getWorkingDirectory())).planning) {
      return `<context source="agent-toolkit">${PLANNING_NOTE}</context>`;
    }
    return null;
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

  const built = buildContextBlock({
    projectFolder,
    instructions,
    memoryIndex,
    skillList,
    gitSnapshot: snapshot,
    withheld,
    maxChars: config.get("maxInjectedChars"),
  });
  for (const notice of notices) ctl.createStatus({ status: "error", text: `agent-toolkit did not load ${notice}` });
  if (!built) return null;

  // The same protection the tools have: a key pasted into AGENTS.md or a memory reaches the model as
  // a marker. Only the loaded context is touched, never the user's own message or the files.
  let block = built;
  if (config.get("redactSecrets")) {
    const hidden = redactSecrets(built);
    block = hidden.text;
    if (hidden.count > 0) {
      ctl.createStatus({
        status: "error",
        text: `agent-toolkit hid ${describeRedaction(hidden)} from the model in the loaded files`,
      });
    }
  }

  const loaded = [
    ...instructions.map(i => i.name),
    ...(memoryIndex ? [INDEX_FILE] : []),
    ...(skillList ? ["skills"] : []),
    ...(snapshot ? ["git status"] : []),
  ];
  ctl.createStatus({ status: "done", text: `agent-toolkit loaded ${loaded.join(", ")}` });
  return block;
}

/**
 * The full text of each skill whose `triggers:` appear in the user's message, on any message of the
 * chat, unless the chat already has it. Small models rarely decide to load a skill themselves; a
 * keyword they cannot miss. The skill is someone's text the model is told to follow, so it gets the
 * same scan and redaction as AGENTS.md.
 */
export async function triggeredSkillContext(ctl: PromptPreprocessorController, userText: string): Promise<string | null> {
  const config = ctl.getPluginConfig(configSchematics);
  if (!config.get("enableSkills")) return null;
  const all = await listSkills(defaultSkillsDirectory(ctl.getGlobalPluginConfig(globalConfigSchematics).get("skillsDirectory")));
  const matches = triggeredSkills(all, userText);
  if (matches.length === 0) return null;

  const earlier = (await ctl.pullHistory()).getMessagesArray().map(message => message.getText()).join("\n");
  const blocks: string[] = [];
  for (const { skill, trigger } of matches) {
    const name = shownName(skill.name);
    if (earlier.includes(`<skill name="${name}"`)) continue;
    const text = (await readFile(skill.file, "utf-8").catch(() => ""))
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
      .trim()
      .slice(0, MAX_SKILL_CHARS);
    if (!text) continue;
    const [finding] = config.get("scanLoadedFiles") ? scanForInjection(text) : [];
    if (finding) {
      ctl.createStatus({ status: "error", text: `agent-toolkit did not load skill "${name}": ${describeFinding(finding)}` });
      continue;
    }
    const body = config.get("redactSecrets") ? redactSecrets(text).text : text;
    blocks.push(`<skill name="${name}" loaded-because="your message mentions ${shownName(trigger)}">\n${fenced(body)}\n</skill>`);
  }
  if (blocks.length === 0) return null;
  ctl.createStatus({ status: "done", text: `agent-toolkit loaded the skill${blocks.length > 1 ? "s" : ""} ${matches.map(m => m.skill.name).join(", ")}` });
  return `<context source="agent-toolkit">Skills that match the user's message. Follow them where they apply.\n${blocks.join("\n")}\n</context>`;
}
