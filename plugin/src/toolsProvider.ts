import { type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { configSchematics } from "./config";
import { toolsProvider as documentTools } from "./groups/documents/toolsProvider";
import { toolsProvider as fileTools } from "./groups/files/toolsProvider";
import { toolsProvider as gitTools } from "./groups/git/toolsProvider";
import { toolsProvider as memoryTools } from "./groups/memory/toolsProvider";
import { toolsProvider as utilityTools } from "./groups/utilities/toolsProvider";
import { toolsProvider as webTools } from "./groups/web/toolsProvider";
import { describeRedaction, redactDeep, REDACTION_MARK } from "./shared/redact";

/**
 * LM Studio also asks for the tool list outside any chat, to show it in the plugin's settings. There
 * is no working directory then, and the SDK's getWorkingDirectory() throws, which failed the whole
 * list ("This prediction process is not attached to a working directory"). The groups read it while
 * building their tools, so give them a scratch folder instead: without a chat the tools are only
 * listed, never run.
 */
async function withWorkingDirectory(ctl: ToolsProviderController): Promise<ToolsProviderController> {
  try {
    ctl.getWorkingDirectory();
    return ctl;
  } catch {
    const scratch = join(tmpdir(), "lmstudio-agent-toolkit", "no-chat");
    await mkdir(scratch, { recursive: true });
    return new Proxy(ctl, {
      get(target, prop) {
        if (prop === "getWorkingDirectory") return () => scratch;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

/** Whether the model sent a redaction marker back, e.g. as the old_string of an edit. */
function mentionsMarker(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes(REDACTION_MARK);
  if (typeof value !== "object" || value === null || depth > 5) return false;
  return Object.values(value).some(entry => mentionsMarker(entry, depth + 1));
}

/**
 * Passes everything a tool returns through the secret redaction, in this one place so that no tool
 * can be forgotten. Only the result is touched: the parameters reach the tool as the model sent them,
 * the context object is handed on as it is (its methods rely on `this`), and nothing on disk changes.
 *
 * The model is told in one line that values were hidden, and the user is warned once per call with
 * the count and kinds, never the values. A marker is not in the file, so an edit that quotes one
 * cannot match; the tool's own "not found" error then gets a line saying why.
 */
export function withRedaction(tools: Tool[]): Tool[] {
  return tools.map(tool => {
    const implementation: Tool["implementation"] = async (params, ctx) => {
      const result: unknown = await tool.implementation(params, ctx);
      const hidden = redactDeep(result);
      if (hidden.count > 0) {
        ctx.warn(`agent-toolkit hid ${describeRedaction(hidden)} from the model`);
        if (typeof hidden.value !== "string") return hidden.value;
        const values = hidden.count === 1 ? "1 secret value is" : `${hidden.count} secret values are`;
        return `${hidden.value}\n\n[${values} hidden as "${REDACTION_MARK}…]". Do not try to recover what was hidden, and do not write the markers into files.]`;
      }
      if (typeof result === "string" && result.startsWith("Error:") && mentionsMarker(params)) {
        return `${result}\n[Your input contains a "${REDACTION_MARK}…]" marker. It stands for a hidden secret and is not text in the file: match the text around it instead.]`;
      }
      return result;
    };
    return { ...tool, implementation } as Tool;
  });
}

/**
 * Offers the tools of every group the chat has switched on. Each group reads what it needs from the
 * one shared config, so the project folder is set in a single place.
 *
 * Groups are kept off unless asked for because a long tool list makes small models choose worse.
 * The heavy dependencies (Playwright, PDF.js) are imported on first use inside their group, so an
 * unused group costs nothing at startup.
 */
export async function toolsProvider(controller: ToolsProviderController): Promise<Tool[]> {
  const ctl = await withWorkingDirectory(controller);
  const config = ctl.getPluginConfig(configSchematics);
  const groups: Array<[boolean, (ctl: ToolsProviderController) => Promise<Tool[]>]> = [
    [config.get("enableFiles"), fileTools],
    [config.get("enableMemory"), memoryTools],
    [config.get("enableGit"), gitTools],
    [config.get("enableWeb"), webTools],
    [config.get("enableDocuments"), documentTools],
    [config.get("enableUtilities"), utilityTools],
  ];
  const enabled = groups.filter(([on]) => on).map(([, build]) => build(ctl));
  const tools = (await Promise.all(enabled)).flat();
  return config.get("redactSecrets") ? withRedaction(tools) : tools;
}
