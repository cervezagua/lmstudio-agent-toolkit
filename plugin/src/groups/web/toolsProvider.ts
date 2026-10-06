import { text, tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { mkdir } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { configSchematics, globalConfigSchematics } from "../../config";
import { browserSession, type BrowserChannel } from "./lib/browser";
import { makeFetchUrlTools, type RenderInBrowser } from "./lib/fetchUrlTool";
import { formatResults, runSearch, type SafeSearch, type SearchBackend } from "./lib/search";
import { runWebDoctor } from "./lib/doctor";
import { makeReadFeedTools } from "./lib/feeds";
import { makeVideoTranscriptTools } from "./lib/transcript";
import { makeWikipediaTools } from "./lib/wikipedia";
import { findExecutable } from "../../shared/process";
import { safe, ToolError } from "../../shared/errors";
import { truncate } from "../../shared/truncate";

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);
  const backend = config.get("searchBackend") as SearchBackend;
  const maxPageChars = config.get("maxPageChars");
  const tools: Tool[] = [];

  tools.push(
    tool({
      name: "web_search",
      description: text`
        Search the web. Returns titles, URLs and snippets. Use fetch_url to read a result.
        Write specific queries; add a year for recent topics. Pass page (2, 3, ...) for more results.
      `,
      parameters: {
        query: z.string().min(1),
        count: z.number().int().min(1).max(20).optional(),
        page: z.number().int().min(1).optional(),
      },
      // ctx.status must be called as a method (it relies on `this`), so don't destructure it.
      implementation: safe(async ({ query, count, page }, ctx) => {
        const { signal } = ctx;
        ctx.status(`Searching (${backend}): ${query}${page && page > 1 ? `, page ${page}` : ""}`);
        const { results, note, cached } = await runSearch({
          backend,
          query,
          count: count ?? config.get("maxSearchResults"),
          page,
          safeSearch: config.get("safeSearch") as SafeSearch,
          searxngUrl: config.get("searxngUrl"),
          braveApiKey: backend === "brave" ? ctl.getGlobalPluginConfig(globalConfigSchematics).get("braveApiKey") : "",
          signal,
        });
        if (note && !cached) ctx.warn(note);
        return note ? `${formatResults(results, page)}\n\n(${note})` : formatResults(results, page);
      }),
    }),
  );

  // Also published on its own as the page-reader plugin, which has no browser to fall back on.
  const renderInBrowser: RenderInBrowser | undefined =
    config.get("enableBrowser") && config.get("browserFallback")
      ? async (url, maxChars) => {
          const browserPage = await browserSession.getPage(config.get("browserChannel") as BrowserChannel, config.get("headless"));
          await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await browserSession.settle();
          return browserSession.snapshot(maxChars);
        }
      : undefined;
  tools.push(...makeFetchUrlTools({ maxChars: maxPageChars, renderInBrowser }));
  tools.push(...makeWikipediaTools({ maxChars: maxPageChars }));

  if (config.get("enableBrowser")) {
    const channel = config.get("browserChannel") as BrowserChannel;
    const headless = config.get("headless");

    tools.push(
      tool({
        name: "browser_open",
        description: text`
          Open a URL in a real browser (runs JavaScript) and return a snapshot: title, numbered
          interactive elements, and page text. Use for dynamic sites or multi-step interactions.
        `,
        parameters: { url: z.string() },
        implementation: safe(async ({ url }, ctx) => {
          if (!/^https?:\/\//i.test(url)) throw new ToolError("URL must start with http:// or https://");
          ctx.status(`Opening ${url}`);
          const page = await browserSession.getPage(channel, headless);
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          } catch (error: any) {
            throw new ToolError(`Navigation failed: ${String(error?.message ?? error).split("\n")[0]}`);
          }
          await browserSession.settle();
          return browserSession.snapshot(maxPageChars);
        }),
      }),
      tool({
        name: "browser_snapshot",
        description: "Get a fresh snapshot of the current browser page (after it changed, or to refresh element refs).",
        parameters: {},
        implementation: safe(async () => browserSession.snapshot(maxPageChars)),
      }),
      tool({
        name: "browser_click",
        description: "Click an element by its ref number from the latest snapshot. Returns the updated snapshot.",
        parameters: { ref: z.number().int().min(1) },
        implementation: safe(async ({ ref }) => {
          const element = await browserSession.locate(ref);
          try {
            await element.click({ timeout: 10_000 });
          } catch (error: any) {
            throw new ToolError(`Could not click [${ref}]: ${String(error?.message ?? error).split("\n")[0]}`);
          }
          await browserSession.settle();
          return browserSession.snapshot(maxPageChars);
        }),
      }),
      tool({
        name: "browser_type",
        description: text`
          Replace the text in an input/textarea (by ref from the latest snapshot). Set submit=true to
          press Enter afterwards (e.g. to run a search). For <select> elements, text is the option label.
        `,
        parameters: { ref: z.number().int().min(1), text: z.string(), submit: z.boolean().optional() },
        implementation: safe(async ({ ref, text: value, submit }) => {
          const element = await browserSession.locate(ref);
          try {
            const tag = await element.evaluate(el => el.tagName.toLowerCase());
            if (tag === "select") await element.selectOption({ label: value }, { timeout: 10_000 });
            else await element.fill(value, { timeout: 10_000 });
            if (submit) await element.press("Enter");
          } catch (error: any) {
            throw new ToolError(`Could not type into [${ref}]: ${String(error?.message ?? error).split("\n")[0]}`);
          }
          await browserSession.settle();
          return browserSession.snapshot(maxPageChars);
        }),
      }),
      tool({
        name: "browser_back",
        description: "Go back to the previous page in the browser history.",
        parameters: {},
        implementation: safe(async () => {
          await browserSession.requirePage().goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
          await browserSession.settle();
          return browserSession.snapshot(maxPageChars);
        }),
      }),
      tool({
        name: "browser_screenshot",
        description: "Save a PNG screenshot of the current page into the chat's working directory and return the file path.",
        parameters: { full_page: z.boolean().optional() },
        implementation: safe(async ({ full_page }) => {
          const page = browserSession.requirePage();
          const dir = join(ctl.getWorkingDirectory(), "screenshots");
          await mkdir(dir, { recursive: true });
          const file = join(dir, `screenshot-${Date.now()}.png`);
          await page.screenshot({ path: file, fullPage: full_page ?? false });
          return `Saved screenshot to ${file}`;
        }),
      }),
      tool({
        name: "browser_close",
        description: "Close the browser when you are done with it.",
        parameters: {},
        implementation: safe(async () => {
          await browserSession.close();
          return "Browser closed.";
        }),
      }),
    );
  }

  // Also published on their own as the feed-reader and video-transcripts plugins.
  tools.push(...makeReadFeedTools(), ...makeVideoTranscriptTools({ maxChars: maxPageChars }));

  tools.push(
    tool({
      name: "web_doctor",
      description: text`
        Check what the web tools can use on this machine: whether SearXNG answers, which browser is
        installed, whether yt-dlp is there for video transcripts, and whether a newer agent-toolkit
        is out. Run it when a web tool fails or is missing, and tell the user what it says to fix.
      `,
      parameters: {},
      implementation: safe(async () =>
        runWebDoctor({
          backend,
          searxngUrl: config.get("searxngUrl"),
          braveKeySet: ctl.getGlobalPluginConfig(globalConfigSchematics).get("braveApiKey").trim() !== "",
          browserEnabled: config.get("enableBrowser"),
          channel: config.get("browserChannel"),
          ytDlp: findExecutable("yt-dlp"),
        }),
      ),
    }),
  );

  return tools;
}
