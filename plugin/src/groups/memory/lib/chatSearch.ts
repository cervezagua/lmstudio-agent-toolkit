import { readdir, readFile, stat } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { ToolError } from "../../../shared/errors";

/**
 * Searches the user's earlier LM Studio chats. The conversation files are LM Studio's own format and
 * not a documented one, so everything here is tolerant: a file that cannot be read or does not look
 * as expected is skipped, never an error.
 */
export interface ChatMatch {
  chat: string;
  date: string;
  role: "user" | "assistant";
  excerpt: string;
  score: number;
}

const MAX_CHATS = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const EXCERPT_CHARS = 240;

/** LM Studio records where its data lives in ~/.lmstudio-home-pointer; ~/.lmstudio is the default. */
export function lmStudioHome(home = homedir()): string {
  try {
    const pointed = readFileSync(join(home, ".lmstudio-home-pointer"), "utf-8").trim();
    if (pointed && existsSync(pointed)) return pointed;
  } catch {
    // no pointer file: use the default
  }
  return join(home, ".lmstudio");
}

/**
 * What the user typed and what the assistant answered, in order. Left out on purpose: the model's
 * reasoning, tool calls and their output, and the context this plugin adds to a message (the
 * `preprocessed` copy), none of which is something the user said or was told.
 */
export function extractMessages(conversation: any): Array<{ role: "user" | "assistant"; text: string }> {
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  const textOf = (content: any): string =>
    Array.isArray(content)
      ? content
          .filter(part => part?.type === "text" && typeof part.text === "string")
          .map(part => part.text)
          .join("\n")
      : "";

  for (const message of Array.isArray(conversation?.messages) ? conversation.messages : []) {
    const version = message?.versions?.[message.currentlySelected ?? 0] ?? message?.versions?.[0];
    if (!version) continue;
    if (version.role === "user") {
      const text = textOf(version.content).trim();
      if (text) messages.push({ role: "user", text });
    } else if (version.role === "assistant") {
      const steps = Array.isArray(version.steps) ? version.steps : [{ type: "contentBlock", content: version.content }];
      const text = steps
        .filter((step: any) => step?.type === "contentBlock" && step.style?.type !== "thinking")
        .map((step: any) => textOf(step.content))
        .join("\n")
        .trim();
      if (text) messages.push({ role: "assistant", text });
    }
  }
  return messages;
}

function excerptAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const positions = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const at = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 80);
  const slice = text.slice(start, start + EXCERPT_CHARS).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${start + EXCERPT_CHARS < text.length ? "…" : ""}`;
}

export async function searchChats(options: {
  home: string;
  query: string;
  limit?: number;
  /** The chat doing the searching, which would otherwise match its own question. */
  excludeId?: string;
}): Promise<{ matches: ChatMatch[]; searched: number }> {
  const terms = [...new Set(options.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))];
  if (terms.length === 0) throw new ToolError("Search query needs at least one word of 2+ characters.");
  const count = (haystack: string, term: string) => haystack.split(term).length - 1;

  const directory = join(options.home, "conversations");
  const names = await readdir(directory).catch(() => [] as string[]);
  const files = (
    await Promise.all(
      names
        .filter(name => name.endsWith(".conversation.json") && basename(name, ".conversation.json") !== options.excludeId)
        .map(async name => {
          const file = join(directory, name);
          const info = await stat(file).catch(() => null);
          return info?.isFile() && info.size <= MAX_BYTES ? { file, modified: info.mtimeMs } : null;
        }),
    )
  )
    .filter((entry): entry is { file: string; modified: number } => entry !== null)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, MAX_CHATS);

  const matches: ChatMatch[] = [];
  let searched = 0;
  for (const { file, modified } of files) {
    let conversation: any;
    try {
      conversation = JSON.parse(await readFile(file, "utf-8"));
    } catch {
      continue;
    }
    searched++;
    const chat = typeof conversation?.name === "string" && conversation.name.trim() ? conversation.name.trim() : "(untitled chat)";
    const date = new Date(modified).toISOString().slice(0, 10);
    for (const message of extractMessages(conversation)) {
      const lower = message.text.toLowerCase();
      // Every word must appear: one common word alone matches half of every chat.
      if (!terms.every(term => lower.includes(term))) continue;
      const score = terms.reduce((sum, term) => sum + Math.min(5, count(lower, term)), 0);
      matches.push({ chat, date, role: message.role, excerpt: excerptAround(message.text, terms), score });
    }
  }

  matches.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  return { matches: matches.slice(0, options.limit ?? 8), searched };
}

export function renderChatMatches(result: { matches: ChatMatch[]; searched: number }): string {
  if (result.matches.length === 0) return `No matches in ${result.searched} earlier chats.`;
  return result.matches
    .map(match => `- ${match.date} "${match.chat}" (${match.role}): ${match.excerpt}`)
    .join("\n");
}
