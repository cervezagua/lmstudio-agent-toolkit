import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBlockedPattern, parsePatterns } from "./blocklist";
import { globFiles, grepFiles } from "./search";

describe("blocklist", () => {
  it.each([
    "rm -rf /",
    "sudo rm -rf ~",
    "rm -fr *",
    "format C:",
    "Remove-Item -Recurse -Force C:\\",
    "rd /s /q D:\\",
    "diskpart",
    "Stop-Computer -Force",
    "mkfs.ext4 /dev/sda1",
    ":(){ :|:& };:",
  ])("blocks %s", command => {
    expect(findBlockedPattern(command)).toBeDefined();
  });

  it.each([
    "rm -rf node_modules",
    "rm -rf ./dist",
    "Remove-Item -Recurse .\\build",
    "del C:\\project\\tmp.txt",
    "Get-ChildItem | Format-Table",
    "npm test",
    "git status",
  ])("allows %s", command => {
    expect(findBlockedPattern(command)).toBeUndefined();
  });

  it("applies user patterns and reports invalid ones", () => {
    const { patterns, invalid } = parsePatterns(["git\\s+push", "  ", "([unclosed"]);
    expect(invalid).toEqual(["([unclosed"]);
    expect(findBlockedPattern("GIT PUSH origin main", patterns)).toBeDefined();
  });
});

describe("search", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "coder-tools-search-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
    await writeFile(join(root, "src", "b.py"), "ALPHA = 3\n");
    await writeFile(join(root, "node_modules", "dep", "index.js"), "alpha");
    await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 97, 108, 112, 104, 97]));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("globs files and skips node_modules", async () => {
    const { files } = await globFiles({ cwd: root, pattern: "**/*.{ts,js,py}", limit: 50 });
    const normalize = (f: string) => f.replace(/\\/g, "/");
    expect(files.map(normalize).sort()).toEqual([join(root, "src", "a.ts"), join(root, "src", "b.py")].map(normalize).sort());
  });

  it("greps with line numbers, case options, globs, and skips binaries", async () => {
    const base = { root, searchPath: root, maxResults: 50 };
    expect((await grepFiles({ ...base, pattern: "alpha", ignoreCase: false })).matches).toEqual([
      "src/a.ts:1: const alpha = 1;",
    ]);
    expect((await grepFiles({ ...base, pattern: "alpha", ignoreCase: true })).matches).toHaveLength(2);
    expect((await grepFiles({ ...base, pattern: "alpha", ignoreCase: true, glob: "*.py" })).matches).toEqual([
      "src/b.py:1: ALPHA = 3",
    ]);
  });

  it("stops at maxResults", async () => {
    const result = await grepFiles({ root, searchPath: root, pattern: "const", ignoreCase: false, maxResults: 1 });
    expect(result).toMatchObject({ truncated: true });
    expect(result.matches).toHaveLength(1);
  });
});

describe("grep output modes", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "coder-grepmodes-"));
    await writeFile(join(root, "a.ts"), "import x\nconst target = 1;\nuse(target);\ndone();\n");
    await writeFile(join(root, "b.ts"), "no hits here\n");
    await writeFile(join(root, "c.ts"), "target\ntarget\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const grep = (extra: Record<string, unknown> = {}) =>
    grepFiles({ root, searchPath: root, pattern: "target", ignoreCase: false, maxResults: 50, ...extra });

  it("lists only file paths in files_with_matches mode", async () => {
    const result = await grep({ outputMode: "files_with_matches" });
    expect(result.matches).toEqual(["a.ts", "c.ts"]);
  });

  it("counts matches per file in count mode", async () => {
    const result = await grep({ outputMode: "count" });
    expect(result.matches).toEqual(["a.ts: 2", "c.ts: 2"]);
  });

  it("includes context lines around each match", async () => {
    const result = await grep({ context: 1, maxResults: 1 });
    expect(result.matches[0]).toBe("a.ts:1- import x\na.ts:2: const target = 1;\na.ts:3- use(target);");
  });

  it("pages through matches with offset", async () => {
    const all = await grep();
    expect(all.matches).toHaveLength(4);
    const paged = await grep({ offset: 2 });
    expect(paged.matches).toEqual(all.matches.slice(2));
    expect((await grep({ offset: 99 })).matches).toEqual([]);
  });

  it("reports truncation when more results exist", async () => {
    const result = await grep({ maxResults: 2 });
    expect(result).toMatchObject({ truncated: true });
    expect(result.matches).toHaveLength(2);
  });
});
