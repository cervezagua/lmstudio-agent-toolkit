import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "repoDirectory",
    "string",
    {
      displayName: "Repository Directory",
      subtitle: "Git repository to operate on. Leave empty to use this chat's working directory.",
      placeholder: "D:\\my-project",
    },
    "",
  )
  .field(
    "allowPush",
    "boolean",
    {
      displayName: "Allow Push",
      subtitle: "Expose git_push (never force-pushes). Off by default.",
    },
    false,
  )
  .field(
    "enableGitHub",
    "boolean",
    {
      displayName: "Enable GitHub Tools",
      subtitle: "Expose gh_* tools when the GitHub CLI (gh) is installed and logged in (gh auth login).",
    },
    true,
  )
  .field(
    "maxOutputChars",
    "numeric",
    {
      int: true,
      min: 1000,
      max: 200000,
      displayName: "Max Output Characters",
      subtitle: "Diffs and logs longer than this are truncated.",
    },
    20000,
  )
  .build();
