import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolError } from "./errors";
import { displayPath, resolveInside, resolveSafe } from "./paths";

describe("resolveInside", () => {
  const root = resolve("/project/root");

  it("resolves relative paths inside the root", () => {
    expect(resolveInside(root, "src/index.ts")).toBe(join(root, "src", "index.ts"));
    expect(resolveInside(root, ".")).toBe(root);
    expect(resolveInside(root, "a/../b")).toBe(join(root, "b"));
  });

  it("allows names that merely start with two dots", () => {
    expect(resolveInside(root, "..config")).toBe(join(root, "..config"));
  });

  it("rejects traversal and absolute paths outside the root", () => {
    expect(() => resolveInside(root, "..")).toThrow(ToolError);
    expect(() => resolveInside(root, "../sibling/file")).toThrow(ToolError);
    expect(() => resolveInside(root, resolve("/etc/passwd"))).toThrow(ToolError);
    expect(() => resolveInside(root, resolve("/project/root-evil/x"))).toThrow(ToolError);
  });

  it("accepts absolute paths that are inside the root", () => {
    expect(resolveInside(root, join(root, "x.txt"))).toBe(join(root, "x.txt"));
  });

  it.runIf(process.platform === "win32")("rejects other drives and is case-insensitive on Windows", () => {
    expect(() => resolveInside("C:\\project", "D:\\secret.txt")).toThrow(ToolError);
    expect(resolveInside("C:\\Project", "c:\\project\\a.txt")).toBe("c:\\project\\a.txt");
  });
});

describe("resolveSafe", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "coder-tools-paths-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    // "junction" works without admin rights on Windows; ignored elsewhere.
    await symlink(outside, join(root, "link"), "junction");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("allows files that do not exist yet", async () => {
    await expect(resolveSafe(root, "new/dir/file.txt")).resolves.toBe(join(root, "new", "dir", "file.txt"));
  });

  it("rejects paths that escape through a link", async () => {
    await expect(resolveSafe(root, "link/secret.txt")).rejects.toThrow(ToolError);
    await expect(resolveSafe(root, "link/not-yet.txt")).rejects.toThrow(ToolError);
  });
});

describe("displayPath", () => {
  it("uses forward slashes relative to the root", () => {
    const root = resolve("/r");
    expect(displayPath(root, join(root, "a", "b.txt"))).toBe("a/b.txt");
    expect(displayPath(root, root)).toBe(".");
  });
});
