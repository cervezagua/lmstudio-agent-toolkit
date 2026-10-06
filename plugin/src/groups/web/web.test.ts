import { existsSync } from "fs";
import { mkdtemp, rm, stat } from "fs/promises";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { browserSession, formatSnapshot } from "./lib/browser";
import { clearFetchCache, fetchPage, htmlToMarkdown } from "./lib/fetchPage";
import {
  braveSearchUrl,
  clearSearchState,
  decodeDuckDuckGoUrl,
  duckDuckGoForm,
  formatResults,
  parseDuckDuckGoHtml,
  runSearch,
  searchBrave,
  searchDuckDuckGo,
  searchSearxng,
  type DuckDuckGoDeps,
  type SafeSearch,
  type SearchOptions,
} from "./lib/search";
import { ToolError } from "../../shared/errors";
import { findExecutable } from "../../shared/process";
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
/** The query string of the latest request per path, for checking what a search backend was asked. */
const lastQueries = new Map<string, URLSearchParams>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    const path = req.url?.split("?")[0] ?? "";
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    lastQueries.set(path, new URLSearchParams(req.url?.split("?")[1] ?? ""));
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
  beforeEach(() => clearSearchState());

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
    expect(formatResults([{ title: "T", url: "https://u", snippet: "" }], 2)).toBe("Page 2\n\n1. T\n   https://u");
    expect(formatResults([], 3)).toBe("No results on page 3.");
  });
});

const DDG_OK = { status: 200, html: `<div class="result"><a class="result__a" href="https://example.com/a">A</a></div>` };
const DDG_REFUSED = { status: 202, html: "<html><form action='/anomaly.js'></form></html>" };

/** A DuckDuckGo that answers from a script, on a clock that only moves when the code sleeps or the test says so. */
function fakeDuckDuckGo(answers: Array<"ok" | "refused"> = []) {
  const state = { t: 1_000_000, starts: [] as number[], sleeps: [] as number[], asked: [] as SafeSearch[] };
  const deps: DuckDuckGoDeps = {
    now: () => state.t,
    sleep: async ms => {
      state.sleeps.push(ms);
      state.t += ms;
    },
    request: async (_query, safeSearch) => {
      state.starts.push(state.t);
      state.asked.push(safeSearch);
      return (answers.shift() ?? "ok") === "ok" ? DDG_OK : DDG_REFUSED;
    },
  };
  const search = (query = "q", safeSearch?: SafeSearch) => searchDuckDuckGo(query, 5, { safeSearch }, deps);
  return { state, deps, search };
}

describe("DuckDuckGo pacing", () => {
  beforeEach(() => clearSearchState());

  it("leaves two seconds between the starts of consecutive requests", async () => {
    const { state, search } = fakeDuckDuckGo();
    expect(await search()).toEqual([{ title: "A", url: "https://example.com/a", snippet: "" }]);
    await search();
    expect(state.starts).toEqual([1_000_000, 1_002_000]);
    state.t += 500;
    await search();
    expect(state.sleeps).toEqual([2000, 1500]);
    state.t += 5000; // long enough ago: no wait
    await search();
    expect(state.sleeps).toEqual([2000, 1500]);
    expect(state.starts).toHaveLength(4);
  });

  it("queues concurrent searches instead of firing them together", async () => {
    const { state, search } = fakeDuckDuckGo();
    await Promise.all([search("a"), search("b"), search("c")]);
    expect(state.starts).toEqual([1_000_000, 1_002_000, 1_004_000]);
  });

  it("retries a bot check once, four seconds later", async () => {
    const { state, search } = fakeDuckDuckGo(["refused", "ok"]);
    expect(await search()).toHaveLength(1);
    expect(state.starts).toEqual([1_000_000, 1_004_000]);
    expect(state.sleeps).toEqual([4000]);
  });

  it("stops asking for two minutes after a refusal that survives the retry", async () => {
    const { state, deps, search } = fakeDuckDuckGo(["refused", "refused"]);
    const refusal: Error = await search().catch(error => error);
    expect(refusal).toBeInstanceOf(ToolError);
    expect(refusal.message).toMatch(/refusing automated searches\. Do not retry web_search for about 2 minutes/);
    expect(refusal.message).toContain("SearXNG or a Brave API key in the plugin's Web settings");
    expect(refusal.message).not.toContain("web-tools");
    expect(state.starts).toHaveLength(2);

    // Cooling down: an error straight away, and nothing sent.
    state.t += 61_000;
    await expect(search()).rejects.toThrow(/Do not retry web_search for about 1 minute:/);
    const viaAuto = runSearch({ backend: "auto", query: "other", count: 5, searxngUrl: "", braveApiKey: "" }, (q, c, o) =>
      searchDuckDuckGo(q, c, o, deps),
    );
    await expect(viaAuto).rejects.toThrow(/No search backend worked\..* DuckDuckGo: DuckDuckGo is refusing automated searches/);
    expect(state.starts).toHaveLength(2);
    expect(state.sleeps).toEqual([4000]);

    state.t += 59_000; // two minutes after the refusal
    expect(await search()).toHaveLength(1);
    expect(state.starts).toHaveLength(3);
  });

  it("sends the safe-search level as kp", async () => {
    expect(new URLSearchParams(duckDuckGoForm("cats", "strict")).get("kp")).toBe("1");
    expect(new URLSearchParams(duckDuckGoForm("cats", "moderate")).get("kp")).toBe("-1");
    expect(new URLSearchParams(duckDuckGoForm("cats", "off")).get("kp")).toBe("-2");
    expect(duckDuckGoForm("a b")).toBe("q=a+b&kp=-1");

    const { state, deps } = fakeDuckDuckGo();
    await runSearch({ backend: "duckduckgo", query: "q", count: 5, safeSearch: "strict", searxngUrl: "", braveApiKey: "" }, (q, c, o) =>
      searchDuckDuckGo(q, c, o, deps),
    );
    expect(state.asked).toEqual(["strict"]);
  });
});

describe("search cache, pages and safe search", () => {
  beforeEach(() => clearSearchState());

  const ddgResult = [{ title: "DDG", url: "https://ddg.example", snippet: "" }];
  const counting = () => {
    const calls: string[] = [];
    const ddg = async (query: string) => {
      calls.push(query);
      return ddgResult;
    };
    return { calls, ddg };
  };
  const ddgOptions: SearchOptions = { backend: "duckduckgo", query: "q", count: 5, searxngUrl: "", braveApiKey: "" };

  it("answers a repeated search from the cache for ten minutes, and says so", async () => {
    const { calls, ddg } = counting();
    let t = 0;
    const now = () => t;
    expect(await runSearch({ ...ddgOptions, query: "Some Query" }, ddg, now)).toEqual({ results: ddgResult });
    t += 9 * 60_000;
    expect(await runSearch({ ...ddgOptions, query: "  some query " }, ddg, now)).toEqual({ results: ddgResult, note: "cached", cached: true });
    expect(calls).toHaveLength(1);
    t += 61_000; // ten minutes after the first answer
    expect((await runSearch({ ...ddgOptions, query: "some query" }, ddg, now)).cached).toBeUndefined();
    expect(calls).toHaveLength(2);

    // A fallback keeps its own note.
    const auto = { ...ddgOptions, backend: "auto" as const };
    await runSearch(auto, ddg, now);
    expect((await runSearch(auto, ddg, now)).note).toBe("SearXNG unavailable, used DuckDuckGo: no SearXNG URL is configured; cached");
    expect(calls).toHaveLength(3);
  });

  it("keeps pages, safe-search levels, counts and backends apart", async () => {
    const { calls, ddg } = counting();
    await runSearch(ddgOptions, ddg);
    await runSearch({ ...ddgOptions, safeSearch: "strict" }, ddg);
    await runSearch({ ...ddgOptions, count: 6 }, ddg);
    expect(calls).toHaveLength(3);
    expect((await runSearch({ ...ddgOptions, safeSearch: "moderate", page: 1 }, ddg)).cached).toBe(true); // the defaults
    expect(calls).toHaveLength(3);

    requestCounts.clear();
    const searxng = { ...ddgOptions, backend: "searxng" as const, searxngUrl: `${baseUrl}/searx` };
    expect((await runSearch(searxng, ddg)).cached).toBeUndefined();
    expect((await runSearch({ ...searxng, page: 2 }, ddg)).cached).toBeUndefined();
    expect(requestCounts.get("/searx/search")).toBe(2);
    expect((await runSearch({ ...searxng, page: 2 }, ddg)).cached).toBe(true);
    expect(requestCounts.get("/searx/search")).toBe(2);
    expect(calls).toHaveLength(3);
  });

  it("keeps at most 50 answers, dropping the oldest", async () => {
    const { calls, ddg } = counting();
    for (let i = 0; i <= 50; i++) await runSearch({ ...ddgOptions, query: `query ${i}` }, ddg);
    expect(calls).toHaveLength(51);
    expect((await runSearch({ ...ddgOptions, query: "query 50" }, ddg)).cached).toBe(true);
    expect((await runSearch({ ...ddgOptions, query: "query 1" }, ddg)).cached).toBe(true);
    expect((await runSearch({ ...ddgOptions, query: "query 0" }, ddg)).cached).toBeUndefined(); // was dropped
    expect(calls).toHaveLength(52);
  });

  it("does not cache an empty answer or an error", async () => {
    let answers = 0;
    const empty = async () => {
      answers++;
      return [];
    };
    await runSearch(ddgOptions, empty);
    expect((await runSearch(ddgOptions, empty)).cached).toBeUndefined();
    expect(answers).toBe(2);
  });

  it("asks SearXNG and Brave for the page and safe-search level", async () => {
    await searchSearxng(`${baseUrl}/searx`, "q", 5);
    expect(Object.fromEntries(lastQueries.get("/searx/search")!)).toEqual({ q: "q", format: "json", pageno: "1", safesearch: "1" });
    await searchSearxng(`${baseUrl}/searx`, "q", 5, { page: 3, safeSearch: "strict" });
    expect(lastQueries.get("/searx/search")!.get("pageno")).toBe("3");
    expect(lastQueries.get("/searx/search")!.get("safesearch")).toBe("2");
    await searchSearxng(`${baseUrl}/searx`, "q", 5, { safeSearch: "off" });
    expect(lastQueries.get("/searx/search")!.get("safesearch")).toBe("0");

    const first = braveSearchUrl("q", 5).searchParams;
    expect(first.get("offset")).toBeNull();
    expect(first.get("safesearch")).toBe("moderate");
    const third = braveSearchUrl("q", 5, 3, "strict").searchParams;
    expect(third.get("offset")).toBe("2");
    expect(third.get("safesearch")).toBe("strict");
    expect(braveSearchUrl("q", 5, 10, "off").searchParams.get("offset")).toBe("9");
    expect(braveSearchUrl("q", 5, 10, "off").searchParams.get("safesearch")).toBe("off");
    // Refused before any request is made.
    await expect(searchBrave("key", "q", 5, { page: 11 })).rejects.toThrow(/at most 10 pages/);
  });

  it("explains that DuckDuckGo has no second page", async () => {
    const { calls, ddg } = counting();
    const onePage = /DuckDuckGo only gives the first page.*SearXNG or a Brave API key.*more specific query/;
    await expect(runSearch({ ...ddgOptions, page: 2 }, ddg)).rejects.toThrow(onePage);
    await expect(runSearch({ ...ddgOptions, backend: "auto", page: 2 }, ddg)).rejects.toThrow(onePage);
    await expect(runSearch({ ...ddgOptions, backend: "auto", page: 2, searxngUrl: "http://127.0.0.1:1" }, ddg)).rejects.toThrow(onePage);
    expect(calls).toHaveLength(0);

    // With SearXNG up, auto pages through it.
    expect((await runSearch({ ...ddgOptions, backend: "auto", page: 2, searxngUrl: `${baseUrl}/searx` }, ddg)).results).toHaveLength(1);
    expect(lastQueries.get("/searx/search")!.get("pageno")).toBe("2");
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
  safeSearch: "moderate",
  maxSearchResults: 8,
  maxPageChars: 15000,
  browserFallback: false,
  enableBrowser: true,
  browserChannel: "msedge",
  headless: true,
};

describe("web-tools toolsProvider", () => {
  beforeEach(() => clearSearchState());

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
    // video_transcript is only offered where yt-dlp is installed.
    const transcript = findExecutable("yt-dlp") ? ["video_transcript"] : [];
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
      "read_feed",
      ...transcript,
      "web_doctor",
    ]);
    expect((await provider({ enableBrowser: false })).map(t => t.name)).toEqual([
      "web_search",
      "fetch_url",
      "read_feed",
      ...transcript,
      "web_doctor",
    ]);
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

  it("passes page and the Safe Search setting to the search, and marks a cached answer", async () => {
    const tools = await provider({ safeSearch: "strict" });
    requestCounts.clear();
    expect(await callTool(tools, "web_search", { query: "anything", page: 2 })).toBe("Page 2\n\n1. Result One\n   https://one.example\n   First");
    expect(lastQueries.get("/searx/search")!.get("pageno")).toBe("2");
    expect(lastQueries.get("/searx/search")!.get("safesearch")).toBe("2");
    expect(await callTool(tools, "web_search", { query: "Anything", page: 2 })).toBe(
      "Page 2\n\n1. Result One\n   https://one.example\n   First\n\n(cached)",
    );
    expect(requestCounts.get("/searx/search")).toBe(1);

    const ddg = await provider({ searchBackend: "duckduckgo" });
    expect(await callTool(ddg, "web_search", { query: "anything", page: 2 })).toMatch(/^Error: DuckDuckGo only gives the first page/);
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
