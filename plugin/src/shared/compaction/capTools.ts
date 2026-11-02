import { headAndTail } from "./mask";

/** Strings this short are left alone, whatever the budget: they are names, ids and statuses. */
const SMALL = 200;

/**
 * Wraps tools so no single result can fill the context: each text in a result keeps its head and
 * tail within `perResult` characters, and all results of one reply share `budget` characters. The
 * result keeps its shape (an MCP result stays an MCP result), since some callers check it. The tool
 * still runs in full; only what the model reads is cut, and it is told so. A tool that throws gives
 * an "Error: ..." result instead of ending the reply. `refill` restores the
 * shared budget, for when the reply starts over on a new prompt; `fit` sets the room the context has
 * left, so a reply already near full is not pushed past it by one big result.
 */
export function capTools<T extends { implementation: (...args: any[]) => any }>(
  tools: T[],
  options: { perResult: number; budget: number },
): T[] & { refill(): void; fit(chars: number): void } {
  // Characters handed out since the last refill, and the room left in the context as last told.
  let spent = 0;
  let room = Infinity;
  const left = () => Math.max(0, Math.min(options.budget - spent, room));
  const spend = (chars: number) => {
    spent += chars;
    room -= chars;
  };
  const allowance = () => Math.max(SMALL, Math.min(options.perResult, left()));
  // `strict`: the result as a whole is over its allowance, so short texts count too, and long
  // lists are cut (a thousand file names escape a cap on each text).
  const cap = (value: unknown, strict: boolean): unknown => {
    if (typeof value === "string") {
      if (value.length <= SMALL) {
        if (strict) spend(value.length);
        return value;
      }
      const allowed = allowance();
      spend(Math.min(value.length, allowed));
      if (value.length <= allowed) return value;
      const note = left() === 0 ? " The context for tool output is used up: answer with what you have rather than calling more tools." : "";
      return `${headAndTail(value, allowed)}\n[cut to fit the context; calling the tool again returns the same text.${note}]`;
    }
    if (Array.isArray(value)) return (strict ? fewer(value) : value).map(item => cap(item, strict));
    if (value && typeof value === "object") {
      // A Date, URL or Buffer rebuilt key by key would lose what it is: it goes as the JSON it
      // would be sent as anyway.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const json = JSON.stringify(value);
        return json === undefined ? value : cap(JSON.parse(json), strict);
      }
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cap(inner, strict)]));
    }
    return value;
  };
  /** A long list's first and last items, as many as fit the allowance, and how many were left out. */
  const fewer = (items: unknown[]): unknown[] => {
    const allowed = allowance();
    if ((JSON.stringify(items)?.length ?? 0) <= allowed) return items;
    const sizes = items.map(item => (JSON.stringify(item)?.length ?? 4) + 1);
    let head = 0;
    let tail = 0;
    let used = 50;
    while (head + tail < items.length) {
      const fromHead = head <= tail;
      const size = fromHead ? sizes[head] : sizes[items.length - 1 - tail];
      if (used + size > allowed) break;
      used += size;
      if (fromHead) head++;
      else tail++;
    }
    // At least the first item, cut down itself if it is long.
    if (head + tail === 0) head = 1;
    if (head + tail >= items.length) return items;
    return [...items.slice(0, head), `[${items.length - head - tail} items left out to fit the context]`, ...items.slice(items.length - tail)];
  };
  const capResult = (value: unknown) => cap(value, (JSON.stringify(value)?.length ?? 0) > allowance());
  const wrapped = tools.map(tool => ({
    ...tool,
    implementation: async (...args: any[]) => {
      try {
        return capResult(await tool.implementation(...args));
      } catch (error: any) {
        // As in LM Studio's own loop, a tool that throws (a script that fails in js-code-sandbox,
        // say) gives the model an error to work with; left to the SDK, it ends the whole reply.
        const message = String(error?.message ?? error).replace(/^Error:\s*/, "");
        return capResult(`Error: ${message.length > 4000 ? `${message.slice(0, 4000)} [...]` : message}`);
      }
    },
  }));
  return Object.assign(wrapped, {
    refill: () => {
      spent = 0;
      room = Infinity;
    },
    fit: (chars: number) => void (room = Math.max(0, Math.floor(chars))),
  });
}
