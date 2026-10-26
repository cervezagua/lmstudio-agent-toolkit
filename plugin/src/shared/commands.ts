import { readdir, readFile } from "fs/promises";
import { basename, join } from "path";
import { scanForInjection, describeFinding } from "./injectionScan";

/** Where a project keeps its own commands: one Markdown file each, named after the command. */
export const COMMANDS_FOLDER = join(".agent-toolkit", "commands");

/** A message that starts with `/name`, optionally followed by arguments. */
const COMMAND = /^\s*\/([a-z][a-z0-9-]{0,40})(?:\s+([\s\S]*))?$/i;

export interface Command {
  name: string;
  description: string;
  /** The instructions; $ARGUMENTS is replaced with what the user typed after the name. */
  body: string;
  builtIn: boolean;
}

/**
 * Commands that come with the toolkit. They name the toolkit's tools but say what to do if a group is
 * off, because a command must not fail just because the user switched git tools off.
 */
export const BUILT_IN_COMMANDS: Command[] = [
  {
    name: "review",
    description: "Review the uncommitted changes for bugs, security problems and missing tests.",
    builtIn: true,
    body: [
      "Review the uncommitted changes in this project. Do not change any files.",
      "1. See what changed with git_status and git_diff (or run `git diff` with run_command if the git tools are off).",
      "2. Read the surrounding code wherever a change depends on it.",
      "3. Look for: bugs and unhandled edge cases, errors that are swallowed, security problems (secrets, injection, unsafe paths), missing or broken tests, and code that breaks the project's own conventions.",
      "4. Report what you found, most serious first, each with the file and line, what is wrong, and a fix. If you found nothing worth fixing, say so plainly.",
      "$ARGUMENTS",
    ].join("\n"),
  },
  {
    name: "init",
    description: "Write (or improve) an AGENTS.md that tells agents how to work in this project.",
    builtIn: true,
    body: [
      "Write an AGENTS.md for this project, for coding agents and new contributors.",
      "1. Explore first: list the folders, and read the README, the package or build files (package.json, pyproject.toml, Cargo.toml, Makefile) and any CI configuration.",
      "2. Find the exact commands to install, build, test and lint. Run the quick ones to check they work.",
      "3. Write AGENTS.md, under 60 lines: what the project is, those commands, the main folders, conventions visible in the code, and anything not to touch.",
      "If AGENTS.md already exists, read it and improve it rather than replacing it.",
      "$ARGUMENTS",
    ].join("\n"),
  },
  {
    name: "commit",
    description: "Commit the current changes with a clear message (never pushes).",
    builtIn: true,
    body: [
      "Commit the current changes.",
      "1. Look at git_status and git_diff.",
      "2. Commit only changes that belong together. Leave out secrets, build output and anything unrelated; if you are unsure about a file, ask before committing it.",
      "3. Write the message in the imperative, with a subject of at most 72 characters that says what the change does, and a short body saying why if it is not obvious.",
      "4. Commit with git_commit (or `git commit` with run_command if the git tools are off). Do not push.",
      "$ARGUMENTS",
    ].join("\n"),
  },
  {
    name: "test",
    description: "Run the tests, and fix the code until they pass.",
    builtIn: true,
    body: [
      "Run this project's tests and make them pass.",
      "1. Find the test command (package.json, pyproject.toml, Makefile, AGENTS.md) and run it.",
      "2. For each failure, find the cause and fix the code. Change a test only if the test itself is wrong, and say so when you do.",
      "3. Run the tests again until they pass, or until you are blocked; then report what you changed and what still fails.",
      "$ARGUMENTS",
    ].join("\n"),
  },
];

/** The project's own commands, from <project>/.agent-toolkit/commands/*.md. A missing folder is none. */
export async function projectCommands(projectFolder: string): Promise<Command[]> {
  const folder = join(projectFolder, COMMANDS_FOLDER);
  const names = await readdir(folder).catch(() => [] as string[]);
  const commands: Command[] = [];
  for (const file of names.filter(name => name.toLowerCase().endsWith(".md")).sort()) {
    const text = await readFile(join(folder, file), "utf-8").catch(() => null);
    if (text === null) continue;
    const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const description = header ? /^description:\s*["']?(.*?)["']?\s*$/im.exec(header[1])?.[1] ?? "" : "";
    commands.push({
      name: basename(file, ".md").toLowerCase(),
      description,
      body: (header ? text.slice(header[0].length) : text).trim(),
      builtIn: false,
    });
  }
  return commands;
}

export type CommandOutcome =
  | { kind: "none" }
  /** The message to send instead of what the user typed. */
  | { kind: "expanded"; name: string; text: string }
  /** The project's command was not used; why, for a status line. */
  | { kind: "refused"; name: string; reason: string };

/**
 * Turns `/name arguments` into the command's instructions. A name that is no command is left alone,
 * so a message that merely starts with a path still reaches the model as written. A project's own
 * command is someone else's text that the model will follow, so it gets the same scan as AGENTS.md.
 */
export function expandCommand(message: string, commands: Command[], options: { scan: boolean }): CommandOutcome {
  const match = COMMAND.exec(message);
  if (!match) return { kind: "none" };
  const name = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  if (name === "help") {
    const list = commands.map(c => `- /${c.name}: ${c.description || "(no description)"}${c.builtIn ? "" : " (this project)"}`).join("\n");
    return {
      kind: "expanded",
      name,
      text:
        "The user typed /help. Reply with this list of commands and one line on how to use them, nothing else:\n" +
        `${list}\n- /help: this list\nA command is typed at the start of a message, optionally followed by more details.`,
    };
  }

  const command = commands.find(c => c.name === name);
  if (!command) return { kind: "none" };
  if (!command.builtIn && options.scan) {
    const [finding] = scanForInjection(command.body);
    if (finding) return { kind: "refused", name, reason: describeFinding(finding) };
  }
  const body = command.body.includes("$ARGUMENTS")
    ? command.body.replace(/\$ARGUMENTS/g, args).trim()
    : `${command.body}${args ? `\n\n${args}` : ""}`;
  return { kind: "expanded", name, text: `The user ran the command /${name}${args ? ` with: ${args}` : ""}. Do this:\n\n${body}` };
}

/** Every command for a project: its own first, so a project can replace a built-in one. */
export async function allCommands(projectFolder: string): Promise<Command[]> {
  const own = await projectCommands(projectFolder);
  return [...own, ...BUILT_IN_COMMANDS.filter(b => !own.some(c => c.name === b.name))];
}
