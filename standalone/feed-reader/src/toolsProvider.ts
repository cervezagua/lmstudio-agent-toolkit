import { type Tool } from "@lmstudio/sdk";
// Copied from agent-toolkit by `npm run sync-standalone`; the same tool ships in its Web group.
import { makeReadFeedTools } from "./groups/web/lib/feeds";

export async function toolsProvider(): Promise<Tool[]> {
  return makeReadFeedTools();
}
