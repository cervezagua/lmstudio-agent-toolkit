import { createHash } from "crypto";

/** Same command, same result, this many times in a row: running it again is refused. */
export const REPEAT_LIMIT = 3;

const hash = (text: string) => createHash("sha1").update(text).digest("hex");

/**
 * Notices a small model running the same command over and over, getting the same output each time
 * (a real chat ran one Get-Service six times in a row and never moved on). LM Studio's own loop has
 * no guard for this, and agent-toolkit-loop's leaves run_command alone, since rerunning a command is
 * often right: so the tool keeps count itself, per chat.
 *
 * Only an unbroken run counts: a different command, or any file change through the tools, starts it
 * over, so rerunning the tests after an edit is never refused.
 */
export class CommandRepeats {
  private last: { key: string; result: string; count: number } | null = null;

  /** Why running `key` again is refused, or null when it may run. */
  refusal(key: string): string | null {
    if (!this.last || this.last.key !== key || this.last.count < REPEAT_LIMIT) return null;
    return (
      `You already ran this exact command ${this.last.count} times in a row and got the same output each time, so it was not run again. ` +
      "Use what it showed, or take the next step. To wait for something to change, use task_run and task_wait, or pause first in a different command."
    );
  }

  /** Records a run; returns how many times in a row it has now given this same result. */
  record(key: string, result: string): number {
    const fingerprint = hash(result);
    if (this.last && this.last.key === key && this.last.result === fingerprint) this.last.count++;
    else this.last = { key, result: fingerprint, count: 1 };
    return this.last.count;
  }

  /** A file changed: the same command may now give a different result. */
  changed(): void {
    this.last = null;
  }
}

/** One count per chat: a command run in one chat says nothing about another. */
const chats = new Map<string, CommandRepeats>();

/** The command repeats of the chat with this working directory. */
export function commandRepeatsFor(workingDirectory: string): CommandRepeats {
  let repeats = chats.get(workingDirectory);
  if (!repeats) chats.set(workingDirectory, (repeats = new CommandRepeats()));
  return repeats;
}
