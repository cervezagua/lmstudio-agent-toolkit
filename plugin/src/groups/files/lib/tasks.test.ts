import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskManager } from "./tasks";

// Node itself is the "shell": the command is a script for `node -e`.
const node = { file: process.execPath, args: (script: string) => ["-e", script] };

describe("TaskManager.wait", () => {
  let dir: string;
  let tasks: TaskManager;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tasks-"));
    tasks = new TaskManager(join(dir, "state"));
  });
  afterAll(async () => {
    // Windows takes a moment to release a stopped task's folder.
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  // A dev server's ready line followed by a flood of request logs: the line must still be found.
  it("finds a line printed long before the end of the output", async () => {
    const task = await tasks.start(
      node,
      "console.log('server ready'); process.stdout.write('GET / 200\\n'.repeat(20000)); setTimeout(() => {}, 3000)",
      dir,
    );
    await new Promise(resolve => setTimeout(resolve, 800));
    const result = await tasks.wait(task.id, { offset: 0, until: /server ready/, timeoutMs: 5000, pollMs: 100 });
    expect(result.matched).toBe("server ready");
    expect(result.timedOut).toBe(false);
    await tasks.stop(task.id);
  }, 20000);

  it("reads to the end once the task exits, and clamps an offset past it", async () => {
    const task = await tasks.start(node, "console.log('done')", dir);
    const result = await tasks.wait(task.id, { offset: 10_000_000, timeoutMs: 5000, pollMs: 100 });
    expect(result.state).toBe("exited");
    expect(result.nextOffset).toBe((await stat(task.logFile)).size);
  }, 20000);

  it("stops waiting at once when the signal aborts", async () => {
    const task = await tasks.start(node, "setTimeout(() => {}, 5000)", dir);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started = Date.now();
    const result = await tasks.wait(task.id, { offset: 0, until: /never/, timeoutMs: 60_000, pollMs: 2000, signal: stop.signal });
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
    await tasks.stop(task.id);
  }, 20000);
});
