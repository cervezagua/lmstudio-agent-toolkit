import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, fakeController } from "./shared/testing/fake-controller";
import { modeFile } from "./shared/mode";
import { toolsProvider } from "./toolsProvider";

/** Every key the merged schema declares, so the fake controller can answer any group's lookup. */
const baseConfig = {
  projectFolder: "",
  maxOutputChars: 20000,
  enableFiles: true,
  allowShell: false,
  shell: "auto",
  commandTimeoutSeconds: 30,
  blockedCommandPatterns: [],
  persistentShell: false,
  maxReadBytes: 262144,
  enableBackgroundTasks: false,
  enableDiagnostics: false,
  enableNotebookTools: false,
  enableSubagent: false,
  subagentModel: "",
  enableMemory: false,
  instructionFiles: ["AGENTS.md"],
  injectMemoryIndex: false,
  injectGitSnapshot: false,
  enableSkills: false,
  enablePlanMode: false,
  maxInjectedChars: 12000,
  enableGit: false,
  allowPush: false,
  enableGitHub: false,
  enableWeb: false,
  searchBackend: "auto",
  searxngUrl: "",
  maxSearchResults: 5,
  maxPageChars: 8000,
  browserFallback: false,
  enableBrowser: false,
  browserChannel: "msedge",
  headless: true,
  enableDocuments: false,
  visionModel: "",
  renderScale: 2,
  maxPages: 10,
};
const globalConfig = { memoryDirectory: "", skillsDirectory: "", braveApiKey: "" };

let project: string;
let work: string;

const build = (config: Record<string, unknown>) =>
  toolsProvider(fakeController({ config: { ...baseConfig, ...config }, workingDirectory: work, globalConfig }));

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "toolkit-project-"));
  work = await mkdtemp(join(tmpdir(), "toolkit-work-"));
});

afterAll(async () => {
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  await rm(project, options).catch(() => {});
  await rm(work, options).catch(() => {});
});

describe("group toggles", () => {
  it("offers only the groups that are switched on", async () => {
    const names = (await build({ projectFolder: project })).map(t => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("git_status");
    expect(names).not.toContain("memory_save");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("read_document_text");
  });

  it("adds a group's tools when it is switched on, and nothing else", async () => {
    const before = (await build({ projectFolder: project })).map(t => t.name);
    const after = (await build({ projectFolder: project, enableGit: true })).map(t => t.name);
    const added = after.filter(name => !before.includes(name));
    expect(added).toContain("git_status");
    expect(added.every(name => name.startsWith("git_") || name.startsWith("gh_"))).toBe(true);
    expect(before.every(name => after.includes(name))).toBe(true);
  });

  it("offers no tools at all when every group is off", async () => {
    expect(await build({ projectFolder: project, enableFiles: false })).toHaveLength(0);
  });
});

describe("project folder", () => {
  it("is where the file tools work", async () => {
    await writeFile(join(project, "in-project.txt"), "hello");
    const tools = await build({ projectFolder: project });
    expect(await callTool(tools, "list_dir", {})).toContain("in-project.txt");
  });

  it("falls back to the chat's working directory when empty", async () => {
    await writeFile(join(work, "in-working-dir.txt"), "hello");
    const tools = await build({ projectFolder: "" });
    expect(await callTool(tools, "list_dir", {})).toContain("in-working-dir.txt");
  });
});

describe("outside a chat", () => {
  // LM Studio asks for the tool list to show it in the plugin's settings, with no chat attached, and
  // the SDK's getWorkingDirectory() throws there. That used to fail the whole list with "This
  // prediction process is not attached to a working directory".
  const buildWithoutChat = (config: Record<string, unknown>) =>
    toolsProvider(fakeController({ config: { ...baseConfig, ...config }, workingDirectory: null, globalConfig }));

  it("still lists every enabled group's tools", async () => {
    const names = (await buildWithoutChat({ enableMemory: true, enableGit: true })).map(t => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("memory_save");
    expect(names).toContain("git_status");
  });

  it("still lists them when a project folder is set", async () => {
    const names = (await buildWithoutChat({ projectFolder: project, enableDocuments: true })).map(t => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("read_document_text");
  });

  it("names the setting when the project folder does not exist", async () => {
    await expect(buildWithoutChat({ projectFolder: join(project, "missing") })).rejects.toThrow(/Project Folder/);
  });
});

describe("chat state files", () => {
  // With no project folder the root is the chat's working directory, which is where plan mode keeps
  // its file, so the file tools would otherwise be able to rewrite the chat's own mode. (While
  // planning they are not offered at all, so this is written with planning off.)
  it("cannot be written or edited by the file tools", async () => {
    await writeFile(modeFile(work), JSON.stringify({ planning: false }), "utf-8");
    const tools = await build({ projectFolder: "" });

    for (const [name, params] of [
      ["write_file", { path: ".agent-mode.json", content: '{"planning":true}' }],
      ["edit_file", { path: ".agent-mode.json", old_string: "false", new_string: "true" }],
    ] as const) {
      const result = await callTool(tools, name, params as Record<string, unknown>);
      expect(String(result)).toMatch(/managed by the toolkit/);
    }
    expect(JSON.parse(await readFile(modeFile(work), "utf-8")).planning).toBe(false);
  });
});
