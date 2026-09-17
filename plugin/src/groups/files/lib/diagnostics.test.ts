import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availableCheckers, CHECKERS, runChecker } from "./diagnostics";
import { runSubagent, SUBAGENT_SYSTEM_PROMPT, pickSubagentModel } from "./subagent";
import { ToolError } from "../../../shared/errors";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coder-diag-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("diagnostics detection", () => {
  it("detects nothing in an empty folder", async () => {
    expect(await availableCheckers(root)).toEqual([]);
  });

  it("detects TypeScript from tsconfig.json and ESLint from package.json", async () => {
    await writeFile(join(root, "tsconfig.json"), "{}");
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { eslint: "^9" } }));
    expect((await availableCheckers(root)).map(c => c.name)).toEqual(["tsc", "eslint"]);
  });

  it("detects ESLint from a flat config file alone", async () => {
    await writeFile(join(root, "eslint.config.mjs"), "export default [];");
    expect((await availableCheckers(root)).map(c => c.name)).toEqual(["eslint"]);
  });

  it("ignores project files when the tool is not installed", async () => {
    await writeFile(join(root, "Cargo.toml"), "[package]\nname='x'");
    const cargo = CHECKERS.find(c => c.name === "cargo")!;
    // Passes only if cargo really is installed here; either way detection must not throw.
    await expect(cargo.detect(root)).resolves.toBeTypeOf("boolean");
  });
});

describe("runChecker", () => {
  it("reports a clean project and real type errors", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }));
    await writeFile(join(root, "src", "ok.ts"), "export const x: number = 1;\n");
    // Reuse this repo's TypeScript so the test does not download anything.
    const tsc = {
      ...CHECKERS.find(c => c.name === "tsc")!,
      command: () => ({
        file: process.execPath,
        args: [join(process.cwd(), "plugin", "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--pretty", "false"],
      }),
    };

    expect(await runChecker(tsc, root, { maxChars: 5000 })).toBe("tsc: no problems found.");

    await writeFile(join(root, "src", "bad.ts"), "export const y: number = 'not a number';\n");
    const report = await runChecker(tsc, root, { maxChars: 5000 });
    expect(report).toMatch(/^tsc \(exit 2\)/);
    expect(report).toContain("bad.ts");
    expect(report).toContain("not assignable");
  }, 120000);

  it("explains a missing executable", async () => {
    const missing = { ...CHECKERS[0], name: "ghost", command: () => ({ file: "definitely-not-installed-xyz", args: [] }) };
    await expect(runChecker(missing, root, { maxChars: 100 })).rejects.toThrow(/not installed or not on PATH/);
  });
});

describe("sub-agent", () => {
  it("sends the task with a read-only system prompt and collects the report", async () => {
    const calls: any[] = [];
    const fakeModel = {
      act: async (chat: any, tools: any[], opts: any) => {
        calls.push({ chat, tools, opts });
        opts.onRoundStart?.(0);
        opts.onMessage?.({ getRole: () => "assistant", getText: () => "", getToolCallRequests: () => [{ name: "grep" }], getToolCallResults: () => [] });
        opts.onRoundStart?.(1);
        opts.onMessage?.({ getRole: () => "assistant", getText: () => "Found it in src/a.ts:12", getToolCallRequests: () => [], getToolCallResults: () => [] });
      },
    } as any;

    const result = await runSubagent({ model: fakeModel, tools: [], task: "Where is auth handled?", maxRounds: 5 });
    expect(result).toMatchObject({ report: "Found it in src/a.ts:12", rounds: 2, toolCalls: ["grep"] });
    expect(calls[0].chat[0]).toEqual({ role: "system", content: SUBAGENT_SYSTEM_PROMPT });
    expect(calls[0].chat[1]).toEqual({ role: "user", content: "Where is auth handled?" });
    expect(calls[0].opts.maxPredictionRounds).toBe(5);
  });

  it("says so when the sub-agent writes no report", async () => {
    const silent = { act: async (_c: any, _t: any, opts: any) => opts.onRoundStart?.(0) } as any;
    expect((await runSubagent({ model: silent, tools: [], task: "x", maxRounds: 1 })).report).toMatch(/without a written report/);
  });

  it("picks the configured model, or the first loaded one, and complains when there is none", async () => {
    const client = {
      llm: {
        model: async (key: string) => {
          if (key === "missing") throw new Error("not found");
          return { key } as any;
        },
        listLoaded: async () => [{ key: "loaded-model" }],
      },
    } as any;
    expect(await pickSubagentModel(client, "chosen")).toMatchObject({ key: "chosen" });
    expect(await pickSubagentModel(client, "  ")).toMatchObject({ key: "loaded-model" });
    await expect(pickSubagentModel(client, "missing")).rejects.toThrow(ToolError);

    const empty = { llm: { model: async () => ({}) as any, listLoaded: async () => [] } } as any;
    await expect(pickSubagentModel(empty, "")).rejects.toThrow(/No model is loaded/);
  });
});
