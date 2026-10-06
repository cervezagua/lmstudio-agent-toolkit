/**
 * Small helpers shared by the Word and PDF writers. The markdown they handle is written by the
 * model and may quote untrusted pages, so nothing in it is allowed to become markup or a fetch.
 */

/** Escapes text so it shows literally in HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Like `escapeHtml`, but leaves character references such as `&amp;` or `&#169;` alone. */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
  deg: "°",
  times: "×",
  rarr: "→",
  larr: "←",
};

/** Turns the character references markdown allows in text (`&amp;`, `&#169;`) into characters. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);/g, (whole, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? whole;
    const code = /^#[Xx]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    // XML cannot carry control characters or lone surrogates.
    const valid = code === 9 || code === 10 || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
    return valid ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Whether a link target may become a real hyperlink. Anything else (javascript:, file:, data:,
 * relative paths that mean nothing inside a document) keeps its text and loses the link.
 */
export function isSafeLink(href: string | null | undefined): href is string {
  return typeof href === "string" && /^(https?:\/\/|mailto:|tel:)/i.test(href.trim());
}

/** How many `<img>` tags a piece of raw HTML holds; they are written as text, so they count as left out. */
export function countImageTags(html: string): number {
  return html.match(/<img\b/gi)?.length ?? 0;
}

/** Characters XML 1.0 cannot carry (a .docx is XML); Word refuses a file that contains one. */
export function stripInvalidXmlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");
}
