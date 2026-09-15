import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeController } from "../../../shared/testing/fake-controller";
import { writeMode } from "./shared/mode";
import { toolsProvider } from "./toolsProvider";

/**
 * Plan mode is switched on by memory-tools but enforced here: LM Studio gives every plugin in a
 * chat the same working directory, which is where the mode file lives.
 */
let root: string;
let work: string;

const baseConfig = {
  rootDirectory: "",
  allowShell: true,
  shell: "auto",
  commandTimeoutSeconds: 30,
  maxOutputChars: 20000,
  blockedCommandPatterns: [],
  persistentShell: false,
  enableBackgroundTasks: true,
  enableNotebookTools: true,
  enableDiagnostics: true,
  enableSubagent: false,
  subagentModel: "",
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coder-plan-root-"));
  work = await mkdtemp(join(tmpdir(), "coder-plan-work-"));
});

afterEach(async () => {
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  await rm(root, options).catch(() => {});
  await rm(work, options).catch(() => {});
});

const names = async () =>
  (await toolsProvider(fakeController({ config: { ...baseConfig, rootDirectory: root }, workingDirectory: work }))).map(
    t => t.name,
  );

describe("plan mode in coder-tools", () => {
  it("offers every tool when not planning", async () => {
    const tools = await names();
    expect(tools).toEqual(expect.arrayContaining(["write_file", "edit_file", "multi_edit", "task_run", "notebook_edit"]));
  });

  it("withholds the tools that change things while planning", async () => {
    await writeMode(work, { planning: true, since: new Date().toISOString() });
    const tools = await names();
    for (const tool of ["write_file", "edit_file", "multi_edit", "insert_lines", "undo_edit", "notebook_edit", "task_run", "task_stop"]) {
      expect(tools).not.toContain(tool);
    }
    // Research tools stay available.
    expect(tools).toEqual(expect.arrayContaining(["read_file", "grep", "glob", "list_dir", "notebook_read", "run_command", "task_list"]));
  });

  it("tells the model the rules in run_command's description while planning", async () => {
    await writeMode(work, { planning: true });
    const tools = await toolsProvider(
      fakeController({ config: { ...baseConfig, rootDirectory: root }, workingDirectory: work }),
    );
    const runCommand = tools.find(t => t.name === "run_command")!;
    expect(runCommand.description).toContain("PLANNING MODE");
  });

  it("brings the tools back when planning ends", async () => {
    await writeMode(work, { planning: true });
    expect(await names()).not.toContain("edit_file");
    await writeMode(work, { planning: false, plan: "do the thing" });
    expect(await names()).toContain("edit_file");
  });
});
