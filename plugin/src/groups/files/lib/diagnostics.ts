import { readFile, stat } from "fs/promises";
import { join } from "path";
import { ToolError } from "../../../shared/errors";
import { commandEnv, findExecutable, runProcess } from "../../../shared/process";
import { truncate } from "../../../shared/truncate";

export interface Checker {
  name: string;
  /** What it needs in the project root to be worth running. */
  detect: (root: string) => Promise<boolean>;
  command: (root: string) => { file: string; args: string[] };
  /** Non-zero exit usually means "found problems", not "the tool broke". */
  description: string;
}

const exists = async (path: string) => stat(path).then(() => true, () => false);

async function packageJsonHas(root: string, ...keys: string[]): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return keys.some(key => key in deps);
  } catch {
    return false;
  }
}

/**
 * A project's own tool, run through npx without ever downloading one. On Windows npx is npx.cmd, and
 * Node refuses to start a .cmd file directly (spawn EINVAL, since the 2024 fix for argument
 * injection through batch files), so it goes through cmd.exe there. The arguments are fixed words
 * from this file, never text from the model, so there is nothing for cmd.exe to misread.
 */
export function npxCommand(args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  const all = ["--no-install", ...args];
  return platform === "win32" ? { file: "cmd.exe", args: ["/d", "/s", "/c", "npx", ...all] } : { file: "npx", args: all };
}

/**
 * A checker found on PATH. One installed through npm is a .cmd file on Windows (pyright is, usually),
 * which has the same problem as npx above and the same answer.
 */
function installedCommand(name: string, args: string[]): { file: string; args: string[] } {
  const found = findExecutable(name);
  if (process.platform === "win32" && found && /\.(cmd|bat)$/i.test(found)) {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", name, ...args] };
  }
  return { file: found ?? name, args };
}

export const CHECKERS: Checker[] = [
  {
    name: "tsc",
    description: "TypeScript type checking",
    detect: root => exists(join(root, "tsconfig.json")),
    command: () => npxCommand(["tsc", "--noEmit", "--pretty", "false"]),
  },
  {
    name: "eslint",
    description: "ESLint",
    detect: async root =>
      (await packageJsonHas(root, "eslint")) ||
      (await Promise.all(["eslint.config.js", "eslint.config.mjs", ".eslintrc", ".eslintrc.json", ".eslintrc.cjs"].map(f => exists(join(root, f))))).some(Boolean),
    // The default formatter: "compact" and most others were removed from ESLint itself in version 9.
    command: () => npxCommand(["eslint", "."]),
  },
  {
    name: "ruff",
    description: "Ruff (Python lint)",
    detect: async root =>
      findExecutable("ruff") !== null &&
      (await Promise.all(["pyproject.toml", "ruff.toml", ".ruff.toml"].map(f => exists(join(root, f))))).some(Boolean),
    command: () => installedCommand("ruff", ["check", "--output-format", "concise", "."]),
  },
  {
    name: "pyright",
    description: "Pyright (Python types)",
    detect: async root => findExecutable("pyright") !== null && (await exists(join(root, "pyrightconfig.json"))),
    command: () => installedCommand("pyright", ["--outputjson"]),
  },
  {
    name: "cargo",
    description: "cargo check (Rust)",
    detect: async root => findExecutable("cargo") !== null && (await exists(join(root, "Cargo.toml"))),
    command: () => installedCommand("cargo", ["check", "--message-format", "short"]),
  },
  {
    name: "go",
    description: "go vet",
    detect: async root => findExecutable("go") !== null && (await exists(join(root, "go.mod"))),
    command: () => installedCommand("go", ["vet", "./..."]),
  },
];

export async function availableCheckers(root: string): Promise<Checker[]> {
  const found: Checker[] = [];
  for (const checker of CHECKERS) {
    if (await checker.detect(root)) found.push(checker);
  }
  return found;
}

export async function runChecker(
  checker: Checker,
  root: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxChars: number },
): Promise<string> {
  const { file, args } = checker.command(root);
  let result;
  try {
    result = await runProcess(file, args, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? 180_000,
      signal: options.signal,
      // The same environment the checker was looked for in: see commandEnv.
      env: commandEnv({ NO_COLOR: "1", FORCE_COLOR: "0" }),
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new ToolError(`${checker.name} is not installed or not on PATH.`);
    throw error;
  }
  if (result.timedOut) return `${checker.name}: timed out.`;
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
  if (result.exitCode === 0) return `${checker.name}: no problems found.`;
  return `${checker.name} (exit ${result.exitCode}):\n${truncate(output || "(no output)", options.maxChars)}`;
}
