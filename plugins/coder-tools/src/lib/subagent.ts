import { type LLM, type LMStudioClient, type Tool } from "@lmstudio/sdk";
import { ToolError } from "../shared/errors";

export const SUBAGENT_SYSTEM_PROMPT = [
  "You are a research sub-agent working inside a larger task.",
  "Use the read-only tools to investigate the project and answer the question you were given.",
  "You cannot change files or run commands that change anything.",
  "Finish with a compact report: the answer, the file paths and line numbers that matter, and anything the main agent still needs to decide.",
].join(" ");

/** Picks the model to run the sub-agent on: the configured one, or the first loaded model. */
export async function pickSubagentModel(client: LMStudioClient, configuredKey: string): Promise<LLM> {
  const key = configuredKey.trim();
  if (key) {
    try {
      return await client.llm.model(key);
    } catch (error) {
      throw new ToolError(`Could not load the sub-agent model "${key}": ${(error as Error).message}`);
    }
  }
  const loaded = await client.llm.listLoaded();
  if (loaded.length === 0) {
    throw new ToolError("No model is loaded for the sub-agent. Load one, or set a model in the coder-tools settings.");
  }
  return loaded[0] as LLM;
}

export interface SubagentResult {
  report: string;
  rounds: number;
  toolCalls: string[];
}

/**
 * Runs a nested agent loop on the local model with a read-only tool set. Its purpose is context
 * isolation: a search-heavy sub-task runs in its own conversation and only the summary comes back.
 */
export async function runSubagent(options: {
  model: LLM;
  tools: Tool[];
  task: string;
  maxRounds: number;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}): Promise<SubagentResult> {
  const toolCalls: string[] = [];
  let rounds = 0;
  let report = "";

  await options.model.act(
    [
      { role: "system", content: SUBAGENT_SYSTEM_PROMPT },
      { role: "user", content: options.task },
    ],
    options.tools,
    {
      maxPredictionRounds: options.maxRounds,
      signal: options.signal,
      onRoundStart: index => {
        rounds = index + 1;
        options.onProgress?.(`sub-agent round ${index + 1}`);
      },
      onMessage: message => {
        for (const request of message.getToolCallRequests()) toolCalls.push(request.name);
        if (message.getRole() === "assistant") {
          const text = message.getText().trim();
          if (text) report = text; // keep the latest assistant text as the report
        }
      },
    },
  );

  return { report: report || "(the sub-agent finished without a written report)", rounds, toolCalls };
}
