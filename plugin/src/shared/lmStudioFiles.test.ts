import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLmStudioFile } from "./lmStudioFiles";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lms-home-"));
  await mkdir(join(home, ".lmstudio", "working-directories", "123"), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// A model that could write LM Studio's settings.json could switch tool approval off for itself.
describe("isLmStudioFile", () => {
  it("covers LM Studio's settings, plugins and the pointer to its folder", async () => {
    expect(await isLmStudioFile(join(home, ".lmstudio", "settings.json"), home)).toBe(true);
    expect(await isLmStudioFile(join(home, ".lmstudio", "extensions", "plugins", "x", "index.js"), home)).toBe(true);
    expect(await isLmStudioFile(join(home, ".lmstudio", ".internal", "permissions-store.json"), home)).toBe(true);
    expect(await isLmStudioFile(join(home, ".lmstudio-home-pointer"), home)).toBe(true);
  });

  it("leaves the folders chats work in, and everything else, alone", async () => {
    expect(await isLmStudioFile(join(home, ".lmstudio", "working-directories", "123", "notes.md"), home)).toBe(false);
    expect(await isLmStudioFile(join(home, "projects", "app", "settings.json"), home)).toBe(false);
  });

  it("follows the pointer when LM Studio keeps its data elsewhere", async () => {
    const elsewhere = join(home, "data", "lms");
    await mkdir(join(elsewhere, "working-directories"), { recursive: true });
    await writeFile(join(home, ".lmstudio-home-pointer"), elsewhere);
    expect(await isLmStudioFile(join(elsewhere, "settings.json"), home)).toBe(true);
    expect(await isLmStudioFile(join(elsewhere, "working-directories", "9", "a.txt"), home)).toBe(false);
  });
});
