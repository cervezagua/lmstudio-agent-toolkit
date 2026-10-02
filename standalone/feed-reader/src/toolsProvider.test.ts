import { describe, expect, it } from "vitest";
import { toolsProvider } from "./toolsProvider";

// Imports the plugin as LM Studio would, so it only passes once `npm run sync-standalone` has copied
// in the agent-toolkit files listed in files.json.
describe("feed-reader plugin", () => {
  it("offers read_feed and nothing else", async () => {
    expect((await toolsProvider()).map(t => t.name)).toEqual(["read_feed"]);
  });
});
