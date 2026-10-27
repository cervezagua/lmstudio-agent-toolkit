import { Chat, type PluginContext, type PredictionLoopHandlerController } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { realpathSync } from "fs";
import { loadApprovals } from "./shared/compaction/approvals";
import { lmStudioHome } from "./shared/lmStudioHome";
import { capTools } from "./shared/compaction/capTools";
import { type ChatController, confirmInChat, replyInChat } from "./shared/compaction/chatOutput";
import { runReply } from "./shared/compaction/reply";

/** About as many characters as a token holds, for caps set in tokens. */
const CHARS_PER_TOKEN = 3.5;

/**
 * LM Studio's folder, found once when the plugin loads, as LM Studio itself does: a pointer file
 * changed later (by a tool, say) cannot send the approval settings somewhere else.
 */
const LM_STUDIO_HOME = (() => {
  const home = lmStudioHome();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
})();

async function handlePrediction(ctl: PredictionLoopHandlerController) {
  const config = ctl.getPluginConfig(configSchematics);
  const history = await ctl.pullHistory();
  const model: any = await ctl.tokenSource();
  const chat: ChatController = ctl;

  // A remote model, through a generator plugin such as LM Studio's remote-lmstudio or
  // openai-compat-endpoint, runs the same loop. It cannot count tokens or say its context size, so
  // sizes are estimated from the text and the context is the Usable Context setting (or 32k).
  const remote = typeof model.countTokens !== "function" || typeof model.getContextLength !== "function";

  let session: Awaited<ReturnType<typeof ctl.startToolUseSession>> | undefined;
  let tools: any[] = [];
  try {
    session = await ctl.startToolUseSession();
    tools = session.tools;
  } catch (error: any) {
    ctl.createStatus({ status: "error", text: `agent-toolkit-loop could not get the tools of the enabled plugins (${error?.message ?? error}); answering without them.` });
  }

  // The user's "Always allow" choices as they stand when the reply starts.
  const approved = await loadApprovals(LM_STUDIO_HOME);
  try {
    await replyInChat(chat, async out => {
      const cap = config.get("usableContext");
      const loaded: number = remote ? cap || 32_768 : await model.getContextLength();
      const usable = cap > 0 ? Math.min(loaded, cap) : loaded;
      const definitions = JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parametersJsonSchema ?? {} })));
      const estimate = Math.ceil(definitions.length / CHARS_PER_TOKEN);
      const toolTokens = !tools.length ? 0 : remote ? estimate : await model.countTokens(definitions).catch(() => estimate);
      const maxResultChars = Math.floor(config.get("maxToolResultTokens") * CHARS_PER_TOKEN);
      // All results in one reply share half the context, so a run of big results cannot fill it.
      const capped = capTools(tools, { perResult: maxResultChars, budget: Math.floor(usable * 0.5 * CHARS_PER_TOKEN) });
      await runReply({
        sdk: { Chat },
        model,
        history,
        tools: capped,
        refillToolBudget: capped.refill,
        toolTokens,
        chatDir: ctl.getWorkingDirectory(),
        settings: {
          usable,
          high: config.get("compactAt"),
          low: Math.min(config.get("compactTo"), config.get("compactAt") - 0.1),
          keepRounds: config.get("keepToolRounds"),
          maxResultChars,
          summarize: config.get("summarize"),
          taskReminderEvery: config.get("taskReminderEvery"),
          showNotices: config.get("showNotices"),
        },
        out,
        signal: ctl.abortSignal,
        // LM Studio's own loop asks before each tool call; a loop that replaces it has to ask too.
        confirm: confirmInChat(chat, approved),
      });
    });
  } finally {
    session?.[Symbol.dispose]();
  }
}

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withPredictionLoopHandler(handlePrediction);
}
