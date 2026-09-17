import { type LLM, type LMStudioClient } from "@lmstudio/sdk";
import { ToolError } from "../../../shared/errors";

export const DEFAULT_OCR_PROMPT = [
  "Transcribe everything written in this image, exactly as it appears.",
  "Keep the reading order and the structure: headings, paragraphs, lists.",
  "Render tables as markdown tables. Write formulas as LaTeX.",
  "Do not summarize, explain or add anything that is not in the image.",
  "If part of it is unreadable, write [unreadable] there.",
].join(" ");

/** Finds a vision-capable model: the configured one, a loaded one, or a clear error. */
export async function pickVisionModel(client: LMStudioClient, configuredKey: string): Promise<LLM> {
  const key = configuredKey.trim();
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
      `No vision model is loaded. Load one of these in LM Studio (or set it in the ocr-tools settings): ${visionCapable.slice(0, 5).join(", ")}.`,
    );
  }
  throw new ToolError("No vision-capable model is available. Download one in LM Studio (models marked 'Vision').");
}

export interface OcrPage {
  label: string;
  file: string;
  text: string;
}

/** Sends one image to the vision model and returns its transcription. */
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
