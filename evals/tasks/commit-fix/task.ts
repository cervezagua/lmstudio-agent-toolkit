import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, git } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "git",
  config: { enableGit: true },
  prompt:
    "I fixed the empty-list bug in src/math.js. Commit just that fix with a short message that says what it fixes. " +
    "Leave my other changes uncommitted.",
  async setup(dir) {
    // The history has the bug; the working tree has the fix plus two unrelated changes.
    const math = join(dir, "src", "math.js");
    const fixed = await readFile(math, "utf-8");
    await writeFile(math, fixed.replace("  if (values.length === 0) return 0;\n", "").replace("; 0 for an empty list", ""));
    commitAll(dir, "Add average");
    await writeFile(math, fixed);
    await writeFile(join(dir, "config.local.json"), '{ "port": 3000, "debug": true }\n');
    await appendFile(join(dir, "notes.txt"), "try a median helper next\n");
  },
  async check({ dir }) {
    const problems: string[] = [];
    const commits = git(dir, "rev-list", "--count", "HEAD").output.trim();
    if (commits !== "2") return [`expected one new commit, the history has ${commits} commits`];
    const changed = git(dir, "show", "--name-only", "--format=", "HEAD").output.trim().split("\n").filter(Boolean);
    if (changed.join(",") !== "src/math.js") problems.push(`the commit has ${changed.join(", ") || "no files"}, not just src/math.js`);
    const message = git(dir, "log", "-1", "--format=%s").output.trim();
    if (!/empty|zero|no values|\[\]|length/i.test(message)) problems.push(`the message "${message}" does not say what it fixes`);
    const status = git(dir, "status", "--porcelain").output;
    if (!/^ M config\.local\.json/m.test(status)) problems.push("config.local.json is no longer an uncommitted change");
    if (!/^\?\? notes\.txt/m.test(status)) problems.push("notes.txt is no longer untracked");
    return problems;
  },
};

export default task;
