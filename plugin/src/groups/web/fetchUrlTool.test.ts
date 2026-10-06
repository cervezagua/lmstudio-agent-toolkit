import { createServer, type Server } from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "../../shared/testing/fake-controller";
import { clearFetchCache } from "./lib/fetchPage";
import { makeFetchUrlTools, NEEDS_JAVASCRIPT_NOTE } from "./lib/fetchUrlTool";

const ARTICLE = `<!doctype html><html><head><title>Widgets</title></head><body><article><h1>Widgets</h1>
<p>${"Widgets are small components that do one thing well. ".repeat(12)}</p></article></body></html>`;
const EMPTY = "<html><head><title>App</title></head><body><div id=root></div></body></html>";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const found = req.url === "/article" ? ARTICLE : req.url === "/empty-js" ? EMPTY : null;
    res.writeHead(found ? 200 : 404, { "Content-Type": "text/html" });
    res.end(found ?? "missing");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => clearFetchCache());

const BROWSER_SENTENCE = "Pages that only render through JavaScript are retried automatically in the browser.";

describe("makeFetchUrlTools", () => {
  it("makes one tool, and only promises a browser retry when it has a browser", () => {
    const plain = makeFetchUrlTools({ maxChars: 15000 });
    expect(plain.map(t => t.name)).toEqual(["fetch_url"]);
    expect(plain[0].description).not.toContain("in the browser");

    const withBrowser = makeFetchUrlTools({ maxChars: 15000, renderInBrowser: async () => "" });
    expect(withBrowser[0].description).toContain(` ${BROWSER_SENTENCE} `);
    expect(withBrowser[0].description.replace(`${BROWSER_SENTENCE} `, "")).toBe(plain[0].description);
  });

  it("retries a nearly empty page through the callback, with the final URL and the size asked for", async () => {
    const calls: [string, number][] = [];
    const renderInBrowser = async (url: string, maxChars: number) => {
      calls.push([url, maxChars]);
      return "Title: App\n\nPage text:\nRendered by script";
    };
    const tools = makeFetchUrlTools({ maxChars: 15000, renderInBrowser });
    expect(await callTool(tools, "fetch_url", { url: `${baseUrl}/empty-js` })).toBe(
      `URL: ${baseUrl}/empty-js\nTitle: App\n\n(rendered in the browser because the plain page was empty)\n` +
        "Title: App\n\nPage text:\nRendered by script",
    );
    await callTool(tools, "fetch_url", { url: `${baseUrl}/empty-js`, max_chars: 800, refresh: true });
    expect(calls).toEqual([
      [`${baseUrl}/empty-js`, 15000],
      [`${baseUrl}/empty-js`, 800],
    ]);
  });

  it("leaves a page with content, or a selected part, to the plain fetch", async () => {
    let rendered = 0;
    const tools = makeFetchUrlTools({ maxChars: 15000, renderInBrowser: async () => `${++rendered}` });
    expect(await callTool(tools, "fetch_url", { url: `${baseUrl}/article` })).toContain("Widgets are small components");
    expect(await callTool(tools, "fetch_url", { url: `${baseUrl}/empty-js`, selector: "#root" })).toContain('(1 element matching "#root")');
    expect(rendered).toBe(0);
  });

  it("says so when the browser fails", async () => {
    const tools = makeFetchUrlTools({
      maxChars: 15000,
      renderInBrowser: async () => {
        throw new Error("no browser installed");
      },
    });
    expect(await callTool(tools, "fetch_url", { url: `${baseUrl}/empty-js` })).toBe(
      `URL: ${baseUrl}/empty-js\nTitle: App\n\n(the page looks empty and the browser fallback failed: no browser installed)\n(no readable text)`,
    );
  });

  it("without a browser returns the empty page as it is, or explains it when asked to", async () => {
    const silent = makeFetchUrlTools({ maxChars: 15000 });
    expect(await callTool(silent, "fetch_url", { url: `${baseUrl}/empty-js` })).toBe(`URL: ${baseUrl}/empty-js\nTitle: App\n\n(no readable text)`);

    const explaining = makeFetchUrlTools({ maxChars: 15000, explainEmptyPages: true });
    const result = await callTool(explaining, "fetch_url", { url: `${baseUrl}/empty-js`, refresh: true });
    expect(result).toBe(`URL: ${baseUrl}/empty-js\nTitle: App\n${NEEDS_JAVASCRIPT_NOTE}\n(no readable text)`);
    expect(result).toMatch(/needs JavaScript, which this plugin does not run/);
    expect(await callTool(explaining, "fetch_url", { url: `${baseUrl}/article` })).not.toContain("JavaScript");
  });
});
