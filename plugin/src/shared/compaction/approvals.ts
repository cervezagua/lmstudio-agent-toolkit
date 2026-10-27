import { readFile } from "fs/promises";
import { join } from "path";
import { lmStudioHome } from "../lmStudioHome";

/**
 * Whether the user told LM Studio never to ask about this tool: "Always allow" in a confirmation
 * adds a pattern such as "local/agent-toolkit:*" or "local/agent-toolkit:run_command" to
 * chat.skipToolConfirmationPatterns in LM Studio's settings.json, and chat.neverAskForToolConfirmation
 * switches confirmation off. LM Studio's own loop checks them before asking; a plugin that asks is
 * shown the confirmation whatever they say, so agent-toolkit-loop checks them itself.
 *
 * Read on every call, so a choice made a moment ago counts. When the file cannot be read or parsed,
 * the answer is no, and the user is asked.
 */
export async function alwaysAllowed(pluginIdentifier: string | undefined, toolName: string, home = lmStudioHome()): Promise<boolean> {
  try {
    const chat = JSON.parse(await readFile(join(home, "settings.json"), "utf-8"))?.chat ?? {};
    if (chat.neverAskForToolConfirmation === true) return true;
    if (!pluginIdentifier) return false;
    const patterns: unknown[] = Array.isArray(chat.skipToolConfirmationPatterns) ? chat.skipToolConfirmationPatterns : [];
    return patterns.some(pattern => typeof pattern === "string" && matches(pattern, `${pluginIdentifier}:${toolName}`));
  } catch {
    return false;
  }
}

/** A pattern where "*" stands for any run of characters, as in "local/agent-toolkit:*". */
function matches(pattern: string, name: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return regex.test(name);
}
