import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { ToolError } from "../shared/errors";
import { runProcess } from "../shared/process";

/** Parses a page range like "1-3,7,10-12" into sorted, unique 1-based page numbers. */
export function parsePageRange(range: string | undefined, totalPages: number): number[] {
  if (!range || !range.trim()) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of range.split(",").map(p => p.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new ToolError(`"${part}" is not a page or page range (use e.g. "1-3,7").`);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start) throw new ToolError(`Page range "${part}" is not valid.`);
    for (let page = start; page <= Math.min(end, totalPages); page++) pages.add(page);
  }
  if (pages.size === 0) throw new ToolError(`No pages selected: the document has ${totalPages} pages.`);
  return [...pages].sort((a, b) => a - b);
}

export interface PdfTextResult {
  totalPages: number;
  pages: Array<{ page: number; text: string }>;
  /** True when the PDF carries almost no text layer, i.e. it is probably scanned and needs OCR. */
  looksScanned: boolean;
}

export interface RenderedPage {
  page: number;
  file: string;
}

/** Locates pdf-worker.mjs, both in the bundled plugin (.lmstudio/) and when running from source. */
function workerPath(): string {
  const candidates = [
    join(__dirname, "pdf-worker.mjs"), // running from src/lib (tests, tsx)
    join(__dirname, "..", "src", "lib", "pdf-worker.mjs"), // bundled into <plugin>/.lmstudio/
    join(__dirname, "..", "..", "src", "lib", "pdf-worker.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ToolError("The PDF worker script (pdf-worker.mjs) is missing from the plugin folder.");
}

/**
 * Runs the PDF worker in its own Node process. PDF.js hands buffers to its worker, which only
 * works when unpdf is loaded as real ESM; this plugin is bundled as CommonJS, where that transfer
 * fails with "Cannot transfer object of unsupported type".
 */
async function runWorker<T>(args: string[], signal?: AbortSignal, timeoutMs = 300_000): Promise<T> {
  const script = workerPath();
  const result = await runProcess(process.execPath, [script, ...args], { cwd: dirname(script), timeoutMs, signal });
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: { ok: boolean; error?: string } & Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    if (result.timedOut) throw new ToolError("Reading the PDF timed out.");
    throw new ToolError(`Could not read the PDF: ${result.stderr.trim() || line || "no output"}`);
  }
  if (!parsed.ok) throw new ToolError(String(parsed.error ?? "Could not read the PDF."));
  return parsed as unknown as T;
}

/** Reads the text layer of a PDF. Fast and exact, but blank for scanned documents. */
export async function extractPdfText(file: string, range?: string, signal?: AbortSignal): Promise<PdfTextResult> {
  return runWorker<PdfTextResult>(["extract", file, range ?? ""], signal, 120_000);
}

/** Renders PDF pages to PNG files so a vision model can read them. */
export async function renderPdfPages(
  file: string,
  outputDirectory: string,
  options: { range?: string; scale?: number; maxPages: number; signal?: AbortSignal },
): Promise<{ totalPages: number; rendered: RenderedPage[] }> {
  await mkdir(outputDirectory, { recursive: true });
  return runWorker<{ totalPages: number; rendered: RenderedPage[] }>(
    ["render", file, outputDirectory, options.range ?? "", String(options.scale ?? 2), String(options.maxPages)],
    options.signal,
  );
}
