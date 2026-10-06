import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ToolError } from "../../../shared/errors";
import { USER_AGENT } from "../../../shared/userAgent";

export const DEFAULT_VIEW_PROMPT = [
  "Describe this image thoroughly for someone who cannot see it.",
  "Say what it shows, quote any visible text, describe the layout,",
  "and mention notable colours and details.",
  "Describe only what is actually visible; do not guess.",
].join(" ");

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
export const IMAGE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** The image types the vision model accepts, by the content type a server sends. */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/x-ms-bmp": ".bmp",
};

/** The prompt for the vision model: a full description, or an answer to one question. */
export function buildViewPrompt(question?: string): string {
  const asked = question?.trim();
  if (!asked) return DEFAULT_VIEW_PROMPT;
  return [
    "Look at this image and answer the question about it.",
    "Answer only from what is visible in the image.",
    "If the image does not show the answer, say so plainly instead of guessing.",
    `\n\nQuestion: ${asked}`,
  ].join(" ");
}

/** True when `image` is written as a URL (any scheme) rather than a path. `C:\x.png` is a path. */
export function looksLikeUrl(image: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(image.trim());
}

/** The file extension for an image content type, or null when the type is not supported. */
export function extensionForContentType(contentType: string): string | null {
  return EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0].trim().toLowerCase()] ?? null;
}

/** Checks an image URL before anything is requested, with errors the model can act on. */
export function parseImageUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new ToolError(`"${url}" is not a valid URL. Include the scheme, e.g. https://example.com/picture.png`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolError("Only http and https image URLs can be fetched. For a file, give its path inside the project folder.");
  }
  if (parsed.username || parsed.password) {
    throw new ToolError("URLs with a username or password are refused; credentials do not belong in a fetched URL.");
  }
  return parsed;
}

export interface DownloadImageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface DownloadedImage {
  /** The image on disk, inside a temporary directory that is removed when the callback returns. */
  file: string;
  /** The URL the image finally came from, after redirects. */
  url: string;
  contentType: string;
  bytes: number;
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${bytes} bytes`;
}

async function fetchImageBytes(parsed: URL, options: DownloadImageOptions) {
  const timeoutMs = options.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? IMAGE_DOWNLOAD_MAX_BYTES;
  const tooLarge = () => new ToolError(`The image at ${parsed.href} is larger than ${megabytes(maxBytes)}.`);
  // One signal for the request and the body, so a slow download is cut off as well as a slow start.
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);

  try {
    const response = await fetch(parsed.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp" },
      redirect: "follow",
      signal,
    });
    const finalUrl = response.url || parsed.href;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ToolError(`HTTP ${response.status} ${response.statusText} for ${finalUrl}.`);
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const extension = extensionForContentType(contentType);
    if (!extension) {
      await response.body?.cancel().catch(() => {});
      if (!contentType.startsWith("image/")) {
        throw new ToolError(`${finalUrl} is not an image (content type "${contentType || "unknown"}"). Use fetch_url for pages.`);
      }
      throw new ToolError(`${contentType} images are not supported (${finalUrl}). Supported: png, jpeg, webp, gif, bmp.`);
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge();
    }

    // Content-Length can be missing or wrong, so the limit is enforced on what actually arrives.
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(value);
      }
    }
    if (total === 0) throw new ToolError(`The image at ${finalUrl} is empty.`);
    return { bytes: Buffer.concat(chunks), extension, contentType, url: finalUrl };
  } catch (error: any) {
    if (error instanceof ToolError) throw error;
    if (options.signal?.aborted) throw error; // the user cancelled: not something to retry
    if (error?.name === "TimeoutError") throw new ToolError(`Timed out fetching ${parsed.href} after ${Math.round(timeoutMs / 1000)} s.`);
    throw new ToolError(`Could not fetch ${parsed.href}: ${error?.cause?.message ?? error?.message ?? error}`);
  }
}

/**
 * Downloads an image into a fresh temporary directory, hands the file to `use`, and removes the
 * directory afterwards whatever happens: success, a refused download, a failing `use`, or an abort.
 */
export async function withDownloadedImage<T>(
  url: string,
  use: (image: DownloadedImage) => Promise<T>,
  options: DownloadImageOptions = {},
): Promise<T> {
  const parsed = parseImageUrl(url);
  const directory = await mkdtemp(join(tmpdir(), "view-image-"));
  try {
    const fetched = await fetchImageBytes(parsed, options);
    const file = join(directory, `image${fetched.extension}`);
    await writeFile(file, fetched.bytes);
    return await use({ file, url: fetched.url, contentType: fetched.contentType, bytes: fetched.bytes.byteLength });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
