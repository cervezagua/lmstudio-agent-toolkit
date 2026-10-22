import { join } from "node:path";
import { firstError, read, run } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "code",
  prompt: "The tests in this project fail. Find the bug and fix it so the tests pass. Don't change the tests.",
  async check({ dir }) {
    const problems: string[] = [];
    const result = run(dir, process.execPath, [join("test", "cart.test.js")]);
    if (result.code !== 0) problems.push(`the tests still fail: ${firstError(result.output)}`);
    const original = await read(join(__dirname, "project"), "test/cart.test.js");
    if ((await read(dir, "test/cart.test.js")) !== original) problems.push("the tests were changed");
    return problems;
  },
};

export default task;