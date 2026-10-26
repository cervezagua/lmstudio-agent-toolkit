import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
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
 * Appends the messages the transcript does not have yet. It only ever grows, so a placeholder's
 * #m number keeps pointing at the same message: Bionic's "introspection", with nothing but files.
 * If the chat got shorter (the user deleted or edited messages), it is written again from scratch.
 */
export async function updateTranscript(chatDir: string, msgs: Msg[]): Promise<void> {
  const folder = compactionFolder(chatDir);
  const countFile = join(folder, "transcript.json");
  const written = await readFile(countFile, "utf-8")
    .then(text => Number(JSON.parse(text).written) || 0)
    .catch(() => 0);
  const last = msgs.length ? msgs[msgs.length - 1].n : 0;
  if (last === written) return;
  await mkdir(folder, { recursive: true });
  const file = join(folder, "transcript.md");
  if (last < written) {
    await writeFile(file, `# Transcript of this chat\n\n${msgs.map(m => renderMessage(m)).join("\n\n")}\n\n`);
  } else {
    const fresh = msgs.filter(m => m.n > written);
    const header = written === 0 ? "# Transcript of this chat\n\n" : "";
    await appendFile(file, `${header}${fresh.map(m => renderMessage(m)).join("\n\n")}\n\n`);
  }
  await writeFile(countFile, JSON.stringify({ written: last }));
}
