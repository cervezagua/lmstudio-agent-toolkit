import { basename, relative } from "path";
import { ToolError } from "../shared/errors";
import { resolveInside } from "../shared/paths";
import { runProcess } from "../shared/process";
import { truncate } from "../shared/truncate";

const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never", // Git Credential Manager would otherwise open a sign-in window
  GIT_PAGER: "cat",
  PAGER: "cat",
  GH_PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
  NO_COLOR: "1",
  // Commit editor must never open; messages are always passed explicitly.
  GIT_EDITOR: "true",
};

export interface CliOptions {
  cwd: string;
  maxOutputChars: number;
  signal?: AbortSignal;
  stdin?: string;
  timeoutMs?: number;
}

/**
 * Runs git/gh without a shell (arguments cannot inject commands). Returns stdout on success and
 * throws a ToolError with stderr on failure, so the model sees a clean "Error: ..." message.
 */
export async function runCli(executable: string, args: string[], options: CliOptions): Promise<string> {
  let result;
  try {
    result = await runProcess(executable, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: options.signal,
      stdin: options.stdin,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new ToolError(`"${executable}" is not installed or not on PATH.`);
    throw error;
  }
  // Name the subcommand in errors, skipping leading `-c key=value` style global options.
  const subcommand = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c") ?? "";
  const label = `${basename(executable).replace(/\.exe$/i, "")} ${subcommand}`.trim();
  if (result.timedOut) throw new ToolError(`${label} timed out.`);
  if (result.exitCode !== 0) {
    const message = (result.stderr.trim() || result.stdout.trim() || "no output").split(/\r?\n/).slice(0, 20).join("\n");
    throw new ToolError(`${label} failed (exit ${result.exitCode}): ${message}`);
  }
  const output = result.stdout.trimEnd();
  return output ? truncate(output, options.maxOutputChars) : "(no output)";
}

/** Rejects values that git/gh would parse as options (e.g. a "ref" of "--output=/etc/x"). */
export function assertNotOption(value: string, label: string): string {
  if (value.trim().startsWith("-")) throw new ToolError(`${label} must not start with "-".`);
  if (!value.trim()) throw new ToolError(`${label} must not be empty.`);
  return value.trim();
}

/** Validates a path is inside the repository and returns it relative to the repo root (for pathspecs). */
export function repoPath(repo: string, path: string): string {
  const rel = relative(repo, resolveInside(repo, path));
  return rel === "" ? "." : rel;
}
