import { execFileSync } from "node:child_process";
import { listFiles, read, run } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

// Every function, called the new way: each returns a promise with the same results and errors as before.
const CHECK = `
const db = require("./lib/db");
const { createUser, renameUser } = require("./lib/users");
const { userCount, namesSorted } = require("./lib/report");
const out = [];
const rejects = async (promise, pattern, what) => {
  try { await promise; out.push(what + " did not fail"); } catch (e) { if (!pattern.test(e.message)) out.push(what + " failed with " + e.message); }
};
(async () => {
  for (const [name, fn] of Object.entries({ put: () => db.put({ name: "x" }), get: () => db.get(1), list: () => db.list(), reset: () => db.reset() })) {
    const result = fn();
    if (!result || typeof result.then !== "function") out.push("db." + name + " does not return a promise");
    await result;
  }
  await db.reset();
  const b = await createUser(" Ben ");
  const a = await createUser("Ada");
  if (b.name !== "Ben" || a.id !== 2) out.push("createUser gives " + JSON.stringify([b, a]));
  if ((await renameUser(b.id, "Bea")).name !== "Bea") out.push("renameUser does not rename");
  await rejects(createUser("  "), /name is required/, "createUser with no name");
  await rejects(renameUser(42, "x"), /no user 42/, "renameUser of a missing user");
  await rejects(renameUser(a.id, ""), /name is required/, "renameUser with no name");
  if ((await userCount()) !== 2) out.push("userCount is wrong");
  if ((await namesSorted()).join(",") !== "Ada,Bea") out.push("namesSorted is wrong");
  console.log(JSON.stringify(out));
})().catch(e => console.log(JSON.stringify(["it threw: " + e.message])));
`;

const task: EvalTask = {
  area: "long",
  maxRounds: 80,
  minutes: 25,
  prompt:
    "Convert everything in lib/ from callbacks to async/await: every function should return a promise instead of " +
    "taking a callback. Update everything that calls them, the CLI and the tests included. Behaviour must not change.",
  async check({ dir }) {
    const problems: string[] = [];
    try {
      const got = execFileSync(process.execPath, ["-e", CHECK], { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 30_000 }).trim().split("\n").at(-1)!;
      problems.push(...(JSON.parse(got) as string[]));
    } catch (error: any) {
      problems.push(`lib fails to load: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
    }
    for (const file of (await listFiles(dir)).filter(f => f.endsWith(".js"))) {
      // Calls to a callback, or callback-style (error, result) => handlers; a comment about callbacks is fine.
      if (/\b(callback|cb|done)\s*\(|\(\s*err(or)?\d?\s*(,\s*\w+\s*)?\)\s*=>/.test((await read(dir, file)) ?? "")) {
        problems.push(`${file} still uses callbacks`);
      }
    }
    const cli = run(dir, process.execPath, ["bin/cli.js", "add", "Zoe", "Max"]);
    if (cli.code !== 0 || !cli.output.includes("2 users: Max, Zoe")) problems.push(`the CLI prints ${JSON.stringify(cli.output.trim().slice(0, 80))}`);
    const tests = run(dir, process.execPath, ["test/users.test.js"]);
    if (tests.code !== 0 || !tests.output.includes("passed")) problems.push("the tests fail");
    return problems;
  },
};

export default task;
