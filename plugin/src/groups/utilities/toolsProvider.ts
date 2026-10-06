import { tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { safe } from "../../shared/errors";
import { calculate } from "./lib/calculate";
import { formatCurrentTime } from "./lib/currentTime";

export interface UtilityToolOptions {
  /** The clock, overridable for tests. */
  now?: () => Date;
}

/** The two things a small model gets wrong without help: arithmetic and today's date. */
export function makeUtilityTools({ now = () => new Date() }: UtilityToolOptions = {}): Tool[] {
  return [
    tool({
      name: "calculate",
      description:
        "Evaluate arithmetic exactly; use this instead of doing arithmetic yourself. " +
        'Takes one expression, e.g. "(1200 * 1.23) / 12", "15% of 240", "200 + 15%", "sqrt(2) * 10^3", "round(pi, 4)".',
      parameters: { expression: z.string() },
      implementation: safe(async ({ expression }) => calculate(expression)),
    }),
    tool({
      name: "current_time",
      description:
        "You do not know today's date; call this for the current date, time, weekday and week number. " +
        'Optional timezone is an IANA name such as "Europe/Lisbon"; the default is this computer\'s zone.',
      parameters: { timezone: z.string().optional() },
      implementation: safe(async ({ timezone }) => formatCurrentTime(now(), timezone)),
    }),
  ];
}

export async function toolsProvider(_ctl: ToolsProviderController): Promise<Tool[]> {
  return makeUtilityTools();
}
