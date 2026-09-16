import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { ToolError } from "../shared/errors";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference", "session"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  updated: string;
  content: string;
}

export const INDEX_FILE = "MEMORY.md";

export function defaultMemoryDirectory(configured: string): string {
  const value = configured.trim();
  if (!value) return join(homedir(), ".lmstudio-agent-memory");
  return resolve(value.replace(/^~(?=$|[\\/])/, homedir()));
}

/** Lowercase kebab-case slug safe for file names on every OS. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new ToolError(`"${name}" is not a usable memory name; use letters or digits.`);
  return slug;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function serializeMemory(memory: Memory): string {
  return [
    "---",
    `name: ${memory.name}`,
    `description: ${oneLine(memory.description)}`,
    `type: ${memory.type}`,
    `updated: ${memory.updated}`,
    "---",
    "",
    memory.content.trim(),
    "",
  ].join("\n");
}

export function parseMemory(text: string, fallbackName: string): Memory {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  const type = (MEMORY_TYPES as readonly string[]).includes(fields.type) ? (fields.type as MemoryType) : "reference";
  return {
    name: fields.name || fallbackName,
    description: fields.description ?? "",
    type,
    updated: fields.updated ?? "",
    content: (match ? match[2] : text).trim(),
  };
}

export class MemoryStore {
  constructor(readonly directory: string) {}

  private fileFor(name: string) {
    return join(this.directory, `${slugify(name)}.md`);
  }

  async list(): Promise<Memory[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const memories = await Promise.all(
      files
        .filter(f => f.endsWith(".md") && f !== INDEX_FILE)
        .map(async f => parseMemory(await readFile(join(this.directory, f), "utf-8"), f.slice(0, -3))),
    );
    return memories.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<Memory | null> {
    try {
      return parseMemory(await readFile(this.fileFor(name), "utf-8"), slugify(name));
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  /** Creates or replaces a memory and rebuilds the index. Returns whether it already existed. */
  async save(input: { name: string; description: string; content: string; type: MemoryType }, now = new Date()) {
    const name = slugify(input.name);
    if (!input.content.trim()) throw new ToolError("Memory content must not be empty.");
    await mkdir(this.directory, { recursive: true });
    const existed = (await this.read(name)) !== null;
    const memory: Memory = { ...input, name, updated: now.toISOString() };
    await writeFile(this.fileFor(name), serializeMemory(memory), "utf-8");
    await this.rebuildIndex();
    return { memory, existed };
  }

  async delete(name: string): Promise<boolean> {
    const existing = await this.read(name);
    if (!existing) return false;
    await rm(this.fileFor(name));
    await this.rebuildIndex();
    return true;
  }

  /** MEMORY.md is derived from the files, so it can never drift out of sync with them. */
  async rebuildIndex(): Promise<string> {
    const memories = await this.list();
    const index = renderIndex(memories);
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, INDEX_FILE), index, "utf-8");
    return index;
  }

  async search(query: string, limit = 5) {
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2))];
    if (terms.length === 0) throw new ToolError("Search query needs at least one word of 2+ characters.");
    const count = (haystack: string, term: string) => haystack.toLowerCase().split(term).length - 1;

    const scored = (await this.list())
      .map(memory => {
        let score = 0;
        for (const term of terms) {
          score += 3 * count(memory.name.replace(/-/g, " "), term);
          score += 2 * count(memory.description, term);
          score += Math.min(5, count(memory.content, term));
        }
        const snippetLine = memory.content
          .split(/\r?\n/)
          .find(line => terms.some(term => line.toLowerCase().includes(term)));
        return { memory, score, snippet: snippetLine?.trim().slice(0, 200) };
      })
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updated.localeCompare(a.memory.updated));
    return scored.slice(0, limit);
  }
}

const INDEX_MAX_ENTRIES = 200;
const INDEX_MAX_CHARS = 25_000;
const STALE_AFTER_DAYS = 30;

/**
 * The index is injected into every new chat, so it has to stay small and honest: one line per
 * memory, oldest ones marked stale, and a hard cap so a big collection cannot crowd out the
 * conversation.
 */
export function renderIndex(memories: Memory[], now = new Date()): string {
  if (memories.length === 0) return "# Memory index\n\n(no memories saved yet)\n";

  const staleBefore = now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const memory of memories) {
    const updated = Date.parse(memory.updated);
    const stale = Number.isFinite(updated) && updated < staleBefore ? " (stale)" : "";
    const line = `- [${memory.name}](${memory.name}.md) (${memory.type})${stale} — ${memory.description || "(no description)"}`;
    if (lines.length >= INDEX_MAX_ENTRIES || used + line.length > INDEX_MAX_CHARS) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const notes = ["Keep each entry to a single line."];
  if (dropped > 0) notes.push(`${dropped} older memories are not listed; find them with memory_search.`);
  return `# Memory index\n\n${lines.join("\n")}\n\n${notes.join(" ")}\n`;
}
