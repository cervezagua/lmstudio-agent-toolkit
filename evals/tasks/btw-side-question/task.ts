import { execFileSync } from "node:child_process";
import { listFiles } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const CHECK = `
const { isLeapYear, daysInMonth } = require("./src/dates");
const out = [];
for (const [y, leap] of [[1900, false], [2000, true], [2024, true], [2023, false], [2100, false]]) if (isLeapYear(y) !== leap) out.push("isLeapYear(" + y + ") is " + isLeapYear(y));
if (daysInMonth(2, 2024) !== 29) out.push("February 2024 has " + daysInMonth(2, 2024) + " days");
if (daysInMonth(2, 2023) !== 28) out.push("February 2023 has " + daysInMonth(2, 2023) + " days");
console.log(JSON.stringify(out));
`;

const task: EvalTask = {
  area: "long",
  prompt: "Add an isLeapYear(year) function to src/dates.js and export it.",
  followUps: [
    "/btw quick question: what exactly is the leap-year rule in the Gregorian calendar?",
    "Now make daysInMonth(month, year) give 29 days for February in a leap year, and add tests for both functions in test/dates.test.js. Run them.",
  ],
  async check({ dir, answers }) {
    const problems: string[] = [];
    // The side question is answered, from knowledge, with the 100 and 400 exceptions.
    const side = answers[1] ?? "";
    if (!/400/.test(side) || !/100|centur|1900/i.test(side)) problems.push("the /btw answer does not give the century and 400 rule");
    try {
      problems.push(...(JSON.parse(execFileSync(process.execPath, ["-e", CHECK], { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 30_000 })) as string[]));
    } catch (error: any) {
      problems.push(`src/dates.js fails to load: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
    }
    if (!(await listFiles(dir)).some(f => /^test\/.*dates.*\.js$/.test(f))) problems.push("no test file was added");
    return problems;
  },
};

export default task;
