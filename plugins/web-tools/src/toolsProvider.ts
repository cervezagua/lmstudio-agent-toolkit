import { text, tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { mkdir } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { configSchematics, globalConfigSchematics } from "./config";
import { browserSession, type BrowserChannel } from "./lib/browser";
import { fetchPage } from "./lib/fetchPage";
import { formatResults, runSearch, type SearchBackend } from "./lib/search";
import { safe, ToolError } from "./shared/errors";
import { truncate } from "./shared/truncate";

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
        Write specific queries; add a year for recent topics.
      `,
      parameters: { query: z.string().min(1), count: z.number().int().min(1).max(20).optional() },
      // ctx.status must be called as a method (it relies on `this`), so don't destructure it.
      implementation: safe(async ({ query, count }, ctx) => {
        const { signal } = ctx;
        ctx.status(`Searching (${backend}): ${query}`);
        const { results, note } = await runSearch({
          backend,
          query,
          count: count ?? config.get("maxSearchResults"),
          searxngUrl: config.get("searxngUrl"),
          braveApiKey: backend === "brave" ? ctl.getGlobalPluginConfig(globalConfigSchematics).get("braveApiKey") : "",
          signal,
        });
        if (note) ctx.warn(note);
        return note ? `${formatResults(results)}\n\n(${note})` : formatResults(results);
      }),
    }),
  );

  tools.push(
    tool({
      name: "fetch_url",
      description: text`
        Download a web page and return its main content as markdown. Also reads PDFs, plain text and
        JSON. Long documents are cut off: pass offset (characters already read) to continue where
        the previous call stopped, or a bigger max_chars.
        Pages that only render through JavaScript are retried automatically in the browser.
        Recent pages are cached for a few minutes; pass refresh to fetch again.
      `,
      parameters: {
        url: z.string(),
        max_chars: z.number().int().min(500).max(200000).optional(),
        offset: z.number().int().min(0).optional(),
        refresh: z.boolean().optional(),
      },
      implementation: safe(async ({ url, max_chars, offset, refresh }, ctx) => {
        ctx.status(`Fetching ${url}`);
        const page = await fetchPage(url, { signal: ctx.signal, refresh });
        let body = page.markdown.trim();
        let note = "";

        // A page that renders only through JavaScript arrives nearly empty; the browser can run it.
        if (body.length < 200 && page.kind === "html" && config.get("enableBrowser") && config.get("browserFallback")) {
          ctx.status("Page looks empty, retrying in the browser");
          try {
            const browserPage = await browserSession.getPage(config.get("browserChannel") as BrowserChannel, config.get("headless"));
            await browserPage.goto(page.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await browserSession.settle();
            body = await browserSession.snapshot(max_chars ?? maxPageChars);
            note = "\n(rendered in the browser because the plain page was empty)";
          } catch (error) {
            note = `\n(the page looks empty and the browser fallback failed: ${(error as Error).message})`;
          }
        }

        const start = offset ?? 0;
        if (start >= body.length && body.length > 0) {
          throw new ToolError(`offset ${start} is past the end of this document (${body.length} characters).`);
        }
        const limit = max_chars ?? maxPageChars;
        const slice = body.slice(start, start + limit);
        const more = start + slice.length < body.length ? `\n\n[${body.length - start - slice.length} characters left; call again with offset ${start + slice.length}]` : "";
        const header =
          `URL: ${page.url}\n` +
          (page.title ? `Title: ${page.title}\n` : "") +
          (page.kind === "pdf" ? "Type: PDF\n" : "") +
          (page.redirectedFrom ? `Redirected: ${page.redirectedFrom} -> ${new URL(page.url).host}\n` : "") +
          (page.fromCache ? "From cache (pass refresh to fetch again)\n" : "");
        return `${header}${note}\n${slice || "(no readable text)"}${more}`;
      }),
    }),
  );

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

  return tools;
}
