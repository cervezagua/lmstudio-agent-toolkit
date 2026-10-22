import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { attachmentsFile } from "./attachments";
import { isInside, realpathOfNearestExisting } from "./paths";

/**
 * The chat's current mode, shared between plugins through a small file in the chat's working
 * directory (every plugin in a chat gets the same working directory from LM Studio).
 *
 * In planning mode, tools that change things are not offered to the model at all: coder-tools and
 * git-tools leave them out of the tool list until memory-tools' exit_plan_mode turns planning off.
 */
export interface ChatMode {
  planning: boolean;
  since?: string;
  plan?: string;
}

export function modeFile(workingDirectory: string): string {
  return join(workingDirectory, ".agent-mode.json");
}

/**
 * The folders in the chat's working directory where the toolkit keeps its own state: the list of
 * attached files, background tasks and their logs, undo backups, the todo list.
 */
export function stateFolders(workingDirectory: string): string[] {
  return [dirname(attachmentsFile(workingDirectory)), join(workingDirectory, ".coder-tools"), join(workingDirectory, ".memory-tools")];
}

function owns(workingDirectory: string, file: string): boolean {
  // Windows and macOS filesystems ignore case by default, so ".Agent-Mode.json" is the same file
  // there. On a case-sensitive volume this only errs towards refusing, which is the safe side.
  const ignoreCase = process.platform === "win32" || process.platform === "darwin";
  const fold = (path: string) => (ignoreCase ? resolve(path).toLowerCase() : resolve(path));
  const target = fold(file);
  return target === fold(modeFile(workingDirectory)) || stateFolders(workingDirectory).some(folder => isInside(fold(folder), target));
}

/**
 * Whether `file` is one of the toolkit's own files in the chat's working directory, which the file
 * tools refuse to change. When no project folder is set the root *is* the working directory, so
 * without this the model could turn planning off by writing the mode file instead of calling
 * exit_plan_mode, make any file on disk "attached" by writing the list of attachments, or point a
 * background task's record at another process for task_stop to kill.
 *
 * The real paths are compared as well as the given ones: on Windows an 8.3 short name such as
 * "AGENT-~1" is the same folder under a different spelling.
 */
export async function isChatStateFile(workingDirectory: string, file: string): Promise<boolean> {
  if (owns(workingDirectory, file)) return true;
  const [realWorkingDirectory, realFile] = await Promise.all([
    realpathOfNearestExisting(resolve(workingDirectory)),
    realpathOfNearestExisting(resolve(file)),
  ]);
  return owns(realWorkingDirectory, realFile);
}

export async function readMode(workingDirectory: string): Promise<ChatMode> {
  try {
    const parsed = JSON.parse(await readFile(modeFile(workingDirectory), "utf-8"));
    return { planning: parsed?.planning === true, since: parsed?.since, plan: parsed?.plan };
  } catch {
    return { planning: false };
  }
}

export async function writeMode(workingDirectory: string, mode: ChatMode): Promise<void> {
  await mkdir(workingDirectory, { recursive: true });
  await writeFile(modeFile(workingDirectory), JSON.stringify(mode, null, 2), "utf-8");
}

/** Text appended to read-only tool descriptions while planning, so the model knows the rules. */
export const PLANNING_NOTE =
  "PLANNING MODE is on: research and read only. Do not change files or system state. " +
  "When the plan is ready, call exit_plan_mode with it and wait for approval.";
