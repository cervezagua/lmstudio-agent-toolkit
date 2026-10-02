import { describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../../plugin/src/shared/testing/fake-controller";
import { findExecutable } from "./shared/process";
import { toolsProvider } from "./toolsProvider";

// Imports the plugin as LM Studio would, so it only passes once `npm run sync-standalone` has copied
// in the agent-toolkit files listed in files.json.
describe("video-transcripts plugin", () => {
  const tools = () => toolsProvider(fakeController({ config: { maxChars: 15000 }, workingDirectory: "." }));

  it("offers video_transcript where yt-dlp is installed, and nothing otherwise", async () => {
    expect((await tools()).map(t => t.name)).toEqual(findExecutable("yt-dlp") ? ["video_transcript"] : []);
  });

  it.runIf(findExecutable("yt-dlp") !== null)("refuses something that is not a video URL", async () => {
    expect(await callTool(await tools(), "video_transcript", { url: "--version" })).toMatch(/^Error: That is not a URL/);
  });
});
