import { spawn } from "child_process";
import { commandEnv } from "../../../shared/process";
import { randomBytes } from "crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { ToolError } from "../../../shared/errors";
import { truncate } from "../../../shared/truncate";

export interface TaskRecord {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  logFile: string;
}

export type TaskState = "running" | "exited" | "gone";

/** The most recent output task_wait keeps, and matches "until" against. */
const WAIT_WINDOW_BYTES = 64 * 1024;

/** Waits `ms`, or less if the signal aborts. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Bytes `start` to `end` of a file, as text. */
async function readRange(file: string, start: number, end: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

/** True while the OS still has a process with this id. */
export function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM"; // exists but owned by someone else
  }
}

export function taskState(task: TaskRecord): TaskState {
  if (task.exitCode !== null) return "exited";
  return isAlive(task.pid) ? "running" : "gone";
}

/**
 * Background commands whose output is streamed to a log file, so a long build or dev server can
 * keep running between tool calls. The index file lets tasks survive a plugin reload.
 */
export class TaskManager {
  constructor(private readonly directory: string) {}

  /**
   * Index changes run one at a time. Without this, two tasks starting together would each read the
   * index, add themselves and write it back, losing one of the two, and their renames would collide
   * (EPERM on Windows).
   */
  private queue: Promise<unknown> = Promise.resolve();

  private withIndexLock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => {});
    return result;
  }

  private get indexFile() {
    return join(this.directory, "tasks.json");
  }

  private async readIndex(): Promise<TaskRecord[]> {
    try {
      const text = await readFile(this.indexFile, "utf-8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error: any) {
      // Missing is normal; unparsable means a write was interrupted, and an empty list is a better
      // answer than an exception thrown from a background process-exit handler.
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  private async writeIndex(tasks: TaskRecord[]) {
    await mkdir(this.directory, { recursive: true });
    // Write, then rename: a reader never sees a half-written index.
    const temporary = `${this.indexFile}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(tasks, null, 2), "utf-8");
    try {
      // Windows can refuse a rename while another process has the target open (antivirus, an
      // editor, a reader): retry briefly, then fall back to writing in place.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, this.indexFile);
          return;
        } catch (error: any) {
          const retryable = error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
          if (!retryable || attempt >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
    } catch {
      await writeFile(this.indexFile, JSON.stringify(tasks, null, 2), "utf-8");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async list(): Promise<TaskRecord[]> {
    return (await this.readIndex()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async get(id: string): Promise<TaskRecord> {
    const task = (await this.readIndex()).find(t => t.id === id);
    if (!task) throw new ToolError(`No background task "${id}". Use task_list to see the current tasks.`);
    return task;
  }

  private async update(id: string, patch: Partial<TaskRecord>) {
    await this.withIndexLock(async () => {
      const tasks = await this.readIndex();
      const index = tasks.findIndex(t => t.id === id);
      if (index === -1) return;
      tasks[index] = { ...tasks[index], ...patch };
      await this.writeIndex(tasks);
    });
  }

  async start(shell: { file: string; args: (command: string) => string[] }, command: string, cwd: string, name?: string) {
    await mkdir(this.directory, { recursive: true });
    const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
    const logFile = join(this.directory, `${id}.log`);
    const handle = await open(logFile, "a");
    let started = false;
    try {
      const child = spawn(shell.file, shell.args(command), {
        cwd,
        env: commandEnv(),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", handle.fd, handle.fd],
      });
      // Listened for from the start, so a command that ends at once is still recorded as ended.
      const exited = new Promise<{ code: number; at: string }>(resolve => {
        child.once("exit", code => resolve({ code: code ?? -1, at: new Date().toISOString() }));
      });
      // A process that cannot be started (no such shell, no such folder) says so with an "error"
      // event, not an exception. With nothing listening, Node throws that event in the plugin's own
      // process; and the task would have been listed as started when it never ran.
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      }).catch(async (error: any) => {
        // "Not found" is reported for a missing folder as well as for a missing program.
        const folderExists = await stat(cwd).then(
          info => info.isDirectory(),
          () => false,
        );
        const why = !folderExists
          ? `the folder ${cwd} does not exist`
          : error?.code === "ENOENT"
            ? `the shell "${shell.file}" was not found. Pick another Shell in the plugin's settings`
            : String(error?.message ?? error);
        throw new ToolError(`The task could not be started: ${why}.`);
      });
      child.on("error", () => {}); // a later failure, such as a signal that cannot be delivered, is not fatal
      started = true;
      const task: TaskRecord = {
        id,
        name: name?.trim() || command.slice(0, 60),
        command,
        cwd,
        pid: child.pid ?? null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        logFile,
      };
      await this.withIndexLock(async () => this.writeIndex([...(await this.readIndex()), task]));
      // Nothing awaits this, so a failure here must not become an unhandled rejection.
      void exited.then(({ code, at }) => this.update(id, { exitCode: code, endedAt: at })).catch(() => {});
      child.unref();
      return task;
    } finally {
      await handle.close();
      // Nothing ran, so there is no output to keep. Only once the handle is closed: Windows will not
      // remove a file that is still open.
      if (!started) await rm(logFile, { force: true }).catch(() => {});
    }
  }

  /** Reads the log from `offset` bytes; returns the next offset so the model can poll for more. */
  async output(id: string, offset: number, maxChars: number) {
    const task = await this.get(id);
    let size = 0;
    try {
      size = (await stat(task.logFile)).size;
    } catch {
      size = 0;
    }
    const start = Math.max(0, Math.min(offset, size));
    let text = "";
    if (size > start) {
      const handle = await open(task.logFile, "r");
      try {
        const length = size - start;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        text = buffer.toString("utf-8");
      } finally {
        await handle.close();
      }
    }
    return { task, state: taskState(task), text: truncate(text, maxChars), nextOffset: size, totalBytes: size };
  }

  /**
   * Waits for a task to finish, or for its output (from `offset`) to match `until`, checking every
   * `pollMs`. Nothing is generated while a tool waits, so a model can wait out a long download for
   * free and carry on when it is done.
   */
  async wait(
    id: string,
    options: { offset: number; until?: RegExp; timeoutMs: number; pollMs?: number; signal?: AbortSignal; onTick?: (elapsedMs: number) => void },
  ): Promise<{ task: TaskRecord; state: TaskState; matched: string | null; timedOut: boolean; aborted: boolean; text: string; nextOffset: number }> {
    const started = Date.now();
    const pollMs = options.pollMs ?? 2000;
    // Only the new bytes are read on each check, and "until" runs over the recent text alone, so a
    // chatty log costs little however long the wait, and a slow pattern stays bounded.
    let offset = options.offset;
    let recent = "";
    let goneOnce = false;
    for (;;) {
      // The state before the read: a task that ended in between still has its last lines read.
      let task = await this.get(id);
      let state = taskState(task);
      if (state === "gone" && !goneOnce) {
        // Just exited, and its exit code may not be saved yet: look again shortly.
        goneOnce = true;
        await sleep(300, options.signal);
        task = await this.get(id);
        state = taskState(task);
      }
      const size = await stat(task.logFile).then(
        info => info.size,
        () => 0,
      );
      if (size > offset) {
        const from = Math.max(offset, size - WAIT_WINDOW_BYTES);
        recent = (recent + (await readRange(task.logFile, from, size))).slice(-WAIT_WINDOW_BYTES);
        offset = size;
      }
      const matched = options.until ? (options.until.exec(recent)?.[0] ?? null) : null;
      const elapsed = Date.now() - started;
      const done = state !== "running" || matched !== null;
      const timedOut = !done && elapsed >= options.timeoutMs;
      const aborted = !done && !timedOut && Boolean(options.signal?.aborted);
      if (done || timedOut || aborted) return { task, state, matched, timedOut, aborted, text: recent, nextOffset: offset };
      options.onTick?.(elapsed);
      await sleep(Math.min(pollMs, Math.max(50, options.timeoutMs - elapsed)), options.signal);
    }
  }

  async stop(id: string) {
    const task = await this.get(id);
    const state = taskState(task);
    if (state !== "running") return { task, state, killed: false };
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(task.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-task.pid!, "SIGKILL");
      } catch {
        try {
          process.kill(task.pid!, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    await this.update(id, { exitCode: -1, endedAt: new Date().toISOString() });
    return { task, state, killed: true };
  }

  /** Drops finished tasks from the index (logs are left on disk). */
  async prune() {
    return this.withIndexLock(async () => {
      const tasks = await this.readIndex();
      const keep = tasks.filter(t => taskState(t) === "running");
      if (keep.length !== tasks.length) await this.writeIndex(keep);
      return tasks.length - keep.length;
    });
  }
}

export function formatTaskLine(task: TaskRecord): string {
  const state = taskState(task);
  const runtime = Math.round(((task.endedAt ? Date.parse(task.endedAt) : Date.now()) - Date.parse(task.startedAt)) / 1000);
  const status = state === "running" ? `running ${runtime}s` : state === "exited" ? `exited ${task.exitCode}` : "gone";
  return `${task.id}  [${status}]  ${task.name}`;
}
