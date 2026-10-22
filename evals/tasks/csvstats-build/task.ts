import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const SPEC = `Build a command-line tool in this empty folder: csvstats.js, plain Node with no dependencies.

  node csvstats.js <file.csv> [--column <name>]

The first line of the file is the header. For every column whose non-empty values are all numbers, print one line:
  <column>: count=<n> min=<min> max=<max> mean=<mean> median=<median>
with mean and median rounded to 2 decimals. Empty cells are skipped, and columns with any non-numeric value are left out.
Fields can be quoted, and a quoted field can contain commas and doubled quotes ("").
With --column, print only that column; if it does not exist or is not numeric, print an error to stderr and exit with code 1.
If the file does not exist, print an error to stderr and exit with code 2.
Add tests, and make sure they pass.`;

const SALES = [
  "region,units,price,note,discount",
  'North,12,9.5,"big, early order",0',
  'South,7,10,"said ""thanks""",',
  "East,-3,12.25,return,5",
  "West,40,8,,2.5",
  'Central,1,11,"quoted ""x"", with commas, here",',
].join("\n");

const expected: Record<string, number[]> = {
  units: [5, -3, 40, 11.4, 7],
  price: [5, 8, 12.25, 10.15, 10],
  discount: [3, 0, 5, 2.5, 2.5],
};

function cli(dir: string, ...args: string[]) {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["csvstats.js", ...args], { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 20_000 }), err: "" };
  } catch (error: any) {
    return { code: error.status ?? 1, out: String(error.stdout ?? ""), err: String(error.stderr ?? "") };
  }
}

function statsLine(out: string, column: string): number[] | null {
  const line = out.split(/\r?\n/).find(l => l.trim().startsWith(`${column}:`));
  if (!line) return null;
  return ["count", "min", "max", "mean", "median"].map(key => Number(new RegExp(`${key}=(-?[\\d.]+)`).exec(line)?.[1] ?? NaN));
}

const task: EvalTask = {
  area: "long",
  maxRounds: 80,
  minutes: 25,
  prompt: SPEC,
  async check({ dir }) {
    const problems: string[] = [];
    if (!(await listFiles(dir)).includes("csvstats.js")) return ["csvstats.js was not created"];
    await writeFile(join(dir, "check-sales.csv"), SALES);
    const all = cli(dir, "check-sales.csv");
    if (all.code !== 0) problems.push(`it fails on a valid file: ${all.err.trim().split("\n")[0]}`);
    for (const [column, want] of Object.entries(expected)) {
      const got = statsLine(all.out, column);
      if (!got) problems.push(`no line for ${column}`);
      else if (got.some((value, i) => !(Math.abs(value - want[i]) < 0.006))) problems.push(`${column}: got ${got.join(" ")}, expected ${want.join(" ")}`);
    }
    for (const skipped of ["region", "note"]) if (statsLine(all.out, skipped)) problems.push(`the non-numeric column ${skipped} is printed`);
    const one = cli(dir, "check-sales.csv", "--column", "price");
    if (!statsLine(one.out, "price") || statsLine(one.out, "units")) problems.push("--column price does not print just price");
    if (cli(dir, "check-sales.csv", "--column", "note").code !== 1) problems.push("--column with a non-numeric column does not exit with 1");
    if (cli(dir, "check-sales.csv", "--column", "nope").code !== 1) problems.push("--column with an unknown column does not exit with 1");
    if (cli(dir, "missing.csv").code !== 2) problems.push("a missing file does not exit with 2");
    const tests = (await listFiles(dir)).filter(f => /test/i.test(f) && f.endsWith(".js"));
    if (tests.length === 0) problems.push("no tests were added");
    return problems;
  },
};

export default task;
