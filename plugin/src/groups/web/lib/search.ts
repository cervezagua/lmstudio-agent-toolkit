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

export type SafeSearch = "moderate" | "strict" | "off";

const DUCKDUCKGO_KP: Record<SafeSearch, string> = { strict: "1", moderate: "-1", off: "-2" };
const SEARXNG_SAFESEARCH: Record<SafeSearch, string> = { strict: "2", moderate: "1", off: "0" };

/** DuckDuckGo refuses clients that search in bursts, so requests are spaced out and refusals respected. */
export const DUCKDUCKGO_GAP_MS = 2_000;
export const DUCKDUCKGO_RETRY_MS = 4_000;
export const DUCKDUCKGO_COOL_DOWN_MS = 2 * 60_000;
export const SEARCH_CACHE_MS = 10 * 60_000;
export const SEARCH_CACHE_ENTRIES = 50;

export interface DuckDuckGoOptions {
  safeSearch?: SafeSearch;
  signal?: AbortSignal;
}

/** The clock, the wait and the HTTP call behind a DuckDuckGo search; replaceable so tests stay offline and fast. */
export interface DuckDuckGoDeps {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  request: (query: string, safeSearch: SafeSearch, signal?: AbortSignal) => Promise<{ status: number; html: string }>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function duckDuckGoForm(query: string, safeSearch: SafeSearch = "moderate"): string {
  return new URLSearchParams({ q: query, kp: DUCKDUCKGO_KP[safeSearch] }).toString();
}

async function requestDuckDuckGo(query: string, safeSearch: SafeSearch, signal?: AbortSignal) {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: duckDuckGoForm(query, safeSearch),
    signal,
  });
  return { status: response.status, html: await response.text() };
}

// Process-wide: every chat shares one address, so they share one queue and one cool-down.
let duckDuckGoQueue: Promise<unknown> = Promise.resolve();
let duckDuckGoLastStart = Number.NEGATIVE_INFINITY;
let duckDuckGoRefusedUntil = 0;

function duckDuckGoRefused(msLeft: number): ToolError {
  const minutes = Math.max(1, Math.ceil(msLeft / 60_000));
  return new ToolError(
    `DuckDuckGo is refusing automated searches. Do not retry web_search for about ${minutes} minute${minutes === 1 ? "" : "s"}: ` +
      "continue with what you have, or tell the user. The user can set up SearXNG or a Brave API key in the plugin's Web settings.",
  );
}

/**
 * Searches DuckDuckGo's HTML endpoint, one request at a time and at least DUCKDUCKGO_GAP_MS apart.
 * A bot check is retried once; if it stands, searches fail without a request until the cool-down ends.
 */
export function searchDuckDuckGo(
  query: string,
  count: number,
  options: DuckDuckGoOptions = {},
  deps: Partial<DuckDuckGoDeps> = {},
): Promise<SearchResult[]> {
  const { safeSearch = "moderate", signal } = options;
  const { now, sleep: wait, request } = { now: Date.now, sleep, request: requestDuckDuckGo, ...deps };
  const turn = duckDuckGoQueue.then(async () => {
    signal?.throwIfAborted();
    for (let attempt = 1; ; attempt++) {
      if (now() < duckDuckGoRefusedUntil) throw duckDuckGoRefused(duckDuckGoRefusedUntil - now());
      const early = duckDuckGoLastStart + DUCKDUCKGO_GAP_MS - now();
      if (early > 0) await wait(early, signal);
      duckDuckGoLastStart = now();
      const { status, html } = await request(query, safeSearch, signal);
      const results = parseDuckDuckGoHtml(html);
      if (results.length > 0 || (status === 200 && !/anomaly|captcha|challenge/i.test(html))) return results.slice(0, count);
      if (attempt === 2) {
        duckDuckGoRefusedUntil = now() + DUCKDUCKGO_COOL_DOWN_MS;
        throw duckDuckGoRefused(DUCKDUCKGO_COOL_DOWN_MS);
      }
      await wait(DUCKDUCKGO_RETRY_MS, signal);
    }
  });
  duckDuckGoQueue = turn.catch(() => undefined);
  return turn;
}

export interface BackendOptions {
  page?: number;
  safeSearch?: SafeSearch;
  signal?: AbortSignal;
}

export async function searchSearxng(baseUrl: string, query: string, count: number, options: BackendOptions = {}): Promise<SearchResult[]> {
  const { page = 1, safeSearch = "moderate", signal } = options;
  if (!baseUrl.trim()) throw new ToolError("Search backend is searxng but no SearXNG URL is configured in the plugin settings.");
  let url: URL;
  try {
    url = new URL("search", baseUrl.trim().replace(/\/?$/, "/"));
  } catch {
    throw new ToolError(`SearXNG URL "${baseUrl}" is not a valid URL.`);
  }
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", String(page));
  url.searchParams.set("safesearch", SEARXNG_SAFESEARCH[safeSearch]);
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

/** The Brave request for a search; its `offset` counts pages, starting at 0 and ending at 9. */
export function braveSearchUrl(query: string, count: number, page = 1, safeSearch: SafeSearch = "moderate"): URL {
  if (page > 10) throw new ToolError("Brave returns at most 10 pages of results. Use a more specific query instead.");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  if (page > 1) url.searchParams.set("offset", String(page - 1));
  url.searchParams.set("safesearch", safeSearch);
  return url;
}

export async function searchBrave(apiKey: string, query: string, count: number, options: BackendOptions = {}): Promise<SearchResult[]> {
  if (!apiKey.trim()) throw new ToolError("Search backend is brave but no Brave API key is set in the plugin's global settings.");
  const url = braveSearchUrl(query, count, options.page, options.safeSearch);
  const data = await getJson(url.href, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey.trim() },
    signal: options.signal,
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
  /** 1-based; DuckDuckGo only has page 1. */
  page?: number;
  safeSearch?: SafeSearch;
  searxngUrl: string;
  braveApiKey: string;
  signal?: AbortSignal;
}

export interface SearchOutcome {
  results: SearchResult[];
  note?: string;
  /** True when the answer came from the in-memory cache and no request was made. */
  cached?: boolean;
}

const DUCKDUCKGO_ONE_PAGE =
  "DuckDuckGo only gives the first page of results: more pages need SearXNG or a Brave API key (the plugin's Web settings). " +
  "Try a more specific query instead.";

const searchCache = new Map<string, { at: number; results: SearchResult[]; note?: string }>();

/** Forgets cached results and DuckDuckGo's pacing and cool-down. For tests. */
export function clearSearchState(): void {
  searchCache.clear();
  duckDuckGoQueue = Promise.resolve();
  duckDuckGoLastStart = Number.NEGATIVE_INFINITY;
  duckDuckGoRefusedUntil = 0;
}

async function search(options: SearchOptions, duckDuckGo: typeof searchDuckDuckGo): Promise<SearchOutcome> {
  const { backend, query, count, page = 1, safeSearch = "moderate", signal } = options;
  switch (backend) {
    case "searxng":
      return { results: await searchSearxng(options.searxngUrl, query, count, { page, safeSearch, signal }) };
    case "brave":
      return { results: await searchBrave(options.braveApiKey, query, count, { page, safeSearch, signal }) };
    case "duckduckgo":
      if (page > 1) throw new ToolError(DUCKDUCKGO_ONE_PAGE);
      return { results: await duckDuckGo(query, count, { safeSearch, signal }) };
    case "auto": {
      let searxngProblem = "no SearXNG URL is configured";
      if (options.searxngUrl.trim()) {
        try {
          return { results: await searchSearxng(options.searxngUrl, query, count, { page, safeSearch, signal }) };
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          searxngProblem = error.message;
        }
      }
      if (page > 1) throw new ToolError(`SearXNG unavailable (${searxngProblem}) and ${DUCKDUCKGO_ONE_PAGE}`);
      try {
        return {
          results: await duckDuckGo(query, count, { safeSearch, signal }),
          note: `SearXNG unavailable, used DuckDuckGo: ${searxngProblem}`,
        };
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        throw new ToolError(`No search backend worked. SearXNG: ${searxngProblem} DuckDuckGo: ${error.message}`);
      }
    }
  }
}

/**
 * Runs a search on the configured backend. `auto` prefers SearXNG and falls back to DuckDuckGo if
 * SearXNG is not configured or fails; the returned note says so, so the model and user know.
 * Answers with results are kept for SEARCH_CACHE_MS, so a repeated search costs no request.
 */
export async function runSearch(
  options: SearchOptions,
  duckDuckGo: typeof searchDuckDuckGo = searchDuckDuckGo, // injectable so tests stay offline
  now: () => number = Date.now,
): Promise<SearchOutcome> {
  const { backend, query, count, page = 1, safeSearch = "moderate" } = options;
  // The SearXNG URL is part of the key so that pointing the plugin at another instance takes effect at once.
  const key = JSON.stringify([backend, query.trim().toLowerCase(), page, safeSearch, count, options.searxngUrl.trim()]);
  const hit = searchCache.get(key);
  if (hit && now() - hit.at < SEARCH_CACHE_MS) {
    return { results: hit.results, note: hit.note ? `${hit.note}; cached` : "cached", cached: true };
  }
  searchCache.delete(key);

  const outcome = await search(options, duckDuckGo);
  if (outcome.results.length > 0) {
    searchCache.set(key, { at: now(), results: outcome.results, note: outcome.note });
    for (const oldest of searchCache.keys()) {
      if (searchCache.size <= SEARCH_CACHE_ENTRIES) break;
      searchCache.delete(oldest);
    }
  }
  return outcome;
}

export function formatResults(results: SearchResult[], page = 1): string {
  if (results.length === 0) return page > 1 ? `No results on page ${page}.` : "No results.";
  const list = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
  return page > 1 ? `Page ${page}\n\n${list}` : list;
}
