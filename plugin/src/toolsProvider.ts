import { type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { configSchematics } from "./config";
import { toolsProvider as documentTools } from "./groups/documents/toolsProvider";
import { toolsProvider as fileTools } from "./groups/files/toolsProvider";
import { toolsProvider as gitTools } from "./groups/git/toolsProvider";
import { toolsProvider as memoryTools } from "./groups/memory/toolsProvider";
import { toolsProvider as webTools } from "./groups/web/toolsProvider";

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
  ];
  const enabled = groups.filter(([on]) => on).map(([, build]) => build(ctl));
  return (await Promise.all(enabled)).flat();
}
