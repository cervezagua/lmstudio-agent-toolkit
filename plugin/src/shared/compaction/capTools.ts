import { headAndTail } from "./mask";

/** Strings this short are left alone, whatever the budget: they are names, ids and statuses. */
const SMALL = 200;

/**
 * Wraps tools so no single result can fill the context: each text in a result keeps its head and
 * tail within `perResult` characters, and all results of one reply share `budget` characters. The
 * result keeps its shape (an MCP result stays an MCP result), since some callers check it. The tool
 * still runs in full; only what the model reads is cut, and it is told so. A tool that throws gives
 * an "Error: ..." result instead of ending the reply. `refill` restores the
 * shared budget, for when older output was hidden to make room; `fit` lowers it to the room the
 * context has left, so a reply already near full is not pushed past it by one big result.
 */
export function capTools<T extends { implementation: (...args: any[]) => any }>(
  tools: T[],
  options: { perResult: number; budget: number },
): T[] & { refill(): void; fit(chars: number): void } {
  let left = options.budget;
  const cap = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.length <= SMALL) return value;
      const allowed = Math.max(SMALL, Math.min(options.perResult, left));
      left = Math.max(0, left - Math.min(value.length, allowed));
      if (value.length <= allowed) return value;
      const note = left === 0 ? " The context for tool output is used up: answer with what you have rather than calling more tools." : "";
      return `${headAndTail(value, allowed)}\n[cut to fit the context; calling the tool again returns the same text.${note}]`;
    }
    if (Array.isArray(value)) return value.map(cap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cap(inner)]));
    return value;
  };
  const wrapped = tools.map(tool => ({
    ...tool,
    implementation: async (...args: any[]) => {
      try {
        return cap(await tool.implementation(...args));
      } catch (error: any) {
        // As in LM Studio's own loop, a tool that throws (a script that fails in js-code-sandbox,
        // say) gives the model an error to work with; left to the SDK, it ends the whole reply.
        const message = String(error?.message ?? error).replace(/^Error:\s*/, "");
        return cap(`Error: ${message.length > 4000 ? `${message.slice(0, 4000)} [...]` : message}`);
      }
    },
  }));
  return Object.assign(wrapped, {
    refill: () => void (left = options.budget),
    fit: (chars: number) => void (left = Math.max(0, Math.min(left, Math.floor(chars)))),
  });
}
