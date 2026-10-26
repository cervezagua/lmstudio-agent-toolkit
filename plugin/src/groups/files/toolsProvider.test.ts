import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { readAttachments, recordAttachments, setUserFilesDirectory } from "../../shared/attachments";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { toolsProvider } from "./toolsProvider";

const baseConfig = {
  projectFolder: "",
  allowShell: true,
  shell: "auto",
  commandTimeoutSeconds: 30,
  maxOutputChars: 20000,
  maxReadBytes: 262144,
  blockedCommandPatterns: ["git\\s+push"],
  persistentShell: false,
  enableBackgroundTasks: true,
  enableNotebookTools: true,
  enableDiagnostics: true,
  autoCheckEdits: true,
  enableCheckpoints: true,
  enableSqlite: false,
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
    tools = await toolsProvider(fakeController({ config: { ...baseConfig, projectFolder: root }, workingDirectory: work }));
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
      fakeController({ config: { ...baseConfig, projectFolder: root, enableSubagent: true }, workingDirectory: work }),
    );
    expect(withSubagent.map(t => t.name)).toContain("run_subagent");
    expect(tools.map(t => t.name)).not.toContain("run_subagent");
  });

  it("reports when no checker fits the project, and points at its tests", async () => {
    expect(await callTool(tools, "diagnostics", {})).toMatch(/^Error: No checker was detected.*Run the project's tests/);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    try {
      expect(await callTool(tools, "diagnostics", {})).toContain('Run its tests instead: run_command "npm test" (node test.js).');
    } finally {
      await rm(join(root, "package.json"));
    }
  });

  // In the evals, models asked about "signup.js" looked for it in the root first, and got the
  // system's ENOENT with a full path; a suggestion takes them straight to it.
  it("says where a missing file or folder probably is", async () => {
    await mkdir(join(root, "app", "forms"), { recursive: true });
    await writeFile(join(root, "app", "forms", "signup.js"), "// form\n");
    try {
      expect(await callTool(tools, "read_file", { path: "signup.js" })).toBe("Error: signup.js does not exist. Did you mean: app/forms/signup.js?");
      expect(await callTool(tools, "list_dir", { path: "forms" })).toBe(
        "Error: forms does not exist (write_file creates missing folders). Did you mean: app/forms?",
      );
      expect(await callTool(tools, "list_dir", { path: "app/forms/signup.js" })).toMatch(/is a file, not a folder/);
    } finally {
      await rm(join(root, "app"), { recursive: true, force: true });
    }
  });

  it("omits run_command when shell is disabled and falls back to the working directory", async () => {
    const noShell = await toolsProvider(
      fakeController({ config: { ...baseConfig, allowShell: false }, workingDirectory: root }),
    );
    expect(noShell.map(t => t.name)).not.toContain("run_command");
  });

  it("fails fast when the root directory does not exist", async () => {
    await expect(
      toolsProvider(fakeController({ config: { ...baseConfig, projectFolder: join(root, "missing") }, workingDirectory: root })),
    ).rejects.toThrow(/does not exist/);
  });

  it("writes, reads, and edits a file", async () => {
    expect(await callTool(tools, "write_file", { path: "src/hello.txt", content: "hello\nworld\n" })).toMatch(
      /^Created src\/hello.txt/,
    );
    // A file ending in a newline has two lines, not a phantom empty third one.
    expect(await callTool(tools, "read_file", { path: "src/hello.txt" })).toBe("1\thello\n2\tworld");
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
    expect(await callTool(tools, "read_file", { path: "nope.txt" })).toBe("Error: nope.txt does not exist.");
    await callTool(tools, "read_file", { path: "long.txt" }); // edits need a prior read
    expect(await callTool(tools, "edit_file", { path: "long.txt", old_string: "line", new_string: "row" })).toMatch(
      /^Error: old_string occurs/,
    );
    expect(await callTool(tools, "grep", { pattern: "([bad" })).toMatch(/^Error: Invalid regular expression/);
  });

  it("says in the edit's own result when the edit broke the file's syntax", async () => {
    await writeFile(join(root, "calc.js"), "function add(a, b) {\n  return a + b;\n}\n");
    await callTool(tools, "read_file", { path: "calc.js" });
    const broken = await callTool(tools, "edit_file", { path: "calc.js", old_string: "  return a + b;\n}", new_string: "  return a + b;" });
    expect(broken).toMatch(/^Edited calc\.js: 1 replacement\.\n\nThe file was written, but node --check found a problem:/);
    const fixed = await callTool(tools, "edit_file", { path: "calc.js", old_string: "  return a + b;", new_string: "  return a + b;\n}" });
    expect(fixed).toBe("Edited calc.js: 1 replacement.");
    await rm(join(root, "calc.js"));
  }, 30000);

  it("refuses to edit a file it has not read, and one that changed underneath", async () => {
    await writeFile(join(root, "unseen.txt"), "first\n");
    expect(await callTool(tools, "edit_file", { path: "unseen.txt", old_string: "first", new_string: "second" })).toMatch(
      /^Error: You have not read unseen.txt/,
    );

    await callTool(tools, "read_file", { path: "unseen.txt" });
    await writeFile(join(root, "unseen.txt"), "changed by someone else\n"); // e.g. the user, or a build
    expect(await callTool(tools, "edit_file", { path: "unseen.txt", old_string: "changed", new_string: "x" })).toMatch(
      /^Error: unseen.txt changed on disk since you read it/,
    );

    // Reading again makes the edit go through.
    await callTool(tools, "read_file", { path: "unseen.txt" });
    expect(await callTool(tools, "edit_file", { path: "unseen.txt", old_string: "changed", new_string: "edited" })).toMatch(
      /^Edited unseen.txt/,
    );
  });

  it("suggests a likely path when a file does not exist", async () => {
    await writeFile(join(root, "notes.md"), "hi");
    expect(await callTool(tools, "edit_file", { path: "notes.txt", old_string: "hi", new_string: "ho" })).toMatch(
      /does not exist. Did you mean: notes.md\?/,
    );
  });

  it("refuses a whole-file read over the size limit but allows a window", async () => {
    const small = await toolsProvider(
      fakeController({ config: { ...baseConfig, projectFolder: root, maxReadBytes: 8192 }, workingDirectory: work }),
    );
    await writeFile(join(root, "huge.txt"), "x".repeat(20000));
    expect(await callTool(small, "read_file", { path: "huge.txt" })).toMatch(/^Error: huge.txt is \d+ KB, over the 8 KB limit/);
    expect(await callTool(small, "read_file", { path: "huge.txt", limit: 1 })).toContain("1\txxx");
  });

  it("lets a file be edited after reading part of it, the only way to read a big one", async () => {
    // Reads with offset or limit did not count as reading, and a file over the limit can be read no
    // other way, so "read it first" could never be satisfied.
    const small = await toolsProvider(
      fakeController({ config: { ...baseConfig, projectFolder: root, maxReadBytes: 8192 }, workingDirectory: work }),
    );
    await writeFile(join(root, "big.txt"), `first line\n${"x".repeat(20000)}\nlast line\n`);
    const edit = (old_string: string, new_string: string) => callTool(small, "edit_file", { path: "big.txt", old_string, new_string });

    expect(await edit("first line", "1st line")).toMatch(/^Error: You have not read big.txt/);
    expect(await callTool(small, "read_file", { path: "big.txt" })).toMatch(/^Error: big.txt is \d+ KB, over the 8 KB limit/);
    expect(await callTool(small, "read_file", { path: "big.txt", offset: 1, limit: 1 })).toContain("1\tfirst line");
    expect(await edit("first line", "1st line")).toMatch(/^Edited big.txt/);

    // What the check is for still holds: a file someone else changed since has to be read again.
    await writeFile(join(root, "big.txt"), `rewritten\n${"y".repeat(20000)}\n`);
    expect(await edit("rewritten", "mine")).toMatch(/^Error: big.txt changed on disk since you read it/);
    await callTool(small, "read_file", { path: "big.txt", limit: 1 });
    expect(await edit("rewritten", "mine")).toMatch(/^Edited big.txt/);
  });

  it("keeps glob and grep inside the project folder", async () => {
    // A project folder with something next to it that is none of the model's business.
    const outer = await mkdtemp(join(tmpdir(), "coder-tools-confined-"));
    try {
      const inner = join(outer, "project");
      await mkdir(inner);
      await writeFile(join(inner, "in.txt"), "marker inside\n");
      await writeFile(join(outer, "out.txt"), "marker outside\n");
      const confined = await toolsProvider(fakeController({ config: { ...baseConfig, projectFolder: inner }, workingDirectory: work }));

      for (const pattern of ["../*.txt", "../**/*", join(outer, "*.txt").replace(/\\/g, "/")]) {
        expect(await callTool(confined, "glob", { pattern })).toMatch(/^Error: pattern must stay inside the project folder/);
        // Refused the same way whether ripgrep or the built-in search would have run.
        expect(await callTool(confined, "grep", { pattern: "marker", glob: pattern })).toMatch(/^Error: glob must stay inside the project folder/);
      }
      expect(await callTool(confined, "glob", { pattern: "*.txt" })).toBe("in.txt");
      expect(await callTool(confined, "grep", { pattern: "marker" })).toBe("in.txt:1: marker inside");
    } finally {
      await rm(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  });

  it("reads a text file the user attached, and never changes the list of attachments", async () => {
    const store = await mkdtemp(join(tmpdir(), "coder-tools-user-files-"));
    setUserFilesDirectory(store); // stands in for LM Studio's own folder
    try {
      await writeFile(join(store, "1792647278075 - 9.txt"), "attached notes\n");
      await writeFile(join(store, "1792647278075 - 10.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
      await recordAttachments(work, [
        { name: "notes.txt", path: join(store, "1792647278075 - 9.txt"), image: false },
        { name: "report.pdf", path: join(store, "1792647278075 - 10.pdf"), image: false },
      ]);
      expect(await callTool(tools, "read_file", { path: "notes.txt" })).toBe("1\tattached notes");
      // A PDF is pointed at the tool that reads it, and is shown by its own name.
      expect(await callTool(tools, "read_file", { path: "report.pdf" })).toBe(
        'Error: "report.pdf" looks like a binary file. For a PDF, use read_document_text (Documents group).',
      );
      // Read only: the attachment is not in the project, so it cannot be edited or overwritten.
      expect(await callTool(tools, "edit_file", { path: "notes.txt", old_string: "attached", new_string: "x" })).toMatch(/does not exist/);

      // With no Project Folder the tools work in the chat's folder, where the list is kept. A model
      // that could write it could make any file "attached", so no spelling of it may be written.
      const scratch = await toolsProvider(fakeController({ config: { ...baseConfig, projectFolder: "" }, workingDirectory: work }));
      const spellings = [".agent-toolkit/attachments.json", ".agent-toolkit/other.json", ".agent-toolkit"];
      // Another case is the same file only where the filesystem ignores case; on Linux it is a different, harmless file.
      if (process.platform === "win32" || process.platform === "darwin") spellings.push(".AGENT-TOOLKIT/Attachments.JSON");
      if (process.platform === "win32") {
        // A stream of the file, a name Windows trims, and the folder's 8.3 short name.
        spellings.push(".agent-toolkit/attachments.json::$DATA", ".agent-toolkit/attachments.json.", ".agent-toolkit./attachments.json");
        const folder = join(work, ".agent-toolkit").replace(/'/g, "''");
        const short = execFileSync("powershell", ["-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${folder}').ShortPath`], {
          encoding: "utf-8",
        }).trim();
        // Only where the volume makes short names, as system drives do by default.
        if (short && !/\.agent-toolkit$/i.test(short)) spellings.push(`${basename(short)}/attachments.json`);
      }
      for (const path of spellings) {
        for (const [name, params] of [
          ["write_file", { path, content: '[{"name":"k","path":"C:/x","image":false}]' }],
          ["insert_lines", { path, after_line: 0, content: "[]" }],
        ] as const) {
          expect(await callTool(scratch, name, params), `${name} ${path}`).toMatch(
            /^Error: (.* is managed by the toolkit and cannot be changed by a tool|Path .* (contains ":"|has a name ending in a dot or a space))/,
          );
        }
      }
      expect(await readAttachments(work)).toHaveLength(2);
    } finally {
      setUserFilesDirectory(null);
      await rm(store, { recursive: true, force: true }).catch(() => {});
    }
    // Starting PowerShell for the short name took over 20 s on a cold Windows CI machine.
  }, 60_000);

  it("names a working folder that does not exist, instead of blaming the shell", async () => {
    for (const name of ["run_command", "task_run"]) {
      expect(await callTool(tools, name, { command: "node -e \"1\"", cwd: "no-such-folder" })).toMatch(
        /^Error: cwd "no-such-folder" is not a folder in the project\. Use list_dir/,
      );
    }
    expect(await callTool(tools, "task_list", {})).not.toContain("node -e");
  });

  it("sends text edits on notebooks to notebook_edit", async () => {
    await callTool(tools, "write_file", { path: "book.ipynb", content: JSON.stringify({ cells: [] }) });
    expect(await callTool(tools, "edit_file", { path: "book.ipynb", old_string: "cells", new_string: "x" })).toMatch(
      /^Error: book.ipynb is a Jupyter notebook; use notebook_edit/,
    );
  });

  it("saves very long command output to a file the model can read", async () => {
    const tiny = await toolsProvider(
      fakeController({ config: { ...baseConfig, projectFolder: root, maxOutputChars: 1000 }, workingDirectory: work }),
    );
    const result = await callTool(tiny, "run_command", {
      command: `node -e "for (let i = 0; i < 400; i++) console.log('line ' + i + ' ' + 'y'.repeat(40))"`,
      description: "print a lot of output",
    });
    const path = /saved to (.+?) - read it/.exec(result)?.[1];
    expect(path).toBeTruthy();
    expect(result).toContain("characters truncated");

    // The overflow file lives outside the project root, but read_file can still open it.
    const full = await callTool(tiny, "read_file", { path: path!, limit: 5 });
    expect(full).toContain("line 0");
  }, 30000);

  it("lists, globs, and greps", async () => {
    const listing = await callTool(tools, "list_dir", {});
    expect(listing).toMatch(/^\.:\nsrc\//); // folders first
    expect(listing).toContain("long.txt");
    expect(await callTool(tools, "glob", { pattern: "**/*.txt" })).toContain("src/hello.txt");
    expect(await callTool(tools, "grep", { pattern: "line 4\\d", max_results: 3 })).toBe(
      "long.txt:40: line 40\nlong.txt:41: line 41\nlong.txt:42: line 42\n[stopped at 3 results; narrow the search, or pass offset 3 for more]",
    );
  });

  // With ripgrep installed, searching one file found nothing: ripgrep leaves the path out then, and
  // the lines without one were dropped. A model in an eval searched a file 30 times for a line in it.
  it("lets the model edit a line grep showed it, but not one grep only counted", async () => {
    await writeFile(join(root, "found.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(join(root, "counted.txt"), "alpha\n");
    expect(await callTool(tools, "grep", { pattern: "alpha", path: "counted.txt", output_mode: "count" })).toMatch(/counted\.txt: 1/);
    expect(await callTool(tools, "edit_file", { path: "counted.txt", old_string: "alpha", new_string: "x" })).toMatch(/have not read/);
    expect(await callTool(tools, "grep", { pattern: "beta" })).toContain("found.txt:2: beta");
    expect(await callTool(tools, "edit_file", { path: "found.txt", old_string: "beta", new_string: "BETA" })).not.toMatch(/^Error/);
    expect(await readFile(join(root, "found.txt"), "utf-8")).toBe("alpha\nBETA\ngamma\n");
    // A change after grep showed the file is still refused.
    await callTool(tools, "grep", { pattern: "gamma", path: "found.txt" });
    await writeFile(join(root, "found.txt"), "alpha\nBETA\ngamma\ndelta\n");
    expect(await callTool(tools, "edit_file", { path: "found.txt", old_string: "gamma", new_string: "G" })).toMatch(/changed on disk/);
  });

  it("searches a single file", async () => {
    expect(await callTool(tools, "grep", { pattern: "line 4[01]$", path: "long.txt" })).toBe("long.txt:40: line 40\nlong.txt:41: line 41");
    expect(await callTool(tools, "grep", { pattern: "line", path: "long.txt", output_mode: "count" })).toMatch(/^long\.txt: \d+$/);
    expect(await callTool(tools, "grep", { pattern: "line 7$", path: "long.txt", context: 1 })).toBe(
      "long.txt:6- line 6\nlong.txt:7: line 7\nlong.txt:8- line 8",
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
      fakeController({ config: { ...baseConfig, projectFolder: root, persistentShell: true }, workingDirectory: work }),
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
