// Renders PDF pages to PNG files. Run as its own Node process on purpose: PDF.js only renders
// correctly when unpdf is loaded as real ESM, and a plugin bundle (or tsx) loads it as CommonJS,
// where the buffer transfer fails with "Cannot transfer object of unsupported type".
//
// Usage: node pdf-worker.mjs render <pdf file> <output dir> <range|""> <scale> <maxPages>
//        node pdf-worker.mjs extract <pdf file> <range|"">
// Prints one line of JSON: {ok, ...result} or {ok:false, error}.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mode, file, ...rest] = process.argv.slice(2);

function parsePageRange(text, totalPages) {
  if (!text || !text.trim()) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set();
  for (const part of text.split(",").map(p => p.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new Error(`"${part}" is not a page or page range (use e.g. "1-3,7").`);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start) throw new Error(`Page range "${part}" is not valid.`);
    for (let page = start; page <= Math.min(end, totalPages); page++) pages.add(page);
  }
  if (pages.size === 0) throw new Error(`No pages selected: the document has ${totalPages} pages.`);
  return [...pages].sort((a, b) => a - b);
}

async function readBytes() {
  const buffer = await readFile(file);
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

try {
  const { getDocumentProxy, extractText, renderPageAsImage } = await import("unpdf");

  if (mode === "extract") {
    const [range] = rest;
    const document = await getDocumentProxy(await readBytes());
    const { text, totalPages } = await extractText(document, { mergePages: false });
    const selected = parsePageRange(range, totalPages);
    const pages = selected.map(page => ({ page, text: (text[page - 1] ?? "").trim() }));
    const characters = pages.reduce((sum, p) => sum + p.text.length, 0);
    console.log(JSON.stringify({ ok: true, totalPages, pages, looksScanned: characters < 50 * pages.length }));
    process.exit(0);
  }

  const [outputDirectory, range, scaleText, maxPagesText] = rest;
  const document = await getDocumentProxy(await readBytes());
  const totalPages = document.numPages;
  const selected = parsePageRange(range, totalPages);
  const maxPages = Number(maxPagesText);
  if (selected.length > maxPages) {
    throw new Error(`That is ${selected.length} pages; at most ${maxPages} can be rendered at a time. Use pages to select fewer.`);
  }

  await mkdir(outputDirectory, { recursive: true });
  const rendered = [];
  for (const page of selected) {
    const image = await renderPageAsImage(await readBytes(), page, {
      scale: Number(scaleText) || 2,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    const target = join(outputDirectory, `page-${String(page).padStart(3, "0")}.png`);
    await writeFile(target, Buffer.from(image));
    rendered.push({ page, file: target });
  }
  console.log(JSON.stringify({ ok: true, totalPages, rendered }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
}
