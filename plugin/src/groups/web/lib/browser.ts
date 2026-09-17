import type { Browser, BrowserContext, Page } from "playwright-core";
import { ToolError } from "../../../shared/errors";
import { truncate } from "../../../shared/truncate";
import { USER_AGENT } from "./fetchPage";

export type BrowserChannel = "msedge" | "chrome" | "chromium";

/**
 * Runs inside the page. Tags visible interactive elements with data-lms-ref="N" so the model can
 * refer to them, and returns them with the page text. Kept as a string: bundlers may inject helper
 * calls into real functions, which do not exist inside the browser.
 */
const SNAPSHOT_SCRIPT = String.raw`(() => {
  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=switch]", "[role=textbox]", "[role=combobox]", "[contenteditable=''], [contenteditable=true]"
  ].join(",");
  for (const el of document.querySelectorAll("[data-lms-ref]")) el.removeAttribute("data-lms-ref");
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none" || el.disabled) continue;
    n++;
    el.setAttribute("data-lms-ref", String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = el.getAttribute("role") ||
      (tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" :
       tag === "input" ? (["checkbox", "radio", "submit", "button", "reset"].includes(type) ? (type === "submit" || type === "reset" ? "button" : type) : "textbox") : tag);
    const labelEl = el.id ? document.querySelector("label[for='" + CSS.escape(el.id) + "']") : null;
    const name = clean(el.getAttribute("aria-label") || (labelEl && labelEl.innerText) || el.innerText ||
      el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") ||
      (type === "submit" ? el.value : "")).slice(0, 100);
    const item = { ref: n, role, name };
    if (tag === "a") item.href = el.getAttribute("href");
    if (role === "textbox" || role === "combobox") item.value = clean(el.value).slice(0, 100);
    if (role === "checkbox" || role === "radio") item.checked = !!el.checked;
    elements.push(item);
    if (n >= 400) break;
  }
  return { title: document.title, url: location.href, text: document.body ? document.body.innerText : "", elements };
})()`;

interface SnapshotData {
  title: string;
  url: string;
  text: string;
  elements: Array<{ ref: number; role: string; name: string; href?: string; value?: string; checked?: boolean }>;
}

export function formatSnapshot(data: SnapshotData, maxChars: number): string {
  const elementLines = data.elements.map(e => {
    let line = `[${e.ref}] ${e.role} "${e.name}"`;
    if (e.href) line += ` -> ${e.href.length > 80 ? e.href.slice(0, 80) + "…" : e.href}`;
    if (e.value !== undefined) line += ` value="${e.value}"`;
    if (e.checked !== undefined) line += e.checked ? " (checked)" : " (unchecked)";
    return line;
  });
  const elementsBlock = truncate(elementLines.join("\n"), Math.floor(maxChars * 0.4));
  const text = truncate(data.text.replace(/\n{3,}/g, "\n\n").trim(), Math.max(1000, maxChars - elementsBlock.length));
  return [
    `Title: ${data.title}`,
    `URL: ${data.url}`,
    "",
    "Interactive elements (pass the number as ref to browser_click / browser_type):",
    elementsBlock || "(none)",
    "",
    "Page text:",
    text || "(empty)",
  ].join("\n");
}

/** One browser per plugin process, shared by all chats; relaunched if the channel/headless setting changes. */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launchedWith = "";

  async getPage(channel: BrowserChannel, headless: boolean): Promise<Page> {
    const key = `${channel}:${headless}`;
    if (this.browser && (this.launchedWith !== key || !this.browser.isConnected())) await this.close();
    if (!this.browser) {
      const { chromium } = await import("playwright-core");
      try {
        this.browser = await chromium.launch({ channel: channel === "chromium" ? undefined : channel, headless });
      } catch (error: any) {
        throw new ToolError(
          `Could not start the browser (${channel}): ${String(error?.message ?? error).split("\n")[0]}. ` +
            "Ask the user to pick an installed browser in the web-tools plugin settings.",
        );
      }
      this.launchedWith = key;
      this.context = await this.browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 900 } });
      // Follow links that open in a new tab.
      this.context.on("page", page => (this.page = page));
    }
    if (!this.page || this.page.isClosed()) {
      const open = this.context!.pages().filter(p => !p.isClosed());
      this.page = open.at(-1) ?? (await this.context!.newPage());
    }
    return this.page;
  }

  /** The current page, or an error telling the model to open one first. */
  requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new ToolError("No page is open. Use browser_open first.");
    return this.page;
  }

  async snapshot(maxChars: number): Promise<string> {
    const page = this.requirePage();
    const data = (await page.evaluate(SNAPSHOT_SCRIPT)) as SnapshotData;
    return formatSnapshot(data, maxChars);
  }

  async locate(ref: number) {
    const page = this.requirePage();
    const locator = page.locator(`[data-lms-ref="${ref}"]`);
    if ((await locator.count()) === 0) {
      throw new ToolError(`Element [${ref}] is not on the page anymore. Call browser_snapshot to get fresh refs.`);
    }
    return locator.first();
  }

  /** Waits briefly for navigation or client-side rendering triggered by an action. */
  async settle() {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchedWith = "";
    await browser?.close().catch(() => {});
  }
}

export const browserSession = new BrowserSession();
