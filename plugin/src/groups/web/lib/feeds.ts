import { text, tool, type Tool } from "@lmstudio/sdk";
import { DOMParser, parseHTML } from "linkedom";
import { z } from "zod";
import { safe, ToolError } from "../../../shared/errors";

/**
 * RSS and Atom feeds. Self-contained so it can also ship as the standalone feed-reader plugin: it
 * imports only from shared/ and does its own small fetch.
 */

export interface FeedItem {
  title: string;
  link: string;
  date?: Date;
  summary: string;
}

export interface Feed {
  title: string;
  url: string;
  items: FeedItem[];
}

const MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; agent-toolkit feed reader)";

/** Plain text from a summary that may carry HTML, whether escaped or not. */
export function plainText(value: string, maxChars = 300): string {
  const stripped = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    // Feeds often escape their HTML twice, so tags can only appear once the entities are decoded.
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > maxChars ? `${stripped.slice(0, maxChars).trimEnd()}…` : stripped;
}

const textOf = (element: Element | null | undefined) => element?.textContent?.trim() ?? "";
const dateOf = (value: string) => {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
};

/** Parses RSS 2.0 or Atom. Returns null when the text is neither. */
export function parseFeed(xml: string, url: string): Feed | null {
  const document = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const root = document.documentElement;
  if (!root) return null;
  const name = root.tagName.toLowerCase();

  if (name === "rss" || name === "rdf:rdf") {
    const channel = root.querySelector("channel");
    const items = Array.from(root.querySelectorAll("item")).map(item => ({
      title: plainText(textOf(item.querySelector("title")), 200) || "(untitled)",
      link: textOf(item.querySelector("link")) || textOf(item.querySelector("guid")),
      date: dateOf(textOf(item.querySelector("pubDate")) || textOf(item.getElementsByTagName("dc:date")[0])),
      summary: plainText(textOf(item.querySelector("description"))),
    }));
    return { title: plainText(textOf(channel?.querySelector("title")), 200), url, items };
  }

  if (name === "feed") {
    const items = Array.from(root.querySelectorAll("entry")).map(entry => {
      const links = Array.from(entry.querySelectorAll("link"));
      const link = links.find(l => (l.getAttribute("rel") ?? "alternate") === "alternate") ?? links[0];
      return {
        title: plainText(textOf(entry.querySelector("title")), 200) || "(untitled)",
        link: link?.getAttribute("href") ?? "",
        date: dateOf(textOf(entry.querySelector("updated")) || textOf(entry.querySelector("published"))),
        summary: plainText(textOf(entry.querySelector("summary")) || textOf(entry.querySelector("content"))),
      };
    });
    const title = Array.from(root.children).find(child => child.tagName.toLowerCase() === "title");
    return { title: plainText(textOf(title), 200), url, items };
  }
  return null;
}

/** The feed a web page advertises with <link rel="alternate" type="application/rss+xml">, if any. */
export function discoverFeed(html: string, pageUrl: string): string | null {
  const { document } = parseHTML(html);
  const link = Array.from(document.querySelectorAll('link[rel~="alternate"]')).find(l =>
    /application\/(rss|atom)\+xml/i.test(l.getAttribute("type") ?? ""),
  );
  const href = link?.getAttribute("href");
  if (!href) return null;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}

async function download(url: string, signal?: AbortSignal): Promise<{ url: string; body: string; isHtml: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new ToolError(`"${url}" is not a valid URL. Include the scheme, e.g. https://example.com/feed`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ToolError("Only http and https feeds can be read.");
  if (parsed.username || parsed.password) throw new ToolError("URLs with a username or password are refused.");

  const signals = [AbortSignal.timeout(20_000), ...(signal ? [signal] : [])];
  let response: Response;
  try {
    response = await fetch(parsed.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.any(signals),
    });
  } catch (error: any) {
    if (error?.name === "TimeoutError") throw new ToolError(`Timed out fetching ${parsed.href}.`);
    throw new ToolError(`Could not fetch ${parsed.href}: ${error?.cause?.message ?? error?.message ?? error}`);
  }
  if (!response.ok) throw new ToolError(`HTTP ${response.status} ${response.statusText} for ${response.url || parsed.href}.`);

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new ToolError(`${parsed.href} is larger than 5 MB, which is not a feed.`);
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf-8");
  const type = response.headers.get("content-type") ?? "";
  const isHtml = /html/i.test(type) && !/xml/i.test(type) ? true : /^\s*(<!doctype html|<html)/i.test(body);
  return { url: response.url || parsed.href, body, isHtml };
}

/** Reads a feed, or the feed a web page points to. */
export async function readFeed(url: string, signal?: AbortSignal): Promise<Feed> {
  let page = await download(url, signal);
  if (page.isHtml) {
    const feedUrl = discoverFeed(page.body, page.url);
    if (!feedUrl) throw new ToolError(`${page.url} is a web page that does not link to an RSS or Atom feed.`);
    page = await download(feedUrl, signal);
  }
  const feed = parseFeed(page.body, page.url);
  if (!feed) throw new ToolError(`${page.url} is not an RSS or Atom feed.`);
  return feed;
}

export function renderFeed(feed: Feed, limit: number): string {
  const items = [...feed.items]
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
    .slice(0, limit);
  const header = `Feed: ${feed.title || "(untitled)"} (${feed.url}) — ${feed.items.length} items, showing ${items.length}`;
  if (items.length === 0) return `${header}\n(no items)`;
  return [
    header,
    ...items.map((item, index) =>
      [
        `${index + 1}. ${item.title}`,
        `   ${[item.date?.toISOString().slice(0, 10), item.link].filter(Boolean).join(" · ")}`,
        ...(item.summary ? [`   ${item.summary}`] : []),
      ].join("\n"),
    ),
  ].join("\n");
}

export function makeReadFeedTools(): Tool[] {
  return [
    tool({
      name: "read_feed",
      description: text`
        Read an RSS or Atom feed and list its latest items: title, date, link and a short summary.
        Accepts a feed URL, or a site's page that links to its feed. Use fetch_url on an item's link
        to read the full article.
      `,
      parameters: {
        url: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      implementation: safe(async ({ url, limit }, ctx) => {
        ctx.status(`Reading ${url}`);
        return renderFeed(await readFeed(url, ctx.signal), limit ?? 10);
      }),
    }),
  ];
}
