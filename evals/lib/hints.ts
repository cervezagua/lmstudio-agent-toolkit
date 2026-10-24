/** One tool call as a run's trace records it. */
export interface TracedCall {
  name: string;
  args: string;
  result: string;
  failed?: boolean;
}

/**
 * The kinds of error a tool gives, most specific first. Several of them carry a hint (the closest
 * text, a likely path); comparing them with the plain ones shows whether the hint helps.
 */
export const ERROR_KINDS: { kind: string; pattern: RegExp }[] = [
  { kind: "edit missed, closest text shown", pattern: /closest text is at|spaces or indentation differ/ },
  { kind: "edit missed, no close text", pattern: /old_string was not found[\s\S]*Read the file again/ },
  { kind: "path missing, likely one suggested", pattern: /does not exist[\s\S]*Did you mean:/ },
  { kind: "path missing, nothing suggested", pattern: /does not exist/ },
  { kind: "edit before reading", pattern: /have not read/ },
  { kind: "file changed since read", pattern: /changed on disk/ },
  { kind: "file too big to read whole", pattern: /limit for a whole-file read/ },
];

export function errorKind(result: string): string {
  return ERROR_KINDS.find(k => k.pattern.test(result))?.kind ?? "other error";
}

export interface ErrorStat {
  kind: string;
  seen: number;
  /** The model's next call to the same tool worked. */
  nextTryWorked: number;
  /** Calls from the error to the same tool's next success, for the errors that got there. */
  callsToSuccess: number[];
  /** No later call to that tool worked in the run. */
  neverRecovered: number;
}

/**
 * What the model did after each kind of error: whether its next call to the same tool worked, and
 * how many calls it took to get one that did. A hint that helps shows as more next tries working
 * and fewer calls in between than the plain error of the same sort.
 */
export function errorStats(traces: TracedCall[][]): ErrorStat[] {
  const stats = new Map<string, ErrorStat>();
  for (const trace of traces) {
    trace.forEach((call, i) => {
      if (!call.failed) return;
      const kind = errorKind(call.result);
      const stat = stats.get(kind) ?? { kind, seen: 0, nextTryWorked: 0, callsToSuccess: [], neverRecovered: 0 };
      stat.seen++;
      const later = trace.slice(i + 1);
      const next = later.find(c => c.name === call.name);
      if (next && !next.failed) stat.nextTryWorked++;
      const success = later.findIndex(c => c.name === call.name && !c.failed);
      if (success === -1) stat.neverRecovered++;
      else stat.callsToSuccess.push(success + 1);
      stats.set(kind, stat);
    });
  }
  return [...stats.values()].sort((a, b) => b.seen - a.seen);
}
