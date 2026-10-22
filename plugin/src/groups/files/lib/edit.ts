import { ToolError } from "../../../shared/errors";

/**
 * Removes `search` from `content`: the first occurrence, or every one. An occurrence that is a whole
 * line takes its line break with it, otherwise the file keeps a blank line where the model asked for
 * the text to be gone; one inside a longer line just goes.
 *
 * Each occurrence is handled where it stands, in the same left-to-right order `countOccurrences`
 * counts them, so the number reported is the number removed. (A single pattern for "a whole line"
 * cannot do this: it swallows the line break that the next line's match would have to start after,
 * so every second line of a run survived, and occurrences inside a line were never touched.)
 */
function removeOccurrences(content: string, search: string, all: boolean): string {
  let out = "";
  let position = 0;
  let index = content.indexOf(search);
  while (index !== -1) {
    const end = index + search.length;
    const next = all ? content.indexOf(search, end) : -1;
    const startsLine = index === 0 || content[index - 1] === "\n";
    const lineBreak = content.startsWith("\r\n", end) ? 2 : content[end] === "\n" ? 1 : 0;
    // Not when the next occurrence begins inside that line break (a search that itself starts with one).
    const takeLineBreak = startsLine && lineBreak > 0 && (next === -1 || next >= end + lineBreak);
    out += content.slice(position, index);
    position = takeLineBreak ? end + lineBreak : end;
    index = next;
  }
  return out + content.slice(position);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

const squash = (line: string) => line.trim().replace(/\s+/g, " ");

/** How alike two lines are, from 0 to 1: shared letter pairs (Dice), after squashing whitespace. */
function similarity(a: string, b: string): number {
  const x = squash(a);
  const y = squash(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) pairs.set(x.slice(i, i + 2), (pairs.get(x.slice(i, i + 2)) ?? 0) + 1);
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const pair = y.slice(i, i + 2);
    const left = pairs.get(pair) ?? 0;
    if (left > 0) {
      shared++;
      pairs.set(pair, left - 1);
    }
  }
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

export interface ClosestMatch {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  /** The same text but for spaces, tabs and indentation. */
  whitespaceOnly: boolean;
}

/**
 * The lines of `content` most like `search`, when an exact match failed. Small models quote text
 * slightly wrong (indentation, a changed word, a line they misremember) and then re-read the whole
 * file to find it; showing them the nearest text lets them copy it on the next try.
 *
 * The search's most distinctive line anchors the comparison, so a big file costs one pass rather
 * than one per window. Returns null when nothing is reasonably close.
 */
export function closestMatch(content: string, search: string): ClosestMatch | null {
  const lines = content.split(/\r?\n/);
  const wanted = search.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (wanted.length > 60 || lines.length > 200_000) return null;
  const anchor = wanted.reduce((best, line, i) => (squash(line).length > squash(wanted[best]).length ? i : best), 0);
  if (squash(wanted[anchor]).length < 4) return null;

  const candidates = lines
    .map((line, i) => ({ start: i - anchor, score: similarity(line, wanted[anchor]) }))
    .filter(c => c.score >= 0.5 && c.start >= 0 && c.start + wanted.length <= lines.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  let best: { start: number; score: number } | null = null;
  for (const { start } of candidates) {
    const score = wanted.reduce((sum, line, j) => sum + similarity(lines[start + j], line), 0) / wanted.length;
    if (!best || score > best.score) best = { start, score };
  }
  if (!best || best.score < 0.6) return null;

  const found = lines.slice(best.start, best.start + wanted.length);
  return {
    startLine: best.start + 1,
    endLine: best.start + wanted.length,
    text: found.join("\n"),
    whitespaceOnly: found.every((line, j) => squash(line) === squash(wanted[j])),
  };
}

/** The not-found error, with the nearest text when there is some. */
function notFound(content: string, search: string): ToolError {
  const base = "old_string was not found in the file.";
  const match = closestMatch(content, search);
  if (!match) return new ToolError(`${base} Read the file again and copy the text exactly, including whitespace and indentation.`);
  const where = match.startLine === match.endLine ? `line ${match.startLine}` : `lines ${match.startLine}-${match.endLine}`;
  const shown = match.text
    .split("\n")
    .map((line, i) => `${match.startLine + i}\t${line.length > 300 ? line.slice(0, 300) + "…" : line}`)
    .join("\n");
  const why = match.whitespaceOnly
    ? `The text is at ${where}, but its spaces or indentation differ from yours:`
    : `The closest text is at ${where}:`;
  return new ToolError(`${base} ${why}\n${shown}\nCopy it exactly as old_string (without the line numbers and the tab after them).`);
}

export interface EditResult {
  content: string;
  replacements: number;
}

/**
 * Exact string replacement, like Claude Code's Edit tool: `oldString` must occur exactly once
 * unless `replaceAll` is set. If the file uses CRLF and the model sent LF, the LF text is retried
 * as CRLF so edits work on Windows files.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): EditResult {
  if (oldString === "") {
    throw new ToolError("old_string must not be empty. Use write_file to create or overwrite a file.");
  }
  if (oldString === newString) {
    throw new ToolError("old_string and new_string are identical; nothing to change.");
  }

  let search = oldString;
  let replacement = newString;
  let count = countOccurrences(content, search);
  if (count === 0 && content.includes("\r\n") && !oldString.includes("\r\n")) {
    search = oldString.replace(/\n/g, "\r\n");
    replacement = newString.replace(/\r?\n/g, "\r\n");
    count = countOccurrences(content, search);
  }

  if (count === 0) throw notFound(content, oldString);
  if (count > 1 && !replaceAll) {
    throw new ToolError(
      `old_string occurs ${count} times. Include more surrounding lines to make it unique, ` +
        "or set replace_all to true.",
    );
  }

  if (replacement === "") {
    return { content: removeOccurrences(content, search, replaceAll), replacements: replaceAll ? count : 1 };
  }

  // split/join avoids String.replace's special `$&`-style patterns in the replacement.
  const updated = replaceAll
    ? content.split(search).join(replacement)
    : content.slice(0, content.indexOf(search)) +
      replacement +
      content.slice(content.indexOf(search) + search.length);
  return { content: updated, replacements: replaceAll ? count : 1 };
}

export interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Applies several exact replacements in order, all-or-nothing: if any one fails to match (or is
 * ambiguous), nothing is written and the model is told which step failed.
 */
export function applyEdits(content: string, edits: EditOperation[]): { content: string; replacements: number } {
  if (edits.length === 0) throw new ToolError("edits must contain at least one edit.");
  let current = content;
  let replacements = 0;
  const applied: string[] = [];
  edits.forEach((edit, index) => {
    // An edit that matches text an earlier edit just inserted would apply the batch twice over.
    const clash = applied.findIndex(previous => previous !== "" && previous.includes(edit.old_string));
    if (clash !== -1) {
      throw new ToolError(
        `Edit ${index + 1} of ${edits.length} searches for text that edit ${clash + 1} just inserted, ` +
          `so it would be applied twice. Combine them into one edit. No changes were written.`,
      );
    }
    try {
      const result = applyEdit(current, edit.old_string, edit.new_string, edit.replace_all ?? false);
      current = result.content;
      replacements += result.replacements;
      applied.push(edit.new_string);
    } catch (error) {
      const reason = error instanceof ToolError ? error.message : String(error);
      throw new ToolError(`Edit ${index + 1} of ${edits.length} failed: ${reason} No changes were written.`);
    }
  });
  return { content: current, replacements };
}

/** Inserts text after the given 1-based line (0 = beginning of the file). */
export function insertLines(content: string, afterLine: number, text: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (afterLine < 0 || afterLine > lines.length) {
    throw new ToolError(`after_line ${afterLine} is out of range (0..${lines.length}).`);
  }
  const inserted = text.split(/\r?\n/);
  lines.splice(afterLine, 0, ...inserted);
  return lines.join(newline);
}

/**
 * A compact line diff for previews: only changed regions, with a little context. Good enough for a
 * model (and a human) to check an edit before it is written, without pulling in a diff library.
 */
export function previewDiff(before: string, after: string, context = 2): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  if (start > endA && start > endB) return "(no changes)";

  const lines: string[] = [];
  for (let i = Math.max(0, start - context); i < start; i++) lines.push(`  ${i + 1}\t${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`- ${i + 1}\t${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+ ${i + 1}\t${b[i]}`);
  for (let i = endA + 1; i < Math.min(a.length, endA + 1 + context); i++) lines.push(`  ${i + 1}\t${a[i]}`);
  return lines.join("\n");
}
