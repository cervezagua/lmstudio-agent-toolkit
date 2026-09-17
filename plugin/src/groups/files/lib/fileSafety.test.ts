import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEdit, applyEdits } from "./edit";
import { assertFresh, clearFileState, forget, recordRead, recordWrite } from "./fileState";
import { assertReadableSize, looksBinary, readTextSlice } from "./readText";
import { writeFileAtomic } from "./safeWrite";
import { suggestPaths } from "./suggest";
import { ToolError } from "../../../shared/errors";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coder-safety-"));
  clearFileState();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("file state (read before edit)", () => {
  it("refuses a file the model never read", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "content");
    await expect(assertFresh(file, "a.txt", "content")).rejects.toThrow(/have not read a.txt/);
  });

  it("accepts a file that was read and is unchanged", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "content");
    await recordRead(file);
    await expect(assertFresh(file, "a.txt", "content")).resolves.toBeUndefined();
  });

  it("refuses a file whose content changed since it was read", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "before");
    await recordRead(file);
    await writeFile(file, "after");
    await expect(assertFresh(file, "a.txt", "after")).rejects.toThrow(/changed on disk since you read it/);
  });

  it("accepts a touched file whose content is identical (antivirus, cloud sync)", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "same");
    await recordRead(file);
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    await expect(assertFresh(file, "a.txt", "same")).resolves.toBeUndefined();
  });

  it("treats our own writes as read, and forget() undoes that", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "written");
    await recordWrite(file, "written");
    await expect(assertFresh(file, "a.txt", "written")).resolves.toBeUndefined();
    forget(file);
    await expect(assertFresh(file, "a.txt", "written")).rejects.toThrow(/have not read/);
  });

  it("remembers CRLF files exactly", async () => {
    const file = join(dir, "crlf.txt");
    await writeFile(file, "one\r\ntwo\r\n");
    await recordRead(file);
    await expect(assertFresh(file, "crlf.txt", "one\r\ntwo\r\n")).resolves.toBeUndefined();
  });
});

describe("atomic write", () => {
  it("replaces content and leaves no temporary files", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "old");
    await writeFileAtomic(file, "new");
    expect(await readFile(file, "utf-8")).toBe("new");
    expect((await readdir(dir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("creates a file that does not exist yet", async () => {
    const file = join(dir, "fresh.txt");
    await writeFileAtomic(file, "hello");
    expect(await readFile(file, "utf-8")).toBe("hello");
  });

  it.runIf(process.platform !== "win32")("keeps the original file mode", async () => {
    const file = join(dir, "script.sh");
    await writeFile(file, "#!/bin/sh\n", { mode: 0o755 });
    await writeFileAtomic(file, "#!/bin/sh\necho hi\n");
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });
});

describe("reading large files", () => {
  const bigFile = async (lines: number) => {
    const file = join(dir, "big.txt");
    await writeFile(file, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"));
    return file;
  };

  it("refuses a whole-file read over the limit but allows a window", async () => {
    const file = await bigFile(5000);
    const size = (await stat(file)).size;
    await expect(assertReadableSize(file, "big.txt", 1024, false)).rejects.toThrow(/over the 1 KB limit/);
    await expect(assertReadableSize(file, "big.txt", 1024, true)).resolves.toMatchObject({ size });
  });

  it("returns only the requested window and the true total", async () => {
    const file = await bigFile(5000);
    const slice = await readTextSlice(file, 4998, 10);
    expect(slice.lines).toEqual(["line 4998", "line 4999", "line 5000"]);
    expect(slice).toMatchObject({ start: 4998, totalLines: 5000 });
    await expect(readTextSlice(file, 9000, 10)).rejects.toThrow(/past the end/);
  });

  it("detects binary files from their first bytes", async () => {
    const binary = join(dir, "b.bin");
    await writeFile(binary, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
    expect(await looksBinary(binary)).toBe(true);
    const text = join(dir, "t.txt");
    await writeFile(text, "just text");
    expect(await looksBinary(text)).toBe(false);
  });
});

describe("path suggestions", () => {
  it("suggests the same name with another extension, and a deeper path", async () => {
    await mkdir(join(dir, "src", "components"), { recursive: true });
    await writeFile(join(dir, "src", "components", "Button.tsx"), "x");
    await writeFile(join(dir, "src", "index.ts"), "x");

    expect(await suggestPaths(dir, "src/components/Button.ts")).toContain("src/components/Button.tsx");
    expect(await suggestPaths(dir, "components/Button.tsx")).toContain("src/components/Button.tsx");
    expect(await suggestPaths(dir, "totally/unrelated.xyz")).toEqual([]);
  });
});

describe("edit guards", () => {
  it("removes the whole line when new_string is empty", () => {
    expect(applyEdit("one\ntwo\nthree\n", "two", "").content).toBe("one\nthree\n");
    expect(applyEdit("one\r\ntwo\r\nthree\r\n", "two", "").content).toBe("one\r\nthree\r\n");
    // Deleting part of a line still leaves the line in place.
    expect(applyEdit("alpha beta\n", "beta", "").content).toBe("alpha \n");
  });

  it("refuses an edit that would re-apply an earlier edit's insertion", () => {
    expect(() =>
      applyEdits("const a = 1;\n", [
        { old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" },
        { old_string: "const b = 3;", new_string: "const b = 4;" },
      ]),
    ).toThrow(/edit 1 just inserted/);
  });

  it("still allows independent edits in one batch", () => {
    const result = applyEdits("a\nb\n", [
      { old_string: "a", new_string: "x" },
      { old_string: "b", new_string: "y" },
    ]);
    expect(result.content).toBe("x\ny\n");
  });
});
