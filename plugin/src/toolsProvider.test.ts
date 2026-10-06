import { readFileSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, fakeController, fakeToolContext } from "./shared/testing/fake-controller";
import { modeFile } from "./shared/mode";
import { toolsProvider, withRedaction } from "./toolsProvider";

/** Every key the merged schema declares, so the fake controller can answer any group's lookup. */
const baseConfig = {
  projectFolder: "",
  maxOutputChars: 20000,
  redactSecrets: true,
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
  enableSqlite: false,
  enableSubagent: false,
  subagentModel: "",
  enableMemory: false,
  instructionFiles: ["AGENTS.md"],
  injectMemoryIndex: false,
  injectGitSnapshot: false,
  enableSkills: false,
  enablePlanMode: false,
  scanLoadedFiles: true,
  allowSkillSave: false,
  enableChatSearch: false,
  maxInjectedChars: 12000,
  enableGit: false,
  allowPush: false,
  enableGitHub: false,
  enableWeb: false,
  searchBackend: "auto",
  searxngUrl: "",
  safeSearch: "moderate",
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
  enableUtilities: false,
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
    expect(names).not.toContain("calculate");
    expect(names).not.toContain("current_time");
  });

  it("adds the Utilities tools only when that group is switched on", async () => {
    const before = (await build({ projectFolder: project })).map(t => t.name);
    const tools = await build({ projectFolder: project, enableUtilities: true });
    const after = tools.map(t => t.name);
    expect(after.filter(name => !before.includes(name))).toEqual(["calculate", "current_time"]);
    expect(await callTool(tools, "calculate", { expression: "200 + 15%" })).toBe("200 + 15% = 230");
    expect(await callTool(tools, "current_time", { timezone: "UTC" })).toContain("Time zone: UTC (UTC+00:00)");

    // The group needs no project folder and no other group.
    const alone = await build({ enableFiles: false, enableUtilities: true });
    expect(alone.map(t => t.name)).toEqual(["calculate", "current_time"]);
  });

  it("has Utilities off by default in the settings", () => {
    const source = readFileSync(join(__dirname, "config.ts"), "utf-8");
    expect(source).toMatch(/"enableUtilities",\s*"boolean",\s*\{[^}]*displayName: "Utilities",[^}]*\},\s*false,/);
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

  // That fallback is LM Studio's empty per-chat folder. A model not told so decides the project is
  // empty, so it is said in list_dir's description, when listing the root, and in git's error.
  it("tells the model when no Project Folder is set", async () => {
    const tools = await build({ projectFolder: "", enableGit: true, allowShell: true });
    const listDir = tools.find(t => t.name === "list_dir");
    expect(listDir.description).toContain("No Project Folder is set");
    // A model that explores with `dir` or `ls` would otherwise meet the same empty folder unwarned.
    expect(tools.find(t => t.name === "run_command").description).toContain("No Project Folder is set");
    expect(await callTool(tools, "list_dir", {})).toContain("No Project Folder is set");
    expect(String(await callTool(tools, "git_status", {}))).toMatch(/not a git repository\. No Project Folder is set/);
  });

  it("says nothing about it when a Project Folder is set", async () => {
    const tools = await build({ projectFolder: project, enableGit: true, allowShell: true });
    const listDir = tools.find(t => t.name === "list_dir");
    expect(listDir.description).not.toContain("No Project Folder");
    expect(tools.find(t => t.name === "run_command").description).not.toContain("No Project Folder");
    expect(await callTool(tools, "list_dir", {})).not.toContain("No Project Folder");
    expect(String(await callTool(tools, "git_status", {}))).toMatch(/Run git_init to create one, or point Project Folder/);
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

// Tool output goes into the model's context and the saved chat, so secrets in it are replaced by
// markers on the way out. The values below are made up, and assembled so this file holds no token.
describe("secret redaction", () => {
  const TOKEN = "ghp" + "_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
  const ENV_FILE = `# local settings\nGITHUB_TOKEN=${TOKEN}\nDB_PASSWORD=correcthorsebattery\nPORT=8080\n`;

  const call = async (tools: any[], name: string, params: Record<string, unknown>) => {
    const { ctx, warnings, statuses } = fakeToolContext();
    const found = tools.find(t => t.name === name);
    found.checkParameters(params);
    return { result: await found.implementation(params, ctx), warnings, statuses };
  };

  it("hides a token in a file that is read, warns the user, and tells the model", async () => {
    await writeFile(join(project, ".env"), ENV_FILE);
    const tools = await build({ projectFolder: project });
    const { result, warnings } = await call(tools, "read_file", { path: ".env" });

    expect(result).toContain("2\tGITHUB_TOKEN=[redacted: GitHub token]");
    expect(result).toContain("3\tDB_PASSWORD=[redacted: password]");
    expect(result).toContain("4\tPORT=8080");
    expect(result).not.toContain(TOKEN);
    expect(result).not.toContain("correcthorsebattery");
    const lastLine = String(result).split("\n").pop();
    expect(lastLine).toMatch(/^\[2 secret values are hidden as "\[redacted: …\]"\. Do not try to recover what was hidden, and do not write the markers into files\.\]$/);

    expect(warnings).toEqual(["agent-toolkit hid 2 secrets (GitHub token, password) from the model"]);
    expect(warnings.join()).not.toContain(TOKEN.slice(0, 8));
  });

  it("never changes the file on disk", async () => {
    await writeFile(join(project, ".env"), ENV_FILE);
    const tools = await build({ projectFolder: project, allowShell: true });
    await call(tools, "read_file", { path: ".env" });
    await call(tools, "grep", { pattern: "TOKEN" });
    expect(await readFile(join(project, ".env"), "utf-8")).toBe(ENV_FILE);
  });

  it("covers every tool, not only read_file", async () => {
    await writeFile(join(project, ".env"), ENV_FILE);
    const tools = await build({ projectFolder: project });
    const { result, warnings } = await call(tools, "grep", { pattern: "GITHUB", glob: ".env" });
    expect(result).toContain("GITHUB_TOKEN=[redacted: GitHub token]");
    expect(result).not.toContain(TOKEN);
    expect(warnings).toHaveLength(1);
  });

  it("leaves output without secrets exactly as it was, with no warning", async () => {
    await writeFile(join(project, "notes.txt"), "The token bucket refills every second.\n");
    const on = await call(await build({ projectFolder: project }), "read_file", { path: "notes.txt" });
    const off = await call(await build({ projectFolder: project, redactSecrets: false }), "read_file", { path: "notes.txt" });
    expect(on.result).toBe(off.result);
    expect(on.warnings).toEqual([]);
  });

  it("does nothing when the setting is off", async () => {
    await writeFile(join(project, ".env"), ENV_FILE);
    const tools = await build({ projectFolder: project, redactSecrets: false });
    const { result, warnings } = await call(tools, "read_file", { path: ".env" });
    expect(result).toContain(`GITHUB_TOKEN=${TOKEN}`);
    expect(result).not.toContain("redacted");
    expect(warnings).toEqual([]);
  });

  it("does not redact what the model sends: a write keeps its content", async () => {
    const tools = await build({ projectFolder: project });
    const content = `API_TOKEN=${TOKEN}\n`;
    const { result, warnings } = await call(tools, "write_file", { path: "written.env", content });
    expect(result).toMatch(/^Created written\.env/);
    expect(warnings).toEqual([]);
    expect(await readFile(join(project, "written.env"), "utf-8")).toBe(content);
  });

  // The model only ever saw the marker, so an edit that quotes it cannot match the file.
  it("explains why an edit that quotes a marker did not match, and changes nothing", async () => {
    await writeFile(join(project, ".env"), ENV_FILE);
    const tools = await build({ projectFolder: project });
    await call(tools, "read_file", { path: ".env" });
    const { result } = await call(tools, "edit_file", {
      path: ".env",
      old_string: "GITHUB_TOKEN=[redacted: GitHub token]",
      new_string: "GITHUB_TOKEN=other",
    });
    expect(result).toMatch(/^Error: old_string was not found/);
    expect(result).toContain("It stands for a hidden secret and is not text in the file");
    expect(await readFile(join(project, ".env"), "utf-8")).toBe(ENV_FILE);

    // Editing around the secret works as usual.
    const around = await call(tools, "edit_file", { path: ".env", old_string: "PORT=8080", new_string: "PORT=9090" });
    expect(around.result).toMatch(/^Edited \.env/);
    expect(await readFile(join(project, ".env"), "utf-8")).toBe(ENV_FILE.replace("8080", "9090"));
  });

  describe("around any tool", () => {
    const fakeTool = (name: string, implementation: (params: any, ctx: any) => unknown) =>
      ({ name, description: "", type: "function", checkParameters: () => {}, implementation }) as any;

    it("keeps results that are not strings, redacting only the strings inside them", async () => {
      const image = Buffer.from("not text");
      const tools = withRedaction([
        fakeTool("object", () => ({ ok: true, count: 2, lines: [`key ${TOKEN}`, "plain"], image })),
        fakeTool("number", () => 42),
        fakeTool("nothing", () => undefined),
        fakeTool("list", async () => ["a", 1, null]),
      ]);
      const object = await call(tools, "object", {});
      expect(object.result).toEqual({ ok: true, count: 2, lines: ["key [redacted: GitHub token]", "plain"], image });
      expect(object.result.image).toBe(image);
      expect(object.warnings).toEqual(["agent-toolkit hid 1 secret (GitHub token) from the model"]);
      expect((await call(tools, "number", {})).result).toBe(42);
      expect((await call(tools, "nothing", {})).result).toBeUndefined();
      expect((await call(tools, "list", {})).result).toEqual(["a", 1, null]);
    });

    it("hands the tool its parameters and context untouched", async () => {
      let seen: { params: unknown; ctx: unknown } | undefined;
      const tools = withRedaction([
        fakeTool("probe", (params, ctx) => {
          seen = { params, ctx };
          ctx.status("working");
          return ctx.signal.aborted ? "aborted" : `value ${TOKEN}`;
        }),
      ]);
      const { ctx, statuses, warnings } = fakeToolContext();
      const params = { text: `sent ${TOKEN}` };
      const result = await tools[0].implementation(params, ctx as any);
      expect(seen?.ctx).toBe(ctx);
      expect(seen?.params).toBe(params);
      expect(statuses).toEqual(["working"]);
      expect(warnings).toHaveLength(1);
      expect(result).toContain("value [redacted: GitHub token]");
    });

    it("lets a tool's real failure through", async () => {
      const tools = withRedaction([
        fakeTool("broken", () => {
          throw new Error("disk on fire");
        }),
      ]);
      await expect(call(tools, "broken", {})).rejects.toThrow("disk on fire");
    });
  });
});
