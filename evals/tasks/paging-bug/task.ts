import { execFileSync } from "node:child_process";
import { type EvalTask } from "../../lib/task";

// Run in a child process, so the model's code is loaded fresh and cannot hang the runner.
const CHECK = `
const { exportPages } = require("./src/export");
const items = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: "c" + (i + 1) }));
const out = [];
for (const [n, size] of [[11, 4], [8, 4], [3, 4], [0, 4], [10, 3], [1, 1]]) {
  const pages = exportPages(items(n), size);
  const ids = pages.flat().map(c => c.id);
  const ok = ids.length === n && ids.every((id, i) => id === i + 1) && pages.every(p => p.length > 0 && p.length <= size);
  if (!ok) out.push(n + " customers, " + size + " a page: " + JSON.stringify(pages.map(p => p.map(c => c.id))));
}
console.log(JSON.stringify(out));
`;

const task: EvalTask = {
  area: "code",
  prompt:
    "Our customer export is wrong: the first customer of every page is missing, and some customers at the end never " +
    "show up at all. Find out why and fix it.",
  async check({ dir }) {
    try {
      const wrong: string[] = JSON.parse(execFileSync(process.execPath, ["-e", CHECK], { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 30_000 }));
      return wrong.map(w => `pages are wrong for ${w}`);
    } catch (error: any) {
      return [`the export fails to run: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`];
    }
  },
};

export default task;
