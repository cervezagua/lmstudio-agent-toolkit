import type { Browser } from "playwright-core";
import { ToolError } from "../../../shared/errors";
import { countImageTags, escapeHtml, escapeHtmlText, isSafeLink } from "./markdown";

/** Print stylesheet: self-contained, so the page needs nothing from the network. */
const PRINT_CSS = `
@page { size: A4; margin: 20mm 18mm; }
html { font-size: 11pt; }
body { margin: 0; font-family: Georgia, "Times New Roman", "Liberation Serif", serif; line-height: 1.5; color: #1a1a1a; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { font-family: "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif; line-height: 1.25; margin: 1.4em 0 0.5em; page-break-after: avoid; }
h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4 { font-size: 1.1em; } h5, h6 { font-size: 1em; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p { margin: 0 0 0.8em; }
a { color: #0b57d0; }
ul, ol { margin: 0 0 0.8em; padding-left: 1.6em; }
li > p { margin-bottom: 0.4em; }
li input[type=checkbox] { margin: 0 0.4em 0 0; }
blockquote { margin: 0 0 0.8em; padding: 0.1em 0 0.1em 1em; border-left: 3px solid #bbb; color: #444; }
code, pre { font-family: Consolas, "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace; font-size: 0.88em; }
code { background: #f1f1f1; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f5f5f5; border: 1px solid #e2e2e2; border-radius: 4px; padding: 0.7em 0.9em; margin: 0 0 0.9em; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 1em; }
table { border-collapse: collapse; width: 100%; margin: 0 0 0.9em; page-break-inside: avoid; }
th, td { border: 1px solid #999; padding: 0.3em 0.6em; vertical-align: top; }
th:not([align]) { text-align: left; }
th { background: #f0f0f0; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
hr { border: 0; border-top: 1px solid #999; margin: 1.4em 0; }
`;

/**
 * Renders markdown as a complete HTML page for printing. Raw HTML in the markdown is escaped and
 * images become their alt text in brackets, so the page holds no script and nothing to fetch.
 */
export async function markdownToPrintHtml(markdown: string, title = "Document"): Promise<{ html: string; omittedImages: number }> {
  const { Marked } = await import("marked");
  let omittedImages = 0;
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    renderer: {
      html(token) {
        omittedImages += countImageTags(token.text);
        const literal = escapeHtml(token.text.replace(/\n+$/, ""));
        return "block" in token && token.block ? `<pre class="raw-html">${literal}</pre>\n` : literal;
      },
      image(token) {
        omittedImages++;
        return escapeHtml(`[${token.text || "image"}]`);
      },
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        return isSafeLink(token.href) ? `<a href="${escapeHtml(token.href.trim())}">${label}</a>` : label;
      },
      // The default trusts text inside a raw HTML block; nothing is trusted here.
      text(token) {
        return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : escapeHtmlText(token.text);
      },
    },
  });
  const body = marked.parse(markdown) as string;
  const html = [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PRINT_CSS}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("\n");
  return { html, omittedImages };
}

export type PdfBrowserLauncher = (channel: string) => Promise<Browser>;

const launchHeadless: PdfBrowserLauncher = async channel => {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ channel: channel === "chromium" ? undefined : channel, headless: true });
};

/**
 * Prints an HTML page to an A4 PDF with its own headless browser (`page.pdf` needs headless, and
 * the Web group's shared browser may not be). JavaScript is off and every request is aborted, so
 * nothing in the page can run or make the browser fetch anything.
 */
export async function htmlToPdfBuffer(
  html: string,
  channel: string,
  options: { signal?: AbortSignal; launch?: PdfBrowserLauncher } = {},
): Promise<Buffer> {
  let browser: Browser;
  try {
    browser = await (options.launch ?? launchHeadless)(channel);
  } catch (error: any) {
    throw new ToolError(
      `PDF output needs Edge or Chrome installed, and the configured browser (${channel}) could not be started: ` +
        `${String(error?.message ?? error).split("\n")[0]}. Write a .docx instead, or ask the user to pick an installed ` +
        "browser in the plugin's Web settings.",
    );
  }
  const stop = () => void browser.close().catch(() => {});
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (options.signal?.aborted) throw new ToolError("Cancelled.");
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    options.signal?.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }
}
