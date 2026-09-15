import { spawn } from "child_process";
import { mkdir, open, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import { ToolError } from "../shared/errors";
import { truncate } from "../shared/truncate";

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

  private get indexFile() {
    return join(this.directory, "tasks.json");
  }

  private async readIndex(): Promise<TaskRecord[]> {
    try {
      return JSON.parse(await readFile(this.indexFile, "utf-8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeIndex(tasks: TaskRecord[]) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.indexFile, JSON.stringify(tasks, null, 2), "utf-8");
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
    const tasks = await this.readIndex();
    const index = tasks.findIndex(t => t.id === id);
    if (index === -1) return;
    tasks[index] = { ...tasks[index], ...patch };
    await this.writeIndex(tasks);
  }

  async start(shell: { file: string; args: (command: string) => string[] }, command: string, cwd: string, name?: string) {
    await mkdir(this.directory, { recursive: true });
    const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
    const logFile = join(this.directory, `${id}.log`);
    const handle = await open(logFile, "a");
    try {
      const child = spawn(shell.file, shell.args(command), {
        cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", handle.fd, handle.fd],
      });
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
      await this.writeIndex([...(await this.readIndex()), task]);
      child.on("exit", code => {
        void this.update(id, { exitCode: code ?? -1, endedAt: new Date().toISOString() });
      });
      child.unref();
      return task;
    } finally {
      await handle.close();
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
    const tasks = await this.readIndex();
    const keep = tasks.filter(t => taskState(t) === "running");
    if (keep.length !== tasks.length) await this.writeIndex(keep);
    return tasks.length - keep.length;
  }
}

export function formatTaskLine(task: TaskRecord): string {
  const state = taskState(task);
  const runtime = Math.round(((task.endedAt ? Date.parse(task.endedAt) : Date.now()) - Date.parse(task.startedAt)) / 1000);
  const status = state === "running" ? `running ${runtime}s` : state === "exited" ? `exited ${task.exitCode}` : "gone";
  return `${task.id}  [${status}]  ${task.name}`;
}
