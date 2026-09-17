import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { truncate } from "../../../shared/truncate";

/**
 * Long command output is cut to fit the model's context, and the dropped middle is gone for good.
 * When output is much larger than the limit, the whole thing is written to a file first, so the
 * model can page through it with read_file instead of re-running the command.
 */
export async function storeOverflow(directory: string, text: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `output-${Date.now().toString(36)}.txt`);
  await writeFile(file, text, "utf-8");
  return file;
}

export function overflowNote(file: string, text: string, maxChars: number): string {
  return `${truncate(text, maxChars)}\n\n[full output (${text.length} characters) saved to ${file} - read it with read_file]`;
}
