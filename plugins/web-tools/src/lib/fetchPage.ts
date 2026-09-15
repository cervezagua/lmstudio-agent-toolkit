import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { ToolError } from "../shared/errors";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 lmstudio-web-tools";

const MAX_BYTES = 5 * 1024 * 1024;

export interface FetchedPage {
  url: string;
  title: string;
  contentType: string;
  markdown: string;
  /** How the content was obtained, so the tool can tell the model what it is looking at. */
  kind: "html" | "pdf" | "text";
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

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
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

/** Waits for the Retry-After header when the server sends a sensible one, otherwise backs off. */
function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) return seconds * 1000;
  return Math.min(4000, 500 * 2 ** attempt);
}

export async function fetchPage(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number; retries?: number } = {},
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
    throw new ToolError(`HTTP ${response.status} ${response.statusText} for ${response.url || parsed.href}${retried}.`);
  }
  const finalUrl = response.url || parsed.href;

  if (contentType === "application/pdf" || (contentType === "" && parsed.pathname.toLowerCase().endsWith(".pdf"))) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new ToolError(`The PDF at ${finalUrl} is larger than 5 MB.`);
    try {
      const { title, text } = await pdfToText(buffer);
      return { url: finalUrl, title, contentType: "application/pdf", markdown: text, kind: "pdf" };
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
    return { url: finalUrl, title, contentType: contentType || "text/html", markdown, kind: "html" };
  }
  return { url: finalUrl, title: "", contentType, markdown: body, kind: "text" };
}
