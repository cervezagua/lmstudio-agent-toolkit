import { readFile, stat } from "fs/promises";
import { join } from "path";
import { ToolError } from "../../../shared/errors";
import { findExecutable, runProcess } from "../../../shared/process";
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

const npx = () => (process.platform === "win32" ? "npx.cmd" : "npx");

export const CHECKERS: Checker[] = [
  {
    name: "tsc",
    description: "TypeScript type checking",
    detect: root => exists(join(root, "tsconfig.json")),
    command: () => ({ file: npx(), args: ["--no-install", "tsc", "--noEmit", "--pretty", "false"] }),
  },
  {
    name: "eslint",
    description: "ESLint",
    detect: async root =>
      (await packageJsonHas(root, "eslint")) ||
      (await Promise.all(["eslint.config.js", "eslint.config.mjs", ".eslintrc", ".eslintrc.json", ".eslintrc.cjs"].map(f => exists(join(root, f))))).some(Boolean),
    command: () => ({ file: npx(), args: ["--no-install", "eslint", ".", "--format", "compact"] }),
  },
  {
    name: "ruff",
    description: "Ruff (Python lint)",
    detect: async root =>
      findExecutable("ruff") !== null &&
      (await Promise.all(["pyproject.toml", "ruff.toml", ".ruff.toml"].map(f => exists(join(root, f))))).some(Boolean),
    command: () => ({ file: "ruff", args: ["check", "--output-format", "concise", "."] }),
  },
  {
    name: "pyright",
    description: "Pyright (Python types)",
    detect: async root => findExecutable("pyright") !== null && (await exists(join(root, "pyrightconfig.json"))),
    command: () => ({ file: "pyright", args: ["--outputjson"] }),
  },
  {
    name: "cargo",
    description: "cargo check (Rust)",
    detect: async root => findExecutable("cargo") !== null && (await exists(join(root, "Cargo.toml"))),
    command: () => ({ file: "cargo", args: ["check", "--message-format", "short"] }),
  },
  {
    name: "go",
    description: "go vet",
    detect: async root => findExecutable("go") !== null && (await exists(join(root, "go.mod"))),
    command: () => ({ file: "go", args: ["vet", "./..."] }),
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
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
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
