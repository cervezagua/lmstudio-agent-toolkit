import { text, tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import { configSchematics } from "../../config";
import { extractPdfText, renderPdfPages } from "./lib/pdf";
import { DEFAULT_OCR_PROMPT, ocrImageFile, pickVisionModel } from "./lib/vision";
import { safe, ToolError } from "../../shared/errors";
import { displayPath, resolveSafe } from "../../shared/paths";
import { truncate } from "../../shared/truncate";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);
  const root = config.get("projectFolder").trim() || ctl.getWorkingDirectory();
  const maxOutputChars = config.get("maxOutputChars");
  const show = (path: string) => displayPath(root, path);

  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Project Folder "${root}" does not exist or is not a directory.`);
  }

  const resolveDocument = async (path: string) => {
    const file = await resolveSafe(root, path);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new ToolError(`"${path}" is not a file.`);
    return file;
  };

  const tools: Tool[] = [];

  tools.push(
    tool({
      name: "read_document_text",
      description: text`
        Read the text layer of a PDF: fast, exact and free, but blank for scanned documents and
        images. Always try this first for a PDF; it tells you if the document is scanned, in which
        case use ocr_document. Use pages ("1-3,7") for long documents.
      `,
      parameters: { path: z.string(), pages: z.string().optional() },
      implementation: safe(async ({ path, pages }, ctx) => {
        const file = await resolveDocument(path);
        const result = await extractPdfText(file, pages, ctx.signal);
        const body = result.pages.map(p => `--- page ${p.page} of ${result.totalPages} ---\n${p.text || "(no text on this page)"}`).join("\n\n");
        const hint = result.looksScanned
          ? "\n\n[This PDF has almost no text layer: it is probably scanned. Use ocr_document to read it.]"
          : "";
        return `${show(file)} (${result.totalPages} pages)\n\n${truncate(body, maxOutputChars)}${hint}`;
      }),
    }),
  );

  tools.push(
    tool({
      name: "ocr_document",
      description: text`
        Read a scanned PDF or an image (png, jpg, webp, gif, bmp) and return its content as text,
        using a vision model in LM Studio. Pages of a PDF are read one at a time, so use pages
        ("1-3,7") to limit how many. instructions can steer the transcription, e.g. "only the table".
      `,
      parameters: { path: z.string(), pages: z.string().optional(), instructions: z.string().optional() },
      implementation: safe(async ({ path, pages, instructions }, ctx) => {
        const file = await resolveDocument(path);
        const isPdf = file.toLowerCase().endsWith(".pdf");
        const isImage = IMAGE_EXTENSIONS.some(extension => file.toLowerCase().endsWith(extension));
        if (!isPdf && !isImage) {
          throw new ToolError(`"${path}" is neither a PDF nor a supported image (${IMAGE_EXTENSIONS.join(", ")}).`);
        }

        const model = await pickVisionModel(ctl.client, config.get("visionModel"));
        const prompt = instructions?.trim() ? `${DEFAULT_OCR_PROMPT}\n\nAdditional instruction: ${instructions.trim()}` : DEFAULT_OCR_PROMPT;

        if (isImage) {
          ctx.status(`Reading ${show(file)}`);
          const transcription = await ocrImageFile(ctl.client, model, file, prompt, ctx.signal);
          return `${show(file)}\n\n${truncate(transcription, maxOutputChars)}`;
        }

        const workDirectory = await mkdtemp(join(tmpdir(), "ocr-pages-"));
        try {
          ctx.status("Rendering PDF pages");
          const { totalPages, rendered } = await renderPdfPages(file, workDirectory, {
            range: pages,
            scale: config.get("renderScale"),
            maxPages: config.get("maxPages"),
            signal: ctx.signal,
          });
          const parts: string[] = [];
          for (const page of rendered) {
            ctx.status(`Reading page ${page.page} of ${totalPages}`);
            const transcription = await ocrImageFile(ctl.client, model, page.file, prompt, ctx.signal);
            parts.push(`--- page ${page.page} of ${totalPages} ---\n${transcription}`);
          }
          return `${show(file)} (${rendered.length} of ${totalPages} pages)\n\n${truncate(parts.join("\n\n"), maxOutputChars)}`;
        } finally {
          await rm(workDirectory, { recursive: true, force: true }).catch(() => {});
        }
      }),
    }),
  );

  tools.push(
    tool({
      name: "pdf_to_images",
      description: text`
        Render PDF pages as PNG files and return their paths, without reading them. Useful when the
        user wants the page images themselves, or to inspect one page closely afterwards.
      `,
      parameters: { path: z.string(), pages: z.string().optional(), output_directory: z.string().optional() },
      implementation: safe(async ({ path, pages, output_directory }, ctx) => {
        const file = await resolveDocument(path);
        const target = await resolveSafe(root, output_directory ?? "ocr-pages");
        ctx.status("Rendering PDF pages");
        const { totalPages, rendered } = await renderPdfPages(file, target, {
          range: pages,
          scale: config.get("renderScale"),
          maxPages: config.get("maxPages"),
        });
        return `Rendered ${rendered.length} of ${totalPages} pages of ${show(file)}:\n${rendered.map(p => `page ${p.page}: ${show(p.file)}`).join("\n")}`;
      }),
    }),
  );

  return tools;
}
