import { existsSync } from "fs";
import { mkdtemp, rm, stat } from "fs/promises";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { browserSession, formatSnapshot } from "./lib/browser";
import { clearFetchCache, fetchPage, htmlToMarkdown } from "./lib/fetchPage";
import { decodeDuckDuckGoUrl, formatResults, parseDuckDuckGoHtml, runSearch, searchSearxng } from "./lib/search";
import { ToolError } from "../../shared/errors";
import { toolsProvider } from "./toolsProvider";

const ARTICLE = `<!doctype html><html><head><title>Fallback Title</title><script>var x = 1;</script></head><body>
<nav><a href="/home">Home</a></nav>
<article>
  <h1>Understanding Widgets</h1>
  <p>${"Widgets are small components that do one thing well. ".repeat(12)}</p>
  <p>Read the <a href="/docs/guide">guide</a> or see <img src="data:image/png;base64,AAAA" alt="inline"> <img src="/img/chart.png" alt="Chart">.</p>
  <pre><code>npm install widgets</code></pre>
</article>
<footer>Copyright</footer>
</body></html>`;

const FORM_PAGE = `<!doctype html><html><head><title>Search Form</title></head><body>
<h1>Find things</h1>
<label for="q">Query</label><input id="q" name="q" value="">
<button id="go" onclick="document.getElementById('out').textContent = 'You searched: ' + document.getElementById('q').value">Go</button>
<a href="/next">Next page</a>
<div id="out"></div>
<button style="display:none">Hidden</button>
</body></html>`;

/** Builds a valid one-page PDF (with a correct xref table) containing the given text. */
function makePdf(content: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 12 Tf 20 100 Td (${content}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 20 100 Td (${content}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const MINIMAL_PDF = makePdf("Quarterly report text");

let server: Server;
let baseUrl: string;
/** Counts requests per path so the retry tests can assert how many attempts were made. */
const requestCounts = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    const path = req.url?.split("?")[0] ?? "";
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    switch (path) {
      case "/article":
        return send(200, "text/html; charset=utf-8", ARTICLE);
      case "/flaky": {
        // Fails twice with a retryable status, then succeeds.
        const attempts = requestCounts.get(path) ?? 0;
        if (attempts < 3) {
          res.writeHead(503, { "Content-Type": "text/plain", "Retry-After": "0" });
          return res.end("busy");
        }
        return send(200, "text/plain", "recovered");
      }
      case "/always-503":
        res.writeHead(503, { "Content-Type": "text/plain", "Retry-After": "0" });
        return res.end("still busy");
      case "/empty-js":
        return send(200, "text/html", "<html><head><title>App</title></head><body><div id=root></div></body></html>");
      case "/long":
        return send(200, "text/plain", "ABCDEFGHIJ".repeat(60)); // 600 characters
      case "/doc.pdf":
        return send(200, "application/pdf", MINIMAL_PDF);
      case "/form":
        return send(200, "text/html", FORM_PAGE);
      case "/next":
        return send(200, "text/html", "<html><head><title>Next</title></head><body><p>Second page</p></body></html>");
      case "/data.json":
        return send(200, "application/json", JSON.stringify({ ok: true }));
      case "/image.png":
        return send(200, "image/png", Buffer.from([137, 80, 78, 71]));
      case "/redirect":
        res.writeHead(302, { Location: "/article" });
        return res.end();
      case "/searx/search":
        return send(200, "application/json", JSON.stringify({ results: [{ title: " Result  One ", url: "https://one.example", content: "First" }] }));
      case "/nojson/search":
        return send(200, "text/html", "<html>json disabled</html>");
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await browserSession.close();
  await new Promise(resolve => server.close(resolve));
});

describe("search parsing", () => {
  it("parses DuckDuckGo HTML results, skipping ads", () => {
    const html = `<div class="result result--ad"><a class="result__a" href="https://ad.example">Ad</a></div>
      <div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x">Example   A</a></h2>
      <a class="result__snippet">Snippet <b>text</b></a></div>`;
    expect(parseDuckDuckGoHtml(html)).toEqual([{ title: "Example A", url: "https://example.com/a?b=1", snippet: "Snippet text" }]);
    expect(decodeDuckDuckGoUrl("https://plain.example/x")).toBe("https://plain.example/x");
  });

  it("queries SearXNG JSON and explains a disabled json format", async () => {
    expect(await searchSearxng(`${baseUrl}/searx`, "q", 5)).toEqual([{ title: "Result One", url: "https://one.example", snippet: "First" }]);
    await expect(searchSearxng(`${baseUrl}/nojson`, "q", 5)).rejects.toThrow(/Enable the json format/);
    await expect(searchSearxng("", "q", 5)).rejects.toThrow(/no SearXNG URL/);
  });

  it("auto uses SearXNG when reachable and falls back to DuckDuckGo with a note", async () => {
    const ddgResult = [{ title: "DDG", url: "https://ddg.example", snippet: "" }];
    const fakeDdg = async () => ddgResult;
    const failingDdg = async (): Promise<never> => {
      throw new ToolError("bot check");
    };
    const base = { backend: "auto" as const, query: "q", count: 5, braveApiKey: "" };

    expect(await runSearch({ ...base, searxngUrl: `${baseUrl}/searx` }, fakeDdg)).toEqual({
      results: [{ title: "Result One", url: "https://one.example", snippet: "First" }],
    });

    const fallback = await runSearch({ ...base, searxngUrl: "http://127.0.0.1:1" }, fakeDdg);
    expect(fallback.results).toEqual(ddgResult);
    expect(fallback.note).toMatch(/^SearXNG unavailable, used DuckDuckGo: Could not reach SearXNG at http:\/\/127\.0\.0\.1:1/);

    expect((await runSearch({ ...base, searxngUrl: "" }, fakeDdg)).note).toMatch(/no SearXNG URL is configured/);
    await expect(runSearch({ ...base, searxngUrl: `${baseUrl}/nojson` }, failingDdg)).rejects.toThrow(
      /No search backend worked\. SearXNG: .*json format.* DuckDuckGo: bot check/,
    );
  });

  it("formats results", () => {
    expect(formatResults([{ title: "T", url: "https://u", snippet: "S" }])).toBe("1. T\n   https://u\n   S");
    expect(formatResults([])).toBe("No results.");
  });
});

describe("page fetching", () => {
  beforeEach(() => clearFetchCache());

  it("extracts the article as markdown with absolute links and no inline images", () => {
    const { title, markdown } = htmlToMarkdown(ARTICLE, "https://site.example/blog/post");
    expect(title).toBe("Fallback Title");
    expect(markdown).toContain("Widgets are small components");
    expect(markdown).toContain("[guide](https://site.example/docs/guide)");
    expect(markdown).toContain("![Chart](https://site.example/img/chart.png)");
    expect(markdown).not.toContain("data:image");
    expect(markdown).not.toContain("var x");
    expect(markdown).toContain("```\nnpm install widgets\n```");
  });

  it("extracts text from a PDF", async () => {
    const page = await fetchPage(`${baseUrl}/doc.pdf`);
    expect(page.kind).toBe("pdf");
    expect(page.markdown).toContain("Quarterly report text");
    expect(page.markdown).toContain("--- page 1 of 1 ---");
  });

  it("retries retryable failures and gives up with a clear error", async () => {
    requestCounts.clear();
    const page = await fetchPage(`${baseUrl}/flaky`);
    expect(page.markdown).toBe("recovered");
    expect(requestCounts.get("/flaky")).toBe(3); // two failures, then success

    requestCounts.clear();
    await expect(fetchPage(`${baseUrl}/always-503`, { retries: 1 })).rejects.toThrow(/HTTP 503.*after 2 attempts/);
    expect(requestCounts.get("/always-503")).toBe(2);
  }, 30000);

  it("fetches html (following redirects), text, and rejects binary, 404s, and bad URLs", async () => {
    const page = await fetchPage(`${baseUrl}/redirect`);
    expect(page.url).toBe(`${baseUrl}/article`);
    expect(page.markdown).toContain("Widgets are small components");
    expect((await fetchPage(`${baseUrl}/data.json`)).markdown).toBe('{"ok":true}');
    await expect(fetchPage(`${baseUrl}/image.png`)).rejects.toThrow(/Cannot read image\/png/);
    await expect(fetchPage(`${baseUrl}/missing`)).rejects.toThrow(/HTTP 404/);
    await expect(fetchPage("not a url")).rejects.toThrow(/not a valid URL/);
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow(/Only http and https/);
    await expect(fetchPage("http://127.0.0.1:1/")).rejects.toThrow(/Could not fetch/);
  });
});

describe("formatSnapshot", () => {
  it("lists elements and page text", () => {
    const out = formatSnapshot(
      {
        title: "T",
        url: "https://u",
        text: "Hello",
        elements: [
          { ref: 1, role: "link", name: "Docs", href: "/docs" },
          { ref: 2, role: "textbox", name: "Search", value: "" },
          { ref: 3, role: "checkbox", name: "Remember", checked: true },
        ],
      },
      5000,
    );
    expect(out).toBe(
      'Title: T\nURL: https://u\n\nInteractive elements (pass the number as ref to browser_click / browser_type):\n' +
        '[1] link "Docs" -> /docs\n[2] textbox "Search" value=""\n[3] checkbox "Remember" (checked)\n\nPage text:\nHello',
    );
  });
});

const baseConfig = {
  searchBackend: "searxng",
  searxngUrl: "",
  maxSearchResults: 8,
  maxPageChars: 15000,
  browserFallback: false,
  enableBrowser: true,
  browserChannel: "msedge",
  headless: true,
};

describe("web-tools toolsProvider", () => {
  let workingDirectory: string;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "web-tools-"));
  });

  afterAll(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  const provider = (overrides: Record<string, unknown> = {}) =>
    toolsProvider(
      fakeController({
        config: { ...baseConfig, searxngUrl: `${baseUrl}/searx`, ...overrides },
        globalConfig: { braveApiKey: "" },
        workingDirectory,
      }),
    );

  it("registers tools and hides browser tools when disabled", async () => {
    expect((await provider()).map(t => t.name)).toEqual([
      "web_search",
      "fetch_url",
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_back",
      "browser_screenshot",
      "browser_close",
    ]);
    expect((await provider({ enableBrowser: false })).map(t => t.name)).toEqual(["web_search", "fetch_url"]);
  });

  it("searches and fetches through the tools", async () => {
    const tools = await provider();
    expect(await callTool(tools, "web_search", { query: "anything" })).toBe("1. Result One\n   https://one.example\n   First");
    const brave = await provider({ searchBackend: "brave" });
    expect(await callTool(brave, "web_search", { query: "x" })).toMatch(/^Error: .*no Brave API key/);
    const fetched = await callTool(tools, "fetch_url", { url: `${baseUrl}/article`, max_chars: 500 });
    expect(fetched).toMatch(/^URL: http:\/\/127\.0\.0\.1:\d+\/article\nTitle: Fallback Title\n\n/);
    expect(fetched).toMatch(/\[\d+ characters left; call again with offset 500\]$/);
  });

  it("pages through a long document with offset", async () => {
    const tools = await provider();
    const first = await callTool(tools, "fetch_url", { url: `${baseUrl}/long`, max_chars: 500 });
    expect(first).toContain("[100 characters left; call again with offset 500]");
    const second = await callTool(tools, "fetch_url", { url: `${baseUrl}/long`, max_chars: 500, offset: 500 });
    expect(second).not.toContain("characters left");
    expect(second.trimEnd().endsWith("ABCDEFGHIJ")).toBe(true);
    expect(await callTool(tools, "fetch_url", { url: `${baseUrl}/long`, offset: 9999 })).toMatch(/^Error: offset 9999 is past the end/);
  });

  const edgeInstalled =
    existsSync("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe") ||
    existsSync("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");

  it.runIf(edgeInstalled)(
    "drives a real browser: open, type, click, navigate, back, screenshot, close",
    async () => {
      const tools = await provider();
      expect(await callTool(tools, "browser_snapshot", {})).toBe("Error: No page is open. Use browser_open first.");

      const opened = await callTool(tools, "browser_open", { url: `${baseUrl}/form` });
      expect(opened).toContain("Title: Search Form");
      expect(opened).toContain('[1] textbox "Query" value=""');
      expect(opened).toContain('[2] button "Go"');
      expect(opened).toContain('[3] link "Next page" -> /next');
      expect(opened).not.toContain("Hidden");

      expect(await callTool(tools, "browser_type", { ref: 1, text: "lm studio" })).toContain('[1] textbox "Query" value="lm studio"');
      expect(await callTool(tools, "browser_click", { ref: 2 })).toContain("You searched: lm studio");
      expect(await callTool(tools, "browser_click", { ref: 99 })).toMatch(/^Error: Element \[99\] is not on the page/);

      expect(await callTool(tools, "browser_click", { ref: 3 })).toContain("Second page");
      expect(await callTool(tools, "browser_back", {})).toContain("Title: Search Form");

      const shot = await callTool(tools, "browser_screenshot", {});
      const file = shot.replace("Saved screenshot to ", "");
      expect((await stat(file)).size).toBeGreaterThan(1000);

      expect(await callTool(tools, "browser_close", {})).toBe("Browser closed.");
      expect(await callTool(tools, "browser_snapshot", {})).toMatch(/^Error: No page is open/);
    },
    60_000,
  );

  it.runIf(edgeInstalled)(
    "renders a JavaScript-only page in the browser when fetch_url comes back empty",
    async () => {
      const tools = await provider({ browserFallback: true });
      const result = await callTool(tools, "fetch_url", { url: `${baseUrl}/empty-js` });
      expect(result).toContain("rendered in the browser because the plain page was empty");
      expect(result).toContain("Title: App");
      await callTool(tools, "browser_close", {});
    },
    60_000,
  );
});

describe.runIf(process.env.LIVE_WEB === "1")("live network (LIVE_WEB=1)", () => {
  it("searches DuckDuckGo and fetches a real page", async () => {
    const tools = await toolsProvider(
      fakeController({
        config: { ...baseConfig, searchBackend: "duckduckgo", enableBrowser: false },
        globalConfig: { braveApiKey: "" },
        workingDirectory: tmpdir(),
      }),
    );
    const results = await callTool(tools, "web_search", { query: "LM Studio plugins documentation", count: 3 });
    console.log(results);
    expect(results).toMatch(/^(1\. |Error: DuckDuckGo refused)/);
    const page = await callTool(tools, "fetch_url", { url: "https://example.com" });
    expect(page).toContain("Example Domain");
  }, 60_000);
});

describe("fetch cache and URL checks", () => {
  beforeEach(() => clearFetchCache());

  it("serves a repeat fetch from cache, and refresh bypasses it", async () => {
    requestCounts.clear();
    const first = await fetchPage(`${baseUrl}/article`);
    expect(first.fromCache).toBeUndefined();
    expect(requestCounts.get("/article")).toBe(1);

    const second = await fetchPage(`${baseUrl}/article`);
    expect(second.fromCache).toBe(true);
    expect(second.markdown).toBe(first.markdown);
    expect(requestCounts.get("/article")).toBe(1); // no second request

    const forced = await fetchPage(`${baseUrl}/article`, { refresh: true });
    expect(forced.fromCache).toBeUndefined();
    expect(requestCounts.get("/article")).toBe(2);
  });

  it("refuses URLs with credentials or absurd length", async () => {
    await expect(fetchPage("https://user:secret@example.com/")).rejects.toThrow(/username or password/);
    await expect(fetchPage(`https://example.com/${"x".repeat(2100)}`)).rejects.toThrow(/over the 2048 character limit/);
  });

  it("reports a redirect that changes host", async () => {
    // A second server on another port counts as a different host, which is what we want to flag.
    const other = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("landed elsewhere");
    });
    await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
    const otherUrl = `http://127.0.0.1:${(other.address() as any).port}/`;

    const hop = createServer((_req, res) => {
      res.writeHead(302, { Location: otherUrl });
      res.end();
    });
    await new Promise<void>(resolve => hop.listen(0, "127.0.0.1", resolve));
    const hopUrl = `http://127.0.0.1:${(hop.address() as any).port}/`;

    try {
      const page = await fetchPage(hopUrl);
      expect(page.markdown).toBe("landed elsewhere");
      expect(page.redirectedFrom).toBe(new URL(hopUrl).host);
      // Same-host redirects stay quiet.
      expect((await fetchPage(`${baseUrl}/redirect`)).redirectedFrom).toBeUndefined();
    } finally {
      await new Promise(resolve => hop.close(resolve));
      await new Promise(resolve => other.close(resolve));
    }
  }, 30000);
});
