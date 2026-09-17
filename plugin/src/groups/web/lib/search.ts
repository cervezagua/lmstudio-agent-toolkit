import { parseHTML } from "linkedom";
import { ToolError } from "../../../shared/errors";
import { USER_AGENT } from "./fetchPage";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** DuckDuckGo's HTML endpoint wraps result links in a redirect; unwrap to the real URL. */
export function decodeDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.href;
  } catch {
    return href;
  }
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const result of Array.from(document.querySelectorAll(".result"))) {
    if (result.classList.contains("result--ad")) continue;
    const link = result.querySelector("a.result__a");
    if (!link) continue;
    const url = decodeDuckDuckGoUrl(link.getAttribute("href") ?? "");
    if (!/^https?:/.test(url)) continue;
    results.push({ title: clean(link.textContent), url, snippet: clean(result.querySelector(".result__snippet")?.textContent) });
  }
  return results;
}

async function getJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new ToolError(`Search request failed: HTTP ${response.status} ${response.statusText}. ${body}`);
  }
  return response.json();
}

export async function searchDuckDuckGo(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  const html = await response.text();
  const results = parseDuckDuckGoHtml(html);
  if (results.length === 0 && (response.status !== 200 || /anomaly|captcha|challenge/i.test(html))) {
    throw new ToolError(
      "DuckDuckGo refused the request (rate limit or bot check). Wait and retry later, or ask the user to " +
        "configure a SearXNG instance or a Brave API key in the web-tools plugin settings.",
    );
  }
  return results.slice(0, count);
}

export async function searchSearxng(baseUrl: string, query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!baseUrl.trim()) throw new ToolError("Search backend is searxng but no SearXNG URL is configured in the plugin settings.");
  let url: URL;
  try {
    url = new URL("search", baseUrl.trim().replace(/\/?$/, "/"));
  } catch {
    throw new ToolError(`SearXNG URL "${baseUrl}" is not a valid URL.`);
  }
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  // SearXNG queries several engines itself, so allow it a while, but never hang the chat.
  const timeout = AbortSignal.timeout(20_000);
  const data = await getJson(url.href, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(error => {
    if (error instanceof ToolError) throw error;
    if (error instanceof SyntaxError) {
      throw new ToolError("SearXNG did not return JSON. Enable the json format under search.formats in its settings.yml.");
    }
    if (error?.name === "TimeoutError") throw new ToolError(`SearXNG at ${url.origin} did not answer within 20 seconds.`);
    throw new ToolError(`Could not reach SearXNG at ${url.origin} (${error?.cause?.code ?? error?.message ?? error}).`);
  });
  return (data.results ?? [])
    .slice(0, count)
    .map((r: any) => ({ title: clean(r.title), url: String(r.url), snippet: clean(r.content) }));
}

export async function searchBrave(apiKey: string, query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!apiKey.trim()) throw new ToolError("Search backend is brave but no Brave API key is set in the plugin's global settings.");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  const data = await getJson(url.href, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey.trim() },
    signal,
  });
  const strip = (s: string) => clean(s?.replace(/<[^>]+>/g, ""));
  return (data.web?.results ?? []).slice(0, count).map((r: any) => ({
    title: strip(r.title),
    url: String(r.url),
    snippet: strip(r.description),
  }));
}

export type SearchBackend = "auto" | "searxng" | "duckduckgo" | "brave";

export interface SearchOptions {
  backend: SearchBackend;
  query: string;
  count: number;
  searxngUrl: string;
  braveApiKey: string;
  signal?: AbortSignal;
}

/**
 * Runs a search on the configured backend. `auto` prefers SearXNG and falls back to DuckDuckGo if
 * SearXNG is not configured or fails; the returned note says so, so the model and user know.
 */
export async function runSearch(
  options: SearchOptions,
  duckDuckGo: typeof searchDuckDuckGo = searchDuckDuckGo, // injectable so tests stay offline
): Promise<{ results: SearchResult[]; note?: string }> {
  const { backend, query, count, signal } = options;
  switch (backend) {
    case "searxng":
      return { results: await searchSearxng(options.searxngUrl, query, count, signal) };
    case "brave":
      return { results: await searchBrave(options.braveApiKey, query, count, signal) };
    case "duckduckgo":
      return { results: await duckDuckGo(query, count, signal) };
    case "auto": {
      let searxngProblem = "no SearXNG URL is configured";
      if (options.searxngUrl.trim()) {
        try {
          return { results: await searchSearxng(options.searxngUrl, query, count, signal) };
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          searxngProblem = error.message;
        }
      }
      try {
        return { results: await duckDuckGo(query, count, signal), note: `SearXNG unavailable, used DuckDuckGo: ${searxngProblem}` };
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        throw new ToolError(`No search backend worked. SearXNG: ${searxngProblem} DuckDuckGo: ${error.message}`);
      }
    }
  }
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results.";
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
}
