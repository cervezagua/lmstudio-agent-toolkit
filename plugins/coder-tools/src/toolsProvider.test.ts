import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../../shared/testing/fake-controller";
import { toolsProvider } from "./toolsProvider";

const baseConfig = {
  rootDirectory: "",
  allowShell: true,
  shell: "auto",
  commandTimeoutSeconds: 30,
  maxOutputChars: 20000,
  blockedCommandPatterns: ["git\\s+push"],
  persistentShell: false,
  enableBackgroundTasks: true,
  enableNotebookTools: true,
  enableDiagnostics: true,
  enableSubagent: false,
  subagentModel: "",
};

describe("coder-tools toolsProvider", () => {
  let root: string;
  let work: string; // stands in for the chat working directory (task logs, undo backups)
  let tools: any[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "coder-tools-e2e-"));
    work = await mkdtemp(join(tmpdir(), "coder-tools-work-"));
    tools = await toolsProvider(fakeController({ config: { ...baseConfig, rootDirectory: root }, workingDirectory: work }));
  });

  afterAll(async () => {
    // A shell session holds its working directory open on Windows, so retry the cleanup.
    const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
    await rm(root, options).catch(() => {});
    await rm(work, options).catch(() => {});
  });

  it("registers all tools", () => {
    expect(tools.map(t => t.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "multi_edit",
      "insert_lines",
      "undo_edit",
      "list_dir",
      "glob",
      "grep",
      "notebook_read",
      "notebook_edit",
      "run_command",
      "task_run",
      "task_list",
      "task_output",
      "task_stop",
      "diagnostics",
    ]);
  });

  it("adds the sub-agent only when it is enabled", async () => {
    const withSubagent = await toolsProvider(
      fakeController({ config: { ...baseConfig, rootDirectory: root, enableSubagent: true }, workingDirectory: work }),
    );
    expect(withSubagent.map(t => t.name)).toContain("run_subagent");
    expect(tools.map(t => t.name)).not.toContain("run_subagent");
  });

  it("reports when no checker fits the project", async () => {
    expect(await callTool(tools, "diagnostics", {})).toMatch(/^Error: No checker was detected/);
  });

  it("omits run_command when shell is disabled and falls back to the working directory", async () => {
    const noShell = await toolsProvider(
      fakeController({ config: { ...baseConfig, allowShell: false }, workingDirectory: root }),
    );
    expect(noShell.map(t => t.name)).not.toContain("run_command");
  });

  it("fails fast when the root directory does not exist", async () => {
    await expect(
      toolsProvider(fakeController({ config: { ...baseConfig, rootDirectory: join(root, "missing") }, workingDirectory: root })),
    ).rejects.toThrow(/does not exist/);
  });

  it("writes, reads, and edits a file", async () => {
    expect(await callTool(tools, "write_file", { path: "src/hello.txt", content: "hello\nworld\n" })).toMatch(
      /^Created src\/hello.txt/,
    );
    expect(await callTool(tools, "read_file", { path: "src/hello.txt" })).toBe("1\thello\n2\tworld\n3\t");
    expect(await callTool(tools, "edit_file", { path: "src/hello.txt", old_string: "hello", new_string: "hi" })).toBe(
      "Edited src/hello.txt: 1 replacement.",
    );
    expect(await readFile(join(root, "src", "hello.txt"), "utf-8")).toBe("hi\nworld\n");
    expect(await callTool(tools, "write_file", { path: "src/hello.txt", content: "x" })).toMatch(/^Overwrote/);
  });

  it("pages through long files", async () => {
    await writeFile(join(root, "long.txt"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
    const result = await callTool(tools, "read_file", { path: "long.txt", offset: 10, limit: 2 });
    expect(result).toBe("10\tline 10\n11\tline 11\n\n[showing lines 10-11 of 50; use offset to read more]");
  });

  it("returns recoverable errors as strings", async () => {
    expect(await callTool(tools, "read_file", { path: "../../outside.txt" })).toMatch(/^Error: .*outside the allowed root/);
    expect(await callTool(tools, "read_file", { path: "nope.txt" })).toMatch(/^Error: ENOENT/);
    expect(await callTool(tools, "edit_file", { path: "long.txt", old_string: "line", new_string: "row" })).toMatch(
      /^Error: old_string occurs/,
    );
    expect(await callTool(tools, "grep", { pattern: "([bad" })).toMatch(/^Error: Invalid regular expression/);
  });

  it("lists, globs, and greps", async () => {
    expect(await callTool(tools, "list_dir", {})).toMatch(/^\.:\nsrc\/\nlong\.txt/);
    expect(await callTool(tools, "glob", { pattern: "**/*.txt" })).toContain("src/hello.txt");
    expect(await callTool(tools, "grep", { pattern: "line 4\\d", max_results: 3 })).toBe(
      "long.txt:40: line 40\nlong.txt:41: line 41\nlong.txt:42: line 42\n[stopped at 3 results; narrow the search]",
    );
  });

  it("runs shell commands in the root and enforces the blocklist", async () => {
    const output = await callTool(tools, "run_command", { command: "node -e \"console.log(process.cwd())\"" });
    expect(output).toContain("exit_code: 0");
    // Compare the folder name only: TEMP may be an 8.3 short path while the shell prints the long one.
    expect(output).toContain(basename(root));
    expect(await callTool(tools, "run_command", { command: "git push origin main" })).toMatch(/^Error: This command is blocked/);
    expect(await callTool(tools, "run_command", { command: "node -e \"process.exit(4)\"" })).toContain("exit_code: 4");
    // An earlier failure followed by a success reports success, like bash.
    expect(await callTool(tools, "run_command", { command: "node -e \"process.exit(4)\"\nnode -e \"1\"" })).toContain(
      "exit_code: 0",
    );
  });

  it.runIf(process.platform === "win32")("reports failing PowerShell cmdlets as exit code 1 with stderr", async () => {
    const output = await callTool(tools, "run_command", { command: "Get-Item does-not-exist.txt" });
    expect(output).toMatch(/^exit_code: 1\n(stdout|stderr):\n[\s\S]*does-not-exist/);
  });

  it("previews, multi-edits, inserts and undoes", async () => {
    await callTool(tools, "write_file", { path: "edit.txt", content: "alpha\nbeta\ngamma\n" });

    const preview = await callTool(tools, "edit_file", { path: "edit.txt", old_string: "beta", new_string: "BETA", preview: true });
    expect(preview).toContain("- 2\tbeta");
    expect(preview).toContain("+ 2\tBETA");
    expect(await readFile(join(root, "edit.txt"), "utf-8")).toBe("alpha\nbeta\ngamma\n"); // preview wrote nothing

    expect(
      await callTool(tools, "multi_edit", {
        path: "edit.txt",
        edits: [
          { old_string: "alpha", new_string: "one" },
          { old_string: "gamma", new_string: "three" },
        ],
      }),
    ).toBe("Edited edit.txt: 2 edits, 2 replacements.");
    expect(await readFile(join(root, "edit.txt"), "utf-8")).toBe("one\nbeta\nthree\n");

    // A failing edit in the batch leaves the file untouched.
    expect(
      await callTool(tools, "multi_edit", {
        path: "edit.txt",
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "missing", new_string: "x" },
        ],
      }),
    ).toMatch(/^Error: Edit 2 of 2 failed/);
    expect(await readFile(join(root, "edit.txt"), "utf-8")).toBe("one\nbeta\nthree\n");

    expect(await callTool(tools, "insert_lines", { path: "edit.txt", after_line: 0, content: "# header" })).toMatch(/^Inserted 1 line/);
    expect(await readFile(join(root, "edit.txt"), "utf-8")).toBe("# header\none\nbeta\nthree\n");

    expect(await callTool(tools, "undo_edit", { path: "edit.txt" })).toMatch(/^Restored edit.txt/);
    expect(await readFile(join(root, "edit.txt"), "utf-8")).toBe("one\nbeta\nthree\n");
    expect(await callTool(tools, "undo_edit", { path: "edit.txt" })).toMatch(/^Error: No undo history/);
  });

  it("reads and edits notebooks", async () => {
    const notebook = {
      cells: [{ cell_type: "code", source: ["print(1)\n"], metadata: {}, outputs: [], execution_count: null }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    await callTool(tools, "write_file", { path: "nb.ipynb", content: JSON.stringify(notebook) });
    expect(await callTool(tools, "notebook_read", { path: "nb.ipynb" })).toContain("[0] code\nprint(1)");
    expect(await callTool(tools, "notebook_edit", { path: "nb.ipynb", cell_index: 1, mode: "insert", source: "# Notes", cell_type: "markdown" })).toMatch(
      /^Inserted markdown cell at index 1/,
    );
    expect(await callTool(tools, "notebook_read", { path: "nb.ipynb" })).toContain("[1] markdown\n# Notes");
    expect(await callTool(tools, "notebook_edit", { path: "nb.ipynb", cell_index: 9, mode: "delete" })).toMatch(/^Error: cell index 9/);
  });

  it("runs, polls and stops background tasks", async () => {
    expect(await callTool(tools, "task_list", {})).toBe("No background tasks.");
    const started = await callTool(tools, "task_run", { command: "node -e \"console.log('bg output')\"", name: "bg" });
    const id = /task (\w+)/.exec(started)![1];

    // Poll until the task is finished: output can appear a moment before the exit is recorded.
    let output = "";
    for (let i = 0; i < 40; i++) {
      output = await callTool(tools, "task_output", { id });
      if (output.includes("bg output") && /exited with code 0/.test(output)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(output).toContain("bg output");
    expect(output).toMatch(/exited with code 0/);
    expect(await callTool(tools, "task_list", {})).toContain(id);
    expect(await callTool(tools, "task_output", { id: "nosuch" })).toMatch(/^Error: No background task/);
    expect(await callTool(tools, "task_stop", { id })).toMatch(/was already finished/);
  }, 20000);

  it("keeps state between commands when the shell session is enabled", async () => {
    const sessionTools = await toolsProvider(
      fakeController({ config: { ...baseConfig, rootDirectory: root, persistentShell: true }, workingDirectory: work }),
    );
    expect(sessionTools.map(t => t.name)).toContain("shell_reset");
    const set = process.platform === "win32" ? "$env:LMS_E2E='sticky'" : "export LMS_E2E=sticky";
    const read = process.platform === "win32" ? "Write-Output $env:LMS_E2E" : "echo $LMS_E2E";
    await callTool(sessionTools, "run_command", { command: set });
    expect(await callTool(sessionTools, "run_command", { command: read })).toContain("sticky");
    expect(await callTool(sessionTools, "shell_reset", {})).toMatch(/restarted/);
    expect(await callTool(sessionTools, "run_command", { command: read })).not.toContain("sticky");
  }, 60000);
});
