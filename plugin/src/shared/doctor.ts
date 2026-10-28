import { constants } from "fs";
import { access, stat } from "fs/promises";
import { join } from "path";
import { TOOLKIT_VERSION } from "../version";
import { findExecutable } from "./process";

/** A plugin enabled in the chat, as LM Studio describes it to the plugin. */
export interface EnabledPlugin {
  identifier: string;
  hasPredictionLoopHandler?: boolean;
  hasPromptPreprocessor?: boolean;
  hasToolsProvider?: boolean;
}

/** What /doctor looked at. Anything it could not find out is null, and the report says so. */
export interface DoctorFacts {
  version: string;
  /** The plugins enabled in this chat. */
  plugins: EnabledPlugin[] | null;
  /** The loaded model's context length, in tokens. */
  contextLength: number | null;
  /** Every tool the model is offered, from every enabled plugin. */
  tools: { name: string; plugin?: string }[] | null;
  /** Tokens the tools' definitions take in every prompt. */
  toolTokens: number | null;
  project: { root: string; isSet: boolean; exists: boolean; writable: boolean };
  /** Instruction files found in the project folder (AGENTS.md, say), when the Memory group loads them. */
  instructionFiles: string[] | null;
  /** Programs the enabled groups use: whether each was found, and what is lost without it. */
  programs: {
    name: string;
    found: boolean;
    required: boolean;
    purpose: string;
  }[];
}

/** The five plugins agent-toolkit replaced; enabled beside it, each gives the model a second copy of its tools. */
const REPLACED = ["coder-tools", "memory-tools", "git-tools", "web-tools", "ocr-tools"];
const LOOP_IDENTIFIER = "agent-toolkit-loop";

/**
 * Settles to `fallback` if `start` throws, fails, takes longer than `ms`, or the message is stopped:
 * one slow or broken check must not hold up the report.
 */
async function within<T>(start: () => T | Promise<T>, ms: number, fallback: T, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort = () => {};
  try {
    return await Promise.race([
      Promise.resolve().then(start),
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), ms);
        onAbort = () => resolve(fallback);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** A name from another plugin, as it may appear in a report the model is told to show as it is. */
const safeName = (name: unknown) => String(name).replace(/[^\w./@-]/g, "?").slice(0, 80);

/**
 * Reads what the report needs from LM Studio and this machine. It changes nothing, but measuring the
 * tools starts a tool session, as a reply does: every enabled plugin builds its tools, which can start
 * the MCP servers LM Studio is set up with. Nothing outside LM Studio is contacted.
 */
export async function gatherDoctorFacts(ctl: any, config: { get(key: string): any }, project: { root: string; isSet: boolean }): Promise<DoctorFacts> {
  const signal: AbortSignal | undefined = ctl.abortSignal;
  // Not part of the SDK's public surface, so it may go: the report then says it could not tell.
  const plugins: EnabledPlugin[] | null = Array.isArray(ctl.enabledPluginInfos)
    ? ctl.enabledPluginInfos.filter((p: any) => typeof p?.identifier === "string").map((p: any) => ({ ...p, identifier: safeName(p.identifier) }))
    : null;

  const model: any = await within(() => ctl.tokenSource(), 5000, null, signal);
  const contextLength = await within<number | null>(() => model?.getContextLength?.() ?? null, 5000, null, signal);

  let tools: DoctorFacts["tools"] = null;
  let toolTokens: number | null = null;
  const starting: Promise<any> = Promise.resolve().then(() => ctl.startToolUseSession());
  const session: any = await within(() => starting, 15_000, null, signal);
  // A session that opens after the report gave up on it is closed as soon as it does.
  if (!session) starting.then(late => late?.[Symbol.dispose]?.(), () => {});
  if (session) {
    try {
      const list: any[] = Array.isArray(session.tools) ? session.tools : [];
      tools = list.map(t => ({ name: safeName(t?.name), plugin: t?.pluginIdentifier }));
      const definitions = JSON.stringify(list.map(t => ({ name: t?.name, description: t?.description, parameters: t?.parametersJsonSchema ?? {} })));
      const estimate = Math.ceil(definitions.length / 3.5);
      toolTokens = await within(() => (typeof model?.countTokens === "function" ? model.countTokens(definitions) : estimate), 5000, estimate, signal);
    } finally {
      session[Symbol.dispose]?.();
    }
  }

  const exists = await stat(project.root).then(
    s => s.isDirectory(),
    () => false,
  );
  const writable =
    exists &&
    (await access(project.root, constants.W_OK).then(
      () => true,
      () => false,
    ));

  let instructionFiles: string[] | null = null;
  if (config.get("enableMemory") && exists) {
    instructionFiles = [];
    for (const name of config.get("instructionFiles") as string[]) {
      if (
        await stat(join(project.root, name)).then(
          s => s.isFile(),
          () => false,
        )
      )
        instructionFiles.push(name);
    }
  }

  const programs: DoctorFacts["programs"] = [];
  const need = (name: string, required: boolean, purpose: string, found = findExecutable(name) !== null) => programs.push({ name, found, required, purpose });
  if (config.get("enableFiles")) {
    need("rg", false, "grep is much faster with ripgrep (rg); without it, it searches more slowly in Node");
    if (config.get("allowShell")) {
      const shell = config.get("shell");
      const wanted = shell === "auto" ? (process.platform === "win32" ? ["pwsh", "powershell"] : ["bash", "sh"]) : [shell];
      need(
        wanted[0],
        true,
        "run_command runs commands with it",
        wanted.some(name => findExecutable(name) !== null),
      );
    }
    if (config.get("autoCheckEdits"))
      need("python", false, "edited Python files are checked for syntax errors", findExecutable("python") !== null || findExecutable("python3") !== null);
  }
  if (config.get("enableGit")) {
    need("git", true, "the Git group's tools run it");
    if (config.get("enableGitHub")) need("gh", false, "the gh_* tools need the GitHub CLI, signed in");
  }
  if (config.get("enableWeb")) need("yt-dlp", false, "video transcripts need it");

  return {
    version: TOOLKIT_VERSION,
    plugins,
    contextLength,
    tools,
    toolTokens,
    project: { ...project, exists, writable },
    instructionFiles,
    programs,
  };
}

/**
 * The report, one line per check: ✓ fine, ~ worth knowing, ✗ needs fixing, each with what to do.
 * Most serious first within each part, so the model's "what to fix first" is the first ✗.
 */
export function doctorReport(facts: DoctorFacts): string {
  const lines: string[] = [`agent-toolkit ${facts.version}`];

  // The model and the room the tools take.
  if (facts.contextLength && facts.toolTokens !== null) {
    const share = facts.toolTokens / facts.contextLength;
    const percent = Math.round(share * 100);
    const what = `The ${facts.tools?.length ?? 0} tools' descriptions take about ${facts.toolTokens.toLocaleString("en-US")} tokens of the model's ${facts.contextLength.toLocaleString("en-US")}-token context (${percent}%) on every message.`;
    if (share > 0.5)
      lines.push(
        `✗ ${what} Little is left for the work: switch off the groups you don't need in agent-toolkit's settings, or load the model with a longer context.`,
      );
    else if (share > 0.25) lines.push(`~ ${what} On long tasks that can run short: switch off groups you don't need, or load the model with a longer context.`);
    else lines.push(`✓ ${what}`);
  } else if (facts.contextLength) {
    lines.push(`✓ The model is loaded with a ${facts.contextLength.toLocaleString("en-US")}-token context. (The tools' size could not be measured.)`);
  } else {
    lines.push("~ Could not ask LM Studio about the loaded model, so the context and the tools' size were not checked.");
  }

  // Two plugins offering the same tool: the model sees both, and one of them wins.
  if (facts.tools) {
    const owners = new Map<string, Set<string>>();
    for (const tool of facts.tools) owners.set(tool.name, (owners.get(tool.name) ?? new Set()).add(tool.plugin ?? "?"));
    const doubled = [...owners].filter(([, from]) => from.size > 1).map(([name]) => name);
    if (doubled.length) {
      const shown = doubled.slice(0, 8).join(", ");
      lines.push(
        `✗ ${doubled.length} tools come from two plugins (${shown}${doubled.length > 8 ? ", ..." : ""}): the model gets two copies. Switch one of the plugins off in this chat.`,
      );
    }
  }
  const old = (facts.plugins ?? []).filter(p => REPLACED.some(name => p.identifier.endsWith(`/${name}`) || p.identifier === name));
  if (old.length)
    lines.push(
      `✗ ${old.map(p => p.identifier).join(", ")} ${old.length > 1 ? "are" : "is"} enabled too: agent-toolkit replaces ${old.length > 1 ? "them" : "it"}. Remove ${old.length > 1 ? "them" : "it"} from this chat.`,
    );

  // The reply loop.
  if (facts.plugins) {
    const loops = facts.plugins.filter(p => p.hasPredictionLoopHandler);
    const ours = loops.find(p => p.identifier.endsWith(`/${LOOP_IDENTIFIER}`) || p.identifier === LOOP_IDENTIFIER);
    if (loops.length > 1)
      lines.push(`✗ ${loops.length} plugins want to run the reply (${loops.map(p => p.identifier).join(", ")}): LM Studio uses only one. Keep one on.`);
    else if (ours) lines.push("✓ agent-toolkit-loop runs the reply: long tasks are kept within the context, and /btw works.");
    else if (loops.length === 1) lines.push(`✓ ${loops[0].identifier} runs the reply.`);
    else if (facts.contextLength !== null && facts.contextLength <= 32_768)
      lines.push(
        "~ LM Studio's own loop runs the reply, and the context is small: long tasks may stop when it fills. Enable agent-toolkit-loop in this chat to keep them within it (it also adds /btw).",
      );
    else lines.push("✓ LM Studio's own loop runs the reply. (agent-toolkit-loop would keep long tasks within the context and add /btw.)");
  } else {
    lines.push("~ Could not tell which plugins are enabled in this chat.");
  }

  // The project folder.
  const { project } = facts;
  if (!project.isSet)
    lines.push(
      `~ No Project Folder is set, so this chat has a folder of its own (${project.root}). Set Project Folder in agent-toolkit's settings to work on a project, and so /handoff and /resume find each other.`,
    );
  else if (!project.exists) lines.push(`✗ The Project Folder ${project.root} does not exist. Fix it in agent-toolkit's settings.`);
  else if (!project.writable) lines.push(`✗ The Project Folder ${project.root} cannot be written to, so file edits will fail.`);
  else lines.push(`✓ Project Folder: ${project.root}`);
  if (facts.instructionFiles) {
    lines.push(
      facts.instructionFiles.length
        ? `✓ Instructions loaded at the start of a chat: ${facts.instructionFiles.join(", ")}`
        : "~ No AGENTS.md in the project folder: /init writes one, so the model knows how to build and test the project.",
    );
  }

  // Programs.
  for (const program of facts.programs) {
    if (program.found) lines.push(`✓ ${program.name} found`);
    else lines.push(`${program.required ? "✗" : "~"} ${program.name} not found: ${program.purpose}. Install it, then restart LM Studio.`);
  }
  return lines.join("\n");
}

/** What the preprocessor sends instead of "/doctor": the report, for the model to pass on as it is. */
export function doctorMessage(report: string): string {
  return [
    "The user ran /doctor, agent-toolkit's check of this chat's setup. Do not call any tools.",
    "Show the report below exactly as it is, in a code block. Then, in at most two sentences, say what to fix first (the first line marked ✗, else the first marked ~), or that everything looks fine.",
    "",
    report,
  ].join("\n");
}
