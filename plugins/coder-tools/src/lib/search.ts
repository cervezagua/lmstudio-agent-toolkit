import fg from "fast-glob";
import { readFile, stat } from "fs/promises";
import { displayPath } from "../shared/paths";

export const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/target/**",
];

const MAX_FILE_BYTES = 1_000_000;

export interface GlobOptions {
  cwd: string;
  pattern: string;
  limit: number;
  includeHidden?: boolean;
}

/** Matches files under `cwd`, newest-modified first. */
export async function globFiles({ cwd, pattern, limit, includeHidden = true }: GlobOptions) {
  const entries = await fg(pattern, {
    cwd,
    absolute: true,
    dot: includeHidden,
    onlyFiles: true,
    ignore: DEFAULT_IGNORES,
    suppressErrors: true,
    stats: true,
    followSymbolicLinks: false,
  });
  entries.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
  return { files: entries.slice(0, limit).map(e => e.path), total: entries.length };
}

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepOptions {
  root: string;
  searchPath: string;
  pattern: string;
  glob?: string;
  ignoreCase: boolean;
  maxResults: number;
  signal?: AbortSignal;
  /** Lines of context to show around each matching line (content mode only). */
  context?: number;
  /** content: matching lines; files_with_matches: paths only; count: matches per file. */
  outputMode?: GrepOutputMode;
  /** Skip this many results before returning any, so the model can page through matches. */
  offset?: number;
}

export interface GrepResult {
  matches: string[];
  truncated: boolean;
  filesSearched: number;
}

/** Pure-JS recursive regex search, used when ripgrep is not installed. */
export async function grepFiles(options: GrepOptions): Promise<GrepResult> {
  const regex = new RegExp(options.pattern, options.ignoreCase ? "i" : "");
  const searchStat = await stat(options.searchPath);
  const files = searchStat.isFile()
    ? [options.searchPath]
    : (
        await fg(options.glob ? (options.glob.includes("/") ? options.glob : `**/${options.glob}`) : "**/*", {
          cwd: options.searchPath,
          absolute: true,
          dot: true,
          onlyFiles: true,
          ignore: DEFAULT_IGNORES,
          suppressErrors: true,
          followSymbolicLinks: false,
        })
      ).sort();

  const mode = options.outputMode ?? "content";
  const context = Math.max(0, Math.min(options.context ?? 0, 10));
  const skip = Math.max(0, options.offset ?? 0);
  const clip = (line: string) => (line.length > 300 ? line.slice(0, 300) + "…" : line);

  const matches: string[] = [];
  let filesSearched = 0;
  let seen = 0; // results found, including those skipped by offset

  for (const file of files) {
    if (options.signal?.aborted) break;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) continue;
      const buffer = await readFile(file);
      if (buffer.subarray(0, 8000).includes(0)) continue; // binary
      filesSearched++;
      const lines = buffer.toString("utf-8").split(/\r?\n/);
      const shown = displayPath(options.root, file);

      if (mode !== "content") {
        // One result per file: its path, or its path and match count.
        const count = lines.filter(line => regex.test(line)).length;
        if (count === 0) continue;
        seen++;
        if (seen <= skip) continue;
        matches.push(mode === "count" ? `${shown}: ${count}` : shown);
        if (matches.length >= options.maxResults) return { matches, truncated: true, filesSearched };
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;
        seen++;
        if (seen <= skip) continue;
        if (context === 0) {
          matches.push(`${shown}:${i + 1}: ${clip(lines[i])}`);
        } else {
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          const block = [];
          for (let j = from; j <= to; j++) {
            block.push(`${shown}:${j + 1}${j === i ? ":" : "-"} ${clip(lines[j])}`);
          }
          matches.push(block.join("\n"));
        }
        if (matches.length >= options.maxResults) {
          return { matches, truncated: true, filesSearched };
        }
      }
    } catch {
      // unreadable file; skip
    }
  }
  return { matches, truncated: false, filesSearched };
}
