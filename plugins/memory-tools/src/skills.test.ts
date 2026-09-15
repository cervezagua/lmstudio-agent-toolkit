import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../../shared/testing/fake-controller";
import { defaultSkillsDirectory, listSkills, parseSkillHeader, readSkill, renderSkillList } from "./lib/skills";
import { readMode, writeMode } from "./shared/mode";
import { toolsProvider } from "./toolsProvider";

let base: string;
let skillsDir: string;
let chatDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "memory-skills-"));
  skillsDir = join(base, "skills");
  chatDir = join(base, "chat");
  await mkdir(join(skillsDir, "release-checklist"), { recursive: true });
  await mkdir(chatDir);
  await writeFile(
    join(skillsDir, "release-checklist", "SKILL.md"),
    "---\nname: release-checklist\ndescription: Steps to cut a release\n---\n\n1. Run the tests\n2. Tag the commit\n",
  );
  await writeFile(join(skillsDir, "release-checklist", "template.md"), "# Release notes\n");
  await writeFile(join(skillsDir, "commit-style.md"), "# Commit style\n\nUse imperative mood, no trailing period.\n");
  await writeFile(join(skillsDir, "README.md"), "not a skill");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const config = () => ({
  projectDirectory: "",
  instructionFiles: [],
  injectMemoryIndex: false,
  enableSkills: true,
  enablePlanMode: true,
  maxInjectedChars: 12000,
});

describe("skills", () => {
  it("falls back to the default directory and expands ~", () => {
    expect(defaultSkillsDirectory("")).toMatch(/[\\/]\.lmstudio-agent-skills$/);
    expect(defaultSkillsDirectory("~/mine")).toMatch(/[\\/]mine$/);
  });

  it("reads name and description from frontmatter, or the first body line", () => {
    expect(parseSkillHeader("---\nname: a\ndescription: does things\n---\nbody", "fallback")).toEqual({
      name: "a",
      description: "does things",
    });
    expect(parseSkillHeader("# Title\n\nFirst real line\n", "fallback")).toEqual({
      name: "fallback",
      description: "First real line",
    });
  });

  it("lists folder skills and single-file skills, ignoring README", async () => {
    const skills = await listSkills(skillsDir);
    expect(skills.map(s => s.name)).toEqual(["commit-style", "release-checklist"]);
    expect(skills[1]).toMatchObject({ description: "Steps to cut a release", extraFiles: ["template.md"] });
    expect(renderSkillList(skills)).toContain("- release-checklist: Steps to cut a release");
    expect(await listSkills(join(base, "missing"))).toEqual([]);
    expect(renderSkillList([])).toBe("No skills are installed.");
  });

  it("reads a skill by name and reports unknown ones", async () => {
    const { skill, content } = await readSkill(skillsDir, "Release-Checklist");
    expect(skill.name).toBe("release-checklist");
    expect(content).toContain("Tag the commit");
    await expect(readSkill(skillsDir, "nope")).rejects.toThrow(/No skill named "nope". Available skills: commit-style, release-checklist/);
  });
});

describe("skill and plan-mode tools", () => {
  const provider = (overrides: Record<string, unknown> = {}) =>
    toolsProvider(
      fakeController({
        config: { ...config(), ...overrides },
        globalConfig: { memoryDirectory: join(base, "memory"), skillsDirectory: skillsDir },
        workingDirectory: chatDir,
      }),
    );

  it("exposes skills and plan mode, and can be switched off", async () => {
    const tools = await provider();
    expect(tools.map(t => t.name)).toEqual(
      expect.arrayContaining(["skill_list", "skill_read", "enter_plan_mode", "exit_plan_mode"]),
    );
    expect(await callTool(tools, "skill_list", {})).toContain("release-checklist: Steps to cut a release");
    const loaded = await callTool(tools, "skill_read", { name: "release-checklist" });
    expect(loaded).toContain("Tag the commit");
    expect(loaded).toContain("template.md");
    expect(await callTool(tools, "skill_read", { name: "ghost" })).toMatch(/^Error: No skill named/);

    const off = await provider({ enableSkills: false, enablePlanMode: false });
    expect(off.map(t => t.name).some(n => n.startsWith("skill_") || n.endsWith("plan_mode"))).toBe(false);
  });

  it("records planning mode in the chat working directory", async () => {
    const tools = await provider();
    expect((await readMode(chatDir)).planning).toBe(false);

    expect(await callTool(tools, "enter_plan_mode", {})).toContain("Planning mode is on");
    expect(await readMode(chatDir)).toMatchObject({ planning: true });

    expect(await callTool(tools, "exit_plan_mode", { plan: "1. Fix the bug\n2. Add a test" })).toContain("1. Fix the bug");
    const mode = await readMode(chatDir);
    expect(mode.planning).toBe(false);
    expect(mode.plan).toContain("Add a test");
  });

  it("treats an unreadable mode file as 'not planning'", async () => {
    await writeFile(join(chatDir, ".agent-mode.json"), "{ broken json");
    expect(await readMode(chatDir)).toEqual({ planning: false });
    await writeMode(chatDir, { planning: true });
    expect((await readMode(chatDir)).planning).toBe(true);
  });
});
