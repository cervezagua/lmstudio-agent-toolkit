import { createServer, type Server } from "http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../../shared/errors";
import { callTool } from "../../shared/testing/fake-controller";
import { USER_AGENT } from "../../shared/userAgent";
import { checkLanguage, clearWikipediaCache, lookupWikipedia, makeWikipediaTools } from "./lib/wikipedia";

// A stand-in for the MediaWiki API on 127.0.0.1; nothing here reaches wikipedia.org.

const TURING_TEXT = `Alan Mathison Turing was an English mathematician and computer scientist.\n\n== Early life ==\n${"He studied at Cambridge. ".repeat(80)}`.trim();
const MERCURY_TEXT = "Mercury most commonly refers to:\n\nMercury (planet), the closest planet to the Sun\nMercury (element), a chemical element";

interface Seen {
  language: string;
  params: URLSearchParams;
  userAgent: string | undefined;
}

let server: Server;
let baseUrl: string;
const requests: Seen[] = [];

const SEARCHES: Record<string, unknown> = {
  "alan turing": {
    query: {
      searchinfo: { totalhits: 3 },
      search: [
        { title: "Alan Turing", snippet: '<span class="searchmatch">Alan</span> Mathison <span class="searchmatch">Turing</span> was an English mathematician' },
        { title: "Turing machine", snippet: 'A <span class="searchmatch">Turing</span> machine is a &quot;model&quot; of\n computation &amp; more' },
        { title: "Turing test", snippet: "" },
      ],
    },
  },
  colour: { query: { search: [{ title: "Colour", snippet: "Redirect" }] } },
  mercury: { query: { search: [{ title: "Mercury", snippet: "may refer to" }, { title: "Mercury (planet)", snippet: "The planet" }] } },
  "nothing here": { query: { searchinfo: { totalhits: 0 }, search: [] } },
  turnig: { query: { searchinfo: { totalhits: 0, suggestion: "turing" }, search: [] } },
  stub: { query: { search: [{ title: "Stub", snippet: "" }] } },
  refused: { error: { code: "ratelimited", info: "You've exceeded your rate limit." } },
};

const PAGES: Record<string, unknown> = {
  "Alan Turing": {
    query: { pages: { "1208": { pageid: 1208, title: "Alan Turing", extract: TURING_TEXT, canonicalurl: "https://en.wikipedia.org/wiki/Alan_Turing" } } },
  },
  // A redirect, answered without a canonical URL, and from a site that is not Wikipedia's.
  Colour: {
    query: {
      redirects: [{ from: "Colour", to: "Color" }],
      pages: { "5921": { pageid: 5921, title: "Color", extract: "Color is the visual perception of light.", canonicalurl: "https://evil.example/wiki/Color" } },
    },
  },
  Mercury: { query: { pages: [{ pageid: 1, title: "Mercury", extract: MERCURY_TEXT, canonicalurl: "https://en.wikipedia.org/wiki/Mercury" }] } },
  Stub: { query: { pages: { "-1": { title: "Stub", missing: "" } } } },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/([^/]+)\/w\/api\.php$/.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("missing");
    }
    const params = url.searchParams;
    requests.push({ language: match[1], params, userAgent: req.headers["user-agent"] });
    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (params.get("list") === "search") {
      const query = params.get("srsearch") ?? "";
      if (query === "boom") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("broken");
      }
      if (query === "busy") {
        res.writeHead(429, { "Content-Type": "text/plain" });
        return res.end("slow down");
      }
      if (query === "slow") return; // never answers
      if (query === "html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<html>a login page</html>");
      }
      if (query === "huge") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(`{"padding":"${"x".repeat(6 * 1024 * 1024)}"}`);
      }
      return json(SEARCHES[query.toLowerCase()] ?? { query: { search: [] } });
    }
    return json(PAGES[params.get("titles") ?? ""] ?? { query: { pages: {} } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  clearWikipediaCache();
  requests.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const apiBase = (language: string) => `${baseUrl}/${language}`;
const tools = (options: { maxChars?: number; timeoutMs?: number; apiBase?: (language: string) => string } = {}) =>
  makeWikipediaTools({ maxChars: 15000, apiBase, ...options });
const ask = (params: Record<string, unknown>, options?: Parameters<typeof tools>[0]) => callTool(tools(options), "wikipedia", params) as Promise<string>;

describe("wikipedia", () => {
  it("searches, then returns the best match as plain text with its title, URL and the other matches", async () => {
    const text = await ask({ query: "alan turing" });
    expect(text).toBe(
      `Title: Alan Turing\nURL: https://en.wikipedia.org/wiki/Alan_Turing\n\n${TURING_TEXT}\n\n` +
        "Other matches (ask again with the exact title):\n" +
        '- Turing machine: A Turing machine is a "model" of computation & more\n' +
        "- Turing test",
    );

    expect(requests).toHaveLength(2);
    const [search, extract] = requests;
    expect(search.language).toBe("en");
    expect(Object.fromEntries(search.params)).toEqual({ action: "query", list: "search", srsearch: "alan turing", srlimit: "5", format: "json" });
    expect(extract.language).toBe("en");
    expect(Object.fromEntries(extract.params)).toEqual({
      action: "query",
      prop: "extracts|info",
      explaintext: "1",
      redirects: "1",
      inprop: "url",
      titles: "Alan Turing",
      format: "json",
    });
  });

  it("sends the toolkit's honest User-Agent with every request", async () => {
    await ask({ query: "alan turing" });
    expect(requests.map(request => request.userAgent)).toEqual([USER_AGENT, USER_AGENT]);
    expect(USER_AGENT).toContain("lmstudio-web-tools");
  });

  it("asks the Wikipedia of the given language", async () => {
    await ask({ query: "alan turing", language: "de" });
    await ask({ query: "alan turing", language: " ZH-Yue " });
    expect(requests.map(request => request.language)).toEqual(["de", "de", "zh-yue", "zh-yue"]);
  });

  it("refuses anything that is not a language code, without a request", async () => {
    for (const language of ["english", "e", "en_US", "en.evil.example", "../../etc", "en/", "en wiki", "-en", "en-", "e1"]) {
      expect(await ask({ query: "alan turing", language })).toMatch(/^Error: ".*" is not a Wikipedia language code\. Use one such as en, de, pt or zh-yue\.$/s);
    }
    expect(requests).toHaveLength(0);
    expect(checkLanguage(undefined)).toBe("en");
    expect(checkLanguage(" ")).toBe("en");
    expect(checkLanguage("pt")).toBe("pt");
    expect(checkLanguage("zh-min-nan")).toBe("zh-min-nan");
    expect(() => checkLanguage("en.evil.example")).toThrow(ToolError);
  });

  it("only ever talks to https://<language>.wikipedia.org when no test server is injected", async () => {
    const asked: Array<{ url: string; userAgent: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: RequestInit) => {
      asked.push({ url: String(url), userAgent: new Headers(init?.headers).get("user-agent") });
      return Response.json({ query: { search: [] } });
    });
    const real = makeWikipediaTools({ maxChars: 15000 });
    expect(await callTool(real, "wikipedia", { query: "anything at all", language: "pt" })).toMatch(/^No article found on pt\.wikipedia\.org/);
    expect(await callTool(real, "wikipedia", { query: "anything at all" })).toMatch(/^No article found on en\.wikipedia\.org/);
    expect(asked.map(request => request.url.split("?")[0])).toEqual(["https://pt.wikipedia.org/w/api.php", "https://en.wikipedia.org/w/api.php"]);
    expect(asked.every(request => request.userAgent === USER_AGENT)).toBe(true);
  });

  it("pages through a long article with offset and max_chars, in fetch_url's words", async () => {
    const first = await ask({ query: "alan turing", max_chars: 500 });
    expect(first.startsWith(`Title: Alan Turing\nURL: https://en.wikipedia.org/wiki/Alan_Turing\n\n${TURING_TEXT.slice(0, 500)}\n\n`)).toBe(true);
    expect(first).toContain(`\n\n[${TURING_TEXT.length - 500} characters left; call again with offset 500]\n\nOther matches`);

    const second = await ask({ query: "alan turing", max_chars: 500, offset: 500 });
    expect(second).toBe(
      `Title: Alan Turing\nURL: https://en.wikipedia.org/wiki/Alan_Turing\n\n${TURING_TEXT.slice(500, 1000)}\n\n` +
        `[${TURING_TEXT.length - 1000} characters left; call again with offset 1000]`,
    );

    const last = await ask({ query: "alan turing", offset: TURING_TEXT.length - 10 });
    expect(last).toBe(`Title: Alan Turing\nURL: https://en.wikipedia.org/wiki/Alan_Turing\n\n${TURING_TEXT.slice(-10)}`);

    expect(await ask({ query: "alan turing", offset: 99999 })).toBe(
      `Error: offset 99999 is past the end of this document (${TURING_TEXT.length} characters).`,
    );
  });

  it("cuts at the configured page size unless max_chars is passed", async () => {
    const text = await ask({ query: "alan turing" }, { maxChars: 600 });
    expect(text).toContain(`[${TURING_TEXT.length - 600} characters left; call again with offset 600]`);
    expect(await ask({ query: "alan turing", max_chars: 5000 }, { maxChars: 600 })).not.toContain("characters left");
  });

  it("says plainly when nothing was found, which is not an error", async () => {
    expect(await ask({ query: "nothing here" })).toBe('No article found on en.wikipedia.org for "nothing here". Try other words, or another language.');
    expect(await ask({ query: "turnig", language: "de" })).toBe('No article found on de.wikipedia.org for "turnig". Did you mean "turing"?');
    // One search each, and no article request.
    expect(requests.map(request => request.params.get("list"))).toEqual(["search", "search"]);
  });

  it("follows a redirect and says so, linking to the real Wikipedia whatever the answer claims", async () => {
    expect(await ask({ query: "colour" })).toBe(
      "Title: Color\nURL: https://en.wikipedia.org/wiki/Color\nRedirected: Colour -> Color\n\nColor is the visual perception of light.",
    );
    expect(requests[1].params.get("redirects")).toBe("1");
  });

  it("returns a disambiguation page as it is", async () => {
    expect(await ask({ query: "mercury" })).toBe(
      `Title: Mercury\nURL: https://en.wikipedia.org/wiki/Mercury\n\n${MERCURY_TEXT}\n\nOther matches (ask again with the exact title):\n- Mercury (planet): The planet`,
    );
  });

  it("copes with a match that has no text", async () => {
    expect(await ask({ query: "stub" })).toBe("Title: Stub\nURL: https://en.wikipedia.org/wiki/Stub\n\n(no readable text)");
  });

  it("reports HTTP errors, API errors and answers that are not JSON", async () => {
    expect(await ask({ query: "boom" })).toMatch(/^Error: Wikipedia \(127\.0\.0\.1:\d+\) answered HTTP 500 Internal Server Error\.$/);
    expect(await ask({ query: "busy" })).toMatch(/^Error: Wikipedia \(127\.0\.0\.1:\d+\) answered HTTP 429 Too Many Requests \(too many requests; wait a little before trying again\)\.$/);
    expect(await ask({ query: "refused" })).toMatch(/^Error: Wikipedia \(127\.0\.0\.1:\d+\) refused the request: You've exceeded your rate limit\.$/);
    expect(await ask({ query: "html" })).toMatch(/^Error: Wikipedia \(127\.0\.0\.1:\d+\) did not answer with JSON\.$/);
  });

  it("reports a network failure", async () => {
    const text = await ask({ query: "alan turing" }, { apiBase: () => "http://127.0.0.1:9" });
    expect(text).toMatch(/^Error: Could not reach Wikipedia \(127\.0\.0\.1:9\): .+\. Check the connection and the language code\.$/);
  });

  it("gives up after the timeout", async () => {
    const started = Date.now();
    expect(await ask({ query: "slow" }, { timeoutMs: 200 })).toMatch(/^Error: Timed out after 0\.2 s waiting for Wikipedia \(127\.0\.0\.1:\d+\)\.$/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops when the call is cancelled", async () => {
    const abort = new AbortController();
    const pending = lookupWikipedia("slow", "en", { apiBase, signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toThrow(ToolError);
    await expect(lookupWikipedia("slow", "en", { apiBase, signal: abort.signal })).rejects.toThrow("The Wikipedia request was cancelled.");
  });

  it("refuses an answer over the size cap", async () => {
    expect(await ask({ query: "huge" })).toBe("Error: Wikipedia's answer is larger than 5 MB, which is more than this tool reads.");
  });

  it("answers from the cache for ten minutes, making no second request", async () => {
    const first = await ask({ query: "alan turing", max_chars: 500 });
    expect(requests).toHaveLength(2);

    // The same query, however it is typed, and the next part of the same article.
    expect(await ask({ query: "  Alan Turing ", max_chars: 500 })).toBe(first);
    expect(await ask({ query: "alan turing", max_chars: 500, offset: 500 })).toContain(TURING_TEXT.slice(500, 1000));
    expect(requests).toHaveLength(2);
    expect((await lookupWikipedia("alan turing", "en", { apiBase })).fromCache).toBe(true);

    // Another language is another article.
    await ask({ query: "alan turing", language: "de" });
    expect(requests).toHaveLength(4);

    // "Nothing found" is remembered too.
    await ask({ query: "nothing here" });
    await ask({ query: "nothing here" });
    expect(requests).toHaveLength(5);

    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 9 * 60 * 1000);
    await ask({ query: "alan turing" });
    expect(requests).toHaveLength(5);
    vi.spyOn(Date, "now").mockReturnValue(realNow + 11 * 60 * 1000);
    expect(await ask({ query: "alan turing", max_chars: 500 })).toBe(first);
    expect(requests).toHaveLength(7);
  });

  it("does not remember a failure", async () => {
    expect(await ask({ query: "boom" })).toMatch(/^Error: /);
    expect(await ask({ query: "boom" })).toMatch(/^Error: /);
    expect(requests).toHaveLength(2);
  });
});
