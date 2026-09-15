// End-to-end check with a real model: a loaded LM Studio model must use each plugin's tools to
// complete a task, and the results are verified on disk / in the tool outputs.
//
// Usage: node scripts/e2e.mjs <modelKey> [--in-process] [--only coder,memory,git,web]
//
// Default mode asks LM Studio for the installed plugins' tools (`npm run install-plugins` first).
// LM Studio only allows that for API clients granted the "use plugins" permission.
// --in-process runs the same toolsProvider code inside this script instead (no install or permission
// needed; memory is written to a temporary folder). A model loaded by this script is unloaded again.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const require = createRequire(join(repo, "plugins", "coder-tools", "package.json"));
const { LMStudioClient } = require("@lmstudio/sdk");

const args = process.argv.slice(2);
const modelKey = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
if (!modelKey) {
  console.error("usage: node scripts/e2e.mjs <model-key> [--in-process] [--only coder,memory,git,web]");
  console.error("       <model-key> is a tool-capable LM Studio model, e.g. one listed by `lms ls --llm`.");
  process.exit(1);
}
const inProcess = args.includes("--in-process");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1].split(",") : ["coder", "memory", "git", "web"];

// Plugins are CommonJS TypeScript; tsx's require hook loads them (and their node_modules) directly.
let tsxRequire;
if (inProcess) ({ require: tsxRequire } = await import("tsx/cjs/api"));
const importTs = async path => tsxRequire(join(repo, path), import.meta.url);

const scratchMemoryDir = await mkdtemp(join(tmpdir(), "lms-e2e-memory-"));
const memoryDir = inProcess ? scratchMemoryDir : join(homedir(), ".lmstudio-agent-memory");

/** Per-chat and global config used in --in-process mode (mirrors each plugin's defaults). */
const inProcessConfig = {
  coder: {
    config: { rootDirectory: "", allowShell: true, shell: "auto", commandTimeoutSeconds: 60, maxOutputChars: 20000, blockedCommandPatterns: [] },
  },
  memory: {
    config: { projectDirectory: "", instructionFiles: ["AGENTS.md"], injectMemoryIndex: true, maxInjectedChars: 12000 },
    globalConfig: { memoryDirectory: scratchMemoryDir },
  },
  git: { config: { repoDirectory: "", allowPush: false, enableGitHub: false, maxOutputChars: 20000 } },
  web: {
    config: {
      searchBackend: "duckduckgo",
      searxngUrl: "",
      maxSearchResults: 5,
      maxPageChars: 8000,
      enableBrowser: true,
      browserChannel: "msedge",
      headless: true,
    },
    globalConfig: { braveApiKey: "" },
  },
};

async function getTools(name, workingDirectory) {
  if (!inProcess) {
    const session = await client.plugins.pluginTools(`local/${name}-tools`, { workingDirectory });
    return { tools: session.tools, dispose: () => session[Symbol.dispose]() };
  }
  const { fakeController } = await importTs("shared/testing/fake-controller.ts");
  const { toolsProvider } = await importTs(`plugins/${name}-tools/src/toolsProvider.ts`);
  const tools = await toolsProvider(fakeController({ ...inProcessConfig[name], workingDirectory }));
  // A browser left open by the web scenario is closed when this process exits.
  return { tools, dispose: () => {} };
}

async function runScenario(name, prompt, check) {
  if (!only.includes(name)) return null;
  const workingDirectory = await mkdtemp(join(tmpdir(), `lms-e2e-${name}-`));
  const calls = [];
  const results = [];
  const { tools, dispose } = await getTools(name, workingDirectory);
  const started = Date.now();
  try {
    await model.act(
      [
        { role: "system", content: "You are a careful agent. Use the provided tools to complete the task, then answer briefly." },
        { role: "user", content: prompt },
      ],
      tools,
      {
        maxPredictionRounds: 12,
        onMessage: message => {
          for (const request of message.getToolCallRequests()) calls.push(request.name);
          for (const result of message.getToolCallResults()) results.push(result.content);
        },
      },
    );
    const problems = await check({ workingDirectory, calls, results });
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`\n[${problems.length ? "FAIL" : "PASS"}] ${name} (${seconds}s) tools used: ${calls.join(", ") || "none"}`);
    for (const problem of problems) console.log(`  - ${problem}`);
    return problems.length === 0;
  } finally {
    await dispose();
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

const client = new LMStudioClient();
const alreadyLoaded = (await client.llm.listLoaded()).some(m => m.modelKey === modelKey);
console.log(`${alreadyLoaded ? "Using loaded" : "Loading"} model ${modelKey} (${inProcess ? "in-process tools" : "installed plugins"})...`);
const model = await client.llm.model(modelKey, { config: { contextLength: 16384 }, verbose: false });

const outcomes = [];
try {
  outcomes.push(
    await runScenario(
      "coder",
      "Create a file hello.txt containing exactly 'hello world'. Then use edit_file to change 'hello' to 'hi'. " +
        "Then run a shell command that prints the file's contents. Finally try to read the file ../../outside-secret.txt and tell me what happened.",
      async ({ workingDirectory, calls, results }) => {
        const problems = [];
        const file = join(workingDirectory, "hello.txt");
        const content = existsSync(file) ? (await readFile(file, "utf-8")).trim() : null;
        if (content !== "hi world") problems.push(`hello.txt should be "hi world", got ${JSON.stringify(content)}`);
        for (const tool of ["write_file", "edit_file", "run_command", "read_file"]) {
          if (!calls.includes(tool)) problems.push(`expected a ${tool} call`);
        }
        if (!results.some(r => /outside the allowed root/.test(r))) problems.push("path escape was not rejected");
        return problems;
      },
    ),
  );

  const memoryDirExisted = existsSync(memoryDir);
  outcomes.push(
    await runScenario(
      "memory",
      "Save a memory named e2e-favorite-color (type user) recording that my favorite color is teal. " +
        "Then search memories for 'color', read that memory back, and finally delete it.",
      async ({ calls, results }) => {
        const problems = [];
        for (const tool of ["memory_save", "memory_search", "memory_read", "memory_delete"]) {
          if (!calls.includes(tool)) problems.push(`expected a ${tool} call`);
        }
        if (!results.some(r => /teal/i.test(r))) problems.push("memory content was never read back");
        if (existsSync(join(memoryDir, "e2e-favorite-color.md"))) problems.push("memory file was not deleted");
        if (!memoryDirExisted && !inProcess) await rm(memoryDir, { recursive: true, force: true });
        return problems;
      },
    ),
  );

  outcomes.push(
    await runScenario(
      "git",
      "Initialize a git repository here. Then use git_status and tell me the branch name. Do not commit anything.",
      async ({ workingDirectory, calls }) => {
        const problems = [];
        if (!existsSync(join(workingDirectory, ".git"))) problems.push(".git folder was not created");
        for (const tool of ["git_init", "git_status"]) if (!calls.includes(tool)) problems.push(`expected a ${tool} call`);
        return problems;
      },
    ),
  );

  outcomes.push(
    await runScenario(
      "web",
      "Use fetch_url to read https://example.com and tell me the page heading. Then open the same URL with browser_open, " +
        "click the link on the page, tell me the title of the page you land on, and close the browser.",
      async ({ calls, results }) => {
        const problems = [];
        for (const tool of ["fetch_url", "browser_open", "browser_click", "browser_close"]) {
          if (!calls.includes(tool)) problems.push(`expected a ${tool} call`);
        }
        if (!results.some(r => /Example Domain/.test(r))) problems.push("example.com content never came back");
        return problems;
      },
    ),
  );
} finally {
  if (!alreadyLoaded) {
    console.log(`\nUnloading ${modelKey}.`);
    await model.unload().catch(error => console.error(`Could not unload: ${error.message}`));
  }
  await rm(scratchMemoryDir, { recursive: true, force: true }).catch(() => {});
}

const ran = outcomes.filter(o => o !== null);
console.log(`\n${ran.filter(Boolean).length}/${ran.length} scenarios passed.`);
process.exit(ran.every(Boolean) ? 0 : 1);
