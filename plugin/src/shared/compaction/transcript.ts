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

/** A fingerprint of the messages up to number `upTo`, to notice when earlier ones were edited. */
const fingerprint = (msgs: Msg[], upTo: number) => {
  const hash = createHash("sha256");
  for (const msg of msgs) if (msg.n <= upTo) hash.update(`${renderMessage(msg)}\u0000`);
  return hash.digest("hex");
};

/**
 * Appends the messages the transcript does not have yet. It only ever grows, so a placeholder's
 * #m number keeps pointing at the same message: Bionic's "introspection", with nothing but files.
 * If the user deleted or edited earlier messages, it is written again from scratch, and the summary
 * and the remembered cut are dropped, since they describe a conversation that is gone.
 */
export async function updateTranscript(chatDir: string, msgs: Msg[]): Promise<void> {
  const folder = compactionFolder(chatDir);
  const countFile = join(folder, "transcript.json");
  const saved = await readFile(countFile, "utf-8")
    .then(text => JSON.parse(text) as { written?: number; hash?: string })
    .catch(() => ({}) as { written?: number; hash?: string });
  const written = Number(saved.written) || 0;
  const last = msgs.length ? msgs[msgs.length - 1].n : 0;
  const rewritten = last < written || (saved.hash !== undefined && fingerprint(msgs, written) !== saved.hash);
  if (last === written && !rewritten) return;
  await mkdir(folder, { recursive: true });
  // Without a Project Folder the chat's folder is the project: keep the transcript out of `git add .`.
  await writeFile(join(chatDir, ".agent-toolkit", ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
  const file = join(folder, "transcript.md");
  if (rewritten) {
    await writeFile(file, `# Transcript of this chat\n\n${msgs.map(m => renderMessage(m)).join("\n\n")}\n\n`);
    await rm(join(folder, "summary.json"), { force: true });
  } else {
    const fresh = msgs.filter(m => m.n > written);
    const header = written === 0 ? "# Transcript of this chat\n\n" : "";
    await appendFile(file, `${header}${fresh.map(m => renderMessage(m)).join("\n\n")}\n\n`);
  }
  await writeFile(countFile, JSON.stringify({ written: last, hash: fingerprint(msgs, last) }));
}
