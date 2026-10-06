import { type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { configSchematics } from "./config";
// Copied from agent-toolkit by `npm run sync-standalone`; the same tool ships in its Web group.
import { makeFetchUrlTools } from "./groups/web/lib/fetchUrlTool";

/** Offers fetch_url. There is no browser here, so a page that needs JavaScript is reported as such. */
export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
  return makeFetchUrlTools({ maxChars: ctl.getPluginConfig(configSchematics).get("maxChars"), explainEmptyPages: true });
}
