import { text, tool, type LLM, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { mkdir, mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, extname, join } from "path";
import { z } from "zod";
import { configSchematics } from "../../config";
import { extractPdfText, renderPdfPages } from "./lib/pdf";
import { buildViewPrompt, looksLikeUrl, parseImageUrl, withDownloadedImage } from "./lib/viewImage";
import { markdownToDocxBuffer } from "./lib/writeDocx";
import { htmlToPdfBuffer, markdownToPrintHtml } from "./lib/writePdf";
import { DEFAULT_OCR_PROMPT, IMAGE_EXTENSIONS, ocrImageFile, pickVisionModel, visionModelName } from "./lib/vision";
import { safe, ToolError } from "../../shared/errors";
import { isChatStateFile, readMode } from "../../shared/mode";
import { displayPath, resolveSafe } from "../../shared/paths";
import { projectRoot } from "../../shared/projectFolder";
import { writeFileAtomic } from "../../shared/safeWrite";
import { truncate } from "../../shared/truncate";

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);
  const { root } = projectRoot(config.get("projectFolder"), () => ctl.getWorkingDirectory());
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

  /** Resolves a path a tool is about to change, refusing the toolkit's own chat state files. */
  const resolveWritable = async (path: string) => {
    const file = await resolveSafe(root, path);
    if (isChatStateFile(ctl.getWorkingDirectory(), file)) {
      throw new ToolError(`${show(file)} is managed by the toolkit and cannot be changed by a tool.`);
    }
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
        Transcribe the exact text of a scanned PDF or an image (png, jpg, webp, gif, bmp), using a
        vision model in LM Studio; to ask what an image shows, use view_image. Pages of a PDF are
        read one at a time, so use pages ("1-3,7") to limit how many. instructions can steer the
        transcription, e.g. "only the table".
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
      name: "view_image",
      description: text`
        Have a vision model look at an image and describe it, or answer a question about it: what a
        screenshot shows, a colour, a chart. image is a path in the project folder or an http(s)
        URL (png, jpg, webp, gif, bmp). For the exact text of an image, use ocr_document.
      `,
      parameters: { image: z.string(), question: z.string().optional() },
      implementation: safe(async ({ image, question }, ctx) => {
        const prompt = buildViewPrompt(question);
        const look = async (model: LLM, file: string, label: string) => {
          const name = visionModelName(model);
          ctx.status(`Looking at ${label}`);
          const answer = await ocrImageFile(ctl.client, model, file, prompt, ctx.signal);
          const source = `[Answer from the vision model${name ? ` ${name}` : ""}, which looked at the image.]`;
          return `${label}\n${source}\n\n${truncate(answer || "(the vision model returned nothing)", maxOutputChars)}`;
        };

        if (looksLikeUrl(image)) {
          // Refuse a bad URL, then a missing model, before anything is downloaded.
          const url = parseImageUrl(image).href;
          const model = await pickVisionModel(ctl.client, config.get("visionModel"));
          ctx.status(`Downloading ${url}`);
          return await withDownloadedImage(url, downloaded => look(model, downloaded.file, url), { signal: ctx.signal });
        }

        const file = await resolveDocument(image);
        if (!IMAGE_EXTENSIONS.some(extension => file.toLowerCase().endsWith(extension))) {
          throw new ToolError(`"${image}" is not a supported image (${IMAGE_EXTENSIONS.join(", ")}). For a PDF, use ocr_document.`);
        }
        return await look(await pickVisionModel(ctl.client, config.get("visionModel")), file, show(file));
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

  // Plan mode (the Memory group's): while planning, tools that change things are not offered.
  const planning = (await readMode(ctl.getWorkingDirectory())).planning;

  if (!planning) {
    tools.push(
      tool({
        name: "write_document",
        description: text`
          Write markdown as a Word (.docx) or PDF (.pdf) file in the project folder; the extension of
          path picks the format. Headings, lists, tables, code and links are kept; images are left
          out. Refuses to replace an existing file unless overwrite is true. For text formats (.md,
          .csv, .html) use write_file.
        `,
        parameters: { path: z.string(), content: z.string(), overwrite: z.boolean().optional() },
        implementation: safe(async ({ path, content, overwrite }, ctx) => {
          const extension = extname(path).toLowerCase();
          if (extension !== ".docx" && extension !== ".pdf") {
            throw new ToolError(
              `write_document writes Word (.docx) and PDF (.pdf) files, so "${path}" must end in .docx or .pdf. ` +
                "For text formats such as .md, .csv or .html, use write_file.",
            );
          }
          if (!content.trim()) throw new ToolError("content is empty: pass the document as markdown.");

          const file = await resolveWritable(path);
          const existing = await stat(file).catch(() => null);
          if (existing?.isDirectory()) throw new ToolError(`"${path}" is a directory.`);
          if (existing && !overwrite) {
            throw new ToolError(`${show(file)} already exists. Pass overwrite: true to replace it, or choose another name.`);
          }

          const title = basename(file, extname(file));
          let buffer: Buffer;
          let omittedImages: number;
          if (extension === ".docx") {
            ctx.status(`Writing ${show(file)}`);
            ({ buffer, omittedImages } = await markdownToDocxBuffer(content, title));
          } else {
            const page = await markdownToPrintHtml(content, title);
            omittedImages = page.omittedImages;
            ctx.status(`Printing ${show(file)}`);
            buffer = await htmlToPdfBuffer(page.html, config.get("browserChannel"), { signal: ctx.signal });
          }

          await mkdir(dirname(file), { recursive: true });
          await writeFileAtomic(file, buffer);
          const left =
            omittedImages === 0
              ? ""
              : ` ${omittedImages} image${omittedImages === 1 ? " was" : "s were"} left out (images are not embedded; the alt text is kept in brackets).`;
          return `${existing ? "Overwrote" : "Created"} ${show(file)} (${extension === ".docx" ? "Word" : "PDF"}, ${formatSize(buffer.length)}).${left}`;
        }),
      }),
    );
  }

  return tools;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
