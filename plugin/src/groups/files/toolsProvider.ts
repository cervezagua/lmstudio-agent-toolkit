import { text, tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, join, relative } from "path";
import { z } from "zod";
import { configSchematics } from "../../config";
import { BackupStore } from "./lib/backups";
import { findBlockedPattern, parsePatterns } from "./lib/blocklist";
import { applyEdit, applyEdits, insertLines, previewDiff } from "./lib/edit";
import { assertFresh, forget, recordRead, recordWrite } from "./lib/fileState";
import { assertReadableSize, looksBinary, readTextSlice } from "./lib/readText";
import { writeFileAtomic } from "./lib/safeWrite";
import { overflowNote, storeOverflow } from "./lib/overflow";
import { notFoundMessage } from "./lib/suggest";
import { availableCheckers, runChecker } from "./lib/diagnostics";
import { editNotebook, parseNotebook, renderNotebook } from "./lib/notebook";
import { pickSubagentModel, runSubagent } from "./lib/subagent";
import { globFiles, grepFiles } from "./lib/search";
import { getSession, resetSession, type ShellSpec } from "./lib/session";
import { formatTaskLine, TaskManager } from "./lib/tasks";
import { safe, ToolError } from "../../shared/errors";
import { isChatStateFile, PLANNING_NOTE, readMode } from "../../shared/mode";
import { displayPath, resolveSafe } from "../../shared/paths";
import { findExecutable, formatRunResult, runProcess } from "../../shared/process";
import { truncate } from "../../shared/truncate";

const MAX_LINE_CHARS = 2000;
const MAX_EDIT_BYTES = 5 * 1024 * 1024;

function resolveShellName(choice: string): string {
  if (choice !== "auto") return choice;
  if (process.platform === "win32") return findExecutable("pwsh") ? "pwsh" : "powershell";
  return findExecutable("bash") ? "bash" : "sh";
}

function shellInvocation(choice: string, command: string): { file: string; args: string[] } {
  const shell = resolveShellName(choice);
  if (shell === "pwsh" || shell === "powershell") {
    // Force UTF-8 so non-ASCII output is not mangled. -Command collapses a failing native exit code to
    // 1, so re-exit with $LASTEXITCODE when the last statement failed (tests/builds report real codes).
    const script = [
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';$global:LASTEXITCODE=0",
      command,
      "$__ok=$?; if (-not $__ok) { if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE } else { exit 1 } }",
    ].join("\n");
    return { file: shell, args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  return { file: shell, args: ["-lc", command] };
}

function sessionSpec(choice: string): ShellSpec {
  const shell = resolveShellName(choice);
  if (shell === "pwsh" || shell === "powershell") {
    return { file: shell, replArgs: ["-NoProfile", "-NonInteractive", "-Command", "-"], kind: "powershell" };
  }
  return { file: shell, replArgs: ["-s"], kind: "posix" };
}

/** Quotes a path for a single-quoted string in the target shell. */
function quoteForShell(path: string, kind: ShellSpec["kind"]): string {
  return kind === "powershell" ? `'${path.replace(/'/g, "''")}'` : `'${path.replace(/'/g, `'\\''`)}'`;
}

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);
  const root = config.get("projectFolder").trim() || ctl.getWorkingDirectory();
  const maxOutputChars = config.get("maxOutputChars");
  const maxReadBytes = config.get("maxReadBytes");
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`coder-tools: root directory "${root}" does not exist or is not a directory.`);
  }
  const show = (path: string) => displayPath(root, path);
  // State that must not pollute the user's project lives in the chat's working directory.
  const stateDir = join(ctl.getWorkingDirectory(), ".coder-tools");
  const backups = new BackupStore(join(stateDir, "backups"));
  const readIfExists = (file: string) => readFile(file, "utf-8").catch(() => null);

  /** Paths resolve inside the project root, or inside the plugin's own state folder (overflow output). */
  const resolveReadable = async (path: string) => {
    try {
      return await resolveSafe(root, path);
    } catch (error) {
      try {
        return await resolveSafe(stateDir, path);
      } catch {
        throw error; // report the project-root error, which is the one the model needs
      }
    }
  };

  /** Resolves a path a tool is about to change, refusing the toolkit's own chat state files. */
  const resolveWritable = async (path: string) => {
    const file = await resolveSafe(root, path);
    if (isChatStateFile(ctl.getWorkingDirectory(), file)) {
      throw new ToolError(`${show(file)} is managed by the toolkit and cannot be changed by a tool.`);
    }
    return file;
  };

  /**
   * Shared preparation for every tool that changes a file: resolve it, refuse notebooks and huge
   * files, and refuse editing a version the model has not read (or that changed since it did).
   */
  const openForEdit = async (path: string) => {
    const file = await resolveWritable(path);
    if (file.toLowerCase().endsWith(".ipynb")) {
      throw new ToolError(`${show(file)} is a Jupyter notebook; use notebook_edit instead of text edits.`);
    }
    const info = await stat(file).catch(() => null);
    if (!info) throw new ToolError(await notFoundMessage(root, path, `${show(file)} does not exist.`));
    if (info.isDirectory()) throw new ToolError(`${show(file)} is a directory.`);
    if (info.size > MAX_EDIT_BYTES) {
      throw new ToolError(`${show(file)} is ${Math.round(info.size / 1024 / 1024)} MB, too large to edit safely.`);
    }
    const content = await readFile(file, "utf-8");
    await assertFresh(file, show(file), content);
    return { file, content };
  };
  // memory-tools' plan mode: while planning, the tools that change things are not offered at all.
  const planning = (await readMode(ctl.getWorkingDirectory())).planning;

  const tools: Tool[] = [];

  tools.push(
    tool({
      name: "read_file",
      description: text`
        Read a text file. Each returned line is prefixed with its line number and a tab.
        Paths are relative to the project root (${root}).
        For large files, use offset (1-based line to start from) and limit (number of lines).
        The line-number prefix is not part of the file; never include it in edit_file's old_string.
      `,
      parameters: {
        path: z.string(),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).optional(),
      },
      implementation: safe(async ({ path, offset, limit }) => {
        const file = await resolveReadable(path);
        const windowed = offset !== undefined || limit !== undefined;
        await assertReadableSize(file, show(file), maxReadBytes, windowed);
        if (await looksBinary(file)) throw new ToolError(`"${path}" looks like a binary file.`);

        const { lines, start, totalLines } = await readTextSlice(file, offset ?? 1, limit ?? 2000);
        const body = lines
          .map((line, i) => {
            const clipped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line;
            return `${start + i}\t${clipped}`;
          })
          .join("\n");
        const end = start + lines.length - 1;
        const note =
          end < totalLines ? `\n\n[showing lines ${start}-${end} of ${totalLines}; use offset to read more]` : "";

        // Remember what the model has seen, so edits to a stale view can be refused. The content is
        // re-read inside recordRead so the hash matches the bytes on disk, line endings included.
        if (!windowed) await recordRead(file);
        return truncate(body, maxOutputChars) + note || "(empty file)";
      }),
    }),
  );

  tools.push(
    tool({
      name: "write_file",
      description: text`
        Create a file or completely overwrite an existing one with the given content. Parent folders
        are created automatically. To change part of an existing file, prefer edit_file.
        The previous content is kept, so undo_edit can restore it.
      `,
      parameters: { path: z.string(), content: z.string() },
      implementation: safe(async ({ path, content }) => {
        const file = await resolveWritable(path);
        const info = await stat(file).catch(() => null);
        if (info?.isDirectory()) throw new ToolError(`"${path}" is a directory.`);
        const existing = await readIfExists(file);
        await mkdir(dirname(file), { recursive: true });
        await backups.save(file, existing);
        await writeFileAtomic(file, content);
        await recordWrite(file, content);
        return `${existing === null ? "Created" : "Overwrote"} ${show(file)} (${Buffer.byteLength(content)} bytes).`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "edit_file",
      description: text`
        Edit a file by replacing an exact piece of text. old_string must match the file exactly
        (including indentation) and must be unique in the file, unless replace_all is true.
        Read the file first. Include enough surrounding lines in old_string to make it unique.
        Set preview to true to see the diff without changing the file; undo_edit reverts a change.
      `,
      parameters: {
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
        preview: z.boolean().optional(),
      },
      implementation: safe(async ({ path, old_string, new_string, replace_all, preview }) => {
        const { file, content: original } = await openForEdit(path);
        const { content, replacements } = applyEdit(original, old_string, new_string, replace_all ?? false);
        if (preview) return `Preview of ${show(file)} (nothing written):\n${previewDiff(original, content)}`;
        await backups.save(file, original);
        await writeFileAtomic(file, content);
        await recordWrite(file, content);
        return `Edited ${show(file)}: ${replacements} replacement${replacements === 1 ? "" : "s"}.`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "multi_edit",
      description: text`
        Make several exact replacements in one file in one call. Each edit applies to the result of
        the previous one, and each must match uniquely (or set replace_all on it).
        If any edit fails, nothing is written. Prefer this over repeated edit_file calls on one file.
      `,
      parameters: {
        path: z.string(),
        edits: z
          .array(z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }))
          .min(1),
        preview: z.boolean().optional(),
      },
      implementation: safe(async ({ path, edits, preview }) => {
        const { file, content: original } = await openForEdit(path);
        const { content, replacements } = applyEdits(original, edits);
        if (preview) return `Preview of ${show(file)} (nothing written):\n${previewDiff(original, content)}`;
        await backups.save(file, original);
        await writeFileAtomic(file, content);
        await recordWrite(file, content);
        return `Edited ${show(file)}: ${edits.length} edits, ${replacements} replacements.`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "insert_lines",
      description: text`
        Insert text after a given line number (0 inserts at the top of the file). Useful for adding
        an import or a new function without quoting the surrounding code. Line numbers come from read_file.
      `,
      parameters: {
        path: z.string(),
        after_line: z.number().int().min(0),
        content: z.string(),
        preview: z.boolean().optional(),
      },
      implementation: safe(async ({ path, after_line, content, preview }) => {
        // Inserting into a file that does not exist yet is allowed, so only existing files go
        // through the read-before-edit check.
        const existing = await readIfExists(await resolveSafe(root, path));
        const { file, content: original } =
          existing === null ? { file: await resolveSafe(root, path), content: "" } : await openForEdit(path);
        const updated = insertLines(original, after_line, content);
        if (preview) return `Preview of ${show(file)} (nothing written):\n${previewDiff(original, updated)}`;
        await backups.save(file, existing === null ? null : original);
        await writeFileAtomic(file, updated);
        await recordWrite(file, updated);
        return `Inserted ${content.split(/\r?\n/).length} line(s) into ${show(file)} after line ${after_line}.`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "undo_edit",
      description: "Restore a file to the state it had before this chat's most recent change to it.",
      parameters: { path: z.string() },
      implementation: safe(async ({ path }) => {
        const file = await resolveWritable(path);
        const { restored, savedAt } = await backups.restore(file);
        forget(file);
        return restored === "deleted"
          ? `${show(file)} did not exist before that change, so it has been removed again.`
          : `Restored ${show(file)} to its content from ${savedAt}.`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "list_dir",
      description: "List the entries of a directory (default: project root). Folders end with '/'.",
      parameters: { path: z.string().optional() },
      implementation: safe(async ({ path }) => {
        const dir = await resolveSafe(root, path ?? ".");
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        const shown = entries.slice(0, 500).map(e => (e.isDirectory() ? `${e.name}/` : e.name));
        const more = entries.length > 500 ? `\n[${entries.length - 500} more entries not shown]` : "";
        return `${show(dir)}:\n${shown.join("\n") || "(empty)"}${more}`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "glob",
      description: text`
        Find files by name pattern, e.g. "**/*.ts" or "src/**/config.*". Returns paths relative to
        the project root, most recently modified first. node_modules, .git and build folders are skipped.
      `,
      parameters: { pattern: z.string(), path: z.string().optional() },
      implementation: safe(async ({ pattern, path }) => {
        const cwd = await resolveSafe(root, path ?? ".");
        const { files, total } = await globFiles({ cwd, pattern, limit: 200 });
        if (total === 0) return "No files matched.";
        const more = total > files.length ? `\n[${total - files.length} more matches not shown]` : "";
        return files.map(show).join("\n") + more;
      }),
    }),
  );

  tools.push(
    tool({
      name: "grep",
      description: text`
        Search file contents with a regular expression. Returns "path:line: text" for each matching
        line. Optionally restrict to a sub-path and/or a file glob like "*.py".
        output_mode "files_with_matches" lists only the files (cheapest way to answer "where is X
        used?"), "count" gives matches per file. context adds surrounding lines, offset pages
        through results.
      `,
      parameters: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        ignore_case: z.boolean().optional(),
        max_results: z.number().int().min(1).max(1000).optional(),
        context: z.number().int().min(0).max(10).optional(),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
        offset: z.number().int().min(0).optional(),
      },
      implementation: safe(async ({ pattern, path, glob, ignore_case, max_results, context, output_mode, offset }, { signal }) => {
        try {
          new RegExp(pattern);
        } catch (error) {
          throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
        }
        const searchPath = await resolveSafe(root, path ?? ".");
        const maxResults = max_results ?? 100;
        const mode = output_mode ?? "content";
        const skip = offset ?? 0;
        const rg = findExecutable("rg");
        let lines: string[];
        let truncated: boolean;
        if (rg) {
          const args = ["--color", "never", "--max-columns", "300"];
          if (mode === "files_with_matches") args.push("--files-with-matches");
          else if (mode === "count") args.push("--count");
          else args.push("--line-number", "--no-heading");
          if (context && mode === "content") args.push("--context", String(context));
          if (ignore_case) args.push("-i");
          if (glob) args.push("-g", glob);
          args.push("-e", pattern, "--", relative(root, searchPath) || ".");
          const result = await runProcess(rg, args, { cwd: root, timeoutMs: 60_000, signal });
          if (result.exitCode === 2) throw new ToolError(result.stderr.trim() || "ripgrep failed");
          const all = result.stdout.split(/\r?\n/).filter(Boolean).map(l => l.replace(/\\/g, "/"));
          const paged = all.slice(skip, skip + maxResults);
          lines = mode === "content" ? paged.map(l => l.replace(/^([^:]+:\d+):/, "$1: ")) : paged;
          truncated = all.length > skip + maxResults;
        } else {
          const result = await grepFiles({
            root,
            searchPath,
            pattern,
            glob,
            ignoreCase: ignore_case ?? false,
            maxResults,
            signal,
            context,
            outputMode: mode,
            offset: skip,
          });
          lines = result.matches;
          truncated = result.truncated;
        }
        if (lines.length === 0) return skip > 0 ? "No more matches." : "No matches.";
        const note = truncated
          ? `\n[stopped at ${maxResults} results; narrow the search, or pass offset ${skip + maxResults} for more]`
          : "";
        return truncate(lines.join("\n"), maxOutputChars) + note;
      }),
    }),
  );

  if (config.get("enableNotebookTools")) {
    tools.push(
      tool({
        name: "notebook_read",
        description:
          "Read a Jupyter notebook (.ipynb): every cell with its index, type, source and a summary of its outputs.",
        parameters: { path: z.string() },
        implementation: safe(async ({ path }) => {
          const file = await resolveWritable(path);
          const raw = await readFile(file, "utf-8");
          await recordRead(file, raw);
          const notebook = parseNotebook(raw);
          return truncate(`${show(file)} (${notebook.cells.length} cells)\n\n${renderNotebook(notebook)}`, maxOutputChars);
        }),
      }),
      tool({
        name: "notebook_edit",
        description: text`
          Change a Jupyter notebook cell. mode "replace" rewrites the cell at cell_index, "insert"
          adds a new cell at that index, "delete" removes it. Indexes come from notebook_read and
          shift after an insert or delete, so re-read afterwards. Editing a code cell clears its
          stale outputs.
        `,
        parameters: {
          path: z.string(),
          cell_index: z.number().int().min(0),
          mode: z.enum(["replace", "insert", "delete"]),
          source: z.string().optional(),
          cell_type: z.enum(["code", "markdown", "raw"]).optional(),
        },
        implementation: safe(async ({ path, cell_index, mode, source, cell_type }) => {
          const file = await resolveWritable(path);
          const original = await readFile(file, "utf-8");
          await assertFresh(file, show(file), original);
          const { notebook, message } = editNotebook(parseNotebook(original), {
            index: cell_index,
            mode,
            source,
            cellType: cell_type,
          });
          await backups.save(file, original);
          const serialized = JSON.stringify(notebook, null, 1) + "\n";
          await writeFileAtomic(file, serialized);
          await recordWrite(file, serialized);
          return `${message} (${show(file)})`;
        }),
      }),
    );
  }

  if (config.get("allowShell")) {
    const defaultTimeout = config.get("commandTimeoutSeconds");
    const { patterns: extraPatterns } = parsePatterns(config.get("blockedCommandPatterns"));
    const shellChoice = config.get("shell");
    const shellName = resolveShellName(shellChoice);
    const persistent = config.get("persistentShell");
    /** Keeps the whole output when it is far past the limit, instead of dropping the middle. */
    const withOverflow = async (result: Parameters<typeof formatRunResult>[0]) => {
      const formatted = formatRunResult(result, maxOutputChars);
      const full = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      if (full.length <= maxOutputChars * 2) return formatted;
      const file = await storeOverflow(join(stateDir, "output"), full);
      return overflowNote(file, formatted, maxOutputChars);
    };

    const checkCommand = (command: string) => {
      const blocked = findBlockedPattern(command, extraPatterns);
      if (blocked) {
        throw new ToolError(`This command is blocked by the safety rules (pattern ${blocked}). Do not retry it.`);
      }
    };

    tools.push(
      tool({
        name: "run_command",
        description: text`
          Run a shell command (${shellName}) and return its exit code, stdout and stderr.
          ${
            persistent
              ? "Commands share one persistent shell, so cd, environment variables and activated virtualenvs carry over between calls."
              : "Each call runs in a fresh shell."
          }
          Starts in the project root; pass cwd (relative to the root) to run elsewhere.
          Pass description: one short line saying what the command does, shown to the person who
          approves it. Very long output is saved to a file and its path returned, so nothing is lost.
          Non-interactive only: commands that wait for input hang until the timeout.
          Default timeout is ${defaultTimeout}s; use task_run for servers, watchers and long builds.
          ${planning ? PLANNING_NOTE : ""}
        `,
        parameters: {
          command: z.string(),
          description: z.string().optional(),
          cwd: z.string().optional(),
          timeout_seconds: z
            .number()
            .int()
            .min(1)
            .max(defaultTimeout * 10)
            .optional(),
        },
        implementation: safe(async ({ command, description, cwd, timeout_seconds }, ctx) => {
          const { signal } = ctx;
          checkCommand(command);
          const workingDir = await resolveSafe(root, cwd ?? ".");
          const timeoutMs = (timeout_seconds ?? defaultTimeout) * 1000;
          const label = description?.trim() || (command.length > 80 ? command.slice(0, 80) + "…" : command);
          ctx.status(`Running: ${label}`);

          if (persistent) {
            const spec = sessionSpec(shellChoice);
            const session = getSession(spec, root);
            // Run elsewhere without losing the session's own current directory.
            const quoted = quoteForShell(workingDir, spec.kind);
            const scoped =
              cwd === undefined
                ? command
                : spec.kind === "powershell"
                  ? `Push-Location -LiteralPath ${quoted}\ntry {\n${command}\n} finally { Pop-Location }`
                  : `(cd ${quoted} && ${command})`;
            const result = await session.exec(scoped, timeoutMs, signal);
            if (result.timedOut) {
              return `[command timed out after ${timeoutMs / 1000}s; the shell session was restarted]\n${truncate(result.stdout, maxOutputChars)}`;
            }
            return withOverflow(
              { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: false, aborted: false },
            );
          }

          const { file, args } = shellInvocation(shellChoice, command);
          try {
            const result = await runProcess(file, args, { cwd: workingDir, timeoutMs, signal });
            return withOverflow(result);
          } catch (error: any) {
            if (error?.code === "ENOENT") throw new ToolError(`Shell "${file}" was not found on PATH.`);
            throw error;
          }
        }),
      }),
    );

    if (persistent) {
      tools.push(
        tool({
          name: "shell_reset",
          description:
            "Restart the shell session, clearing its working directory and environment variables. Use it if the shell gets stuck.",
          parameters: {},
          implementation: safe(async () => {
            resetSession(sessionSpec(shellChoice), root);
            return "Shell session restarted; the next command starts in the project root.";
          }),
        }),
      );
    }

    if (config.get("enableBackgroundTasks")) {
      const tasks = new TaskManager(join(stateDir, "tasks"));
      tools.push(
        tool({
          name: "task_run",
          description: text`
            Start a command in the background and get a task id back immediately. Use it for dev
            servers, watchers, long builds and test suites. Read its output with task_output (poll
            it), and end it with task_stop. It keeps running between your tool calls.
          `,
          parameters: { command: z.string(), cwd: z.string().optional(), name: z.string().optional() },
          implementation: safe(async ({ command, cwd, name }, ctx) => {
            checkCommand(command);
            const workingDir = await resolveSafe(root, cwd ?? ".");
            ctx.status(`Starting background task: ${command.slice(0, 60)}`);
            const task = await tasks.start(
              {
                file: shellInvocation(shellChoice, "").file,
                args: (command: string) => shellInvocation(shellChoice, command).args,
              },
              command,
              workingDir,
              name,
            );
            return `Started task ${task.id} (${task.name}). Read its output with task_output id "${task.id}".`;
          }),
        }),
        tool({
          name: "task_list",
          description: "List this chat's background tasks with their status (running, exited with a code, or gone).",
          parameters: {},
          implementation: safe(async () => {
            const all = await tasks.list();
            return all.length === 0 ? "No background tasks." : all.map(formatTaskLine).join("\n");
          }),
        }),
        tool({
          name: "task_output",
          description: text`
            Read a background task's output. Returns whatever was written after "offset" (0 = from
            the start) plus the next offset, so you can poll for new output without re-reading it all.
          `,
          parameters: {
            id: z.string(),
            offset: z.number().int().min(0).optional(),
            max_chars: z.number().int().min(200).max(100000).optional(),
          },
          implementation: safe(async ({ id, offset, max_chars }) => {
            const result = await tasks.output(id, offset ?? 0, max_chars ?? maxOutputChars);
            const status =
              result.state === "running"
                ? "running"
                : result.state === "exited"
                  ? `exited with code ${result.task.exitCode}`
                  : "no longer running (it started before the plugin restarted)";
            return `task ${id} (${result.task.name}): ${status}\nnext_offset: ${result.nextOffset}\n\n${result.text || "(no new output)"}`;
          }),
        }),
        tool({
          name: "task_stop",
          description: "Stop a running background task (kills the process and its children).",
          parameters: { id: z.string() },
          implementation: safe(async ({ id }) => {
            const { task, state, killed } = await tasks.stop(id);
            if (killed) return `Stopped task ${id} (${task.name}).`;
            return `Task ${id} was already ${state === "exited" ? `finished (code ${task.exitCode})` : "not running"}.`;
          }),
        }),
      );
    }
  }

  if (config.get("enableDiagnostics")) {
    tools.push(
      tool({
        name: "diagnostics",
        description: text`
          Run the project's own checkers (TypeScript, ESLint, Ruff, Pyright, cargo check, go vet,
          whichever the project has) and report the problems they find. Use it after editing code,
          instead of guessing whether a change compiles. Pass checker to run just one.
        `,
        parameters: { checker: z.string().optional(), timeout_seconds: z.number().int().min(5).max(900).optional() },
        implementation: safe(async ({ checker, timeout_seconds }, ctx) => {
          const available = await availableCheckers(root);
          if (available.length === 0) {
            throw new ToolError(
              "No checker was detected for this project (looked for tsconfig.json, ESLint config, pyproject.toml, Cargo.toml, go.mod).",
            );
          }
          const selected = checker ? available.filter(c => c.name === checker.trim().toLowerCase()) : available;
          if (selected.length === 0) {
            throw new ToolError(`Checker "${checker}" is not available here. Available: ${available.map(c => c.name).join(", ")}.`);
          }
          const reports: string[] = [];
          for (const one of selected) {
            ctx.status(`Running ${one.name} (${one.description})`);
            reports.push(await runChecker(one, root, { signal: ctx.signal, timeoutMs: (timeout_seconds ?? 180) * 1000, maxChars: maxOutputChars }));
          }
          return reports.join("\n\n");
        }),
      }),
    );
  }

  if (config.get("enableSubagent")) {
    tools.push(
      tool({
        name: "run_subagent",
        description: text`
          Hand a self-contained research question to a sub-agent that can only read: it searches the
          project on its own and returns a short report, without filling this conversation with file
          contents. Good for "where is X handled?" or "how does Y work?". It cannot change anything,
          so do the edits yourself afterwards. Give it one clear question and say what to report back.
        `,
        parameters: { task: z.string().min(1), max_rounds: z.number().int().min(1).max(20).optional() },
        implementation: safe(async ({ task, max_rounds }, ctx) => {
          const readOnly = new Set(["read_file", "list_dir", "glob", "grep", "notebook_read"]);
          const subTools = tools.filter(t => readOnly.has(t.name));
          ctx.status("Starting sub-agent");
          const model = await pickSubagentModel(ctl.client, config.get("subagentModel"));
          const result = await runSubagent({
            model,
            tools: subTools,
            task,
            maxRounds: max_rounds ?? 8,
            signal: ctx.signal,
            onProgress: text => ctx.status(text),
          });
          const used = result.toolCalls.length ? `tools used: ${[...new Set(result.toolCalls)].join(", ")}` : "no tools used";
          return `Sub-agent report (${result.rounds} rounds, ${used}):\n\n${truncate(result.report, maxOutputChars)}`;
        }),
      }),
    );
  }

  if (planning) {
    const changesThings = new Set([
      "write_file",
      "edit_file",
      "multi_edit",
      "insert_lines",
      "undo_edit",
      "notebook_edit",
      "task_run",
      "task_stop",
    ]);
    return tools.filter(t => !changesThings.has(t.name));
  }
  return tools;
}
