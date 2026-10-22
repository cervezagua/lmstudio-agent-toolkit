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
  /** The model's last answer. */
  answer: string;
  /** Its final answer to each turn, in order. */
  answers: string[];
  calls: Call[];
}

export interface EvalTask {
  /** What the task exercises: code, shell, git, documents, utilities, web, memory... `--only` takes these too. */
  area: string;
  /**
   * Written the way a user would ask: never name a tool. Several prompts are separate chats, one after
   * another, sharing the project and the memory folder (to see what carries over to a new chat).
   */
  prompt: string | string[];
  /** More messages in the same chat after the (last) prompt, each sent once the model has answered. */
  followUps?: string[];
  /** Prediction rounds per message (40), and minutes for the whole run (the --minutes option). */
  maxRounds?: number;
  minutes?: number;
  /**
   * Called as each tool result comes back, before the model sees it, to change the world under the
   * model (say, a teammate editing a file it just read). Must be synchronous.
   */
  afterCall?: (call: Call, dir: string) => void;
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
