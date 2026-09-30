import { LMStudioClient } from "@lmstudio/sdk";

/** The dropdown's first choice: let the tool pick a model, as an empty text field used to. */
export const AUTO_MODEL = "auto";

/** The model key a setting names, or "" to pick one automatically ("" and "auto" both mean that). */
export function configuredModelKey(value: string): string {
  const key = value.trim();
  return key === AUTO_MODEL ? "" : key;
}

export interface ModelOption {
  value: string;
  displayName: string;
}

export interface ModelChoices {
  vision: ModelOption[];
  subagent: ModelOption[];
}

interface DownloadedModel {
  modelKey: string;
  displayName?: string;
  vision?: boolean;
  trainedForToolUse?: boolean;
}

/**
 * Turns the downloaded models into dropdown options. Both dropdowns offer every model: a model's
 * vision and tool-use flags are not always set, and the text field these replace accepted any key,
 * so filtering on them would take away choices that work. The flags only order the list and label
 * the likely fits: vision models first for OCR, tool-use models first for the sub-agent.
 *
 * A dropdown refuses duplicate values and one model key can be listed more than once, so keys are
 * deduplicated; two models that share a display name are told apart by their key.
 */
export function toModelChoices(models: DownloadedModel[]): ModelChoices {
  const byKey = new Map<string, DownloadedModel>();
  for (const model of models) {
    const key = model.modelKey?.trim();
    if (key && key !== AUTO_MODEL && !byKey.has(key)) byKey.set(key, model);
  }
  const named = [...byKey.entries()].map(([key, model]) => ({ key, model, name: model.displayName?.trim() || key }));
  const counts = new Map<string, number>();
  for (const { name } of named) counts.set(name, (counts.get(name) ?? 0) + 1);

  const options = (fits: (model: DownloadedModel) => boolean, label: string): ModelOption[] =>
    named
      .map(({ key, model, name }) => ({
        value: key,
        name: counts.get(name)! > 1 ? `${name} (${key})` : name,
        fits: Boolean(fits(model)),
      }))
      .sort((a, b) => Number(b.fits) - Number(a.fits) || a.name.localeCompare(b.name))
      .map(({ value, name, fits: fit }) => ({ value, displayName: fit ? `${name} · ${label}` : name }));

  return {
    vision: options(model => model.vision === true, "vision"),
    subagent: options(model => model.trainedForToolUse === true, "tool use"),
  };
}

/**
 * Lists the available models when the plugin starts, so the model settings can be dropdowns. The
 * SDK gives a plugin no client until a tool runs, so this builds its own from the credentials
 * LM Studio's plugin bootstrap reads from the environment. Any problem returns null, and the
 * settings stay plain text fields: a dropdown is a convenience, never a reason to fail to start.
 *
 * Loaded models are listed as well as downloaded ones, so a model that is loaded without being a
 * local download (one served through LM Link, say) can still be chosen.
 */
export async function listModelChoices(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000,
  makeClient: (options: ConstructorParameters<typeof LMStudioClient>[0]) => LMStudioClient = options =>
    new LMStudioClient(options),
): Promise<ModelChoices | null> {
  const clientIdentifier = env.LMS_PLUGIN_CLIENT_IDENTIFIER;
  const clientPasskey = env.LMS_PLUGIN_CLIENT_PASSKEY;
  if (!clientIdentifier || !clientPasskey) return null;

  let client: LMStudioClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connected = makeClient({ clientIdentifier, clientPasskey, baseUrl: env.LMS_PLUGIN_BASE_URL });
    client = connected;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out listing models")), timeoutMs);
    });
    const listing = Promise.all([
      connected.system.listDownloadedModels("llm"),
      connected.llm.listLoaded().catch(() => []),
    ]);
    const [downloaded, loaded] = await Promise.race([listing, timeout]);
    return toModelChoices([...(loaded as DownloadedModel[]), ...(downloaded as DownloadedModel[])]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    // Not awaited: disposing waits for calls still in flight, so after a timeout it could wait
    // forever and hold up the whole plugin's startup, which the timeout exists to prevent.
    if (client) void client[Symbol.asyncDispose]().catch(() => {});
  }
}
