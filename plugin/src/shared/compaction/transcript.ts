import { createHash } from "crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { type Msg } from "./history";

/** The chat's own folder for compaction state; agent-toolkit's read_file and grep can reach it. */
export const compactionFolder = (chatDir: string) => join(chatDir, ".agent-toolkit", "compaction");
export const TRANSCRIPT_PATH = ".agent-toolkit/compaction/transcript.md";

/** One message as the transcript shows it, numbered as the placeholders refer to it. */
export function renderMessage(msg: Msg, maxChars = Infinity): string {
  const cut = (text: string) => (text.length > maxChars ? `${text.slice(0, maxChars)} [...]` : text);
  const parts = [`## #m${msg.n} ${msg.role}`];
  if (msg.text) parts.push(cut(msg.text));
  for (const call of msg.calls) parts.push(`-> ${call.name} ${cut(JSON.stringify(call.args))}`);
  for (const result of msg.results) parts.push(cut(result.content));
  return parts.join("\n");
}

/**
 * A short fingerprint of one message, to notice which was edited. The system prompt is left out:
 * changing the preset mid-chat changes none of the conversation.
 */
const fingerprint = (msg: Msg) => (msg.role === "system" ? "" : createHash("sha256").update(renderMessage(msg)).digest("hex").slice(0, 16));

/**
 * Appends the messages the transcript does not have yet. It only ever grows, so a placeholder's
 * #m number keeps pointing at the same message: Bionic's "introspection", with nothing but files.
 * If the user deleted or edited earlier messages, it is written again from scratch, and the summary
 * is dropped if it covered an edited message, since it describes a conversation that is gone.
 */
export async function updateTranscript(chatDir: string, msgs: Msg[]): Promise<void> {
  const folder = compactionFolder(chatDir);
  const countFile = join(folder, "transcript.json");
  const saved = await readFile(countFile, "utf-8")
    .then(text => JSON.parse(text) as { written?: number; hashes?: string[] })
    .catch(() => ({}) as { written?: number; hashes?: string[] });
  const written = Number(saved.written) || 0;
  const last = msgs.length ? msgs[msgs.length - 1].n : 0;
  const hashes = msgs.map(fingerprint);
  // The first message that is not as it was written: edited, or deleted.
  let firstChanged = last < written ? last + 1 : Infinity;
  for (let i = 0; i < Math.min(written, last); i++) {
    if (saved.hashes?.[i] !== undefined && saved.hashes[i] !== hashes[i]) {
      firstChanged = i + 1;
      break;
    }
  }
  const rewritten = firstChanged !== Infinity;
  if (last === written && !rewritten) return;
  await mkdir(folder, { recursive: true });
  // Without a Project Folder the chat's folder is the project: keep the transcript out of `git add .`.
  await writeFile(join(chatDir, ".agent-toolkit", ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
  const file = join(folder, "transcript.md");
  if (rewritten) {
    await writeFile(file, `# Transcript of this chat\n\n${msgs.map(m => renderMessage(m)).join("\n\n")}\n\n`);
    // Editing the latest message, say, leaves a summary of much earlier ones as true as it was.
    const summaryFile = join(folder, "summary.json");
    const covered = await readFile(summaryFile, "utf-8")
      .then(text => Number(JSON.parse(text).coversUpTo) || 0)
      .catch(() => 0);
    if (firstChanged <= covered) await rm(summaryFile, { force: true });
  } else {
    const fresh = msgs.filter(m => m.n > written);
    const header = written === 0 ? "# Transcript of this chat\n\n" : "";
    await appendFile(file, `${header}${fresh.map(m => renderMessage(m)).join("\n\n")}\n\n`);
  }
  await writeFile(countFile, JSON.stringify({ written: last, hashes }));
}
