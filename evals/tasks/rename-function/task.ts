import { firstError, listFiles, read, run } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "code",
  prompt: "Rename the function toSlug to slugify everywhere in this project.",
  async check({ dir }) {
    const problems: string[] = [];
    for (const file of await listFiles(dir)) {
      if (file === "test.js") continue;
      if ((await read(dir, file))?.includes("toSlug")) problems.push(`${file} still says toSlug`);
    }
    for (const [file, args] of [["test.js", ["test.js"]], ["app.js", ["app.js"]]] as const) {
      const result = run(dir, process.execPath, [...args]);
      if (result.code !== 0) problems.push(`${file} fails: ${firstError(result.output)}`);
    }
    return problems;
  },
};

export default task;