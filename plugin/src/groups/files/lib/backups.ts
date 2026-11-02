import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { ToolError } from "../../../shared/errors";
import { writeFileAtomic } from "../../../shared/safeWrite";

/** Windows and macOS filesystems ignore case by default; elsewhere "A.txt" and "a.txt" are two files. */
const foldsCase = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

/** The name of a file's backup slot. The platform is a parameter so tests can try both kinds. */
export function backupName(path: string, platform: NodeJS.Platform = process.platform): string {
  return `${createHash("sha1").update(foldsCase(platform) ? path.toLowerCase() : path).digest("hex")}.bak`;
}

const NO_HISTORY = "No undo history for this file in this chat. Only the last change to each file is kept.";

interface BackupRecord {
  path: string;
  savedAt: string;
  previousContent: string | null;
  /** Set when the file was not UTF-8 text: previousContent then holds its exact bytes. */
  encoding?: "base64";
}

/**
 * Keeps the previous contents of files the model changes, so an edit can be undone. Backups live
 * outside the project (in the chat's working directory) so they never show up in the user's repo.
 */
export class BackupStore {
  constructor(private readonly directory: string) {}

  private fileFor(path: string) {
    return join(this.directory, backupName(path));
  }

  /**
   * Records the content a file had before a change. Pass null when the file did not exist, and the
   * raw bytes of a file that is not UTF-8 text, which a string would not bring back intact.
   */
  async save(path: string, previousContent: string | Buffer | null) {
    await mkdir(this.directory, { recursive: true });
    const record: BackupRecord = Buffer.isBuffer(previousContent)
      ? { path, savedAt: new Date().toISOString(), previousContent: previousContent.toString("base64"), encoding: "base64" }
      : { path, savedAt: new Date().toISOString(), previousContent };
    await writeFile(this.fileFor(path), JSON.stringify(record), "utf-8");
  }

  /** `check` runs once there is a backup to restore, and can refuse by throwing. */
  async restore(path: string, check?: () => Promise<void>): Promise<{ restored: "content" | "deleted"; savedAt: string }> {
    let record: BackupRecord;
    try {
      record = JSON.parse(await readFile(this.fileFor(path), "utf-8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new ToolError(NO_HISTORY);
      }
      throw error;
    }
    // Two paths can share a slot (names that differ only in case, on a filesystem that keeps them
    // apart): one file's backup must never be written over the other.
    const same = foldsCase(process.platform) ? record.path.toLowerCase() === path.toLowerCase() : record.path === path;
    if (!same) throw new ToolError(NO_HISTORY);
    await check?.();
    if (record.previousContent === null) {
      await rm(path, { force: true });
      await rm(this.fileFor(path), { force: true });
      return { restored: "deleted", savedAt: record.savedAt };
    }
    const content = record.encoding === "base64" ? Buffer.from(record.previousContent, "base64") : record.previousContent;
    await writeFileAtomic(path, content);
    await rm(this.fileFor(path), { force: true });
    return { restored: "content", savedAt: record.savedAt };
  }

  async count(): Promise<number> {
    try {
      return (await readdir(this.directory)).filter(f => f.endsWith(".bak")).length;
    } catch {
      return 0;
    }
  }
}
