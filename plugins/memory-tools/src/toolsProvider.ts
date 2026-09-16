import { text, tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics, globalConfigSchematics } from "./config";
import { defaultSkillsDirectory, listSkills, readSkill, renderSkillList } from "./lib/skills";
import { readMode, writeMode } from "./shared/mode";
import { defaultMemoryDirectory, MEMORY_TYPES, MemoryStore, renderIndex } from "./lib/memoryStore";
import { completionNudge, readTodos, renderTodos, TODO_STATUSES, writeTodos } from "./lib/todos";
import { safe, ToolError } from "./shared/errors";

export async function toolsProvider(ctl: ToolsProviderController) {
  const globalConfig = ctl.getGlobalPluginConfig(globalConfigSchematics);
  const config = ctl.getPluginConfig(configSchematics);
  const store = new MemoryStore(defaultMemoryDirectory(globalConfig.get("memoryDirectory")));
  const skillsDirectory = defaultSkillsDirectory(globalConfig.get("skillsDirectory"));
  const workingDirectory = ctl.getWorkingDirectory();
  const tools: Tool[] = [];

  tools.push(
    tool({
      name: "memory_save",
      description: text`
        Save a fact to long-term memory so it is available in future chats. Saving with an existing
        name replaces that memory (read it first and merge if you want to keep old content).
        Types: user (who the user is, preferences), feedback (corrections or confirmed ways of
        working, include why), project (goals, decisions, deadlines as absolute dates),
        reference (links, where things live), session (summary of a work session).
        Save one fact per memory. Do not save things that are obvious from the code or temporary.
      `,
      parameters: {
        name: z.string().describe("short kebab-case name, e.g. prefers-pnpm"),
        description: z.string().describe("one-line summary used to decide relevance later"),
        content: z.string(),
        type: z.enum(MEMORY_TYPES),
      },
      implementation: safe(async params => {
        const { memory, existed } = await store.save(params);
        return `${existed ? "Updated" : "Saved"} memory "${memory.name}".`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "memory_read",
      description: "Read the full content of a saved memory by name.",
      parameters: { name: z.string() },
      implementation: safe(async ({ name }) => {
        const memory = await store.read(name);
        if (!memory) {
          const similar = await store.search(name, 3).catch(() => []);
          const hint = similar.length ? ` Similar: ${similar.map(s => s.memory.name).join(", ")}.` : "";
          throw new ToolError(`No memory named "${name}".${hint}`);
        }
        return `# ${memory.name} (${memory.type}, updated ${memory.updated})\n${memory.description}\n\n${memory.content}`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "memory_search",
      description: "Search saved memories by keywords. Returns the best matches with a snippet.",
      parameters: { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
      implementation: safe(async ({ query, limit }) => {
        const results = await store.search(query, limit ?? 5);
        if (results.length === 0) return "No memories matched.";
        return results
          .map(r => `- ${r.memory.name} (${r.memory.type}) — ${r.memory.description}${r.snippet ? `\n  > ${r.snippet}` : ""}`)
          .join("\n");
      }),
    }),
  );

  tools.push(
    tool({
      name: "memory_list",
      description: "List all saved memories (name, type, description).",
      parameters: {},
      implementation: safe(async () => renderIndex(await store.list())),
    }),
  );

  tools.push(
    tool({
      name: "memory_delete",
      description: "Delete a saved memory that is wrong or no longer useful.",
      parameters: { name: z.string() },
      implementation: safe(async ({ name }) =>
        (await store.delete(name)) ? `Deleted memory "${name}".` : `Error: No memory named "${name}".`,
      ),
    }),
  );

  tools.push(
    tool({
      name: "save_session_summary",
      description: text`
        Save a summary of this chat so work can continue in a new chat when the context is getting
        full. Include: the goal, what was done (files changed), decisions made, and next steps.
        In the new chat, the user can ask you to memory_read it.
      `,
      parameters: { title: z.string(), summary: z.string() },
      implementation: safe(async ({ title, summary }) => {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const { memory } = await store.save({
          name: `session-${stamp}-${title}`,
          description: `Session summary: ${title}`,
          content: summary,
          type: "session",
        });
        return `Saved session summary as "${memory.name}". Start a new chat and ask to read that memory to continue.`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "todo_write",
      description: text`
        Replace this chat's todo list. Use it for tasks with 3+ steps: write the plan first, mark
        exactly one item in_progress while working on it, and mark items completed as soon as they
        are done. Always send the complete list.
      `,
      parameters: {
        todos: z.array(z.object({ content: z.string(), status: z.enum(TODO_STATUSES) })),
      },
      implementation: safe(async ({ todos }) => {
        await writeTodos(workingDirectory, todos);
        const nudge = completionNudge(todos);
        return nudge ? `${renderTodos(todos)}\n\n${nudge}` : renderTodos(todos);
      }),
    }),
  );

  tools.push(
    tool({
      name: "todo_read",
      description: "Show this chat's current todo list.",
      parameters: {},
      implementation: safe(async () => renderTodos(await readTodos(workingDirectory))),
    }),
  );

  if (config.get("enableSkills")) {
    tools.push(
      tool({
        name: "skill_list",
        description: text`
          List the skills installed on this machine. A skill is a set of written instructions for a
          particular kind of task (a workflow, a house style, a checklist). Check this when a task
          might have a skill for it, then load it with skill_read before starting the work.
        `,
        parameters: {},
        implementation: safe(async () => renderSkillList(await listSkills(skillsDirectory))),
      }),
      tool({
        name: "skill_read",
        description: "Load a skill's full instructions by name, and follow them for the task at hand.",
        parameters: { name: z.string() },
        implementation: safe(async ({ name }) => {
          const { skill, content } = await readSkill(skillsDirectory, name);
          const extras = skill.extraFiles.length
            ? `\n\n[files in this skill's folder, read them with coder-tools if needed: ${skill.extraFiles.join(", ")}]`
            : "";
          return `# Skill: ${skill.name}\n(from ${skill.file})\n\n${content}${extras}`;
        }),
      }),
    );
  }

  if (config.get("enablePlanMode")) {
    tools.push(
      tool({
        name: "enter_plan_mode",
        description: text`
          Switch this chat into planning mode before making changes to a codebase you do not fully
          understand yet. While planning, tools that change files, run background jobs or commit are
          not available: you can only read, search and run read-only commands. Investigate, then call
          exit_plan_mode with your plan.
        `,
        parameters: {},
        implementation: safe(async () => {
          await writeMode(workingDirectory, { planning: true, since: new Date().toISOString() });
          return text`
            Planning mode is on. Tools that make changes will disappear from your tool list on the
            next message. Research the task with read_file, grep, glob and read-only commands, then
            call exit_plan_mode with a concrete plan.
          `;
        }),
      }),
      tool({
        name: "exit_plan_mode",
        description: text`
          Leave planning mode and present the plan for approval. Pass the full plan: what you will
          change, in which files, and how you will check it. The tools that make changes come back
          after this.
        `,
        parameters: { plan: z.string().min(1) },
        implementation: safe(async ({ plan }) => {
          const mode = await readMode(workingDirectory);
          await writeMode(workingDirectory, { planning: false, since: mode.since, plan });
          return `Planning mode is off; the tools that make changes are available again.\n\nPlan:\n${plan}`;
        }),
      }),
    );
  }

  return tools;
}
