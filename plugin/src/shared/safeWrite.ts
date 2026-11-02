import { randomBytes } from "crypto";
import { chmod, realpath, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

/**
 * Renames, retrying briefly: Windows can refuse a rename while another process has the target open
 * (antivirus, an editor, a reader), and lets it through a moment later.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error: any) {
      const retryable = error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
      if (!retryable || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

/**
 * Writes a file by creating a temporary file next to it and renaming over the target, so an
 * interrupted write cannot leave the original truncated. Falls back to a direct write when the
 * rename is still refused after a few tries (a locked file, or a filesystem that will not replace
 * across handles), which is the best that can be done there anyway.
 */
export async function writeFileAtomic(file: string, content: string | Uint8Array): Promise<void> {
  // A rename over a symbolic link replaces the link itself: write the file it points at instead.
  file = await realpath(file).catch(() => file);
  const temporary = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
  const mode = await stat(file).then(
    info => info.mode,
    () => undefined,
  );

  try {
    await writeFile(temporary, content, "utf-8");
    if (mode !== undefined) await chmod(temporary, mode).catch(() => {});
    await renameWithRetry(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    await writeFile(file, content, "utf-8");
  }
}
