import { readFile } from "fs/promises";
import { resolveInside } from "../shared/paths";
import { truncate } from "../shared/truncate";

export interface InstructionFile {
  name: string;
  content: string;
}

/** Reads whichever of `names` exist in `projectDirectory` (never outside it). */
export async function loadInstructionFiles(projectDirectory: string, names: string[]): Promise<InstructionFile[]> {
  const found: InstructionFile[] = [];
  for (const name of names.map(n => n.trim()).filter(Boolean)) {
    try {
      const content = (await readFile(resolveInside(projectDirectory, name), "utf-8")).trim();
      if (content) found.push({ name, content });
    } catch {
      // missing, unreadable, or outside the project directory: skip
    }
  }
  return found;
}

/**
 * Builds the context block prepended to the first user message of a chat. Returns null if there is
 * nothing to add. The memory index gets whatever budget the instructions leave (at least 1/4).
 */
export function buildContextBlock(options: {
  projectDirectory: string;
  instructions: InstructionFile[];
  memoryIndex: string | null;
  skillList?: string | null;
  gitSnapshot?: string | null;
  /** Overridable so tests do not depend on the clock. */
  today?: Date;
  maxChars: number;
}): string | null {
  const sections: string[] = [];
  const indexBudget = options.memoryIndex ? Math.floor(options.maxChars / 4) : 0;
  let remaining = options.maxChars - indexBudget;

  for (const file of options.instructions) {
    if (remaining <= 200) break;
    const body = truncate(file.content, remaining);
    sections.push(`## Project instructions from ${file.name}\n\n${body}`);
    remaining -= body.length;
  }

  if (options.memoryIndex) {
    const body = truncate(options.memoryIndex.replace(/^# Memory index\s*/, ""), indexBudget + Math.max(0, remaining));
    sections.push(
      `## Saved memories\n\n${body}\nUse memory_read to open one, memory_search to find more, memory_save to remember new facts.`,
    );
  }

  if (options.skillList) {
    const body = truncate(options.skillList, Math.max(500, Math.floor(options.maxChars / 5)));
    sections.push(`## Skills available\n\n${body}\nLoad one with skill_read before doing work it covers.`);
  }

  if (options.gitSnapshot) {
    const body = truncate(options.gitSnapshot, Math.max(500, Math.floor(options.maxChars / 4)));
    sections.push(`## Repository\n\n${body}`);
  }

  if (sections.length === 0) return null;
  // Local models have no idea what day it is, which quietly ruins anything date-related.
  const today = (options.today ?? new Date()).toISOString().slice(0, 10);
  return [
    `<context source="memory-tools" project="${options.projectDirectory}">`,
    `Today is ${today}. The following was loaded automatically; follow the project instructions.`,
    "",
    sections.join("\n\n"),
    "</context>",
  ].join("\n");
}
