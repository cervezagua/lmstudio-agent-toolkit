import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { safe, ToolError } from "../../../shared/errors";
import { USER_AGENT } from "../../../shared/userAgent";
import { plainText } from "./feeds";

/**
 * The wikipedia tool: searches one language's Wikipedia through the MediaWiki API and returns the
 * best match as plain text, with the other matches listed so the model can ask for one by title.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const SEARCH_LIMIT = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]+)*$/;

export interface WikipediaMatch {
  title: string;
  snippet: string;
}

export interface WikipediaLookup {
  /** The best match, or null when the search found nothing. */
  article: { title: string; url: string; text: string; redirectedFrom?: string } | null;
  /** The other search results, best first. */
  others: WikipediaMatch[];
  /** The search engine's "did you mean", when it has one. */
  suggestion?: string;
  fromCache?: boolean;
}

export interface WikipediaOptions {
  /** The site to ask for a language, without a trailing slash. Only tests pass this. */
  apiBase?: (language: string) => string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const wikipediaOrigin = (language: string) => `https://${language}.wikipedia.org`;

/** Models ask again for the next part of the same article, so recent lookups are kept for a while. */
const cache = new Map<string, { lookup: WikipediaLookup; storedAt: number }>();

/** Test helper. */
export function clearWikipediaCache(): void {
  cache.clear();
}

export function checkLanguage(language: string | undefined): string {
  // Models often send "" for a parameter they mean to leave out.
  const code = (language?.trim() || "en").toLowerCase();
  if (!LANGUAGE.test(code)) {
    throw new ToolError(`"${language}" is not a Wikipedia language code. Use one such as en, de, pt or zh-yue.`);
  }
  return code;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new ToolError("Wikipedia's answer is larger than 5 MB, which is more than this tool reads.");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

async function callApi(origin: string, params: Record<string, string>, options: WikipediaOptions): Promise<any> {
  const url = `${origin}/w/api.php?${new URLSearchParams({ ...params, format: "json" })}`;
  const host = new URL(origin).host;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
  let body: string;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const why = response.status === 429 ? " (too many requests; wait a little before trying again)" : "";
      throw new ToolError(`Wikipedia (${host}) answered HTTP ${response.status} ${response.statusText}`.trimEnd() + `${why}.`);
    }
    body = await readLimited(response);
  } catch (error: any) {
    if (error instanceof ToolError) throw error;
    if (error?.name === "TimeoutError") throw new ToolError(`Timed out after ${timeoutMs / 1000} s waiting for Wikipedia (${host}).`);
    if (error?.name === "AbortError" && options.signal?.aborted) throw new ToolError("The Wikipedia request was cancelled.");
    throw new ToolError(
      `Could not reach Wikipedia (${host}): ${error?.cause?.message ?? error?.message ?? error}. Check the connection and the language code.`,
    );
  }
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ToolError(`Wikipedia (${host}) did not answer with JSON.`);
  }
  if (data?.error) throw new ToolError(`Wikipedia (${host}) refused the request: ${data.error.info ?? data.error.code ?? "unknown error"}`);
  return data;
}

/** Searches, then reads the best match. Throws ToolError for anything that went wrong on the way. */
export async function lookupWikipedia(query: string, language: string, options: WikipediaOptions = {}): Promise<WikipediaLookup> {
  const origin = (options.apiBase ?? wikipediaOrigin)(language).replace(/\/+$/, "");
  const key = `${origin}\n${query.trim().toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) {
    if (Date.now() - cached.storedAt <= CACHE_TTL_MS) return { ...cached.lookup, fromCache: true };
    cache.delete(key);
  }

  const found = await callApi(origin, { action: "query", list: "search", srsearch: query, srlimit: String(SEARCH_LIMIT) }, options);
  const results: any[] = Array.isArray(found?.query?.search) ? found.query.search : [];
  const matches: WikipediaMatch[] = results
    .filter(result => typeof result?.title === "string")
    .map(result => ({ title: result.title, snippet: plainText(String(result.snippet ?? ""), 200) }));
  const suggestion = typeof found?.query?.searchinfo?.suggestion === "string" ? found.query.searchinfo.suggestion : undefined;

  let lookup: WikipediaLookup;
  if (matches.length === 0) {
    lookup = { article: null, others: [], suggestion };
  } else {
    const best = matches[0].title;
    const read = await callApi(
      origin,
      { action: "query", prop: "extracts|info", explaintext: "1", redirects: "1", inprop: "url", titles: best },
      options,
    );
    // The pages come keyed by id, or as a list with formatversion=2; either way there is one.
    const page: any = Object.values(read?.query?.pages ?? {})[0] ?? {};
    const title = typeof page.title === "string" ? page.title : best;
    const redirect = (Array.isArray(read?.query?.redirects) ? read.query.redirects : []).find((entry: any) => entry?.to === title);
    lookup = {
      article: {
        title,
        // Always the real site, whatever answered: this is the link a person would open.
        url:
          typeof page.canonicalurl === "string" && page.canonicalurl.startsWith(`${wikipediaOrigin(language)}/`)
            ? page.canonicalurl
            : `${wikipediaOrigin(language)}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        text: typeof page.extract === "string" ? page.extract.trim() : "",
        redirectedFrom: typeof redirect?.from === "string" ? redirect.from : undefined,
      },
      others: matches.slice(1),
      suggestion,
    };
  }

  cache.set(key, { lookup, storedAt: Date.now() });
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    cache.delete(oldest);
  }
  return lookup;
}

export interface WikipediaToolOptions {
  /** How much of an article one call returns unless the model passes max_chars. */
  maxChars: number;
  /** Only tests pass these; the tool itself talks to https://<language>.wikipedia.org. */
  apiBase?: (language: string) => string;
  timeoutMs?: number;
}

export function makeWikipediaTools({ maxChars, apiBase, timeoutMs }: WikipediaToolOptions): Tool[] {
  return [
    tool({
      name: "wikipedia",
      description:
        "Look something up on Wikipedia: returns the best-matching article as plain text, and the titles of other matches. " +
        "language is a code such as en or de. Long articles are cut off: pass offset (characters already read) to continue, or a bigger max_chars.",
      parameters: {
        query: z.string().min(1),
        language: z.string().optional(),
        max_chars: z.number().int().min(500).max(200000).optional(),
        offset: z.number().int().min(0).optional(),
      },
      // ctx.status must be called as a method (it relies on `this`), so don't destructure it.
      implementation: safe(async ({ query, language, max_chars, offset }, ctx) => {
        const code = checkLanguage(language);
        if (!query.trim()) throw new ToolError("query is empty.");
        ctx.status(`Wikipedia (${code}): ${query}`);
        const { article, others, suggestion } = await lookupWikipedia(query, code, { apiBase, timeoutMs, signal: ctx.signal });
        if (!article) {
          const hint = suggestion ? ` Did you mean "${suggestion}"?` : " Try other words, or another language.";
          return `No article found on ${code}.wikipedia.org for "${query}".${hint}`;
        }

        const start = offset ?? 0;
        if (start >= article.text.length && article.text.length > 0) {
          throw new ToolError(`offset ${start} is past the end of this document (${article.text.length} characters).`);
        }
        const slice = article.text.slice(start, start + (max_chars ?? maxChars));
        const left = article.text.length - start - slice.length;
        const more = left > 0 ? `\n\n[${left} characters left; call again with offset ${start + slice.length}]` : "";
        const header =
          `Title: ${article.title}\nURL: ${article.url}\n` + (article.redirectedFrom ? `Redirected: ${article.redirectedFrom} -> ${article.title}\n` : "");
        // The other matches are listed once, with the start of the article, not on every later part.
        const list =
          start === 0 && others.length > 0
            ? `\n\nOther matches (ask again with the exact title):\n${others.map(match => `- ${match.title}${match.snippet ? `: ${match.snippet}` : ""}`).join("\n")}`
            : "";
        return `${header}\n${slice || "(no readable text)"}${more}${list}`;
      }),
    }),
  ];
}
