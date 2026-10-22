import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { read, run } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const TEST_FILES = ["test/money.test.js", "test/tax.test.js", "test/invoice.test.js"];

// Cases beyond the suite, so a fix that only satisfies the visible tests does not pass.
const CHECK = `
const { toCents } = require("./src/money");
const { vatFor } = require("./src/tax");
const { isOverdue, dueDate } = require("./src/due");
const out = [];
for (const [x, c] of [[0.57, 57], [4.35, 435], [100, 10000]]) if (toCents(x) !== c) out.push("toCents(" + x + ") = " + toCents(x));
for (const [k, n, v] of [["NL", 999, 210], ["FR", 1, 0], ["DE", 5, 1]]) if (vatFor(k, n) !== v) out.push("vatFor(" + k + ", " + n + ") = " + vatFor(k, n));
if (isOverdue("2026-05-10", "2026-05-09")) out.push("an invoice is overdue the day before it is due");
if (dueDate("2026-12-15", 30) !== "2027-01-14") out.push("dueDate changed");
console.log(JSON.stringify(out));
`;

const task: EvalTask = {
  area: "long",
  maxRounds: 60,
  minutes: 20,
  prompt: "Several tests in this project fail. Find the causes and fix the code until the whole suite passes. Don't change the tests.",
  async check({ dir }) {
    const problems: string[] = [];
    const suite = run(dir, process.execPath, ["--test"]);
    if (suite.code !== 0) problems.push(`the suite still fails (${/fail (\d+)/.exec(suite.output)?.[1] ?? "?"} failing)`);
    for (const file of TEST_FILES) {
      if ((await read(dir, file)) !== (await read(join(__dirname, "project"), file))) problems.push(`${file} was changed`);
    }
    try {
      problems.push(...(JSON.parse(execFileSync(process.execPath, ["-e", CHECK], { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 30_000 })) as string[]));
    } catch (error: any) {
      problems.push(`the code fails to load: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
    }
    return problems;
  },
};

export default task;
