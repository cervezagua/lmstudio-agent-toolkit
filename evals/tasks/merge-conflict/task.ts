import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, git, read } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const BASE = `/** The greeting shown at the top of the dashboard. */
function greet(name) {
  return "Hello, " + name + "!";
}

module.exports = { greet };
`;

const task: EvalTask = {
  area: "git",
  config: { enableGit: true },
  prompt:
    "Merge the feature/welcome branch into main. It will conflict in greet.js: keep both changes, the new " +
    "wording from the branch and the name trimming that was added on main.",
  async setup(dir) {
    await writeFile(join(dir, "greet.js"), BASE);
    commitAll(dir, "Add greet");
    git(dir, "checkout", "-q", "-b", "feature/welcome");
    await writeFile(join(dir, "greet.js"), BASE.replace('"Hello, " + name + "!"', '"Welcome back, " + name + "!"'));
    commitAll(dir, "Say welcome back");
    git(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "greet.js"), BASE.replace('"Hello, " + name + "!"', '"Hello, " + name.trim() + "!"'));
    commitAll(dir, "Trim the name");
  },
  async check({ dir }) {
    const problems: string[] = [];
    const parents = git(dir, "log", "-1", "--format=%P").output.trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 2) problems.push("HEAD is not a merge commit");
    if (git(dir, "rev-parse", "--abbrev-ref", "HEAD").output.trim() !== "main") problems.push("main is not checked out");
    if (git(dir, "status", "--porcelain").output.trim()) problems.push("the merge left uncommitted changes");
    const source = (await read(dir, "greet.js")) ?? "";
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) problems.push("greet.js still has conflict markers");
    try {
      const got = execFileSync(process.execPath, ["-e", 'console.log(require("./greet").greet("  Ada "))'], { cwd: dir, encoding: "utf-8", stdio: "pipe" }).trim();
      if (got !== "Welcome back, Ada!") problems.push(`greet("  Ada ") gives ${JSON.stringify(got)}, not "Welcome back, Ada!"`);
    } catch (error: any) {
      problems.push(`greet.js fails to load: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
    }
    return problems;
  },
};

export default task;
