import { type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { configSchematics } from "./config";
// Copied from agent-toolkit by `npm run sync-standalone`; the same tool ships in its Web group.
import { makeVideoTranscriptTools } from "./groups/web/lib/transcript";

/** Offers video_transcript when yt-dlp is installed, and nothing otherwise. */
export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
  return makeVideoTranscriptTools({ maxChars: ctl.getPluginConfig(configSchematics).get("maxChars") });
}
