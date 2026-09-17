// Test-only helpers: drive a plugin's toolsProvider / preprocessor without LM Studio running.
// Not synced into plugins (sync-shared only copies top-level files).

export interface FakeControllerOptions {
  config?: Record<string, unknown>;
  globalConfig?: Record<string, unknown>;
  workingDirectory: string;
  /** For prompt preprocessors: the chat history before the current message (an SDK `Chat`). */
  history?: unknown;
}

function parsedConfig(values: Record<string, unknown>) {
  return {
    get(key: string) {
      if (key in values) return values[key];
      throw new Error(`Config key "${key}" not provided to fake controller`);
    },
  };
}

export function fakeController({ config = {}, globalConfig = {}, workingDirectory, history }: FakeControllerOptions) {
  const abort = new AbortController();
  const statuses: unknown[] = [];
  return {
    client: undefined as any,
    abortSignal: abort.signal,
    statuses,
    getWorkingDirectory: () => workingDirectory,
    getPluginConfig: () => parsedConfig(config),
    getGlobalPluginConfig: () => parsedConfig(globalConfig),
    pullHistory: async () => history,
    createStatus: (state: unknown) => {
      statuses.push(state);
      return { setState: (next: unknown) => statuses.push(next) };
    },
  } as any;
}

/**
 * Mirrors the SDK's tool call context, where `status` and `warn` are methods that use `this`: a tool
 * that destructures them (`{ status }`) crashes in LM Studio, and must crash here too.
 */
class FakeToolCallContext {
  readonly statuses: string[] = [];
  readonly warnings: string[] = [];
  readonly signal = new AbortController().signal;
  readonly callId = 0;
  status(text: string) {
    this.statuses.push(text);
  }
  warn(text: string) {
    this.warnings.push(text);
  }
}

export function fakeToolContext() {
  const ctx = new FakeToolCallContext();
  return { ctx, statuses: ctx.statuses, warnings: ctx.warnings };
}

/** Looks up a tool by name and calls it after validating params like LM Studio would. */
export async function callTool(tools: any[], name: string, params: Record<string, unknown>) {
  const found = tools.find(t => t.name === name);
  if (!found) throw new Error(`Tool "${name}" not registered. Have: ${tools.map(t => t.name).join(", ")}`);
  found.checkParameters(params);
  return found.implementation(params, fakeToolContext().ctx);
}
