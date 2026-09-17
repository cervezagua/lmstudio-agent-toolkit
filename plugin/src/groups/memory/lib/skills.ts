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

/** Reads `name:` and `description:` from a leading YAML frontmatter block, if there is one. */
export function parseSkillHeader(text: string, fallbackName: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
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
