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

export interface GrepOptions {
  root: string;
  searchPath: string;
  pattern: string;
  glob?: string;
  ignoreCase: boolean;
  maxResults: number;
  signal?: AbortSignal;
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

  const matches: string[] = [];
  let filesSearched = 0;
  for (const file of files) {
    if (options.signal?.aborted) break;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) continue;
      const buffer = await readFile(file);
      if (buffer.subarray(0, 8000).includes(0)) continue; // binary
      filesSearched++;
      const lines = buffer.toString("utf-8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const line = lines[i].length > 300 ? lines[i].slice(0, 300) + "…" : lines[i];
          matches.push(`${displayPath(options.root, file)}:${i + 1}: ${line}`);
          if (matches.length >= options.maxResults) {
            return { matches, truncated: true, filesSearched };
          }
        }
      }
    } catch {
      // unreadable file; skip
    }
  }
  return { matches, truncated: false, filesSearched };
}
