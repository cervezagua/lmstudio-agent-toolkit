import { Chat, ChatMessage } from "@lmstudio/sdk";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptPreprocessor } from "../index";
import { toolsProvider } from "../groups/files/toolsProvider";
import { listCheckpoints, MAX_CHECKPOINT_BYTES, recordChange, rewindCommand, rewindTo, startTurn } from "./checkpoints";
import { callTool, fakeController } from "./testing/fake-controller";

let base: string;
let project: string;
let chat: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "checkpoints-"));
  project = join(base, "project");
  chat = join(base, "chat");
  await mkdir(project);
  await mkdir(chat);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("checkpoints", () => {
  it("keep each file's content from before its first change in a turn", async () => {
    const file = join(project, "a.txt");
    await startTurn(chat, "first message");
    await recordChange(chat, file, "v1");
    await recordChange(chat, file, "v2");
    const [checkpoint] = await listCheckpoints(chat);
    expect(checkpoint).toMatchObject({ turn: 1, message: "first message", files: [{ path: file, previous: "v1" }] });
  });

  it("rewind puts every file back to before the chosen turn, deleting ones made since", async () => {
    const edited = join(project, "edited.txt");
    const created = join(project, "created.txt");
    await startTurn(chat, "one");
    await recordChange(chat, edited, "original");
    await writeFile(edited, "after turn 1");
    await startTurn(chat, "two");
    await recordChange(chat, edited, "after turn 1");
    await writeFile(edited, "after turn 2");
    await recordChange(chat, created, null);
    await writeFile(created, "new");
    await startTurn(chat, "three");
    await recordChange(chat, edited, "after turn 2");
    await writeFile(edited, "after turn 3");

    const result = await rewindTo(chat, 2, project);
    expect(result).toEqual({ restored: [edited], deleted: [created], notRestored: [] });
    expect(await readFile(edited, "utf-8")).toBe("after turn 1");
    expect(existsSync(created)).toBe(false);
    expect((await listCheckpoints(chat)).map(c => c.turn)).toEqual([1]);
  });

  it("does not touch a file outside the project, or keep one too big, and says so", async () => {
    const outside = join(base, "outside.txt");
    const big = join(project, "big.bin");
    await writeFile(outside, "changed");
    await startTurn(chat, "one");
    await recordChange(chat, outside, "before");
    await recordChange(chat, big, "x".repeat(MAX_CHECKPOINT_BYTES + 1));
    const result = await rewindTo(chat, 1, project);
    expect(result.notRestored.sort()).toEqual([big, outside].sort());
    expect(await readFile(outside, "utf-8")).toBe("changed");
  });

  it("lists a file it could not keep (a binary document) as not restored, and leaves it alone", async () => {
    const report = join(project, "report.pdf");
    await writeFile(report, "new pdf");
    await startTurn(chat, "one");
    await recordChange(chat, report, null, false);
    expect(await rewindTo(chat, 1, project)).toEqual({ restored: [], deleted: [], notRestored: [report] });
    expect(await readFile(report, "utf-8")).toBe("new pdf");
  });

  // Restoring the smaller, later copy would leave the file in a state it never had before the rewind point.
  it("leaves a file alone when its earliest copy was too big to keep", async () => {
    const log = join(project, "log.txt");
    await writeFile(log, "now");
    await startTurn(chat, "one");
    await recordChange(chat, log, "x".repeat(MAX_CHECKPOINT_BYTES + 1));
    await startTurn(chat, "two");
    await recordChange(chat, log, "small in between");
    const result = await rewindTo(chat, 1, project);
    expect(result).toEqual({ restored: [], deleted: [], notRestored: [log] });
    expect(await readFile(log, "utf-8")).toBe("now");
  });

  it("/rewind lists the messages that changed files, and refuses a bad number", async () => {
    expect(await rewindCommand(chat, "", project)).toMatch(/no file changes have been recorded/);
    await startTurn(chat, "fix the parser please");
    await recordChange(chat, join(project, "src", "parse.js"), "old");
    const list = await rewindCommand(chat, "", project);
    expect(list).toMatch(/^The user typed \/rewind\. Reply with this list/);
    expect(list).toMatch(/- 1 \(\d\d:\d\d\) "fix the parser please": 1 file\(s\): src\/parse\.js/);
    expect(await rewindCommand(chat, "abc", project)).toMatch(/takes the number of a message/);
    expect(await rewindCommand(chat, "7", project)).toMatch(/nothing to rewind/);
  });
});

describe("checkpoints through the file tools and /rewind", () => {
  const config = {
    projectFolder: project,
    enableFiles: true,
    enableCheckpoints: true,
    enableCommands: true,
    scanLoadedFiles: true,
    enableMemory: false,
    readAttachments: false,
  };

  it("an edit made in a message is undone by /rewind with that message's number", async () => {
    const cfg = { ...config, projectFolder: project };
    const preprocess = (text: string) =>
      promptPreprocessor(
        fakeController({ config: cfg, workingDirectory: chat, history: Chat.empty() }),
        ChatMessage.from({ role: "user", content: text }),
      ) as Promise<ChatMessage>;
    const tools = await toolsProvider(
      fakeController({
        config: {
          ...cfg,
          maxOutputChars: 20000,
          allowShell: false,
          shell: "auto",
          commandTimeoutSeconds: 60,
          blockedCommandPatterns: [],
          persistentShell: false,
          maxReadBytes: 262144,
          enableBackgroundTasks: false,
          enableDiagnostics: false,
          autoCheckEdits: false,
          enableNotebookTools: false,
          enableSqlite: false,
          enableSubagent: false,
          subagentModel: "",
          enableGit: false,
          enableWeb: false,
          enableDocuments: false,
          enableUtilities: false,
          enablePlanMode: false,
        },
        workingDirectory: chat,
      }),
    );

    await writeFile(join(project, "notes.txt"), "good\n");
    await preprocess("make it better");
    await callTool(tools, "read_file", { path: "notes.txt" });
    await callTool(tools, "edit_file", { path: "notes.txt", old_string: "good", new_string: "worse" });
    await callTool(tools, "write_file", { path: "extra.txt", content: "made in message 1" });

    const reply = (await preprocess("/rewind 1")).getText();
    expect(reply).toMatch(/^The user typed \/rewind 1\. agent-toolkit has already put the files back to how they were before message 1 \("make it better"\)\./);
    expect(reply).toMatch(/restored: notes\.txt; deleted, since they did not exist then: extra\.txt/);
    expect(await readFile(join(project, "notes.txt"), "utf-8")).toBe("good\n");
    expect(existsSync(join(project, "extra.txt"))).toBe(false);
  });
});
