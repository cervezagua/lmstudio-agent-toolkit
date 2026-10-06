import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { safe, ToolError } from "../../../shared/errors";
import { fetchPage, selectToMarkdown } from "./fetchPage";

/**
 * The fetch_url tool. Self-contained so it can also ship as the standalone page-reader plugin: it
 * imports only fetchPage and shared/, never the browser or agent-toolkit's config.
 */

/** Renders a page in a real browser and returns its text, for pages that are empty without JavaScript. */
export type RenderInBrowser = (url: string, maxChars: number) => Promise<string>;

export interface FetchUrlToolOptions {
  /** How much of a document one call returns unless the model passes max_chars. */
  maxChars: number;
  /** When given, a page that arrives nearly empty is retried through it. */
  renderInBrowser?: RenderInBrowser;
  /**
   * Without a browser, add NEEDS_JAVASCRIPT_NOTE to a page that arrives nearly empty. For plugins
   * that have no browser tools of their own to offer.
   */
  explainEmptyPages?: boolean;
}

export const NEEDS_JAVASCRIPT_NOTE =
  "\n(nearly empty: this page probably needs JavaScript, which this plugin does not run. agent-toolkit's browser tools can open it.)";

export function makeFetchUrlTools({ maxChars, renderInBrowser, explainEmptyPages }: FetchUrlToolOptions): Tool[] {
  const description = [
    "Download a web page and return its main content as markdown. Also reads PDFs, plain text and",
    "JSON. Long documents are cut off: pass offset (characters already read) to continue where",
    "the previous call stopped, or a bigger max_chars.",
    ...(renderInBrowser ? ["Pages that only render through JavaScript are retried automatically in the browser."] : []),
    "Recent pages are cached for a few minutes; pass refresh to fetch again.",
    'To read only part of a page, pass selector, a CSS selector such as "main", "article" or',
    '"table#prices": much shorter than the whole page. It applies to the page as downloaded,',
    "before any JavaScript runs.",
  ].join(" ");

  return [
    tool({
      name: "fetch_url",
      description,
      parameters: {
        url: z.string(),
        selector: z.string().optional(),
        max_chars: z.number().int().min(500).max(200000).optional(),
        offset: z.number().int().min(0).optional(),
        refresh: z.boolean().optional(),
      },
      // ctx.status must be called as a method (it relies on `this`), so don't destructure it.
      implementation: safe(async ({ url, selector, max_chars, offset, refresh }, ctx) => {
        ctx.status(`Fetching ${url}`);
        const page = await fetchPage(url, { signal: ctx.signal, refresh });
        let body = page.markdown.trim();
        let note = "";

        if (selector !== undefined && selector.trim()) {
          if (page.kind !== "html" || !page.html) {
            throw new ToolError(`selector only works on web pages; ${page.url} is ${page.kind === "pdf" ? "a PDF" : "plain text"}.`);
          }
          const selected = selectToMarkdown(page.html, page.url, selector.trim());
          if (selected.matches === 0) {
            throw new ToolError(`Nothing on ${page.url} matches "${selector}". Call without selector to see the whole page.`);
          }
          body = selected.markdown.trim();
          note = `\n(${selected.matches} element${selected.matches === 1 ? "" : "s"} matching "${selector}")`;
        }

        // A page that renders only through JavaScript arrives nearly empty; a browser can run it.
        if (!selector?.trim() && body.length < 200 && page.kind === "html") {
          if (renderInBrowser) {
            ctx.status("Page looks empty, retrying in the browser");
            try {
              body = await renderInBrowser(page.url, max_chars ?? maxChars);
              note = "\n(rendered in the browser because the plain page was empty)";
            } catch (error) {
              note = `\n(the page looks empty and the browser fallback failed: ${(error as Error).message})`;
            }
          } else if (explainEmptyPages) {
            note = NEEDS_JAVASCRIPT_NOTE;
          }
        }

        const start = offset ?? 0;
        if (start >= body.length && body.length > 0) {
          throw new ToolError(`offset ${start} is past the end of this document (${body.length} characters).`);
        }
        const limit = max_chars ?? maxChars;
        const slice = body.slice(start, start + limit);
        const more = start + slice.length < body.length ? `\n\n[${body.length - start - slice.length} characters left; call again with offset ${start + slice.length}]` : "";
        const header =
          `URL: ${page.url}\n` +
          (page.title ? `Title: ${page.title}\n` : "") +
          (page.kind === "pdf" ? "Type: PDF\n" : "") +
          (page.redirectedFrom ? `Redirected: ${page.redirectedFrom} -> ${new URL(page.url).host}\n` : "") +
          (page.fromCache ? "From cache (pass refresh to fetch again)\n" : "");
        return `${header}${note}\n${slice || "(no readable text)"}${more}`;
      }),
    }),
  ];
}
