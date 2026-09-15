import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupStore } from "./backups";
import { applyEdits, insertLines, previewDiff } from "./edit";
import { editNotebook, parseNotebook, renderNotebook, toSourceLines } from "./notebook";
import { getSession, resetSession, type ShellSpec } from "./session";
import { TaskManager, taskState } from "./tasks";
import { ToolError } from "../shared/errors";

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
});
