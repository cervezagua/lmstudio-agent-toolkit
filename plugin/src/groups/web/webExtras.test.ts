import { mkdtemp, rm } from "fs/promises";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { findExecutable } from "../../shared/process";
import { runWebDoctor } from "./lib/doctor";
import { discoverFeed, parseFeed, plainText, readFeed, renderFeed } from "./lib/feeds";
import { clearFetchCache, fetchPage, selectToMarkdown } from "./lib/fetchPage";
import { checkVideoUrl, fetchTranscript, formatDuration, makeVideoTranscriptTools, subtitleLanguages, vttToText } from "./lib/transcript";
import { toolsProvider } from "./toolsProvider";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Widget News</title>
<item><title>Older post</title><link>https://example.test/old</link><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Old &amp;amp; dusty&lt;/p&gt;</description></item>
<item><title>Newer post</title><link>https://example.test/new</link><pubDate>Tue, 30 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Fresh <b>news</b></p>]]></description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Log</title>
<entry><title>Entry one</title><link rel="alternate" href="https://example.test/one"/><updated>2026-09-10T00:00:00Z</updated><summary>First summary</summary></entry>
<entry><title>Entry two</title><link href="https://example.test/two"/><published>2026-09-20T00:00:00Z</published><content type="html">&lt;i&gt;Second&lt;/i&gt;</content></entry>
</feed>`;

const PAGE = `<!doctype html><html><head><title>Prices</title><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head><body>
<main><h1>Plans</h1><p>${"Intro text. ".repeat(40)}</p>
<table id="prices"><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>$5</td></tr></table>
<section class="note">First note</section><section class="note">Second note</section></main></body></html>`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    const path = req.url?.split("?")[0] ?? "";
    if (path === "/rss.xml") return send(200, "application/rss+xml", RSS);
    if (path === "/atom.xml") return send(200, "application/atom+xml; charset=utf-8", ATOM);
    if (path === "/page") return send(200, "text/html", PAGE);
    if (path === "/plain-page") return send(200, "text/html", "<!doctype html><html><body><p>No feed here</p></body></html>");
    if (path === "/notes.txt") return send(200, "text/plain", "just text");
    if (path === "/searx/search") return send(200, "application/json", '{"results":[]}');
    if (path === "/nojson/search") return send(403, "text/plain", "forbidden");
    send(404, "text/plain", "missing");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => clearFetchCache());

describe("feeds", () => {
  it("reads RSS, newest first, with plain-text summaries", async () => {
    const feed = await readFeed(`${baseUrl}/rss.xml`);
    expect(feed.title).toBe("Widget News");
    const text = renderFeed(feed, 10);
    expect(text.indexOf("Newer post")).toBeLessThan(text.indexOf("Older post"));
    expect(text).toContain("2026-09-30 · https://example.test/new");
    expect(text).toContain("Fresh news");
    expect(text).toContain("Old & dusty");
    expect(text).not.toContain("<p>");
  });

  it("reads Atom, including links without rel and HTML content", async () => {
    const feed = await readFeed(`${baseUrl}/atom.xml`);
    expect(feed.items.map(i => i.link)).toEqual(["https://example.test/one", "https://example.test/two"]);
    expect(renderFeed(feed, 1)).toContain("1. Entry two");
    expect(feed.items[1].summary).toBe("Second");
  });

  it("finds the feed a web page links to", async () => {
    expect(discoverFeed(PAGE, `${baseUrl}/page`)).toBe(`${baseUrl}/rss.xml`);
    expect((await readFeed(`${baseUrl}/page`)).title).toBe("Widget News");
  });

  it("explains a page without a feed, text that is no feed, and a bad URL", async () => {
    await expect(readFeed(`${baseUrl}/plain-page`)).rejects.toThrow(/does not link to an RSS or Atom feed/);
    await expect(readFeed(`${baseUrl}/notes.txt`)).rejects.toThrow(/is not an RSS or Atom feed/);
    await expect(readFeed("ftp://example.test/feed")).rejects.toThrow(/Only http and https/);
    await expect(readFeed(`${baseUrl}/missing`)).rejects.toThrow(/HTTP 404/);
  });

  it("trims long summaries and decodes entities", () => {
    expect(plainText("&lt;b&gt;bold&lt;/b&gt; &#169; &#x263A;")).toBe("bold © ☺");
    expect(plainText("word ".repeat(100), 20)).toMatch(/…$/);
    expect(parseFeed("<html><body>no</body></html>", "x")).toBeNull();
  });
});

describe("selector", () => {
  it("selects one element, or several, as markdown", () => {
    const table = selectToMarkdown(PAGE, `${baseUrl}/page`, "table#prices");
    expect(table.matches).toBe(1);
    expect(table.markdown).toContain("Basic");
    expect(table.markdown).not.toContain("Intro text");
    const notes = selectToMarkdown(PAGE, `${baseUrl}/page`, "section.note");
    expect(notes).toEqual({ matches: 2, markdown: "First note\n\n---\n\nSecond note" });
  });

  it("reports an invalid selector", () => {
    expect(() => selectToMarkdown(PAGE, "x", "table[[")).toThrow(/is not a valid CSS selector/);
  });

  describe("through fetch_url", () => {
    let workingDirectory: string;
    beforeAll(async () => {
      workingDirectory = await mkdtemp(join(tmpdir(), "web-extras-"));
    });
    afterAll(async () => {
      await rm(workingDirectory, { recursive: true, force: true });
    });
    const provider = () =>
      toolsProvider(
        fakeController({
          config: {
            searchBackend: "searxng",
            searxngUrl: "",
            safeSearch: "moderate",
            maxSearchResults: 8,
            maxPageChars: 15000,
            browserFallback: false,
            enableBrowser: false,
            browserChannel: "msedge",
            headless: true,
          },
          globalConfig: { braveApiKey: "" },
          workingDirectory,
        }),
      );

    it("returns only the selected part, from the cache too", async () => {
      const tools = await provider();
      const first = String(await callTool(tools, "fetch_url", { url: `${baseUrl}/page`, selector: "#prices" }));
      expect(first).toContain('(1 element matching "#prices")');
      expect(first).toContain("Basic");
      expect(first).not.toContain("Intro text");
      const cached = String(await callTool(tools, "fetch_url", { url: `${baseUrl}/page`, selector: "section.note" }));
      expect(cached).toContain("From cache");
      expect(cached).toContain("Second note");
    });

    it("says when nothing matches, and refuses non-HTML pages", async () => {
      const tools = await provider();
      expect(await callTool(tools, "fetch_url", { url: `${baseUrl}/page`, selector: ".absent" })).toMatch(/^Error: Nothing on .* matches/);
      expect(await callTool(tools, "fetch_url", { url: `${baseUrl}/notes.txt`, selector: "p" })).toMatch(/^Error: selector only works on web pages/);
    });

    it("keeps the page's HTML for selecting without fetching again", async () => {
      const page = await fetchPage(`${baseUrl}/page`);
      expect(page.html).toContain('id="prices"');
    });
  });
});

describe("transcripts", () => {
  it("turns WebVTT into plain text, collapsing rolling auto-captions", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "1",
      "00:00:00.000 --> 00:00:02.000 align:start position:0%",
      "hello<00:00:00.500><c> everyone</c>",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "hello everyone",
      "welcome to the &amp; show",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "welcome to the &amp; show",
      "<v Speaker>today we talk</v>",
    ].join("\r\n");
    expect(vttToText(vtt)).toBe("hello everyone\nwelcome to the & show\ntoday we talk");
  });

  it("refuses anything that is not a plain http(s) URL", () => {
    expect(checkVideoUrl(" https://www.youtube.com/watch?v=abc ")).toBe("https://www.youtube.com/watch?v=abc");
    expect(() => checkVideoUrl("--exec=calc")).toThrow(/not a URL/);
    expect(() => checkVideoUrl("file:///etc/passwd")).toThrow(/Only http and https/);
    expect(() => checkVideoUrl("https://user:pass@example.test/v")).toThrow(/username or password/);
    expect(() => checkVideoUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("asks for the language and its regional variants, and formats lengths", () => {
    expect(subtitleLanguages("EN")).toBe("en,en-.*,en.*");
    expect(subtitleLanguages("de;rm -rf")).toBe("derm-rf,derm-rf-.*,derm-rf.*");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(undefined)).toBe("");
  });

  it("is offered only where yt-dlp is installed", () => {
    const tools = makeVideoTranscriptTools({ maxChars: 1000 });
    expect(tools.map(t => t.name)).toEqual(findExecutable("yt-dlp") ? ["video_transcript"] : []);
  });

  it.runIf(process.env.LIVE_WEB === "1" && findExecutable("yt-dlp") !== null)("fetches a real transcript", async () => {
    const transcript = await fetchTranscript(findExecutable("yt-dlp")!, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    expect(transcript.title.length).toBeGreaterThan(0);
    expect(transcript.text.length).toBeGreaterThan(20);
  }, 120_000);
});

describe("web_doctor", () => {
  const base = { braveKeySet: false, browserEnabled: true, channel: "msedge", ytDlp: null, browserPath: () => "C:/browser.exe" };

  it("says whether SearXNG answers, and whether its JSON format is on", async () => {
    expect(await runWebDoctor({ ...base, backend: "auto", searxngUrl: `${baseUrl}/searx` })).toContain(`✓ SearXNG at ${baseUrl}/searx answers.`);
    expect(await runWebDoctor({ ...base, backend: "auto", searxngUrl: `${baseUrl}/nojson` })).toContain("JSON format switched off");
    expect(await runWebDoctor({ ...base, backend: "auto", searxngUrl: "http://127.0.0.1:9" })).toContain("is not reachable");
  });

  it("reports a Brave key as set or not, never the key", async () => {
    expect(await runWebDoctor({ ...base, backend: "brave", searxngUrl: "", braveKeySet: true })).toContain("with an API key set");
    expect(await runWebDoctor({ ...base, backend: "brave", searxngUrl: "", braveKeySet: false })).toContain("no API key is set");
  });

  it("explains a missing browser and a missing yt-dlp", async () => {
    const report = await runWebDoctor({ ...base, backend: "duckduckgo", searxngUrl: "", browserPath: () => null });
    expect(report).toContain("✗ Browser: Microsoft Edge was not found");
    expect(report).toContain("✗ yt-dlp is not installed");
  });
});
