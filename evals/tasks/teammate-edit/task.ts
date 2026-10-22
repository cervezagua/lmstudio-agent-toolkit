import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { read } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

/** The project folders whose config.js the teammate has already changed. */
const changed = new Set<string>();

const task: EvalTask = {
  area: "recovery",
  prompt: "In config.js, raise the request timeout from 30 to 60 seconds.",
  async setup(dir) {
    changed.delete(dir);
  },
  // Right after the model first sees config.js, a teammate changes another line of it. The model's
  // edit is then refused as stale, and it has to read the file again rather than undo their change.
  afterCall(call, dir) {
    if (changed.has(dir) || !/config\.js/.test(call.args) || call.failed || !/read_file|grep/.test(call.name)) return;
    changed.add(dir);
    const file = join(dir, "config.js");
    writeFileSync(file, readFileSync(file, "utf-8").replace("retries: 2,", "retries: 5, // raised for the flaky gateway"));
  },
  async check({ dir }) {
    const problems: string[] = [];
    const source = (await read(dir, "config.js")) ?? "";
    if (!changed.has(dir)) problems.push("the model never read config.js, so the teammate's change was not made");
    if (!/requestTimeout:\s*60\b/.test(source)) problems.push("the timeout is not 60");
    if (!source.includes("retries: 5, // raised for the flaky gateway")) problems.push("the teammate's change to retries was lost");
    return problems;
  },
};

export default task;
