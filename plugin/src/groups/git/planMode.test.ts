import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeController } from "../../shared/testing/fake-controller";
import { writeMode } from "../../shared/mode";
import { toolsProvider } from "./toolsProvider";

let repo: string;
let work: string;

const config = { projectFolder: "", allowPush: true, enableGitHub: false, maxOutputChars: 20000 };

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "git-plan-repo-"));
  work = await mkdtemp(join(tmpdir(), "git-plan-work-"));
});

afterEach(async () => {
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  await rm(repo, options).catch(() => {});
  await rm(work, options).catch(() => {});
});

const names = async () =>
  (await toolsProvider(fakeController({ config: { ...config, projectFolder: repo }, workingDirectory: work }))).map(t => t.name);

describe("plan mode in git-tools", () => {
  it("keeps only read-only git tools while planning", async () => {
    expect(await names()).toEqual(expect.arrayContaining(["git_commit", "git_add", "git_push", "git_init"]));

    await writeMode(work, { planning: true });
    const planning = await names();
    for (const tool of ["git_add", "git_commit", "git_branch", "git_init", "git_push"]) {
      expect(planning).not.toContain(tool);
    }
    expect(planning).toEqual(expect.arrayContaining(["git_status", "git_diff", "git_log", "git_show"]));
  });
});
