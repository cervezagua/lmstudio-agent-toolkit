import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { randomUUID } from "crypto";

export interface ShellSpec {
  file: string;
  /** Arguments that make the shell read commands from stdin. */
  replArgs: string[];
  kind: "powershell" | "posix";
}

export interface SessionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * A single long-lived shell process. Commands run one after another in it, so the working
 * directory, environment variables and activated virtualenvs persist between tool calls.
 *
 * Each command is followed by a marker that carries the exit code, which is how we know where one
 * command's output ends. On timeout the shell is killed and a fresh one starts on the next call.
 */
export class ShellSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private busy = false;

  constructor(
    private readonly spec: ShellSpec,
    private readonly cwd: string,
  ) {}

  get isRunning() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  private start() {
    const child = spawn(this.spec.file, this.spec.replArgs, {
      cwd: this.cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.on("error", () => this.dispose());
    child.on("exit", () => (this.child = null));
    this.child = child;
    return child;
  }

  /** Wraps a command so its end and exit code are detectable in the output stream. */
  private wrap(command: string, marker: string): string {
    if (this.spec.kind === "powershell") {
      return [
        "$global:LASTEXITCODE=0",
        command,
        `$__ok=$?; $__code=if ($__ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }`,
        `[Console]::Out.WriteLine("${marker}:$__code"); [Console]::Out.Flush()`,
        `[Console]::Error.WriteLine("${marker}"); [Console]::Error.Flush()`,
        "",
      ].join("\n");
    }
    return [
      command,
      "__code=$?",
      String.raw`printf '${marker}:%s\n' "$__code"`,
      String.raw`printf '${marker}\n' 1>&2`,
      "",
    ].join("\n");
  }

  async exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<SessionResult> {
    if (this.busy) {
      throw new Error("The shell session is already running a command. Wait for it, or use task_run for long jobs.");
    }
    this.busy = true;
    try {
      const child = this.isRunning ? this.child! : this.start();
      const marker = `__LMS_${randomUUID().replace(/-/g, "")}__`;
      const stdoutMarker = new RegExp(String.raw`${marker}:(-?\d+)` + String.raw`\r?\n?`);
      let stdout = "";
      let stderr = "";

      return await new Promise<SessionResult>(resolve => {
        let settled = false;
        const finish = (result: SessionResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdout.off("data", onStdout);
          child.stderr.off("data", onStderr);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };

        const done = (exitCode: number | null, timedOut = false) => {
          // Give stderr a moment to arrive; it is a separate stream from stdout.
          setTimeout(() => {
            finish({
              stdout: stdout.replace(stdoutMarker, "").trimEnd(),
              stderr: stderr.split(marker)[0].trimEnd(),
              exitCode,
              timedOut,
            });
          }, 50);
        };

        const onStdout = (chunk: string) => {
          stdout += chunk;
          const match = stdoutMarker.exec(stdout);
          if (match) done(Number(match[1]));
        };
        const onStderr = (chunk: string) => (stderr += chunk);

        const onAbort = () => {
          this.dispose();
          done(null, false);
        };

        const timer = setTimeout(() => {
          this.dispose(); // a hung command would block every later call
          done(null, true);
        }, timeoutMs);

        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("exit", () => done(child.exitCode));

        child.stdin.write(this.wrap(command, marker));
      });
    } finally {
      this.busy = false;
    }
  }

  /** Returns the session's current working directory (useful after the model cd's around). */
  async currentDirectory(timeoutMs = 10_000): Promise<string | null> {
    const command = this.spec.kind === "powershell" ? "(Get-Location).Path" : "pwd";
    const result = await this.exec(command, timeoutMs).catch(() => null);
    const line = result?.stdout.trim().split(/\r?\n/).pop();
    return line || null;
  }

  dispose() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** One session per root directory + shell, reused across predictions in this plugin process. */
const sessions = new Map<string, ShellSession>();

export function getSession(spec: ShellSpec, cwd: string): ShellSession {
  const key = `${spec.file}::${cwd}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new ShellSession(spec, cwd);
  sessions.set(key, session);
  return session;
}

export function resetSession(spec: ShellSpec, cwd: string) {
  const key = `${spec.file}::${cwd}`;
  sessions.get(key)?.dispose();
  sessions.delete(key);
}
