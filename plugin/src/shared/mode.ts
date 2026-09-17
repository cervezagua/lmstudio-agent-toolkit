import { mkdir, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";

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
 * Files in the chat's working directory that the toolkit owns. The file tools refuse to change
 * them: when no project folder is set the root *is* the working directory, so without this the
 * model could turn planning off by writing the file instead of calling exit_plan_mode.
 */
export function isChatStateFile(workingDirectory: string, file: string): boolean {
  const a = resolve(file);
  const b = resolve(modeFile(workingDirectory));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
