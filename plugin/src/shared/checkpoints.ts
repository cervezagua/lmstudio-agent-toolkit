import { mkdir, readdir, readFile, rm } from "fs/promises";
import { join, resolve } from "path";
import { displayPath, isInside, realpathOfNearestExisting } from "./paths";
import { writeFileAtomic } from "./safeWrite";

/**
 * Per-turn checkpoints of the files the model changes, so `/rewind N` can put a project back to how
 * it was before turn N (Claude Code keeps the same kind of checkpoint). A turn is one message from
 * the user. The first time a tool changes a file during a turn, the file's previous content is kept
 * for that turn. Only changes made through the file tools are recorded: a shell command that edits
 * or deletes a file is invisible here, which the README says.
 */

/** Files bigger than this are listed but not kept, so a rewind can say it could not restore them. */
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;

export interface TurnInfo {
  turn: number;
  startedAt: string;
  /** The start of the user's message, to tell the turns apart in /rewind's list. */
  message: string;
}

export interface Checkpoint extends TurnInfo {
  files: { path: string; previous: string | null }[];
  /** Files changed in the turn that were too big to keep. */
  skipped: string[];
}

const folder = (chatDir: string) => join(chatDir, ".agent-toolkit", "checkpoints");
const turnFile = (chatDir: string) => join(folder(chatDir), "turn.json");
const checkpointFile = (chatDir: string, turn: number) => join(folder(chatDir), `${turn}.json`);
const sameFile = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

export async function currentTurn(chatDir: string): Promise<TurnInfo | null> {
  return readJson<TurnInfo>(turnFile(chatDir));
}

/** Called for each user message: starts the next turn. */
export async function startTurn(chatDir: string, message: string, now = new Date()): Promise<TurnInfo> {
  const info: TurnInfo = {
    turn: ((await currentTurn(chatDir))?.turn ?? 0) + 1,
    startedAt: now.toISOString(),
    message: message.replace(/\s+/g, " ").trim().slice(0, 70),
  };
  await mkdir(folder(chatDir), { recursive: true });
  await writeFileAtomic(turnFile(chatDir), JSON.stringify(info));
  return info;
}

/** Keeps a file's content from before its first change in the current turn. */
export async function recordChange(chatDir: string, file: string, previous: string | null): Promise<void> {
  const info = await currentTurn(chatDir);
  if (!info) return; // no turn has started (the tools ran outside a chat)
  const target = checkpointFile(chatDir, info.turn);
  const checkpoint = (await readJson<Checkpoint>(target)) ?? { ...info, files: [], skipped: [] };
  if (checkpoint.files.some(f => sameFile(f.path, file)) || checkpoint.skipped.some(f => sameFile(f, file))) return;
  if (previous !== null && Buffer.byteLength(previous) > MAX_CHECKPOINT_BYTES) checkpoint.skipped.push(file);
  else checkpoint.files.push({ path: file, previous });
  await writeFileAtomic(target, JSON.stringify(checkpoint));
}

export async function listCheckpoints(chatDir: string): Promise<Checkpoint[]> {
  const names = await readdir(folder(chatDir)).catch(() => [] as string[]);
  const checkpoints: Checkpoint[] = [];
  for (const name of names.filter(n => /^\d+\.json$/.test(n))) {
    const checkpoint = await readJson<Checkpoint>(join(folder(chatDir), name));
    if (checkpoint) checkpoints.push(checkpoint);
  }
  return checkpoints.sort((a, b) => a.turn - b.turn);
}

export interface RewindResult {
  restored: string[];
  deleted: string[];
  /** Too big to keep, or outside the project folder now. */
  notRestored: string[];
}

/**
 * Puts every file changed since the start of `turn` back as it was then: a file that did not exist is
 * deleted. Only paths inside the project folder are touched. The checkpoints of the turns undone are
 * removed, since what they recorded no longer happened.
 */
export async function rewindTo(chatDir: string, turn: number, projectFolder: string): Promise<RewindResult> {
  const undone = (await listCheckpoints(chatDir)).filter(c => c.turn >= turn);
  const before = new Map<string, { path: string; previous: string | null }>();
  const notRestored: string[] = [];
  for (const checkpoint of undone) {
    for (const file of checkpoint.files) {
      const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
      if (!before.has(key)) before.set(key, file);
    }
    for (const file of checkpoint.skipped) if (![...before.values()].some(f => sameFile(f.path, file))) notRestored.push(file);
  }

  const result: RewindResult = { restored: [], deleted: [], notRestored };
  // Real paths on both sides: the tools record a file as resolved (links followed, short names
  // expanded), and the configured project folder may be spelled another way.
  const root = await realpathOfNearestExisting(resolve(projectFolder));
  for (const { path, previous } of before.values()) {
    if (!isInside(root, await realpathOfNearestExisting(resolve(path)))) {
      result.notRestored.push(path);
      continue;
    }
    if (previous === null) {
      await rm(path, { force: true });
      result.deleted.push(path);
    } else {
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFileAtomic(path, previous);
      result.restored.push(path);
    }
  }
  for (const checkpoint of undone) await rm(checkpointFile(chatDir, checkpoint.turn), { force: true });
  return result;
}

/**
 * What `/rewind` sends the model instead of the user's message. The restoring is done here, by the
 * plugin, before the model sees anything, so it only has to report it; for a bare `/rewind` it gets
 * the list of turns to show.
 */
export async function rewindCommand(chatDir: string, argument: string, projectFolder: string): Promise<string> {
  const shown = (file: string) => displayPath(projectFolder, file);
  const checkpoints = await listCheckpoints(chatDir);
  if (!argument || argument === "list") {
    if (checkpoints.length === 0) return "The user typed /rewind. Reply, in one sentence, that no file changes have been recorded in this chat yet.";
    const lines = checkpoints.map(c => {
      const time = c.startedAt.slice(11, 16);
      const files = [...c.files.map(f => f.path), ...c.skipped].map(shown);
      return `- ${c.turn} (${time}) "${c.message}": ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}`;
    });
    return (
      "The user typed /rewind. Reply with this list of the messages that changed files, and nothing else:\n" +
      `${lines.join("\n")}\n` +
      "Then say: to put the files back to how they were before one of them, type /rewind and its number. Changes made by shell commands are not tracked."
    );
  }

  const turn = Number(argument);
  if (!Number.isInteger(turn) || turn < 1) {
    return `The user typed /rewind ${argument}. Reply that /rewind takes the number of a message from the list /rewind shows, like /rewind 3.`;
  }
  if (!checkpoints.some(c => c.turn >= turn)) {
    return `The user typed /rewind ${turn}. Reply that there is nothing to rewind: no file was changed by message ${turn} or any later one.`;
  }
  const from = checkpoints.find(c => c.turn >= turn)!;
  const result = await rewindTo(chatDir, turn, projectFolder);
  const parts = [
    result.restored.length ? `restored: ${result.restored.map(shown).join(", ")}` : "",
    result.deleted.length ? `deleted, since they did not exist then: ${result.deleted.map(shown).join(", ")}` : "",
    result.notRestored.length ? `could not be restored (too big to keep, or outside the project folder): ${result.notRestored.map(shown).join(", ")}` : "",
  ].filter(Boolean);
  return (
    `The user typed /rewind ${turn}. agent-toolkit has already put the files back to how they were before message ${from.turn} ("${from.message}"). ` +
    `${parts.join("; ")}.\n` +
    "Tell the user briefly what was put back. What you read of these files earlier is out of date: read them again before editing them. " +
    "Changes made by shell commands were not undone."
  );
}
