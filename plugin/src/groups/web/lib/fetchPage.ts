import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { ToolError } from "../../../shared/errors";
import { USER_AGENT } from "../../../shared/userAgent";

export { USER_AGENT };

const MAX_BYTES = 5 * 1024 * 1024;

export interface FetchedPage {
  url: string;
  title: string;
  contentType: string;
  markdown: string;
  /** How the content was obtained, so the tool can tell the model what it is looking at. */
  kind: "html" | "pdf" | "text";
  /** Set when the server redirected to a different host, which is worth showing to a person. */
  redirectedFrom?: string;
  fromCache?: boolean;
  /** The page as downloaded, so part of it can be selected later without fetching it again. */
  html?: string;
}

function absolutize(href: string | null, base: string): string {
  if (!href) return "";
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function createTurndown(pageUrl: string) {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  service.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "form"] as any);
  service.addRule("absoluteLinks", {
    filter: node => node.nodeName === "A" && !!(node as any).getAttribute("href"),
    replacement: (content, node) => {
      const href = absolutize((node as any).getAttribute("href"), pageUrl);
      const text = content.trim();
      if (!text) return "";
      if (href.startsWith("javascript:") || href.startsWith("#")) return text;
      return `[${text}](${href})`;
    },
  });
  service.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const src = (node as any).getAttribute("src") ?? "";
      const alt = ((node as any).getAttribute("alt") ?? "").trim();
      // Inline data: images are huge and useless to a text model.
      if (!src || src.startsWith("data:") || !alt) return "";
      return `![${alt}](${absolutize(src, pageUrl)})`;
    },
  });
  return service;
}

/** Extracts the main article (Readability) and converts it to markdown; falls back to the whole body. */
export function htmlToMarkdown(html: string, pageUrl: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  const fallbackTitle = document.title?.trim() ?? "";
  const turndown = createTurndown(pageUrl);

  let article: ReturnType<Readability["parse"]> = null;
  try {
    // Readability mutates the document, so give it its own copy.
    article = new Readability(parseHTML(html).document as any, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }

  let markdown: string;
  if (article?.content && (article.textContent ?? "").trim().length > 200) {
    markdown = turndown.turndown(article.content);
  } else {
    for (const el of Array.from(document.querySelectorAll("script, style, noscript, nav, footer, header, aside"))) el.remove();
    markdown = turndown.turndown(document.body?.innerHTML ?? html);
  }
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
  return { title: article?.title?.trim() || fallbackTitle, markdown };
}

/**
 * Markdown for just the elements a CSS selector matches, for when a model needs one table or one
 * section of a long page rather than all of it.
 */
export function selectToMarkdown(html: string, pageUrl: string, selector: string): { matches: number; markdown: string } {
  const { document } = parseHTML(html);
  let elements: Element[];
  try {
    elements = Array.from(document.querySelectorAll(selector)) as unknown as Element[];
  } catch (error) {
    throw new ToolError(`"${selector}" is not a valid CSS selector: ${(error as Error).message}`);
  }
  if (elements.length === 0) return { matches: 0, markdown: "" };
  const turndown = createTurndown(pageUrl);
  const parts = elements.map(element =>
    turndown
      .turndown((element as any).outerHTML ?? "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  return { matches: elements.length, markdown: parts.filter(Boolean).join("\n\n---\n\n") };
}

/**
 * The body, read no further than `maxBytes`: the download stops there, so a huge file costs neither
 * the memory nor the time. `complete` is false when there was more.
 */
async function readBytes(response: Response, maxBytes: number): Promise<{ bytes: Buffer; complete: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), complete: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(chunks), complete: false };
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), complete: true };
}

/** A page's text; one longer than `maxBytes` is cut there. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder("utf-8").decode((await readBytes(response, maxBytes)).bytes);
}

/** Extracts the text of a PDF, page by page, so the model can read reports and papers. */
async function pdfToText(bytes: Uint8Array): Promise<{ title: string; text: string }> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const document = await getDocumentProxy(bytes);
  const [{ text, totalPages }, meta] = await Promise.all([
    extractText(document, { mergePages: false }) as Promise<{ text: string[]; totalPages: number }>,
    getMeta(document).catch(() => ({ info: {} as any })),
  ]);
  const pages = (Array.isArray(text) ? text : [String(text)]).map(
    (page, index) => `\n\n--- page ${index + 1} of ${totalPages} ---\n${page.trim()}`,
  );
  return { title: String((meta as any)?.info?.Title ?? "").trim(), text: pages.join("").trim() };
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_URL_LENGTH = 2048;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const CACHE_MAX_BYTES = 20 * 1024 * 1024;

interface CacheEntry {
  page: FetchedPage;
  storedAt: number;
  bytes: number;
}

/**
 * Models re-fetch the same page repeatedly while working through it. This keeps recent pages in
 * memory for a few minutes; insertion order gives a simple oldest-out policy.
 */
const cache = new Map<string, CacheEntry>();

function cacheGet(url: string): FetchedPage | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return entry.page;
}

function cacheSet(url: string, page: FetchedPage): void {
  const bytes = page.markdown.length + (page.html?.length ?? 0);
  if (bytes > CACHE_MAX_BYTES) return; // one huge page should not evict everything else
  cache.set(url, { page, storedAt: Date.now(), bytes });
  let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES && total <= CACHE_MAX_BYTES) break;
    cache.delete(key);
    total -= entry.bytes;
  }
}

/** Test helper. */
export function clearFetchCache(): void {
  cache.clear();
}

/** Waits for the Retry-After header when the server sends a sensible one, otherwise backs off. */
function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) return seconds * 1000;
  return Math.min(4000, 500 * 2 ** attempt);
}

/**
 * What to try after a page that does not exist: a small model told only "404" stops there, when the
 * page has usually just moved. The same address without its query and up to four folders above it
 * (not the site's front page, which nearly always answers) are tried, all within a few seconds, and
 * the nearest that answers on the same site is named, with words to search for.
 */
async function afterMissingPage(missing: URL, signal?: AbortSignal): Promise<string> {
  const asked = new URL(missing.href);
  asked.hash = "";
  const candidates: string[] = [];
  const add = (url: URL) => {
    if (url.pathname !== "/" && url.href !== asked.href && !candidates.includes(url.href)) candidates.push(url.href);
  };
  const bare = new URL(asked.href);
  bare.search = "";
  add(bare);
  const segments = bare.pathname.split("/").filter(Boolean);
  for (let up = 1; up <= 4 && segments.length - up > 0; up++) {
    const parent = new URL(bare.href);
    parent.pathname = `/${segments.slice(0, segments.length - up).join("/")}/`;
    add(parent);
  }
  // One budget for all of them: a missing page must not hold up the tool call for long.
  const deadline = AbortSignal.timeout(8000);
  let working = "";
  for (const candidate of candidates.slice(0, 5)) {
    if (signal?.aborted || deadline.aborted) break;
    try {
      const probe = await fetch(candidate, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.any([AbortSignal.timeout(5000), deadline, ...(signal ? [signal] : [])]),
      });
      await probe.body?.cancel().catch(() => {});
      // A page that sends the model to another site (a sign-in page, say) is no lead.
      const landed = probe.url || candidate;
      if (probe.ok && new URL(landed).host === missing.host) {
        working = landed;
        break;
      }
    } catch {
      // Unreachable as well: nothing to suggest there.
    }
  }
  // Words from the address, which may come from a page meant to steer the model: letters and digits
  // only, so they cannot close the quote or add a line of their own.
  const words = segments
    .slice(-4)
    .map(part => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .map(part => part.replace(/\.[a-z0-9]+$/i, "").replace(/[^\p{L}\p{N}]+/gu, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  const search = words ? `web_search for "${words}" to find where it is now` : "web_search for the page's topic";
  return working
    ? ` The page may have moved: ${working} answers. Fetch it and follow its links, or ${search}.`
    : ` The page may have moved: ${search}.`;
}

export async function fetchPage(
  url: string,
  /** `suggestOnMissing`: after a 404, look for a nearby page that works, for a model to try next. */
  options: { signal?: AbortSignal; timeoutMs?: number; retries?: number; refresh?: boolean; suggestOnMissing?: boolean } = {},
): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`"${url}" is not a valid URL. Include the scheme, e.g. https://example.com`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolError("Only http and https URLs can be fetched.");
  }
  if (parsed.username || parsed.password) {
    throw new ToolError("URLs with a username or password are refused; credentials do not belong in a fetched URL.");
  }
  if (url.length > MAX_URL_LENGTH) {
    throw new ToolError(`That URL is ${url.length} characters, over the ${MAX_URL_LENGTH} character limit.`);
  }

  if (!options.refresh) {
    const cached = cacheGet(parsed.href);
    if (cached) return { ...cached, fromCache: true };
  }

  const retries = options.retries ?? 2;
  let response: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(response, attempt - 1)));
    }
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])];
    try {
      response = await fetch(parsed.href, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.any(signals),
      });
      lastError = null;
      if (!RETRYABLE_STATUS.has(response.status)) break;
    } catch (error: any) {
      lastError = error;
      response = null;
      if (error?.name === "AbortError" && options.signal?.aborted) break; // the user cancelled
    }
  }

  if (!response) {
    const error = lastError as any;
    if (error?.name === "TimeoutError") throw new ToolError(`Timed out fetching ${parsed.href} (after ${retries + 1} attempts).`);
    throw new ToolError(`Could not fetch ${parsed.href}: ${error?.cause?.message ?? error?.message ?? error}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok) {
    const retried = RETRYABLE_STATUS.has(response.status) ? ` after ${retries + 1} attempts` : "";
    const looksMissing = options.suggestOnMissing && (response.status === 404 || response.status === 410);
    if (looksMissing) await response.body?.cancel().catch(() => {});
    const missing = looksMissing ? await afterMissingPage(parsed, options.signal) : "";
    throw new ToolError(`HTTP ${response.status} ${response.statusText} for ${response.url || parsed.href}${retried}.${missing}`);
  }
  const finalUrl = response.url || parsed.href;
  // Following redirects is convenient, but a hop to another host is worth showing to the model and
  // to the person approving the call.
  const finalHost = (() => {
    try {
      return new URL(finalUrl).host;
    } catch {
      return parsed.host;
    }
  })();
  const redirectedFrom = finalHost !== parsed.host ? parsed.host : undefined;
  const remember = (page: FetchedPage) => {
    cacheSet(parsed.href, page);
    return page;
  };

  if (contentType === "application/pdf" || (contentType === "" && parsed.pathname.toLowerCase().endsWith(".pdf"))) {
    // Refused as soon as it is known to be too big: from the header when the server sends one, and
    // otherwise after 5 MB has arrived, never after the whole file has.
    const tooLarge = () => new ToolError(`The PDF at ${finalUrl} is larger than 5 MB.`);
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    const { bytes, complete } = await readBytes(response, MAX_BYTES);
    if (!complete) throw tooLarge();
    try {
      // A copy with a buffer of its own, which is what PDF.js expects to be handed.
      const { title, text } = await pdfToText(new Uint8Array(bytes));
      return remember({ url: finalUrl, title, contentType: "application/pdf", markdown: text, kind: "pdf", redirectedFrom });
    } catch (error) {
      throw new ToolError(`Could not read the PDF at ${finalUrl}: ${(error as Error).message}`);
    }
  }

  const textual =
    /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml))/.test(contentType) || contentType === "";
  if (!textual) {
    throw new ToolError(`Cannot read ${contentType} content (${finalUrl}). Web pages, text and PDFs are supported.`);
  }

  const body = await readLimited(response, MAX_BYTES);
  if (contentType.includes("html") || (contentType === "" && /<html|<body|<!doctype html/i.test(body.slice(0, 2000)))) {
    const { title, markdown } = htmlToMarkdown(body, finalUrl);
    return remember({ url: finalUrl, title, contentType: contentType || "text/html", markdown, kind: "html", redirectedFrom, html: body });
  }
  return remember({ url: finalUrl, title: "", contentType, markdown: body, kind: "text", redirectedFrom });
}
