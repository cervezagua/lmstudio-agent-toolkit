import { existsSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findExecutable } from "../../../shared/process";
import { quickCheck } from "./quickCheck";

describe("quickCheck", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "quick-check-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const check = async (name: string, content: string) => {
    await writeFile(join(dir, name), content);
    return quickCheck(join(dir, name), { cwd: dir });
  };

  it("passes good JavaScript and reports a syntax error with its line", async () => {
    expect(await check("good.js", "const a = 1;\nmodule.exports = { a };\n")).toBeNull();
    const problem = await check("bad.js", "function f() {\n  return 1;\n");
    expect(problem).toMatch(/^node --check found a problem:/);
    expect(problem).toContain("SyntaxError");
    expect(problem).not.toMatch(/^\s+at /m);
  }, 30000);

  it.skipIf(!findExecutable("python") && !findExecutable("python3"))("reports a Python syntax error", async () => {
    expect(await check("good.py", "def f():\n    return 1\n")).toBeNull();
    expect(await check("bad.py", "def f(:\n    return 1\n")).toMatch(/^Python found a problem:/);
  }, 30000);

  // A project's own tokenize.py or py_compile.py used to replace the standard module during the check,
  // so a cloned repository (or the model) could run code just by having a .py file edited.
  it.skipIf(!findExecutable("python") && !findExecutable("python3"))("never runs the project's own Python modules", async () => {
    const marker = join(dir, "ran.txt");
    const payload = `open(${JSON.stringify(marker)}, "w").write("ran")\n`;
    for (const name of ["py_compile.py", "tokenize.py", "linecache.py", "traceback.py"]) await writeFile(join(dir, name), payload);
    expect(await check("app.py", "x = 1\n")).toBeNull();
    expect(await check("broken.py", "def f(:\n")).toMatch(/^Python found a problem:/);
    expect(existsSync(marker)).toBe(false);
  }, 30000);

  it("reports broken JSON, but not JSON with comments, which tsconfig allows", async () => {
    expect(await check("good.json", '{ "a": 1 }')).toBeNull();
    expect(await check("bad.json", '{ "a": 1, }')).toMatch(/^JSON found a problem:/);
    expect(await check("tsconfig.json", '{ // comments are fine here\n "a": 1, }')).toBeNull();
    expect(await check("bom.json", String.fromCharCode(0xfeff) + '{ "a": 1 }')).toBeNull();
  });

  it("does not call JSX in a .js file broken, but does report a leftover merge marker", async () => {
    expect(await check("App.js", "export default function App() {\n  return <div className=\"x\">hi</div>;\n}\n")).toBeNull();
    expect(await check("merged.js", "const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> main\n")).toMatch(/^node --check found a problem:/);
  }, 30000);

  it("says nothing when the check was stopped", async () => {
    const stopped = new AbortController();
    stopped.abort();
    await writeFile(join(dir, "slow.js"), "function f() {\n");
    expect(await quickCheck(join(dir, "slow.js"), { cwd: dir, signal: stopped.signal })).toBeNull();
  }, 30000);

  it("has nothing to say about other kinds of file", async () => {
    expect(await check("notes.md", "# anything {")).toBeNull();
  });
});
