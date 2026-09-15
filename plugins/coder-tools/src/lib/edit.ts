import { ToolError } from "../shared/errors";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
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

  if (count === 0) {
    throw new ToolError(
      "old_string was not found in the file. Read the file again and copy the text exactly, " +
        "including whitespace and indentation.",
    );
  }
  if (count > 1 && !replaceAll) {
    throw new ToolError(
      `old_string occurs ${count} times. Include more surrounding lines to make it unique, ` +
        "or set replace_all to true.",
    );
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
  edits.forEach((edit, index) => {
    try {
      const result = applyEdit(current, edit.old_string, edit.new_string, edit.replace_all ?? false);
      current = result.content;
      replacements += result.replacements;
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
