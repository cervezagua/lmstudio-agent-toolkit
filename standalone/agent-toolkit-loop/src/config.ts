import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "compactAt",
    "numeric",
    {
      min: 0.3,
      max: 0.95,
      step: 0.05,
      displayName: "Compact At",
      subtitle: "Start making room once the prompt passes this share of the context.",
    },
    0.7,
  )
  .field(
    "compactTo",
    "numeric",
    {
      min: 0.2,
      max: 0.8,
      step: 0.05,
      displayName: "Compact To",
      subtitle: "Aim for this share. A wide gap compacts rarely, which keeps replies fast: every compaction makes the model reread the prompt.",
    },
    0.45,
  )
  .field(
    "usableContext",
    "numeric",
    {
      int: true,
      min: 0,
      max: 1_000_000,
      displayName: "Usable Context",
      subtitle:
        "Treat the context as at most this many tokens. 0 uses the model's loaded size (32000 for a remote model, which cannot say). Small models often get worse long before their limit; 16000–24000 suits many 7–14B models.",
    },
    0,
  )
  .field(
    "keepToolRounds",
    "numeric",
    { int: true, min: 1, max: 30, displayName: "Recent Tool Rounds Kept", subtitle: "Rounds of tool calls whose results stay whole; older output is hidden first." },
    6,
  )
  .field(
    "summarize",
    "boolean",
    {
      displayName: "Summarize When Needed",
      subtitle: "When hiding old output is not enough, the model summarizes the earlier conversation. Off: only hide output.",
    },
    true,
  )
  .field(
    "maxToolResultTokens",
    "numeric",
    { int: true, min: 500, max: 50_000, displayName: "Max Tool Result", subtitle: "Most tokens one tool result may take; longer ones keep their start and end." },
    4000,
  )
  .field(
    "taskReminderEvery",
    "numeric",
    {
      int: true,
      min: 0,
      max: 20,
      displayName: "Task Reminder Every",
      subtitle: "Restate the open task list at the end of the prompt every this many messages (0: only after compacting).",
    },
    4,
  )
  .field(
    "showNotices",
    "boolean",
    { displayName: "Show Notices", subtitle: "Say in the chat when the prompt was compacted. The notices are not sent to the model." },
    true,
  )
  .build();
