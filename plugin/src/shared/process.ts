import { spawn } from "child_process";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import { truncate } from "./truncate";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

// LM Studio runs plugins inside an Electron utility process, which on Windows can hand us an
// environment with no PATHEXT. PATH is intact, but PowerShell relies on PATHEXT to turn a bare
// "node" into "node.exe" and has no fallback, so every command fails with "is not recognized".
// cmd.exe and Node's own spawn() both fall back to a built-in list when PATHEXT is missing or empty,
// which is why git-tools kept working while our PowerShell-based shell did not. Restore the four
// extensions that make programs runnable; deliberately not the
// full Windows default, which also includes script types like .JS and .VBS that Windows would hand
// to the script host.
const FALLBACK_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// The macOS version of the same problem: an app started from the Dock or Finder gets its PATH from
// launchd, usually just /usr/bin:/bin:/usr/sbin:/sbin. Homebrew installs to /opt/homebrew/bin
// (Apple Silicon) or /usr/local/bin (Intel), so gh, rg, node and the project checkers would all look
// missing: the gh_* tools would silently disappear and the diagnostics would find nothing. Put back
// the ones that exist and are not already listed, ahead of the rest as the user's own terminal has
// them (brew shellenv and /etc/paths both do), without removing or reordering anything the host gave.
const MACOS_EXTRA_PATH = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];

function withMacosPath(path: string | undefined): string | undefined {
  const dirs = (path ?? "").split(delimiter).filter(Boolean);
  const missing = MACOS_EXTRA_PATH.filter(dir => !dirs.includes(dir) && existsSync(dir));
  return missing.length ? [...missing, ...dirs].join(delimiter) : path;
}

/**
 * The environment to give a spawned command: the plugin's own, with a usable PATHEXT on Windows and
 * Homebrew's folders on the PATH on macOS.
 */
export function commandEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (process.platform === "win32" && !env.PATHEXT?.trim()) env.PATHEXT = FALLBACK_PATHEXT;
  if (process.platform === "darwin") env.PATH = withMacosPath(env.PATH);
  return env;
}

const executableCache = new Map<string, string | null>();

/** Finds an executable on PATH (honouring PATHEXT on Windows). Returns null if absent. */
export function findExecutable(name: string): string | null {
  if (executableCache.has(name)) return executableCache.get(name)!;
  // Through commandEnv, so a host that supplies no PATHEXT (or an empty one) does not leave us with
  // an empty extension list, which would report every executable as missing — git-tools would then
  // quietly drop its gh_* tools because it could not find gh.
  // The PATH comes from commandEnv too, so a lookup sees the same folders a command will run with.
  // process.env is case-insensitive on Windows, but a copy of it is not, and there the variable is
  // usually "Path": reading env.PATH from the copy would find nothing and report every program
  // missing.
  const env = commandEnv();
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? "").split(";").filter(Boolean).map(e => e.toLowerCase())]
      : [""];
  let found: string | null = null;
  outer: for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate) && (ext !== "" || process.platform !== "win32")) {
        found = candidate;
        break outer;
      }
    }
  }
  executableCache.set(name, found);
  return found;
}

function killTree(pid: number) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }
}

/**
 * Runs a process to completion. Never rejects for a non-zero exit code; the caller decides what
 * that means. Rejects only if the executable cannot be started.
 */
export function runProcess(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? commandEnv(),
      windowsHide: true,
      detached: process.platform !== "win32", // own process group so killTree can reach children
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      if (child.pid) killTree(child.pid);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", error => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", exitCode => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut, aborted });
    });

    // A process can exit before we finish writing (e.g. a command that fails immediately), which
    // makes the write fail with EPIPE. That is not an error worth surfacing: the exit code and
    // output still arrive through the "close" handler above.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}

/** Formats a RunResult as compact text for the model. */
export function formatRunResult(result: RunResult, maxChars: number) {
  const parts: string[] = [];
  if (result.timedOut) parts.push("[process timed out and was killed]");
  if (result.aborted) parts.push("[process was cancelled]");
  parts.push(`exit_code: ${result.exitCode ?? "none"}`);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) parts.push(`stdout:\n${truncate(stdout, maxChars)}`);
  if (stderr) parts.push(`stderr:\n${truncate(stderr, Math.max(2000, Math.floor(maxChars / 2)))}`);
  if (!stdout && !stderr) parts.push("(no output)");
  return parts.join("\n");
}
