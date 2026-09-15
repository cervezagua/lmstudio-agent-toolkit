import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "rootDirectory",
    "string",
    {
      displayName: "Root Directory",
      subtitle:
        "Project folder the tools may read and write. All paths are relative to it and cannot escape it. " +
        "Leave empty to use this chat's LM Studio working directory.",
      placeholder: "D:\\my-project",
    },
    "",
  )
  .field(
    "allowShell",
    "boolean",
    {
      displayName: "Allow Shell Commands",
      subtitle: "Expose the run_command tool. Keep LM Studio's tool call confirmation enabled.",
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
    },
    60,
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
  .field(
    "blockedCommandPatterns",
    "stringArray",
    {
      displayName: "Extra Blocked Command Patterns",
      subtitle: "Regular expressions (case-insensitive). Commands matching any are refused, in addition to built-in ones.",
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
    },
    true,
  )
  .field(
    "enableBackgroundTasks",
    "boolean",
    {
      displayName: "Background Tasks",
      subtitle: "Adds task_run / task_list / task_output / task_stop for dev servers, watchers and long builds.",
    },
    true,
  )
  .field(
    "enableDiagnostics",
    "boolean",
    {
      displayName: "Diagnostics",
      subtitle: "Adds a diagnostics tool that runs the project's own checkers (tsc, ESLint, Ruff, Pyright, cargo, go vet).",
    },
    true,
  )
  .field(
    "enableSubagent",
    "boolean",
    {
      displayName: "Research Sub-agent",
      subtitle:
        "Adds run_subagent: a read-only nested agent for search-heavy questions. Costs extra generation time on your GPU.",
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
      dependencies: [{ key: "enableSubagent", condition: { type: "equals", value: true } }],
    },
    "",
  )
  .field(
    "enableNotebookTools",
    "boolean",
    {
      displayName: "Jupyter Notebook Tools",
      subtitle: "Adds notebook_read and notebook_edit for .ipynb files. Off by default to keep the tool list short.",
    },
    false,
  )
  .build();
