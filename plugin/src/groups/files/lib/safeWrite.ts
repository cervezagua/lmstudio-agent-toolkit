import { randomBytes } from "crypto";
import { chmod, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

/**
 * Writes a file by creating a temporary file next to it and renaming over the target, so an
 * interrupted write cannot leave the original truncated. Falls back to a direct write when the
 * rename is refused (a locked file, or a filesystem that will not replace across handles), which
 * is the best that can be done there anyway.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temporary = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
  const mode = await stat(file).then(
    info => info.mode,
    () => undefined,
  );

  try {
    await writeFile(temporary, content, "utf-8");
    if (mode !== undefined) await chmod(temporary, mode).catch(() => {});
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    await writeFile(file, content, "utf-8");
  }
}
