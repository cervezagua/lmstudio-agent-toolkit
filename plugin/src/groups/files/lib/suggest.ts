import fg from "fast-glob";
import { basename, extname } from "path";
import { displayPath } from "../../../shared/paths";
import { DEFAULT_IGNORES } from "./search";

/**
 * When a path does not exist, offer the files the model most likely meant: the same name with a
 * different extension, or the tail of the path somewhere else in the project. Small models get
 * extensions and folder depth wrong constantly, and a suggestion saves a guessing round.
 */
export async function suggestPaths(root: string, requested: string, limit = 3): Promise<string[]> {
  const normalized = requested.replace(/\\/g, "/").replace(/^\.\//, "");
  const name = basename(normalized);
  if (!name) return [];

  const patterns = [`**/${basename(name, extname(name))}.*`];
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length > 1) patterns.push(`**/${segments.slice(-2).join("/")}`);

  try {
    const matches = await fg(patterns, {
      cwd: root,
      absolute: true,
      dot: true,
      onlyFiles: true,
      ignore: DEFAULT_IGNORES,
      suppressErrors: true,
      followSymbolicLinks: false,
    });
    const wanted = normalized.toLowerCase();
    return [...new Set(matches.map(match => displayPath(root, match)))]
      .filter(candidate => candidate.toLowerCase() !== wanted)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Appends "Did you mean ...?" to a not-found message when there are candidates. */
export async function notFoundMessage(root: string, requested: string, base: string): Promise<string> {
  const suggestions = await suggestPaths(root, requested);
  if (suggestions.length === 0) return base;
  return `${base} Did you mean: ${suggestions.join(", ")}?`;
}
