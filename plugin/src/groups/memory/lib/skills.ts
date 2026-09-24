import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { ToolError } from "../../../shared/errors";

export interface Skill {
  name: string;
  description: string;
  file: string;
  /** Extra files that live next to SKILL.md (scripts, templates, references). */
  extraFiles: string[];
}

export function defaultSkillsDirectory(configured: string): string {
  const value = configured.trim();
  if (!value) return join(homedir(), ".lmstudio-agent-skills");
  return resolve(value.replace(/^~(?=$|[\\/])/, homedir()));
}

/** A key starts a new field only at the left margin; anything indented continues the value above. */
const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]?(.*)$/;

/** Index of the closing quote, honouring \" inside "..." and '' inside '...'. -1 if unterminated. */
function closingQuote(body: string, quote: string): number {
  for (let i = 1; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] !== quote) continue;
    if (quote === "'" && body[i + 1] === "'") {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

function unquote(body: string, quote: string): string {
  if (quote === "'") return body.replace(/''/g, "'");
  // One pass, so an escaped backslash is not re-read as the start of the next escape: \\n is a
  // backslash followed by n, while \n is a break, which becomes a space because the skill list
  // shows one line per skill.
  return body.replace(/\\(.)/g, (_, char) => (char === "n" || char === "t" ? " " : char));
}

/** Collapses whatever whitespace folding left behind into single spaces. */
const fold = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Reads one field's value, which may run past its own line: a plain value can wrap onto indented
 * lines, a quoted one can span lines until its closing quote, and `>` or `|` start a block of
 * indented lines. Everything is folded into one line, because the skill list shows one line each.
 */
function readValue(lines: string[], start: number): { value: string; next: number } {
  const first = KEY_LINE.exec(lines[start])![2].trim();
  let index = start + 1;
  const indented = (line: string) => /^[ \t]+\S/.test(line);
  const followingLines = () => {
    const parts: string[] = [];
    while (index < lines.length && (lines[index].trim() === "" || indented(lines[index]))) {
      const line = lines[index].trim();
      if (line) parts.push(line);
      index++;
    }
    return parts;
  };

  // "|" keeps line breaks and ">" folds them; both are joined here. "-" and "+" only decide what
  // happens to trailing newlines, which do not survive folding either way.
  if (/^[|>][-+]?$/.test(first)) return { value: followingLines().join(" "), next: index };

  const quote = first[0];
  if (quote === '"' || quote === "'") {
    let body = first;
    // A blank line inside quotes is a line break in the value, not the end of it, so keep going to
    // the closing quote. The frontmatter block bounds this either way.
    while (closingQuote(body, quote) === -1 && index < lines.length) {
      body += " " + lines[index].trim();
      index++;
    }
    const end = closingQuote(body, quote);
    return { value: fold(unquote(end === -1 ? body.slice(1) : body.slice(1, end), quote)), next: index };
  }

  return { value: fold([first, ...followingLines()].join(" ")), next: index };
}

/** Reads `name:` and `description:` from a leading YAML frontmatter block, if there is one. */
export function parseSkillHeader(text: string, fallbackName: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  if (match) {
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; ) {
      const key = KEY_LINE.exec(lines[i]);
      if (!key) {
        i++;
        continue;
      }
      const { value, next } = readValue(lines, i);
      fields[key[1].toLowerCase()] = value;
      i = next;
    }
  }
  let description = fields.description ?? "";
  if (!description) {
    // Fall back to the first non-empty, non-heading line of the body.
    const body = match ? text.slice(match[0].length) : text;
    description = body.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith("#")) ?? "";
  }
  return { name: fields.name || fallbackName, description: description.slice(0, 300) };
}

/**
 * A skill is either `<dir>/<skill-name>/SKILL.md` (with optional supporting files next to it) or a
 * plain `<dir>/<skill-name>.md`.
 */
export async function listSkills(directory: string): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const file = join(directory, entry.name, "SKILL.md");
      const exists = await stat(file).then(s => s.isFile(), () => false);
      if (!exists) continue;
      const text = await readFile(file, "utf-8");
      const siblings = (await readdir(join(directory, entry.name))).filter(f => f !== "SKILL.md");
      skills.push({ ...parseSkillHeader(text, entry.name), file, extraFiles: siblings });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
      const file = join(directory, entry.name);
      const text = await readFile(file, "utf-8");
      skills.push({ ...parseSkillHeader(text, basename(entry.name, ".md")), file, extraFiles: [] });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(directory: string, name: string): Promise<{ skill: Skill; content: string }> {
  const skills = await listSkills(directory);
  const wanted = name.trim().toLowerCase();
  const skill =
    skills.find(s => s.name.toLowerCase() === wanted) ??
    skills.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted.replace(/[^a-z0-9]/g, ""));
  if (!skill) {
    const available = skills.map(s => s.name).join(", ") || "none";
    throw new ToolError(`No skill named "${name}". Available skills: ${available}.`);
  }
  return { skill, content: await readFile(skill.file, "utf-8") };
}

export function renderSkillList(skills: Skill[]): string {
  if (skills.length === 0) return "No skills are installed.";
  return skills.map(s => `- ${s.name}: ${s.description || "(no description)"}`).join("\n");
}
