import { createReadStream } from "fs";
import { open, stat } from "fs/promises";
import { createInterface } from "readline";
import { ToolError } from "../shared/errors";

/** Reads the first bytes only, so a huge or binary file is never pulled into memory to check it. */
export async function looksBinary(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export interface TextSlice {
  lines: string[];
  /** 1-based line number of the first returned line. */
  start: number;
  totalLines: number;
}

/**
 * Returns a window of lines without holding the whole file in memory: a 200 MB log costs one pass,
 * not 200 MB. The full line count comes from the same pass, so the caller can say what was left out.
 */
export async function readTextSlice(file: string, offset = 1, limit = 2000): Promise<TextSlice> {
  const start = Math.max(1, offset);
  const lines: string[] = [];
  let totalLines = 0;

  const stream = createReadStream(file, { encoding: "utf-8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      totalLines++;
      if (totalLines >= start && lines.length < limit) lines.push(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (start > totalLines && totalLines > 0) {
    throw new ToolError(`offset ${start} is past the end of the file (${totalLines} lines).`);
  }
  return { lines, start, totalLines };
}

/** Refuses whole-file reads of big files, which otherwise fill the model's context with noise. */
export async function assertReadableSize(file: string, displayPath: string, maxBytes: number, windowed: boolean) {
  const info = await stat(file);
  if (info.isDirectory()) throw new ToolError(`"${displayPath}" is a directory; use list_dir.`);
  if (!windowed && info.size > maxBytes) {
    throw new ToolError(
      `${displayPath} is ${Math.round(info.size / 1024)} KB, over the ${Math.round(maxBytes / 1024)} KB limit for a whole-file read. ` +
        `Read part of it with offset and limit, or search it with grep.`,
    );
  }
  return info;
}
