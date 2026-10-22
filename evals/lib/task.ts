/** One tool call the model made, with what came back. */
export interface Call {
  name: string;
  args: string;
  result: string;
  failed: boolean;
}

/** What a check gets after a run: the project folder as the model left it, its calls and its last answer. */
export interface RunRecord {
  dir: string;
  answer: string;
  calls: Call[];
}

export interface EvalTask {
  /** What the task exercises: code, shell, git, documents, utilities, web, memory... `--only` takes these too. */
  area: string;
  /** Written the way a user would ask: never name a tool. */
  prompt: string;
  /** Settings that differ from the plugin's defaults, such as a group to switch on. */
  config?: Record<string, unknown>;
  /** Runs after the task's project/ folder is copied, for what cannot be a plain file (a git history, a PDF). */
  setup?: (dir: string) => Promise<void>;
  /** Returns what is wrong; an empty list is a pass. Checks the outcome, not which tools were used. */
  check: (run: RunRecord) => Promise<string[]>;
}

/** The digits of every number in a text, with thousands separators removed: "18,240.75" -> "18240.75". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n => n.replace(/,/g, ""));
}
