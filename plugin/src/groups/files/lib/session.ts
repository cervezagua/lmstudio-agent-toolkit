import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { ToolError } from "../../../shared/errors";
import { CappedOutput, commandEnv, killTree, resolveProgram } from "../../../shared/process";
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
  /** When getSession last handed this session out, for closing the ones no chat uses any more. */
  lastUsed = Date.now();

  constructor(
    private readonly spec: ShellSpec,
    private readonly cwd: string,
  ) {}

  get isBusy() {
    return this.busy;
  }

  get isRunning() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  private start() {
    const child = spawn(resolveProgram(this.spec.file), this.spec.replArgs, {
      cwd: this.cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: commandEnv({ NO_COLOR: "1", TERM: "dumb" }),
    });
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    // The shell can die between commands; writing to its stdin then fails with EPIPE, which the
    // next exec() handles by starting a fresh shell.
    child.stdin.on("error", () => {});
    // Only while this is still the session's shell: a shell killed after a timeout exits a moment
    // later, and by then a new one may have taken its place, which must not be forgotten or killed.
    child.on("error", () => {
      if (this.child === child) this.dispose();
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
    return child;
  }

  /** Wraps a command so its end and exit code are detectable in the output stream. */
  private wrap(command: string, marker: string): string {
    if (this.spec.kind === "powershell") {
      return [
        "$global:LASTEXITCODE=0; $__scopedOk=$null",
        command,
        // PowerShell reading commands from stdin keeps waiting after a string that spans lines (a
        // multi-line `python -c "..."`) until a blank line ends the statement.
        "",
        // A command run in another folder saved its own status: here $? would be Pop-Location's.
        `$__ok=$?; if ($null -ne $__scopedOk) { $__ok=$__scopedOk }`,
        `$__code=if ($__ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }`,
        // `node app.js; echo done` ends well even when node failed: say so, or the failure is invisible.
        `if ($__ok -and $global:LASTEXITCODE) { [Console]::Error.WriteLine("[a program in this command exited with code $($global:LASTEXITCODE); exit_code is the last statement's]") }`,
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
      throw new ToolError("The shell session is already running a command. Wait for it, or use task_run for long jobs.");
    }
    this.busy = true;
    try {
      const child = this.isRunning ? this.child! : this.start();
      const marker = `__LMS_${randomUUID().replace(/-/g, "")}__`;
      const stdoutMarker = new RegExp(String.raw`${marker}:(-?\d+)` + String.raw`\r?\n?`);
      const stdout = new CappedOutput();
      const stderr = new CappedOutput();
      // The marker ends the output, so only the last few characters need searching for it.
      const markerWindow = marker.length + 64;

      return await new Promise<SessionResult>((resolve, reject) => {
        let settled = false;
        let stderrWait: ReturnType<typeof setTimeout> | undefined;
        let exitCode: number | null = null;
        let timedOut = false;
        // Everything this command put on the long-lived shell comes off again here. A listener left
        // behind keeps the command's whole output alive for as long as the shell runs.
        const release = () => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          clearTimeout(stderrWait);
          child.stdout.off("data", onStdout);
          child.stderr.off("data", onStderr);
          child.off("exit", onExit);
          child.off("error", onError);
          signal?.removeEventListener("abort", onAbort);
          return true;
        };
        const finish = (result: SessionResult) => {
          if (release()) resolve(result);
        };

        const collect = () =>
          finish({
            stdout: stdout.text().replace(stdoutMarker, "").trimEnd(),
            // Anything up to an earlier command's marker is that command's, arrived late.
            stderr: stderr.text().split(marker)[0].replace(/^[\s\S]*__LMS_[0-9a-f]{32}__\r?\n?/, "").trimEnd(),
            exitCode,
            timedOut,
          });
        const stderrDone = () => stderr.recent(markerWindow).includes(marker);

        // stderr is a separate stream from stdout, and its end can come after stdout's: wait for its
        // marker too, though not for long (a shell stopped or timed out never prints it).
        // The first outcome stands: a shell killed for timing out exits a moment later, and that exit
        // must not turn "timed out" into an ordinary end while stderr is still being waited for.
        let decided = false;
        const done = (code: number | null, timeout = false, waitMs = 50) => {
          if (decided) return;
          decided = true;
          exitCode = code;
          timedOut = timeout;
          if (stderrDone()) return collect();
          clearTimeout(stderrWait);
          stderrWait = setTimeout(collect, waitMs);
        };

        const onStdout = (chunk: string) => {
          stdout.push(chunk);
          const match = stdoutMarker.exec(stdout.recent(markerWindow));
          if (match) done(Number(match[1]), false, 2000);
        };
        const onStderr = (chunk: string) => {
          stderr.push(chunk);
          if (stderrWait && stderrDone()) collect();
        };

        const onAbort = () => {
          this.dispose();
          done(null, false);
        };

        const timer = setTimeout(() => {
          this.dispose(); // a hung command would block every later call
          done(null, true);
        }, timeoutMs);

        const onExit = () => done(child.exitCode);
        // A shell that cannot be started says so with "error" and never exits. Without this the
        // command waited out its whole timeout and was then reported as having timed out.
        const onError = (error: NodeJS.ErrnoException) => {
          if (!release()) return;
          const why =
            error.code === "ENOENT"
              ? `"${this.spec.file}" was not found on PATH. Pick another Shell in the plugin's settings`
              : error.message;
          reject(new ToolError(`The shell could not be started: ${why}.`));
        };

        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("exit", onExit);
        child.on("error", onError);

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
    if (!child || child.pid === undefined) return; // no shell, or one that never started
    killTree(child.pid);
  }
}

/** One session per root directory + shell, reused across predictions in this plugin process. */
const sessions = new Map<string, ShellSession>();

/** A session no chat has used for this long is closed: every chat without a Project Folder has its own. */
export const SESSION_IDLE_MS = 15 * 60_000;

export function getSession(spec: ShellSpec, cwd: string, now = Date.now()): ShellSession {
  for (const [key, session] of sessions) {
    if (!session.isBusy && now - session.lastUsed > SESSION_IDLE_MS) {
      session.dispose();
      sessions.delete(key);
    }
  }
  const key = `${spec.file}::${cwd}`;
  let session = sessions.get(key);
  if (!session) {
    session = new ShellSession(spec, cwd);
    sessions.set(key, session);
  }
  session.lastUsed = now;
  return session;
}

export function resetSession(spec: ShellSpec, cwd: string) {
  const key = `${spec.file}::${cwd}`;
  sessions.get(key)?.dispose();
  sessions.delete(key);
}
