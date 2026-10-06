import { type LLM, type LMStudioClient } from "@lmstudio/sdk";
import { ToolError } from "../../../shared/errors";
import { configuredModelKey } from "../../../shared/models";

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

export const DEFAULT_OCR_PROMPT = [
  "Transcribe everything written in this image, exactly as it appears.",
  "Keep the reading order and the structure: headings, paragraphs, lists.",
  "Render tables as markdown tables. Write formulas as LaTeX.",
  "Do not summarize, explain or add anything that is not in the image.",
  "If part of it is unreadable, write [unreadable] there.",
].join(" ");

/** Finds a vision-capable model: the configured one, a loaded one, or a clear error. */
export async function pickVisionModel(client: LMStudioClient, configuredKey: string): Promise<LLM> {
  const key = configuredModelKey(configuredKey);
  if (key) {
    try {
      return await client.llm.model(key);
    } catch (error) {
      throw new ToolError(`Could not load the vision model "${key}": ${(error as Error).message}`);
    }
  }

  const loaded = await client.llm.listLoaded();
  for (const model of loaded) {
    const info = await model.getModelInfo().catch(() => null);
    if ((info as any)?.vision) return model as LLM;
  }
  const downloaded = await client.system.listDownloadedModels("llm").catch(() => []);
  const visionCapable = downloaded.filter(model => model.vision).map(model => model.modelKey);
  if (visionCapable.length > 0) {
    throw new ToolError(
      `No vision model is loaded. Load one of these in LM Studio (or set Vision Model in the plugin's Documents settings): ${visionCapable.slice(0, 5).join(", ")}.`,
    );
  }
  throw new ToolError("No vision-capable model is available. Download one in LM Studio (models marked 'Vision').");
}

export interface OcrPage {
  label: string;
  file: string;
  text: string;
}

/** The name to show for a vision model, when the handle carries one. */
export function visionModelName(model: LLM): string {
  const { modelKey, identifier } = model as Partial<Pick<LLM, "modelKey" | "identifier">>;
  return (typeof modelKey === "string" && modelKey) || (typeof identifier === "string" && identifier) || "";
}

/**
 * Sends one image with a prompt to the vision model and returns its reply: a transcription for
 * ocr_document, a description or an answer for view_image.
 */
export async function ocrImageFile(
  client: LMStudioClient,
  model: LLM,
  file: string,
  instructions: string,
  signal?: AbortSignal,
): Promise<string> {
  let handle;
  try {
    handle = await client.files.prepareImage(file);
  } catch (error) {
    throw new ToolError(`Could not read the image "${file}": ${(error as Error).message}`);
  }
  const result = await model.respond([{ role: "user", content: instructions, images: [handle] }], { signal });
  return result.nonReasoningContent.trim() || result.content.trim();
}
