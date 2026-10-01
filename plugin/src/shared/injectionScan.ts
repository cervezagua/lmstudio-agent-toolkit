/**
 * Looks for text written to steer the model rather than inform it. Instruction files and skills are
 * loaded into a chat and the model is told to follow them, so a cloned repository's AGENTS.md, or a
 * skill copied from somewhere, is untrusted input with a direct line to the model.
 *
 * These are plain pattern checks, with no model involved. They catch the common, blunt attempts and
 * nothing subtle, and they can flag an honest document that quotes one of these phrases, which is why
 * every finding names its line: the user can see what tripped it and decide.
 */
export interface InjectionFinding {
  reason: string;
  /** 1-based. */
  line: number;
  excerpt: string;
}

const RULES: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: "tells the assistant to ignore its instructions",
    pattern: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines)\b/i,
  },
  {
    reason: "tries to give the assistant a new identity",
    pattern: /\byou are (now|no longer)\b|\bfrom now on,? you (are|will|must)\b|\bnew system prompt\b/i,
  },
  {
    reason: "tells the assistant to hide something from the user",
    pattern: /\b(do not|don't|never)\b[^.\n]{0,20}\b(tell|inform|mention to|reveal to|show|notify)\b[^.\n]{0,15}\b(the )?user\b/i,
  },
  {
    reason: "sends secrets somewhere",
    pattern:
      /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|nc)\b[^\n]*(\.ssh|id_rsa|id_ed25519|\.env\b|\.aws|credentials|api[_-]?key|token|password)|(\.ssh|id_rsa|id_ed25519|\.env\b|\.aws|credentials)[^\n]*\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|nc)\b/i,
  },
  {
    reason: "downloads a script and runs it",
    pattern: /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/i,
  },
];

// Zero-width characters, bidirectional overrides and Unicode "tag" characters: text a person reading
// the file cannot see, but a model can.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/;

export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    // A byte-order mark at the very start of a file is ordinary, not hidden text.
    const line = index === 0 ? lines[index].replace(/^﻿/, "") : lines[index];
    const excerpt = line.trim().slice(0, 120);
    if (INVISIBLE.test(line)) findings.push({ reason: "contains invisible characters", line: index + 1, excerpt });
    for (const rule of RULES) {
      if (rule.pattern.test(line)) findings.push({ reason: rule.reason, line: index + 1, excerpt });
    }
  }
  return findings;
}

/** One line for a person: what was found, where, and the text itself. */
export function describeFinding(finding: InjectionFinding): string {
  return `line ${finding.line} ${finding.reason}: "${finding.excerpt}"`;
}

/**
 * The same without the text. This is the form to give a model: quoting the line back would deliver
 * the very words that were held back.
 */
export function locateFinding(finding: InjectionFinding): string {
  return `line ${finding.line} ${finding.reason}`;
}
