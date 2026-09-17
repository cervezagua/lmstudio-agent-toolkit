import { text, tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "../../config";
import { assertNotOption, repoPath, runCli } from "./lib/cli";
import { safe, ToolError } from "../../shared/errors";
import { readMode } from "../../shared/mode";
import { findExecutable } from "../../shared/process";

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);
  const repo = config.get("projectFolder").trim() || ctl.getWorkingDirectory();
  const maxOutputChars = config.get("maxOutputChars");
  const git = (args: string[], extra: { signal?: AbortSignal; stdin?: string } = {}) =>
    runCli("git", ["-c", "core.quotepath=false", "-c", "color.ui=never", ...args], { cwd: repo, maxOutputChars, ...extra }).catch(
      error => {
        if (error instanceof ToolError && /not a git repository/i.test(error.message)) {
          throw new ToolError(`"${repo}" is not a git repository. Run git_init or set the plugin's Repository Directory.`);
        }
        throw error;
      },
    );

  // memory-tools' plan mode: while planning, only the read-only git tools are offered.
  const planning = (await readMode(ctl.getWorkingDirectory())).planning;

  const tools: Tool[] = [];

  tools.push(
    tool({
      name: "git_status",
      description: "Show the current branch, its upstream tracking state, and changed/untracked files.",
      parameters: {},
      implementation: safe(async (_, { signal }) => git(["status", "--short", "--branch"], { signal })),
    }),
  );

  tools.push(
    tool({
      name: "git_diff",
      description: text`
        Show changes. By default shows unstaged changes; staged=true shows what will be committed.
        ref compares the working tree against a commit or branch (e.g. "main" or "HEAD~3").
        stat_only=true shows only a per-file summary, useful before reading a large diff.
      `,
      parameters: {
        staged: z.boolean().optional(),
        ref: z.string().optional(),
        path: z.string().optional(),
        stat_only: z.boolean().optional(),
      },
      implementation: safe(async ({ staged, ref, path, stat_only }, { signal }) => {
        const args = ["diff"];
        if (staged) args.push("--staged");
        if (stat_only) args.push("--stat");
        if (ref) args.push(assertNotOption(ref, "ref"));
        args.push("--");
        if (path) args.push(repoPath(repo, path));
        return git(args, { signal });
      }),
    }),
  );

  tools.push(
    tool({
      name: "git_log",
      description: "Show recent commits (hash, date, author, subject), optionally only those touching a path.",
      parameters: {
        count: z.number().int().min(1).max(200).optional(),
        ref: z.string().optional(),
        path: z.string().optional(),
      },
      implementation: safe(async ({ count, ref, path }, { signal }) => {
        const args = ["log", `-n${count ?? 15}`, "--date=short", "--pretty=format:%h %ad %an%d  %s"];
        if (ref) args.push(assertNotOption(ref, "ref"));
        args.push("--");
        if (path) args.push(repoPath(repo, path));
        return git(args, { signal });
      }),
    }),
  );

  tools.push(
    tool({
      name: "git_show",
      description: "Show a commit's message and changes (e.g. ref \"HEAD\" or a hash from git_log).",
      parameters: { ref: z.string(), stat_only: z.boolean().optional() },
      implementation: safe(async ({ ref, stat_only }, { signal }) =>
        git(["show", stat_only ? "--stat" : "--patch-with-stat", assertNotOption(ref, "ref")], { signal }),
      ),
    }),
  );

  tools.push(
    tool({
      name: "git_add",
      description: 'Stage files for the next commit. Pass ["."] to stage all changes.',
      parameters: { paths: z.array(z.string()).min(1) },
      implementation: safe(async ({ paths }, { signal }) => {
        await git(["add", "--", ...paths.map(p => repoPath(repo, p))], { signal });
        return git(["status", "--short"], { signal });
      }),
    }),
  );

  tools.push(
    tool({
      name: "git_commit",
      description: text`
        Commit the staged changes with the given message. Stage files with git_add first and check
        git_diff staged=true. Write a concise summary line, then a blank line and details if needed.
      `,
      parameters: { message: z.string().min(1) },
      implementation: safe(async ({ message }, { signal }) => {
        const staged = await git(["diff", "--staged", "--name-only"], { signal });
        if (staged === "(no output)") throw new ToolError("Nothing is staged. Use git_add first.");
        // -F - reads the message from stdin, so multi-line messages and quotes need no escaping.
        return git(["commit", "-F", "-"], { signal, stdin: message });
      }),
    }),
  );

  tools.push(
    tool({
      name: "git_branch",
      description: text`
        Without name: list local branches. With name: create the branch (from base, default the
        current HEAD) and switch to it, or switch to it if it already exists. Set switch=false to
        create without switching.
      `,
      parameters: { name: z.string().optional(), base: z.string().optional(), switch: z.boolean().optional() },
      implementation: safe(async ({ name, base, switch: doSwitch }, { signal }) => {
        if (!name) return git(["branch", "--list", "-vv"], { signal });
        const branch = assertNotOption(name, "name");
        const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { signal }).then(
          () => true,
          () => false,
        );
        const baseArgs = base ? [assertNotOption(base, "base")] : [];
        if (doSwitch === false) {
          if (exists) throw new ToolError(`Branch "${branch}" already exists.`);
          await git(["branch", branch, ...baseArgs], { signal });
          return `Created branch "${branch}".`;
        }
        if (exists) {
          if (base) throw new ToolError(`Branch "${branch}" already exists; base only applies when creating.`);
          await git(["switch", branch], { signal });
          return `Switched to existing branch "${branch}".`;
        }
        await git(["switch", "-c", branch, ...baseArgs], { signal });
        return `Created and switched to branch "${branch}".`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "git_init",
      description: "Create a new git repository in the repository directory.",
      parameters: {},
      implementation: safe(async (_, { signal }) =>
        runCli("git", ["init"], { cwd: repo, maxOutputChars, signal }),
      ),
    }),
  );

  if (config.get("allowPush")) {
    tools.push(
      tool({
        name: "git_push",
        description: "Push the current branch to its remote (default origin), setting upstream if needed. Never force-pushes.",
        parameters: { remote: z.string().optional() },
        implementation: safe(async ({ remote }, { signal }) => {
          const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { signal });
          if (branch === "HEAD") throw new ToolError("Detached HEAD; switch to a branch before pushing.");
          const result = await runCli(
            "git",
            ["push", "--set-upstream", assertNotOption(remote ?? "origin", "remote"), branch],
            { cwd: repo, maxOutputChars, signal, timeoutMs: 300_000 },
          );
          return result === "(no output)" ? `Pushed ${branch}.` : result;
        }),
      }),
    );
  }

  const gh = config.get("enableGitHub") ? findExecutable("gh") : null;
  if (gh) {
    const runGh = (args: string[], extra: { signal?: AbortSignal; stdin?: string } = {}) =>
      runCli(gh, args, { cwd: repo, maxOutputChars, ...extra });
    const state = z.enum(["open", "closed", "merged", "all"]).optional();

    tools.push(
      tool({
        name: "gh_pr_list",
        description: "List pull requests in the GitHub repository.",
        parameters: { state, limit: z.number().int().min(1).max(100).optional(), search: z.string().optional() },
        implementation: safe(async ({ state, limit, search }, { signal }) => {
          const args = ["pr", "list", "--state", state ?? "open", "--limit", String(limit ?? 20)];
          if (search) args.push("--search", search);
          return runGh(args, { signal });
        }),
      }),
      tool({
        name: "gh_pr_view",
        description: "Show a pull request's description, status, and comments. Omit number for the current branch's PR.",
        parameters: { number: z.number().int().optional() },
        implementation: safe(async ({ number }, { signal }) =>
          runGh(["pr", "view", ...(number ? [String(number)] : []), "--comments"], { signal }),
        ),
      }),
      tool({
        name: "gh_pr_diff",
        description: "Show a pull request's diff. Omit number for the current branch's PR.",
        parameters: { number: z.number().int().optional() },
        implementation: safe(async ({ number }, { signal }) => runGh(["pr", "diff", ...(number ? [String(number)] : [])], { signal })),
      }),
      tool({
        name: "gh_pr_checks",
        description: "Show CI check results for a pull request. Omit number for the current branch's PR.",
        parameters: { number: z.number().int().optional() },
        implementation: safe(async ({ number }, { signal }) =>
          runGh(["pr", "checks", ...(number ? [String(number)] : [])], { signal }).catch(error => {
            // gh exits 8 while checks are pending; that output is still what the model wants.
            if (error instanceof ToolError && /exit 8/.test(error.message)) return error.message;
            throw error;
          }),
        ),
      }),
      tool({
        name: "gh_pr_create",
        description: text`
          Open a pull request from the current branch. Push the branch first. body is markdown;
          summarize what changed and why.
        `,
        parameters: {
          title: z.string().min(1),
          body: z.string(),
          base: z.string().optional(),
          draft: z.boolean().optional(),
        },
        implementation: safe(async ({ title, body, base, draft }, { signal }) => {
          const args = ["pr", "create", "--title", title, "--body-file", "-"];
          if (base) args.push("--base", assertNotOption(base, "base"));
          if (draft) args.push("--draft");
          return runGh(args, { signal, stdin: body });
        }),
      }),
      tool({
        name: "gh_issue_list",
        description: "List issues in the GitHub repository.",
        parameters: {
          state: z.enum(["open", "closed", "all"]).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          search: z.string().optional(),
        },
        implementation: safe(async ({ state, limit, search }, { signal }) => {
          const args = ["issue", "list", "--state", state ?? "open", "--limit", String(limit ?? 20)];
          if (search) args.push("--search", search);
          return runGh(args, { signal });
        }),
      }),
      tool({
        name: "gh_issue_view",
        description: "Show an issue with its comments.",
        parameters: { number: z.number().int() },
        implementation: safe(async ({ number }, { signal }) => runGh(["issue", "view", String(number), "--comments"], { signal })),
      }),
    );
  }

  if (planning) {
    const changesThings = new Set(["git_add", "git_commit", "git_branch", "git_init", "git_push", "gh_pr_create"]);
    return tools.filter(t => !changesThings.has(t.name));
  }
  return tools;
}
