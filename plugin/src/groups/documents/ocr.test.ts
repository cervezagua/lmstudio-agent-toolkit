import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { extractPdfText, parsePageRange, renderPdfPages } from "./lib/pdf";
import { DEFAULT_OCR_PROMPT, ocrImageFile, pickVisionModel } from "./lib/vision";
import { ToolError } from "../../shared/errors";
import { toolsProvider } from "./toolsProvider";

/** A small multi-page PDF with real text, built here so the tests need no fixtures. */
function makePdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  // 1 = catalog, 2 = pages, then per page: page object + content stream, then the font.
  let nextId = 3;
  for (let i = 0; i < pageTexts.length; i++) {
    pageIds.push(nextId++);
    contentIds.push(nextId++);
  }
  const fontId = nextId;

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  pageTexts.forEach((pageText, index) => {
    const stream = `BT /F1 14 Tf 40 150 Td (${pageText}) Tj ET`;
    objects[pageIds[index] - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[contentIds[index] - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

let root: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocr-root-"));
  work = await mkdtemp(join(tmpdir(), "ocr-work-"));
  await writeFile(join(root, "doc.pdf"), makePdf(["Invoice number 42", "Total due 99 EUR", "Thank you"]));
});

afterEach(async () => {
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  await rm(root, options).catch(() => {});
  await rm(work, options).catch(() => {});
});

describe("page ranges", () => {
  it("parses ranges, lists and single pages", () => {
    expect(parsePageRange(undefined, 3)).toEqual([1, 2, 3]);
    expect(parsePageRange("1-2,3", 5)).toEqual([1, 2, 3]);
    expect(parsePageRange("2", 5)).toEqual([2]);
    expect(parsePageRange("1-99", 3)).toEqual([1, 2, 3]); // clamped to the document
  });

  it("rejects nonsense", () => {
    expect(() => parsePageRange("abc", 3)).toThrow(ToolError);
    expect(() => parsePageRange("5-2", 9)).toThrow(/not valid/);
    expect(() => parsePageRange("9", 3)).toThrow(/No pages selected/);
  });
});

describe("PDF reading", () => {
  it("extracts the text layer per page and flags scanned documents", async () => {
    const result = await extractPdfText(join(root, "doc.pdf"));
    expect(result.totalPages).toBe(3);
    expect(result.pages[0].text).toContain("Invoice number 42");
    expect(result.pages[2].text).toContain("Thank you");
    expect(result.looksScanned).toBe(true); // very little text per page in this tiny fixture

    const onlyPage2 = await extractPdfText(join(root, "doc.pdf"), "2");
    expect(onlyPage2.pages.map(p => p.page)).toEqual([2]);
    expect(onlyPage2.pages[0].text).toContain("Total due");
  });

  it("renders pages to PNG files and enforces the page limit", async () => {
    const { totalPages, rendered } = await renderPdfPages(join(root, "doc.pdf"), join(work, "pages"), { range: "1-2", scale: 1, maxPages: 5 });
    expect(totalPages).toBe(3);
    expect(rendered.map(r => r.page)).toEqual([1, 2]);
    for (const page of rendered) {
      const png = await readFile(page.file);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG magic
      expect(png.length).toBeGreaterThan(500);
    }
    await expect(renderPdfPages(join(root, "doc.pdf"), join(work, "x"), { maxPages: 2 })).rejects.toThrow(/at most 2/);
  }, 60000);
});

describe("vision helpers", () => {
  const fakeClient = (loaded: any[], downloaded: any[] = []) =>
    ({
      llm: {
        listLoaded: async () => loaded,
        model: async (key: string) => {
          if (key === "broken") throw new Error("could not load");
          return { key };
        },
      },
      system: { listDownloadedModels: async () => downloaded },
      files: { prepareImage: async (path: string) => ({ path }) },
    }) as any;

  it("prefers the configured model and otherwise the first loaded vision model", async () => {
    const client = fakeClient([
      { getModelInfo: async () => ({ vision: false }), key: "text-only" },
      { getModelInfo: async () => ({ vision: true }), key: "sees" },
    ]);
    expect(await pickVisionModel(client, "chosen")).toMatchObject({ key: "chosen" });
    expect(await pickVisionModel(client, "")).toMatchObject({ key: "sees" });
    await expect(pickVisionModel(client, "broken")).rejects.toThrow(/Could not load the vision model/);
  });

  it("names downloadable vision models when none is loaded", async () => {
    const client = fakeClient([{ getModelInfo: async () => ({ vision: false }) }], [{ vision: true, modelKey: "qwen/qwen3.8-27b" }]);
    await expect(pickVisionModel(client, "")).rejects.toThrow(/No vision model is loaded.*qwen\/qwen3.8-27b/s);

    const none = fakeClient([], []);
    await expect(pickVisionModel(none, "")).rejects.toThrow(/No vision-capable model is available/);
  });

  it("sends the image with the OCR prompt and returns the transcription", async () => {
    const seen: any = {};
    const model = {
      respond: async (messages: any[], opts: any) => {
        seen.messages = messages;
        seen.opts = opts;
        return { content: "<think>hm</think>Invoice 42", nonReasoningContent: "Invoice 42" };
      },
    } as any;
    const result = await ocrImageFile(fakeClient([]), model, "page.png", DEFAULT_OCR_PROMPT);
    expect(result).toBe("Invoice 42"); // reasoning stripped
    expect(seen.messages[0].images).toEqual([{ path: "page.png" }]);
    expect(seen.messages[0].content).toContain("Transcribe everything");
  });
});

describe("ocr-tools toolsProvider", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    projectFolder: root,
    visionModel: "",
    renderScale: 1,
    maxPages: 10,
    maxOutputChars: 20000,
    ...overrides,
  });

  const provider = (overrides: Record<string, unknown> = {}) =>
    toolsProvider(fakeController({ config: config(overrides), workingDirectory: work }));

  it("registers its tools", async () => {
    expect((await provider()).map(t => t.name)).toEqual(["read_document_text", "ocr_document", "pdf_to_images"]);
  });

  it("reads a PDF's text layer and warns that it looks scanned", async () => {
    const tools = await provider();
    const output = await callTool(tools, "read_document_text", { path: "doc.pdf" });
    expect(output).toContain("doc.pdf (3 pages)");
    expect(output).toContain("Invoice number 42");
    expect(output).toContain("it is probably scanned");
  });

  it("renders pages to files inside the root", async () => {
    const tools = await provider();
    const output = await callTool(tools, "pdf_to_images", { path: "doc.pdf", pages: "1" });
    expect(output).toMatch(/Rendered 1 of 3 pages/);
    expect(output).toContain("page 1: ocr-pages/page-001.png");
    expect((await readFile(join(root, "ocr-pages", "page-001.png"))).length).toBeGreaterThan(500);
  }, 60000);

  it("refuses files outside the root and unsupported types", async () => {
    const tools = await provider();
    expect(await callTool(tools, "read_document_text", { path: "../outside.pdf" })).toMatch(/^Error: .*outside the allowed root/);
    await writeFile(join(root, "notes.txt"), "hello");
    expect(await callTool(tools, "ocr_document", { path: "notes.txt" })).toMatch(/^Error: .*neither a PDF nor a supported image/);
  });
});
