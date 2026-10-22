import { execFileSync } from "node:child_process";
import { read } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const HEADER = "// Owner: platform-team";

const task: EvalTask = {
  area: "memory",
  // Two separate chats: the preference has to be saved in the first and recalled in the second.
  prompt: [
    `Please remember this for future chats: every new JavaScript file you create for me must start with the line ${HEADER}`,
    "Add a file src/clamp.js that exports a function clamp(value, min, max).",
  ],
  async check({ dir }) {
    const problems: string[] = [];
    const source = await read(dir, "src/clamp.js");
    if (source === null) return ["src/clamp.js was not created"];
    if (source.split(/\r?\n/)[0].trim() !== HEADER) problems.push(`src/clamp.js starts with ${JSON.stringify(source.split(/\r?\n/)[0])}, not the remembered line`);
    try {
      const got = execFileSync(
        process.execPath,
        ["-e", 'const m = require("./src/clamp"); const clamp = m.clamp ?? m; console.log([clamp(5, 0, 3), clamp(-2, 0, 3), clamp(2, 0, 3)].join(","))'],
        { cwd: dir, encoding: "utf-8", stdio: "pipe" },
      ).trim();
      if (got !== "3,0,2") problems.push(`clamp gives ${got}, not 3,0,2`);
    } catch (error: any) {
      problems.push(`src/clamp.js fails to load: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
    }
    return problems;
  },
};

export default task;
