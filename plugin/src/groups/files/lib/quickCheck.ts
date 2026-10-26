import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { extname } from "path";
import { findExecutable, runProcess } from "../../../shared/process";

/**
 * A fast syntax check of one file a tool just wrote, so a broken edit is reported in the same tool
 * result instead of surfacing three steps later (Aider runs its linter after every edit for the same
 * reason). Only checks that need no project setup and run without a shell: the file path is passed
 * as an argument, never put into a command line. Returns the problem, or null when the file is fine
 * or there is no check for its kind.
 */
export async function quickCheck(file: string, options: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<string | null> {
  const extension = extname(file).toLowerCase();
  const timeoutMs = options.timeoutMs ?? 15_000;
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    // --check only parses; it runs nothing and loads nothing from the project.
    const result = await runProcess(process.execPath, ["--check", file], { cwd: tmpdir(), timeoutMs, signal: options.signal });
    return result.exitCode === 0 || result.timedOut ? null : describe("node --check", result.stderr);
  }
  if (extension === ".py") {
    const python = findExecutable("python") ?? findExecutable("python3");
    if (!python) return null;
    // -I (isolated): no current folder or script folder on the module path, no PYTHON* variables, no
    // user site-packages. Without it, `python -m py_compile` imports a project's own tokenize.py or
    // py_compile.py instead of the standard ones, and a file in a cloned repository (or one the model
    // just wrote) would run. compile() only parses; it writes no __pycache__ into the project either.
    // The working folder is the system's temporary folder, not the project, for the same reason.
    const result = await runProcess(
      python,
      ["-I", "-c", "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec', dont_inherit=True)", file],
      { cwd: tmpdir(), timeoutMs, signal: options.signal },
    );
    // Windows' Store placeholder answers every call with an offer to install Python: no Python here.
    if (/Microsoft Store|was not found; run without arguments/i.test(result.stderr)) return null;
    return result.exitCode === 0 || result.timedOut ? null : describe("Python", result.stderr);
  }
  if (extension === ".json") {
    const text = await readFile(file, "utf-8").catch(() => null);
    // tsconfig.json, VS Code settings and the like allow comments; a strict parse would cry wolf.
    if (text === null || /\/\/|\/\*/.test(text)) return null;
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      return describe("JSON", (error as Error).message);
    }
  }
  return null;
}

/** The checker's output trimmed to what helps: the lines that say what and where. */
function describe(checker: string, output: string): string {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .filter(line => line.trim() && !/^\s+at /.test(line) && !/^Node\.js v\d/.test(line));
  return `${checker} found a problem:\n${lines.slice(0, 8).join("\n")}`;
}
