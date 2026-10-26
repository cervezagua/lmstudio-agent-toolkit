import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { read } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const PRICE = `/** A price in cents as "12.34 EUR". */
function price(cents) {
  return (cents / 100).toFixed(2) + " EUR";
}

module.exports = { price };
`;

const task: EvalTask = {
  area: "recovery",
  prompt: "Rename the function price in src/price.js to formatPrice, and add a README.md that documents it.",
  followUps: ["/rewind 1"],
  async setup(dir) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "price.js"), PRICE);
  },
  async check({ dir, answers, calls }) {
    const problems: string[] = [];
    // Only a rewind of real work counts: the first message must have made the change.
    if (!calls.some(c => /write_file|edit_file|multi_edit/.test(c.name) && /formatPrice/.test(c.args) && !c.failed)) {
      problems.push("the first message never renamed the function, so there was nothing to rewind");
    }
    if ((await read(dir, "src/price.js")) !== PRICE) problems.push("src/price.js is not back to how it was before the first message");
    if (existsSync(join(dir, "README.md"))) problems.push("README.md, made by the first message, is still there");
    if (!/price\.js/i.test(answers[1] ?? "")) problems.push("the reply to /rewind does not say what was put back");
    return problems;
  },
};

export default task;
