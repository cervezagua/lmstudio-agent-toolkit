import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import { ToolError } from "../../../shared/errors";

interface FileRecord {
  mtimeMs: number;
  size: number;
  sha1: string;
}

/**
 * What the model has seen of each file in this chat. Editing a file the model has not read, or one
 * that changed since it read it, is the classic way an agent destroys someone's work: it rewrites
 * a version that no longer exists. Both cases are refused with an instruction to read the file.
 *
 * The map lives in the plugin process, so it is emptied when LM Studio reloads the plugin; the
 * error message says so, and re-reading the file is enough to continue.
 */
const seen = new Map<string, FileRecord>();

const hash = (content: string) => createHash("sha1").update(content).digest("hex");
const key = (file: string) => file.toLowerCase(); // Windows paths are case-insensitive

/**
 * Records the file as seen. Pass the exact content when you already have it; otherwise the file is
 * read here, because the hash has to match the bytes on disk (line endings included).
 */
export async function recordRead(file: string, content?: string): Promise<void> {
  try {
    const info = await stat(file);
    const text = content ?? (await readFile(file, "utf-8"));
    seen.set(key(file), { mtimeMs: info.mtimeMs, size: info.size, sha1: hash(text) });
  } catch {
    // The file disappeared between read and record; the next edit will ask for a fresh read.
  }
}

/** Same as recordRead: after we write a file, the model's view is the content we just wrote. */
export const recordWrite = (file: string, content: string) => recordRead(file, content);

export function forget(file: string): void {
  seen.delete(key(file));
}

/**
 * Throws unless the model has read this exact content. Returns the file's current content so the
 * caller does not have to read it twice.
 */
export async function assertFresh(file: string, displayPath: string, currentContent: string): Promise<void> {
  const record = seen.get(key(file));
  if (!record) {
    throw new ToolError(
      `You have not read ${displayPath} in this session, so editing it could overwrite work you cannot see. ` +
        `Read it first, then edit. (This also happens after the plugin restarts.)`,
    );
  }

  const info = await stat(file).catch(() => null);
  if (info && info.mtimeMs === record.mtimeMs && info.size === record.size) return;

  // Antivirus, backup and cloud-sync tools touch mtime without changing content, so compare the
  // content itself before refusing.
  if (hash(currentContent) === record.sha1) {
    if (info) seen.set(key(file), { mtimeMs: info.mtimeMs, size: info.size, sha1: record.sha1 });
    return;
  }

  throw new ToolError(
    `${displayPath} changed on disk since you read it. Read it again and redo your edit against the current content.`,
  );
}

/** Test helper: empties the map. */
export function clearFileState(): void {
  seen.clear();
}
