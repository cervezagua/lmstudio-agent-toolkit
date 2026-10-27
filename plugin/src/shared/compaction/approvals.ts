import { readFile } from "fs/promises";
import { join } from "path";

/** Whether a tool may run without asking: true when the user told LM Studio never to ask about it. */
export type Approvals = (pluginIdentifier: string | undefined, toolName: string) => boolean;

/**
 * The user's "Always allow" choices, as LM Studio's own loop follows them: "Always allow" in a
 * confirmation adds a pattern such as "local/agent-toolkit:*" or "local/agent-toolkit:run_command" to
 * chat.skipToolConfirmationPatterns in LM Studio's settings.json, and chat.neverAskForToolConfirmation
 * switches confirmation off. A plugin that asks is shown the confirmation whatever they say, so
 * agent-toolkit-loop checks them itself.
 *
 * Read once per reply, from the LM Studio folder found when the plugin loaded: a tool that changes
 * the settings during a reply cannot approve the rest of that reply (the file tools refuse to write
 * there at all). When the file cannot be read or parsed, nothing is approved and the user is asked.
 */
export async function loadApprovals(lmStudioHome: string): Promise<Approvals> {
  let chat: any;
  try {
    chat = JSON.parse(await readFile(join(lmStudioHome, "settings.json"), "utf-8"))?.chat ?? {};
  } catch {
    return () => false;
  }
  if (chat.neverAskForToolConfirmation === true) return () => true;
  const patterns: string[] = (Array.isArray(chat.skipToolConfirmationPatterns) ? chat.skipToolConfirmationPatterns : []).filter(
    (pattern: unknown): pattern is string => typeof pattern === "string",
  );
  return (pluginIdentifier, toolName) =>
    pluginIdentifier !== undefined &&
    patterns.some(pattern => {
      // "plugin:tool": each half is matched on its own, so a "*" never reaches across the ":".
      const split = pattern.indexOf(":");
      if (split < 0) return false;
      return wildcard(pattern.slice(0, split), pluginIdentifier) && wildcard(pattern.slice(split + 1), toolName);
    });
}

/** "*" stands for any run of characters. Matched piece by piece, in time linear in the name's length. */
export function wildcard(pattern: string, name: string): boolean {
  const pieces = pattern.split("*");
  if (pieces.length === 1) return pattern === name;
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (!name.startsWith(first) || !name.endsWith(last) || name.length < first.length + last.length) return false;
  let at = first.length;
  const end = name.length - last.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = name.indexOf(piece, at);
    if (found < 0 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}
