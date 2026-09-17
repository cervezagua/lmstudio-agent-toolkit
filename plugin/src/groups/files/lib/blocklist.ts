/**
 * Catastrophic commands that are always refused, regardless of config. This is a seatbelt, not a
 * sandbox: LM Studio's tool-call confirmation and the root directory are the real safeguards.
 */
export const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  // rm -rf / , rm -rf ~ , rm -rf *
  /\brm\s+(-[a-z]*\s+)*-[a-z]*(rf|fr)[a-z]*\s+(\/|~|\*)(\s|$)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\b.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\b(Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
  // Remove-Item / rd / rmdir on a drive root, e.g. `Remove-Item -Recurse C:\`
  /\b(Remove-Item|rm|rd|rmdir|del)\b.*\s["']?[a-z]:[\\/]?["']?(\s|$)/i,
  /\breg(\.exe)?\s+delete\s+HKLM\b/i,
  /\b(shutdown|Stop-Computer|Restart-Computer)\b/i,
];

/** Parses user-supplied patterns: one regular expression per entry (case-insensitive). */
export function parsePatterns(entries: string[]): { patterns: RegExp[]; invalid: string[] } {
  const patterns: RegExp[] = [];
  const invalid: string[] = [];
  for (const entry of entries.map(e => e.trim()).filter(Boolean)) {
    try {
      patterns.push(new RegExp(entry, "i"));
    } catch {
      invalid.push(entry);
    }
  }
  return { patterns, invalid };
}

/** Returns the first pattern `command` matches, or undefined if it is allowed. */
export function findBlockedPattern(command: string, extra: RegExp[] = []): RegExp | undefined {
  return [...DEFAULT_BLOCKED_PATTERNS, ...extra].find(pattern => pattern.test(command));
}
