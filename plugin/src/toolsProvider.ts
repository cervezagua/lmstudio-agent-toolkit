import { type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider as documentTools } from "./groups/documents/toolsProvider";
import { toolsProvider as fileTools } from "./groups/files/toolsProvider";
import { toolsProvider as gitTools } from "./groups/git/toolsProvider";
import { toolsProvider as memoryTools } from "./groups/memory/toolsProvider";
import { toolsProvider as webTools } from "./groups/web/toolsProvider";

/**
 * Offers the tools of every group the chat has switched on. Each group reads what it needs from the
 * one shared config, so the project folder is set in a single place.
 *
 * Groups are kept off unless asked for because a long tool list makes small models choose worse.
 * The heavy dependencies (Playwright, PDF.js) are imported on first use inside their group, so an
 * unused group costs nothing at startup.
 */
export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
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
