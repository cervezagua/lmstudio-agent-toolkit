import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupStore } from "./backups";
import { applyEdits, insertLines, previewDiff } from "./edit";
import { editNotebook, parseNotebook, renderNotebook, toSourceLines } from "./notebook";
import { getSession, resetSession, type ShellSpec } from "./session";
import { TaskManager, taskState } from "./tasks";
import { ToolError } from "../../../shared/errors";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coder-advanced-"));
});

afterEach(async () => {
  // A shell session keeps its working directory open on Windows, so retry the cleanup.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

describe("applyEdits", () => {
  it("applies edits in order, each seeing the previous result", () => {
    const result = applyEdits("a b c", [
      { old_string: "a", new_string: "x" },
      { old_string: "x b", new_string: "y" },
    ]);
    expect(result).toEqual({ content: "y c", replacements: 2 });
  });

  it("writes nothing when a later edit fails, naming the step", () => {
    expect(() =>
      applyEdits("a b", [
        { old_string: "a", new_string: "x" },
        { old_string: "zzz", new_string: "y" },
      ]),
    ).toThrow(/Edit 2 of 2 failed:.*No changes were written/s);
    expect(() => applyEdits("a", [])).toThrow(ToolError);
  });
});

describe("insertLines", () => {
  it("inserts at the top, middle and end, keeping CRLF", () => {
    expect(insertLines("a\nb", 0, "top")).toBe("top\na\nb");
    expect(insertLines("a\nb", 1, "mid")).toBe("a\nmid\nb");
    expect(insertLines("a\nb", 2, "end")).toBe("a\nb\nend");
    expect(insertLines("a\r\nb", 1, "mid")).toBe("a\r\nmid\r\nb");
    expect(insertLines("", 0, "only")).toBe("only");
  });

  it("rejects out-of-range lines", () => {
    expect(() => insertLines("a\nb", 5, "x")).toThrow(/out of range/);
  });
});

describe("previewDiff", () => {
  it("shows only the changed region with context", () => {
    const before = ["one", "two", "three", "four", "five"].join("\n");
    const after = ["one", "two", "CHANGED", "four", "five"].join("\n");
    expect(previewDiff(before, after)).toBe("  1\tone\n  2\ttwo\n- 3\tthree\n+ 3\tCHANGED\n  4\tfour\n  5\tfive");
    expect(previewDiff("same", "same")).toBe("(no changes)");
  });
});

describe("BackupStore", () => {
  it("restores previous content and removes files that did not exist", async () => {
    const store = new BackupStore(join(dir, "backups"));
    const file = join(dir, "a.txt");

    await writeFile(file, "original");
    await store.save(file, "original");
    await writeFile(file, "changed");
    expect(await store.restore(file)).toMatchObject({ restored: "content" });
    expect(await readFile(file, "utf-8")).toBe("original");

    // Restoring twice is refused: only the last change per file is kept.
    await expect(store.restore(file)).rejects.toThrow(/No undo history/);

    const created = join(dir, "new.txt");
    await store.save(created, null);
    await writeFile(created, "content");
    expect(await store.restore(created)).toMatchObject({ restored: "deleted" });
    await expect(readFile(created, "utf-8")).rejects.toThrow();
  });
});

describe("notebook", () => {
  const notebookJson = JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Title\n"], metadata: {} },
      { cell_type: "code", source: ["print(1)\n"], metadata: {}, outputs: [{ output_type: "stream", text: ["1\n"] }], execution_count: 3 },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });

  it("renders cells with outputs and rejects non-notebooks", () => {
    const notebook = parseNotebook(notebookJson);
    const rendered = renderNotebook(notebook);
    expect(rendered).toContain("[0] markdown");
    expect(rendered).toContain("# Title");
    expect(rendered).toContain("[outputs] stream: 1");
    expect(() => parseNotebook("not json")).toThrow(ToolError);
    expect(() => parseNotebook('{"foo":1}')).toThrow(/no cells array/);
  });

  it("splits source into notebook line format", () => {
    expect(toSourceLines("a\nb")).toEqual(["a\n", "b"]);
    expect(toSourceLines("x")).toEqual(["x"]);
  });

  it("replaces, inserts and deletes cells", () => {
    const notebook = parseNotebook(notebookJson);
    editNotebook(notebook, { index: 1, mode: "replace", source: "print(2)" });
    expect(notebook.cells[1].source).toEqual(["print(2)"]);
    expect(notebook.cells[1].outputs).toEqual([]); // stale output cleared
    expect(notebook.cells[1].execution_count).toBeNull();

    editNotebook(notebook, { index: 2, mode: "insert", source: "# end", cellType: "markdown" });
    expect(notebook.cells).toHaveLength(3);
    expect(notebook.cells[2]).toMatchObject({ cell_type: "markdown" });
    expect(notebook.cells[2].outputs).toBeUndefined();

    editNotebook(notebook, { index: 0, mode: "delete" });
    expect(notebook.cells).toHaveLength(2);
    expect(() => editNotebook(notebook, { index: 9, mode: "delete" })).toThrow(/out of range/);
    expect(() => editNotebook(notebook, { index: 0, mode: "insert" })).toThrow(/source is required/);
  });
});

describe("TaskManager", () => {
  const shell =
    process.platform === "win32"
      ? { file: "cmd.exe", args: (c: string) => ["/d", "/s", "/c", c] }
      : { file: "bash", args: (c: string) => ["-lc", c] };

  it("runs a command in the background, pages its output, and reports the exit code", async () => {
    const tasks = new TaskManager(join(dir, "tasks"));
    const script = process.platform === "win32" ? "echo first & echo second" : "echo first; echo second";
    const task = await tasks.start(shell, script, dir, "echo test");
    expect((await tasks.list()).map(t => t.id)).toEqual([task.id]);

    let text = "";
    let offset = 0;
    for (let i = 0; i < 40 && !text.includes("second"); i++) {
      const result = await tasks.output(task.id, offset, 10000);
      text += result.text;
      offset = result.nextOffset;
      if (result.state !== "running" && text.includes("second")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(text).toContain("first");
    expect(text).toContain("second");

    // Polling from the new offset returns nothing new.
    expect((await tasks.output(task.id, offset, 10000)).text).toBe("");
    const finished = await tasks.get(task.id);
    expect(taskState(finished)).not.toBe("running");
  });

  it("stops a long-running task and reports unknown ids", async () => {
    const tasks = new TaskManager(join(dir, "tasks"));
    const sleep = process.platform === "win32" ? "ping -n 60 127.0.0.1 > nul" : "sleep 60";
    const task = await tasks.start(shell, sleep, dir, "sleeper");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(taskState(await tasks.get(task.id))).toBe("running");
    expect(await tasks.stop(task.id)).toMatchObject({ killed: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(taskState(await tasks.get(task.id))).not.toBe("running");
    await expect(tasks.get("nope")).rejects.toThrow(/No background task/);
  });

  it("says so when the task cannot be started, and does not list it", async () => {
    // A process that cannot start reports it through an "error" event. With no listener that event
    // is thrown in the process itself, so this test would bring the whole test file down.
    const tasks = new TaskManager(join(dir, "tasks"));
    const missing = { file: "definitely-not-a-shell-xyz", args: (c: string) => [c] };
    await expect(tasks.start(missing, "echo hi", dir)).rejects.toThrow(ToolError);
    await expect(tasks.start(missing, "echo hi", dir)).rejects.toThrow(
      /^The task could not be started: the shell "definitely-not-a-shell-xyz" was not found\. Pick another Shell/,
    );
    // The same for a folder that is not there: on every system that is a failure to start.
    await expect(tasks.start(shell, "echo hi", join(dir, "no-such-folder"))).rejects.toThrow(
      /^The task could not be started: the folder .*no-such-folder does not exist\.$/,
    );

    expect(await tasks.list()).toEqual([]);
    expect((await readdir(join(dir, "tasks"))).filter(name => name.endsWith(".log"))).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 100)); // room for a stray "error" event to surface
  });

  it("records the exit of a command that ends at once", async () => {
    const tasks = new TaskManager(join(dir, "tasks"));
    const task = await tasks.start(shell, "exit 3", dir);
    for (let i = 0; i < 50 && (await tasks.get(task.id)).exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(await tasks.get(task.id)).toMatchObject({ exitCode: 3 });
  });
});

describe("ShellSession", () => {
  const spec: ShellSpec =
    process.platform === "win32"
      ? { file: "pwsh", replArgs: ["-NoProfile", "-NonInteractive", "-Command", "-"], kind: "powershell" }
      : { file: "bash", replArgs: ["-s"], kind: "posix" };

  afterEach(async () => {
    resetSession(spec, dir);
    await new Promise(resolve => setTimeout(resolve, 300)); // let the killed shell release the directory
  });

  it("keeps the working directory and variables between commands", async () => {
    const session = getSession(spec, dir);
    const setVar = spec.kind === "powershell" ? "$env:LMS_TEST='kept'" : "export LMS_TEST=kept";
    const readVar = spec.kind === "powershell" ? "Write-Output $env:LMS_TEST" : "echo $LMS_TEST";
    const mkdirCmd = spec.kind === "powershell" ? "New-Item -ItemType Directory sub | Out-Null; Set-Location sub" : "mkdir sub && cd sub";

    expect((await session.exec(setVar, 15000)).exitCode).toBe(0);
    expect((await session.exec(readVar, 15000)).stdout.trim()).toBe("kept");
    await session.exec(mkdirCmd, 15000);
    expect((await session.currentDirectory())?.toLowerCase()).toContain("sub");
  }, 60000);

  // A model's script stuck in a loop printed until Node threw "Invalid string length" and the whole
  // plugin process died. The output is now capped, and the command's end is still found after it.
  it("survives a command that prints far more than it keeps", async () => {
    const session = getSession(spec, dir);
    const flood = "node -e \"const s = 'y'.repeat(1e6); for (let i = 0; i < 6; i++) process.stdout.write(s); console.log('END')\"";
    const result = await session.exec(flood, 60000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("characters of output left out");
    expect(result.stdout.endsWith("END")).toBe(true);
    expect(result.stdout.length).toBeLessThan(4_100_000);
  }, 90000);

  it("reports exit codes and stderr, and survives a failing command", async () => {
    const session = getSession(spec, dir);
    const fail = spec.kind === "powershell" ? "node -e \"process.exit(7)\"" : "node -e 'process.exit(7)'";
    const result = await session.exec(fail, 20000);
    expect(result.exitCode).toBe(7);

    const warn = spec.kind === "powershell" ? "node -e \"console.error('oops')\"" : "node -e 'console.error(\"oops\")'";
    const second = await session.exec(warn, 20000);
    expect(second.stderr).toContain("oops");
    expect(second.exitCode).toBe(0);
  }, 60000);

  it("kills a hung command on timeout and recovers on the next call", async () => {
    const session = getSession(spec, dir);
    const hang = spec.kind === "powershell" ? "Start-Sleep -Seconds 30" : "sleep 30";
    const result = await session.exec(hang, 1500);
    expect(result.timedOut).toBe(true);
    const after = await session.exec("echo alive", 20000);
    expect(after.stdout).toContain("alive");
  }, 60000);

  it("leaves nothing of a finished command on the shell", async () => {
    // Each command used to leave an "exit" listener behind, holding on to that command's output.
    const session = getSession(spec, dir);
    for (let i = 0; i < 12; i++) expect((await session.exec(`echo run${i}`, 20000)).stdout).toContain(`run${i}`);
    const child = (session as any).child;
    expect(child.listenerCount("exit")).toBe(1); // the session's own
    expect(child.listenerCount("error")).toBe(1);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  }, 60000);

  it("keeps the shell that replaced a killed one", async () => {
    // The killed shell exits a moment later; that must not make the session forget its new one.
    const session = getSession(spec, dir);
    const hang = spec.kind === "powershell" ? "Start-Sleep -Seconds 30" : "sleep 30";
    expect((await session.exec(hang, 1000)).timedOut).toBe(true);
    const setVar = spec.kind === "powershell" ? "$env:LMS_KEPT='yes'" : "export LMS_KEPT=yes";
    const readVar = spec.kind === "powershell" ? "Write-Output $env:LMS_KEPT" : "echo $LMS_KEPT";
    await session.exec(setVar, 20000); // starts the replacement straight away
    await new Promise(resolve => setTimeout(resolve, 1500)); // by now the killed shell has exited
    expect(session.isRunning).toBe(true);
    expect((await session.exec(readVar, 20000)).stdout.trim()).toBe("yes");
  }, 60000);

  it("says at once when the shell is not installed", async () => {
    const missing: ShellSpec = { file: "definitely-not-a-shell-xyz", replArgs: [], kind: "posix" };
    const session = getSession(missing, dir);
    const started = Date.now();
    try {
      // Used to wait out the whole timeout and then report that the command had timed out.
      await expect(session.exec("echo hi", 30000)).rejects.toThrow(
        /^The shell could not be started: "definitely-not-a-shell-xyz" was not found on PATH\. Pick another Shell/,
      );
      await expect(session.exec("echo hi", 30000)).rejects.toThrow(ToolError);
      expect(Date.now() - started).toBeLessThan(10000);
    } finally {
      resetSession(missing, dir);
    }
  }, 60000);
});

describe("TaskManager index robustness", () => {
  const shell =
    process.platform === "win32"
      ? { file: "cmd.exe", args: (c: string) => ["/d", "/s", "/c", c] }
      : { file: "bash", args: (c: string) => ["-lc", c] };

  it("survives a half-written index instead of throwing", async () => {
    const tasks = new TaskManager(join(dir, "tasks"));
    await tasks.start(shell, "echo hi", dir, "one");
    // Simulate a write interrupted midway, which a reader used to hit as invalid JSON.
    await writeFile(join(dir, "tasks", "tasks.json"), '[{"id":"t1","na');
    await expect(tasks.list()).resolves.toEqual([]);
    await expect(tasks.get("t1")).rejects.toThrow(/No background task/);
  });

  it("writes the index atomically, leaving no temporary files", async () => {
    const tasks = new TaskManager(join(dir, "tasks"));
    await Promise.all([
      tasks.start(shell, "echo a", dir, "a"),
      tasks.start(shell, "echo b", dir, "b"),
      tasks.start(shell, "echo c", dir, "c"),
    ]);
    await new Promise(resolve => setTimeout(resolve, 500));
    const left = (await readdir(join(dir, "tasks"))).filter(name => name.endsWith(".tmp"));
    expect(left).toEqual([]);
    // All three survive: index changes are serialized, so none is lost to a concurrent write.
    const index = JSON.parse(await readFile(join(dir, "tasks", "tasks.json"), "utf-8"));
    expect(index.map((t: any) => t.name).sort()).toEqual(["a", "b", "c"]);
  }, 20000);
});
