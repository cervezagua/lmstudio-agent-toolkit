// Measures how well a local model gets real tasks done through agent-toolkit.
//
// Usage: npm run eval -- --model <key> [--runs 3] [--only fix-bug,git] [--minutes 10] [--subagent-model <key>]
//        npm run eval -- --self-test     (no model: checks that every task fails when nothing is done)
//
// Each task is a folder in evals/tasks: a project/ to work in, and task.ts with the prompt, the
// settings it needs and a check of the outcome. A run copies the project to a temporary folder,
// sets it as the Project Folder, runs the prompt preprocessor and the model with the plugin's tools
// (from source, so a change can be measured before it is installed), then checks what was done.
// Results go to evals/results/, which git ignores.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { globalConfigSchematics, makeConfigSchematics } from "../plugin/src/config";
import { promptPreprocessor } from "../plugin/src/index";
import { fakeController } from "../plugin/src/shared/testing/fake-controller";
import { toolsProvider } from "../plugin/src/toolsProvider";
import { type Call, type EvalTask } from "./lib/task";

const repo = join(__dirname, "..");
const sdk = createRequire(join(repo, "plugin", "package.json"))("@lmstudio/sdk");

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const modelKey = option("model");
if (!modelKey && !args.includes("--self-test")) {
  console.error("usage: npm run eval -- --model <key> [--runs 3] [--only <task or area>,...] [--minutes 10]");
  process.exit(1);
}
const runs = Number(option("runs") ?? 3);
const only = option("only")?.split(",");
const minutes = Number(option("minutes") ?? 10);
/** The model for tools that run a second model (run_subagent, research); the plugin's Auto otherwise. */
const subagentModel = option("subagent-model") ?? "";

const defaults = (schematics: any) =>
  Object.fromEntries([...schematics.fields.entries()].map(([key, field]: [string, any]) => [key, field.defaultValue]));

/** Takes a reasoning model's thinking out of its answer, however LM Studio marked it. */
function withoutThinking(text: string): string {
  return text
    .replace(/^[\s\S]*__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_[0-9a-f]+__/, "")
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .trim();
}

interface RunResult {
  task: string;
  area: string;
  passed: boolean;
  problems: string[];
  seconds: number;
  rounds: number;
  /** The most tokens one prediction was given: how full the context got. */
  peakContext: number;
  calls: number;
  failedCalls: number;
  repeatedFailures: number;
  toolsUsed: string[];
  /** The calls that returned an error, to see what tripped the model up. */
  failures: { name: string; args: string; result: string }[];
  /** Every call of a failed run, in order, to see where it went wrong. */
  trace?: { name: string; args: string; result: string }[];
  answer?: string;
}

async function loadTasks(): Promise<{ name: string; dir: string; task: EvalTask }[]> {
  const root = join(repo, "evals", "tasks");
  const names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  const tasks = [];
  for (const name of names) {
    const loaded = await import(pathToFileURL(join(root, name, "task.ts")).href);
    const task: EvalTask = loaded.default?.default ?? loaded.default;
    if (!only || only.includes(name) || only.includes(task.area)) tasks.push({ name, dir: join(root, name), task });
  }
  return tasks;
}

async function runOnce(model: any, client: any, systemPrompt: string, name: string, taskDir: string, task: EvalTask): Promise<RunResult> {
  const scratch = await mkdtemp(join(tmpdir(), `agent-toolkit-eval-${name}-`));
  const project = join(scratch, "project");
  const chat = join(scratch, "chat");
  const memory = join(scratch, "memory");
  const skills = join(scratch, "skills");
  for (const dir of [chat, memory, skills]) await mkdir(dir, { recursive: true });
  if (existsSync(join(taskDir, "project"))) await cp(join(taskDir, "project"), project, { recursive: true });
  else await mkdir(project);
  await task.setup?.(project);

  const config = { ...defaults(makeConfigSchematics()), projectFolder: project, subagentModel, researchModel: subagentModel, ...task.config };
  const globalConfig = { ...defaults(globalConfigSchematics), memoryDirectory: memory, skillsDirectory: skills };
  const history = sdk.Chat.from([{ role: "system", content: systemPrompt }]);
  // Each prompt is a new chat, with a working directory of its own as in LM Studio.
  const controller = (chatDir: string) => fakeController({ config, globalConfig, workingDirectory: chatDir, history, client });
  const prompts = Array.isArray(task.prompt) ? task.prompt : [task.prompt];
  const limitMinutes = task.minutes ?? minutes;

  const calls: Call[] = [];
  const pending: { id?: string; name: string; args: string }[] = [];
  const answers: string[] = [];
  let answer = "";
  let rounds = 0;
  let peakContext = 0;
  const problems: string[] = [];
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limitMinutes * 60_000);
  try {
    for (const [index, prompt] of prompts.entries()) {
      const chatDir = index === 0 ? chat : join(scratch, `chat-${index + 1}`);
      await mkdir(chatDir, { recursive: true });
      // The conversation so far, kept as LM Studio keeps it: follow-ups see every earlier turn.
      const conversation = sdk.Chat.from([{ role: "system", content: systemPrompt }]);
      const turns = index === prompts.length - 1 ? [prompt, ...(task.followUps ?? [])] : [prompt];
      for (const turn of turns) {
        const ctl = fakeController({ config, globalConfig, workingDirectory: chatDir, history: conversation, client });
        const preprocessed = await promptPreprocessor(ctl, sdk.ChatMessage.from({ role: "user", content: turn }));
        conversation.append("user", typeof preprocessed === "string" ? preprocessed : preprocessed.getText());
        const tools = await toolsProvider(controller(chatDir));
        answer = "";
        await model.act(conversation, tools, {
          maxPredictionRounds: task.maxRounds ?? 40,
          signal: abort.signal,
          onRoundStart: () => rounds++,
          onPredictionCompleted: (result: any) => (peakContext = Math.max(peakContext, result.stats?.promptTokensCount ?? 0)),
          onMessage: (message: any) => {
            conversation.append(message);
            for (const request of message.getToolCallRequests()) {
              pending.push({ id: request.id, name: request.name, args: JSON.stringify(request.arguments ?? {}) });
            }
            for (const result of message.getToolCallResults()) {
              const found = pending.findIndex(p => result.toolCallId && p.id === result.toolCallId);
              const request = pending.splice(found >= 0 ? found : 0, 1)[0] ?? { name: "?", args: "" };
              const content = String(result.content);
              const call = { ...request, result: content, failed: /^"?Error\b/.test(content) };
              calls.push(call);
              task.afterCall?.(call, project);
            }
            if (message.getRole() === "assistant") {
              const text = withoutThinking(message.getText());
              if (text) answer = text;
            }
          },
        });
        answers.push(answer);
      }
    }
  } catch (error: any) {
    problems.push(abort.signal.aborted ? `stopped after ${limitMinutes} minutes` : `the run failed: ${error?.message || error?.title || String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  problems.push(...(await task.check({ dir: project, answer, answers, calls }).catch(error => [`the check failed: ${error.message}`])));
  await rm(scratch, { recursive: true, force: true }).catch(() => {});

  const failedBefore = new Set<string>();
  let repeatedFailures = 0;
  for (const call of calls) {
    const key = `${call.name} ${call.args}`;
    if (failedBefore.has(key)) repeatedFailures++;
    if (call.failed) failedBefore.add(key);
  }
  return {
    task: name,
    area: task.area,
    passed: problems.length === 0,
    problems,
    seconds,
    rounds,
    peakContext,
    calls: calls.length,
    failedCalls: calls.filter(c => c.failed).length,
    repeatedFailures,
    toolsUsed: [...new Set(calls.map(c => c.name))],
    failures: calls.filter(c => c.failed).map(c => ({ name: c.name, args: c.args.slice(0, 300), result: c.result.slice(0, 500) })),
    ...(problems.length ? { trace: calls.map(c => ({ name: c.name, args: c.args.slice(0, 300), result: c.result.slice(0, 300) })), answer } : {}),
  };
}

function report(results: RunResult[], previous: RunResult[] | null, title: string): string {
  const byTask = new Map<string, RunResult[]>();
  for (const result of results) byTask.set(result.task, [...(byTask.get(result.task) ?? []), result]);
  const mean = (values: number[]) => (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1).replace(/\.0$/, "");
  const lines = [
    `# ${title}`,
    "",
    "| Task | Area | Passed | Was | Seconds | Tool calls | Failed calls | Repeated failures | Peak context |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [task, runsOfTask] of byTask) {
    const passed = runsOfTask.filter(r => r.passed).length;
    const before = previous?.filter(r => r.task === task);
    const was = before?.length ? `${before.filter(r => r.passed).length}/${before.length}` : "";
    lines.push(
      `| ${task} | ${runsOfTask[0].area} | ${passed}/${runsOfTask.length} | ${was} | ${mean(runsOfTask.map(r => r.seconds))} | ${mean(runsOfTask.map(r => r.calls))} | ${mean(runsOfTask.map(r => r.failedCalls))} | ${mean(runsOfTask.map(r => r.repeatedFailures))} | ${Math.max(...runsOfTask.map(r => r.peakContext ?? 0))} |`,
    );
  }
  const total = results.filter(r => r.passed).length;
  lines.push("", `**${total}/${results.length} runs passed.**`, "", "## What went wrong", "");
  for (const result of results.filter(r => !r.passed)) {
    lines.push(`- **${result.task}** (tools: ${result.toolsUsed.join(", ") || "none"}): ${result.problems.join("; ")}`);
  }
  if (total === results.length) lines.push("Nothing.");
  // Failed calls cost rounds even when the task passes in the end; they show where a tool trips models up.
  const failures = results.flatMap(r => r.failures.map(f => ({ task: r.task, ...f })));
  if (failures.length) {
    lines.push("", "## Tool calls that failed", "");
    const oneLine = (text: string) => text.replace(/\s+/g, " ").slice(0, 200);
    for (const f of failures) lines.push(`- **${f.task}**: \`${f.name} ${oneLine(f.args)}\` → ${oneLine(f.result)}`);
  }
  return lines.join("\n");
}

/** Sets each task up and checks it untouched, with no answer: every check must find something wrong. */
async function selfTest() {
  let bad = 0;
  for (const { name, dir, task } of await loadTasks()) {
    const scratch = await mkdtemp(join(tmpdir(), `agent-toolkit-eval-${name}-`));
    try {
      if (existsSync(join(dir, "project"))) await cp(join(dir, "project"), scratch, { recursive: true });
      await task.setup?.(scratch);
      const problems = await task.check({ dir: scratch, answer: "", answers: [], calls: [] });
      if (problems.length === 0) bad++;
      console.log(`${problems.length ? "ok  " : "BAD "} ${name}: ${problems.join("; ") || "passes without anything being done"}`);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
  process.exit(bad ? 1 : 0);
}

async function main() {
  if (args.includes("--self-test")) return selfTest();
  const client = new sdk.LMStudioClient();
  const loaded = (await client.llm.listLoaded()).some((m: any) => m.identifier === modelKey || m.modelKey === modelKey);
  console.log(`${loaded ? "Using the loaded" : "Loading"} model ${modelKey}...`);
  // Loaded explicitly, as from LM Studio's model list: a just-in-time load would be unloaded again the
  // moment a tool loads a second model (LM Studio evicts other JIT models), ending the run.
  const model = loaded
    ? await client.llm.model(modelKey)
    : await client.llm.load(modelKey, { config: { contextLength: 32768 }, verbose: false });
  const systemPrompt = await readFile(join(repo, "presets", "agent-toolkit-prompt", "system-prompt.md"), "utf-8");
  const tasks = await loadTasks();
  if (tasks.length === 0) throw new Error(`No task matches --only ${only?.join(",")}`);

  const results: RunResult[] = [];
  try {
    for (const { name, dir, task } of tasks) {
      for (let i = 1; i <= runs; i++) {
        const result = await runOnce(model, client, systemPrompt, name, dir, task);
        results.push(result);
        console.log(
          `[${result.passed ? "PASS" : "FAIL"}] ${name} ${i}/${runs} (${result.seconds}s, ${result.calls} calls, ${result.failedCalls} failed)` +
            (result.passed ? "" : `: ${result.problems.join("; ")}`),
        );
      }
    }
  } finally {
    if (!loaded) await model.unload().catch(() => {});
  }

  const resultsDir = join(repo, "evals", "results");
  await mkdir(resultsDir, { recursive: true });
  const safeModel = modelKey!.replace(/[^\w.-]+/g, "_");
  const earlier = (await readdir(resultsDir)).filter(f => f.endsWith(`-${safeModel}.json`)).sort();
  const previous: RunResult[] | null = earlier.length ? JSON.parse(await readFile(join(resultsDir, earlier.at(-1)!), "utf-8")) : null;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const text = report(results, previous, `${modelKey}, ${new Date().toISOString().slice(0, 16).replace("T", " ")}, ${runs} run(s) per task`);
  await writeFile(join(resultsDir, `${stamp}-${safeModel}.json`), JSON.stringify(results, null, 2));
  await writeFile(join(resultsDir, `${stamp}-${safeModel}.md`), text);
  console.log(`\n${text}\n\nSaved to evals/results/${stamp}-${safeModel}.md`);
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
