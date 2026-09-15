import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { ToolError } from "../shared/errors";

/**
 * Keeps the previous contents of files the model changes, so an edit can be undone. Backups live
 * outside the project (in the chat's working directory) so they never show up in the user's repo.
 */
export class BackupStore {
  constructor(private readonly directory: string) {}

  private fileFor(path: string) {
    return join(this.directory, `${createHash("sha1").update(path.toLowerCase()).digest("hex")}.bak`);
  }

  /** Records the content a file had before a change. Pass null when the file did not exist. */
  async save(path: string, previousContent: string | null) {
    await mkdir(this.directory, { recursive: true });
    const record = { path, savedAt: new Date().toISOString(), previousContent };
    await writeFile(this.fileFor(path), JSON.stringify(record), "utf-8");
  }

  async restore(path: string): Promise<{ restored: "content" | "deleted"; savedAt: string }> {
    let record: { path: string; savedAt: string; previousContent: string | null };
    try {
      record = JSON.parse(await readFile(this.fileFor(path), "utf-8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new ToolError(`No undo history for this file in this chat. Only the last change to each file is kept.`);
      }
      throw error;
    }
    if (record.previousContent === null) {
      await rm(path, { force: true });
      await rm(this.fileFor(path), { force: true });
      return { restored: "deleted", savedAt: record.savedAt };
    }
    await writeFile(path, record.previousContent, "utf-8");
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
