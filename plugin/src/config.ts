import { createConfigSchematics } from "@lmstudio/sdk";

/** Shows a field only while its group (and any sub-switch) is on, so the panel stays short. */
const onlyWhen = (...keys: string[]) =>
  keys.map(key => ({ key, condition: { type: "equals" as const, value: true } }));

export const configSchematics = createConfigSchematics()
  .field(
    "projectFolder",
    "string",
    {
      displayName: "Project Folder",
      subtitle:
        "The folder the model works in: every group below uses it, and file paths cannot escape it. " +
        "Leave empty to use this chat's LM Studio working directory.",
      placeholder: "D:\\my-project",
    },
    "",
  )
  .field(
    "maxOutputChars",
    "numeric",
    {
      int: true,
      min: 1000,
      max: 200000,
      displayName: "Max Output Characters",
      subtitle: "Tool results longer than this are truncated (keeps head and tail). Lower it for small context windows.",
    },
    20000,
  )

  // ── Files & shell ────────────────────────────────────────────────────────────────────────────
  .field(
    "enableFiles",
    "boolean",
    {
      displayName: "Files & Shell",
      subtitle: "Read, write and edit files, search the project, and run commands.",
    },
    true,
  )
  .field(
    "allowShell",
    "boolean",
    {
      displayName: "Allow Shell Commands",
      subtitle: "Expose the run_command tool. Keep LM Studio's tool call confirmation enabled.",
      dependencies: onlyWhen("enableFiles"),
    },
    true,
  )
  .field(
    "shell",
    "select",
    {
      displayName: "Shell",
      subtitle: "auto = pwsh (or Windows PowerShell) on Windows, bash (or sh) elsewhere.",
      options: ["auto", "pwsh", "powershell", "bash"],
      dependencies: onlyWhen("enableFiles", "allowShell"),
    },
    "auto",
  )
  .field(
    "commandTimeoutSeconds",
    "numeric",
    {
      int: true,
      min: 1,
      max: 1800,
      displayName: "Default Command Timeout (seconds)",
      subtitle: "The model can ask for a longer timeout, up to 10x this value.",
      dependencies: onlyWhen("enableFiles", "allowShell"),
    },
    60,
  )
  .field(
    "blockedCommandPatterns",
    "stringArray",
    {
      displayName: "Extra Blocked Command Patterns",
      subtitle: "Regular expressions (case-insensitive). Commands matching any are refused, in addition to built-in ones.",
      dependencies: onlyWhen("enableFiles", "allowShell"),
    },
    [],
  )
  .field(
    "persistentShell",
    "boolean",
    {
      displayName: "Persistent Shell Session",
      subtitle:
        "Run commands in one long-lived shell so cd, environment variables and virtualenvs carry over between calls. Adds shell_reset.",
      dependencies: onlyWhen("enableFiles", "allowShell"),
    },
    true,
  )
  .field(
    "maxReadBytes",
    "numeric",
    {
      int: true,
      min: 8192,
      max: 10485760,
      displayName: "Max Read Bytes",
      subtitle: "Largest file read_file will read whole. Bigger files must be read with offset and limit, or searched with grep.",
      dependencies: onlyWhen("enableFiles"),
    },
    262144,
  )
  .field(
    "enableBackgroundTasks",
    "boolean",
    {
      displayName: "Background Tasks",
      subtitle: "Adds task_run / task_list / task_output / task_stop for dev servers, watchers and long builds.",
      dependencies: onlyWhen("enableFiles"),
    },
    true,
  )
  .field(
    "enableDiagnostics",
    "boolean",
    {
      displayName: "Diagnostics",
      subtitle: "Adds a diagnostics tool that runs the project's own checkers (tsc, ESLint, Ruff, Pyright, cargo, go vet).",
      dependencies: onlyWhen("enableFiles"),
    },
    true,
  )
  .field(
    "enableNotebookTools",
    "boolean",
    {
      displayName: "Jupyter Notebook Tools",
      subtitle: "Adds notebook_read and notebook_edit for .ipynb files. Off by default to keep the tool list short.",
      dependencies: onlyWhen("enableFiles"),
    },
    false,
  )
  .field(
    "enableSubagent",
    "boolean",
    {
      displayName: "Research Sub-agent",
      subtitle:
        "Adds run_subagent: a read-only nested agent for search-heavy questions. Costs extra generation time on your GPU.",
      dependencies: onlyWhen("enableFiles"),
    },
    false,
  )
  .field(
    "subagentModel",
    "string",
    {
      displayName: "Sub-agent Model",
      subtitle: "Model key for the sub-agent. Empty = the first loaded model.",
      placeholder: "qwen/qwen3.8-27b",
      dependencies: onlyWhen("enableFiles", "enableSubagent"),
    },
    "",
  )

  // ── Memory & context ─────────────────────────────────────────────────────────────────────────
  .field(
    "enableMemory",
    "boolean",
    {
      displayName: "Memory & Context",
      subtitle:
        "Remember things between chats, keep a todo list, follow skills, and load project instructions into each new chat.",
    },
    true,
  )
  .field(
    "instructionFiles",
    "stringArray",
    {
      displayName: "Instruction Files",
      subtitle: "File names (relative to the project folder) injected at the start of each new chat, if present.",
      dependencies: onlyWhen("enableMemory"),
    },
    ["AGENTS.md", "CLAUDE.md", ".lmstudio/instructions.md"],
  )
  .field(
    "injectMemoryIndex",
    "boolean",
    {
      displayName: "Inject Memory Index",
      subtitle: "Also show the list of saved memories at the start of each new chat.",
      dependencies: onlyWhen("enableMemory"),
    },
    true,
  )
  .field(
    "injectGitSnapshot",
    "boolean",
    {
      displayName: "Git Snapshot",
      subtitle:
        "Show the branch, uncommitted changes and recent commits at the start of a chat, when the project is a git repository.",
      dependencies: onlyWhen("enableMemory"),
    },
    true,
  )
  .field(
    "enableSkills",
    "boolean",
    {
      displayName: "Skills",
      subtitle: "Adds skill_list and skill_read, and lists the installed skills at the start of each chat.",
      dependencies: onlyWhen("enableMemory"),
    },
    true,
  )
  .field(
    "enablePlanMode",
    "boolean",
    {
      displayName: "Plan Mode",
      subtitle: "Adds enter_plan_mode / exit_plan_mode. While planning, the tools that change things are hidden.",
      dependencies: onlyWhen("enableMemory"),
    },
    true,
  )
  .field(
    "maxInjectedChars",
    "numeric",
    {
      int: true,
      min: 500,
      max: 100000,
      displayName: "Max Injected Characters",
      subtitle: "Cap on instructions + memory index added to the first message. Lower it for small context windows.",
      dependencies: onlyWhen("enableMemory"),
    },
    12000,
  )

  // ── Git & GitHub ─────────────────────────────────────────────────────────────────────────────
  .field(
    "enableGit",
    "boolean",
    {
      displayName: "Git & GitHub",
      subtitle: "Status, diff, commit, branches, and GitHub pull requests and issues.",
    },
    true,
  )
  .field(
    "allowPush",
    "boolean",
    {
      displayName: "Allow Push",
      subtitle: "Expose git_push (never force-pushes). Off by default.",
      dependencies: onlyWhen("enableGit"),
    },
    false,
  )
  .field(
    "enableGitHub",
    "boolean",
    {
      displayName: "Enable GitHub Tools",
      subtitle: "Expose gh_* tools when the GitHub CLI (gh) is installed and logged in (gh auth login).",
      dependencies: onlyWhen("enableGit"),
    },
    true,
  )

  // ── Web ──────────────────────────────────────────────────────────────────────────────────────
  .field(
    "enableWeb",
    "boolean",
    {
      displayName: "Web",
      subtitle: "Search the web, read pages as markdown, and drive a real browser. Off by default.",
    },
    false,
  )
  .field(
    "searchBackend",
    "select",
    {
      displayName: "Search Backend",
      subtitle:
        "auto = SearXNG if reachable, else DuckDuckGo. searxng = your instance only (JSON format enabled). " +
        "duckduckgo needs no setup but often hits bot checks. brave needs an API key (global settings).",
      options: ["auto", "searxng", "duckduckgo", "brave"],
      dependencies: onlyWhen("enableWeb"),
    },
    "auto",
  )
  .field(
    "searxngUrl",
    "string",
    {
      displayName: "SearXNG URL",
      subtitle: "Base URL of your SearXNG instance, used by the auto and searxng backends.",
      placeholder: "http://localhost:8888",
      dependencies: onlyWhen("enableWeb"),
    },
    "http://localhost:8888",
  )
  .field(
    "maxSearchResults",
    "numeric",
    { int: true, min: 1, max: 20, displayName: "Default Search Results", dependencies: onlyWhen("enableWeb") },
    8,
  )
  .field(
    "maxPageChars",
    "numeric",
    {
      int: true,
      min: 1000,
      max: 200000,
      displayName: "Max Page Characters",
      subtitle: "Fetched pages and browser snapshots are truncated to this length.",
      dependencies: onlyWhen("enableWeb"),
    },
    15000,
  )
  .field(
    "browserFallback",
    "boolean",
    {
      displayName: "Browser Fallback for fetch_url",
      subtitle: "When a fetched page has almost no text (JavaScript-only sites), render it in the browser instead.",
      dependencies: onlyWhen("enableWeb"),
    },
    true,
  )
  .field(
    "enableBrowser",
    "boolean",
    {
      displayName: "Enable Browser Tools",
      subtitle: "Expose browser_* tools that drive a real Edge/Chrome window via Playwright.",
      dependencies: onlyWhen("enableWeb"),
    },
    true,
  )
  .field(
    "browserChannel",
    "select",
    {
      displayName: "Browser",
      subtitle: "msedge and chrome use the installed browser. chromium needs `npx playwright install chromium`.",
      options: ["msedge", "chrome", "chromium"],
      dependencies: onlyWhen("enableWeb", "enableBrowser"),
    },
    "msedge",
  )
  .field(
    "headless",
    "boolean",
    {
      displayName: "Headless Browser",
      subtitle: "Turn off to watch the browser while the model uses it.",
      dependencies: onlyWhen("enableWeb", "enableBrowser"),
    },
    true,
  )

  // ── Documents ────────────────────────────────────────────────────────────────────────────────
  .field(
    "enableDocuments",
    "boolean",
    {
      displayName: "Documents",
      subtitle:
        "Read PDFs, scans and images from the project folder. The text layer is read without a model; OCR needs a vision model. Off by default.",
    },
    false,
  )
  .field(
    "visionModel",
    "string",
    {
      displayName: "Vision Model",
      subtitle: "Model key used for OCR. Empty = the first loaded vision-capable model.",
      placeholder: "qwen/qwen3.8-27b",
      dependencies: onlyWhen("enableDocuments"),
    },
    "",
  )
  .field(
    "renderScale",
    "numeric",
    {
      min: 1,
      max: 4,
      step: 0.5,
      displayName: "PDF Render Scale",
      subtitle: "Higher renders pages larger, which reads small print better but costs more tokens and time.",
      slider: { min: 1, max: 4, step: 0.5 },
      dependencies: onlyWhen("enableDocuments"),
    },
    2,
  )
  .field(
    "maxPages",
    "numeric",
    {
      int: true,
      min: 1,
      max: 100,
      displayName: "Max Pages Per Call",
      subtitle: "Guards against sending a whole book to the model in one go.",
      dependencies: onlyWhen("enableDocuments"),
    },
    10,
  )
  .build();

export const globalConfigSchematics = createConfigSchematics()
  .field(
    "memoryDirectory",
    "string",
    {
      displayName: "Memory Directory",
      subtitle: "Where memories are stored (one markdown file each, plus MEMORY.md). Empty = ~/.lmstudio-agent-memory",
      placeholder: "~/.lmstudio-agent-memory",
    },
    "",
  )
  .field(
    "skillsDirectory",
    "string",
    {
      displayName: "Skills Directory",
      subtitle:
        "Folder of skills: either <name>/SKILL.md (with supporting files) or <name>.md. Empty = ~/.lmstudio-agent-skills",
      placeholder: "~/.lmstudio-agent-skills",
    },
    "",
  )
  .field(
    "braveApiKey",
    "string",
    {
      displayName: "Brave Search API Key",
      subtitle: "Only needed when a chat uses the brave search backend.",
      isProtected: true,
    },
    "",
  )
  .build();
