import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { firstError, run } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const todos = [
  { id: 1, title: "Buy milk", done: true },
  { id: 2, title: "Call the plumber", done: false },
  { id: 10, title: "File taxes", done: false },
];

const task: EvalTask = {
  area: "code",
  prompt:
    "Add a --json option to this CLI's list command: with it, print the todos as a JSON array instead of the table. " +
    "Without it, list should print the table as it does now.",
  async check({ dir }) {
    const problems: string[] = [];
    const store = join(dir, "check-todos.json");
    await writeFile(store, JSON.stringify(todos));
    const env = { ...process.env, TODO_FILE: store };
    const cli = (...args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ["bin/todo.js", ...args], { cwd: dir, env, encoding: "utf-8", stdio: "pipe" }) };
      } catch (error: any) {
        return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
    };
    const json = cli("list", "--json");
    try {
      const parsed = JSON.parse(json.out);
      if (JSON.stringify(parsed) !== JSON.stringify(todos)) problems.push(`list --json printed different todos: ${json.out.slice(0, 120)}`);
    } catch {
      problems.push(`list --json did not print JSON: ${json.out.trim().slice(0, 120)}`);
    }
    const plain = cli("list");
    if (!plain.out.includes("[x]   1  Buy milk") || !plain.out.includes("[ ]  10  File taxes")) problems.push(`list without --json changed: ${plain.out.slice(0, 120)}`);
    const tests = run(dir, process.execPath, ["test/format.test.js"]);
    if (tests.code !== 0) problems.push(`the tests fail: ${firstError(tests.output)}`);
    return problems;
  },
};

export default task;
