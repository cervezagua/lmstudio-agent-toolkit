import { runProcess } from "../../../shared/process";

/**
 * A few lines about the repository, added at the start of a chat. Without it the model has to spend
 * tool calls discovering which branch it is on and what is already modified, and it often just
 * assumes instead.
 */
export async function gitSnapshot(directory: string, signal?: AbortSignal): Promise<string | null> {
  const git = async (args: string[]) => {
    try {
      const result = await runProcess("git", ["-c", "core.quotepath=false", ...args], {
        cwd: directory,
        timeoutMs: 5000,
        signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", NO_COLOR: "1" },
      });
      return result.exitCode === 0 ? result.stdout.trim() : null;
    } catch {
      return null; // git missing or unusable; the snapshot is optional
    }
  };

  if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true") return null;

  const [branch, status, log] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["status", "--short"]),
    git(["log", "-5", "--date=short", "--pretty=format:%h %ad %s"]),
  ]);

  const lines: string[] = [];
  if (branch) lines.push(`Branch: ${branch}`);
  if (status !== null) {
    const changes = status ? capLines(status, 2000) : "(working tree clean)";
    lines.push(`Uncommitted changes:\n${changes}`);
  }
  if (log) lines.push(`Recent commits:\n${log}`);
  return lines.length > 0 ? lines.join("\n\n") : null;
}

/** Keeps a block under a character budget, saying how many lines were left out. */
function capLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept: string[] = [];
  let used = 0;
  const all = text.split(/\r?\n/);
  for (const line of all) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return `${kept.join("\n")}\n… and ${all.length - kept.length} more changed files`;
}
