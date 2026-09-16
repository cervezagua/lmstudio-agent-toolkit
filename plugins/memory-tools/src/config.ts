import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "projectDirectory",
    "string",
    {
      displayName: "Project Directory",
      subtitle:
        "Folder to load project instruction files from. Leave empty to use this chat's working directory. " +
        "Set it to the same folder as coder-tools' Root Directory.",
      placeholder: "D:\\my-project",
    },
    "",
  )
  .field(
    "instructionFiles",
    "stringArray",
    {
      displayName: "Instruction Files",
      subtitle: "File names (relative to the project directory) injected at the start of each new chat, if present.",
    },
    ["AGENTS.md", "CLAUDE.md", ".lmstudio/instructions.md"],
  )
  .field(
    "injectMemoryIndex",
    "boolean",
    {
      displayName: "Inject Memory Index",
      subtitle: "Also show the list of saved memories at the start of each new chat.",
    },
    true,
  )
  .field(
    "enableSkills",
    "boolean",
    {
      displayName: "Skills",
      subtitle: "Adds skill_list and skill_read, and lists the installed skills at the start of each chat.",
    },
    true,
  )
  .field(
    "enablePlanMode",
    "boolean",
    {
      displayName: "Plan Mode",
      subtitle:
        "Adds enter_plan_mode / exit_plan_mode. While planning, coder-tools and git-tools hide the tools that change things.",
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
    },
    12000,
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
  .build();
