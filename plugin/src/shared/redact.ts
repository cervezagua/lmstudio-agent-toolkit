/**
 * Hides secrets in text that is about to be shown to the model. Tool output goes into the model's
 * context and the saved chat, so a `.env`, a config file or a shell history read by a tool would put
 * API keys and private keys there, where a model with web tools can be talked into sending them away.
 * The injection scan guards what comes in; this guards what could go out.
 *
 * These are plain pattern checks for well-known formats, with no model involved. A false positive
 * corrupts what the model reads, so the rules are narrow on purpose: an unusual secret is missed
 * rather than ordinary text mangled. Nothing here touches a file; only the copy the model sees.
 *
 * Every pattern is written to stay linear on hostile input: each one can only start matching at the
 * beginning of a run of its own characters, and no quantifier is nested inside an ambiguous one.
 */
export interface Redaction {
  text: string;
  /** How many values were replaced. */
  count: number;
  /** What they were, e.g. "GitHub token", in order of first appearance and without repeats. */
  kinds: string[];
}

/** Every marker starts with this, so callers can tell when the model sends one back. */
export const REDACTION_MARK = "[redacted: ";

const mark = (kind: string) => `${REDACTION_MARK}${kind}]`;

class Tally {
  count = 0;
  readonly kinds: string[] = [];
  add(kind: string): string {
    this.count++;
    if (!this.kinds.includes(kind)) this.kinds.push(kind);
    return mark(kind);
  }
}

// ── Private key blocks ─────────────────────────────────────────────────────────────────────────

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}?PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}?PRIVATE KEY(?: BLOCK)?-----/g;
/** No real key is longer; past this, a BEGIN and an END are two different things. */
const MAX_PEM_CHARS = 64 * 1024;
/**
 * The body of a key whose END line is missing because the output was cut: lines of base64, each
 * possibly behind read_file's "12<tab>" prefix, separated by real newlines or JSON's "\n".
 */
const PEM_CUT_BODY = /(?:\\[rn]|[\r\n])+(?:(?:[ \t]*\d+\t)?[A-Za-z0-9+/=]{16,}(?:(?:\\[rn]|[\r\n])+|$))+/y;

function redactPrivateKeys(text: string, tally: Tally): string {
  if (!text.includes("PRIVATE KEY")) return text;
  let out = "";
  let position = 0;
  // The next END line at or after the current BEGIN. Searched for forwards only, and never again once
  // there is none, so a text full of BEGIN lines is still read once.
  let end: { index: number; stop: number } | null = null;
  let noMoreEnds = false;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    const afterHeader = PEM_BEGIN.lastIndex;
    if (!noMoreEnds && (!end || end.index < afterHeader)) {
      PEM_END.lastIndex = afterHeader;
      const found = PEM_END.exec(text);
      end = found ? { index: found.index, stop: PEM_END.lastIndex } : null;
      noMoreEnds = !found;
    }
    let stop: number | null = null;
    if (end && end.index - afterHeader <= MAX_PEM_CHARS) {
      const nextBegin = text.indexOf("-----BEGIN ", afterHeader);
      if (nextBegin === -1 || nextBegin > end.index) stop = end.stop;
    }
    if (stop === null) {
      PEM_CUT_BODY.lastIndex = afterHeader;
      if (PEM_CUT_BODY.test(text)) stop = PEM_CUT_BODY.lastIndex;
    }
    if (stop === null) continue; // the header alone, e.g. in documentation
    out += text.slice(position, begin.index) + tally.add("private key");
    position = stop;
    PEM_BEGIN.lastIndex = stop;
  }
  return out + text.slice(position);
}

// ── Tokens with a recognisable prefix ──────────────────────────────────────────────────────────

const hasLetterAndDigit = (token: string) => /\d/.test(token) && /[A-Za-z]/.test(token);

const TOKEN_RULES: Array<{ kind: string; pattern: RegExp; valid?: (token: string) => boolean }> = [
  { kind: "GitHub token", pattern: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g },
  { kind: "GitHub token", pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9_])/g },
  { kind: "Anthropic API key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g },
  {
    kind: "OpenAI-style API key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{32,})(?![A-Za-z0-9_-])/g,
    // "sk-" also starts ordinary hyphenated names; a key always mixes letters and digits.
    valid: hasLetterAndDigit,
  },
  { kind: "AWS access key ID", pattern: /(?<![A-Za-z0-9+/_-])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9+/=_-])/g },
  { kind: "Google API key", pattern: /(?<![A-Za-z0-9+/_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { kind: "Slack token", pattern: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g, valid: token => /\d/.test(token) },
  { kind: "Stripe live key", pattern: /(?<![A-Za-z0-9_])[sr]k_live_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/g },
  { kind: "npm token", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  {
    kind: "Hugging Face token",
    pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g,
    // Tells a token from a long lower-case identifier that happens to start with hf_.
    valid: token => /[a-z]/.test(token) && /[A-Z]/.test(token),
  },
];

// The secret half of an AWS key pair has no prefix, so it is only taken on a line that names it.
const AWS_SECRET = /((?:aws_?)?secret_?access_?key["']?[ \t]*[:=][ \t]*["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi;

// Three base64url parts. Checked further below: the first must decode to a JSON header with an "alg".
const JWT = /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function isJwtHeader(part: string): boolean {
  try {
    const header: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
    return typeof header === "object" && header !== null && typeof (header as { alg?: unknown }).alg === "string";
  } catch {
    return false;
  }
}

// ── Values that are named as secret ────────────────────────────────────────────────────────────

/** Stand-ins people write where a secret would go. Redacting them would only hide a harmless hint. */
function isPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (lower === "" || lower.startsWith("[redacted")) return true;
  if (/^(null|none|nil|undefined|true|false|password|passwd|secret|token|todo|tbd|dummy)$/.test(lower)) return true;
  if (/^(your|my)[-_ ]?|^change[-_ ]?(me|this|it)|^replace[-_ ]?(me|this|with)|^x{3,}/.test(lower)) return true;
  if (/example|placeholder|changeme/.test(lower)) return true;
  // <token>, ${TOKEN}, $TOKEN, $(command), %TOKEN%, {{ token }}, {token}, %s
  if (/^<.*>$|^\$[{(a-z_]|^%[a-z_]+%$|^\{.*\}$|^%[sd]$/.test(lower)) return true;
  // ********, ........, --------
  return /^[*.\-•…]+$/.test(lower) || /^(.)\1+$/.test(lower);
}

// scheme://user:password@host. Starts at "://" (the scheme is checked afterwards) so that a long run
// of letters is not tried as a scheme at every position.
const URL_PASSWORD = /(:\/\/[^\s:@/]*:)([^\s@/]+)(?=@[A-Za-z0-9[])/g;

/**
 * NAME="value", export NAME='value', "name": "value", name: "value".
 * 1: everything up to the value, 2: the name, 3: : or =, 4-5: the double- or single-quoted value.
 */
const QUOTED_ASSIGNMENT =
  /(?<![\w.$-])(["']?(-{0,2}[A-Za-z_][\w.-]{0,80})["']?[ \t]*([:=])[ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)')/g;

/**
 * NAME=value, name: value, --name=value, with nothing around the value. 1-3 as above, 4: the value.
 * The value must run to the end of the line (or a comment), which leaves out code such as
 * `token = getToken();` and `password: str,`. The name must not follow a character that could itself
 * be part of a value, so every attempt reads a different stretch of the text; without that, a long
 * line of `a:b:c:d:...` would be read again from each colon.
 */
const BARE_ASSIGNMENT =
  /(?<![^\s"'`,;&()[\]{}<>])((-{0,2}[A-Za-z_][\w.-]{0,80})[ \t]*([:=])[ \t]*)([^\s"'`,;&()[\]{}<>]+)(?=[ \t]*(?:$|#|\r))/gm;

const SECRET_WORDS: Array<[needle: string, kind: string]> = [
  ["_private_key_", "private key"],
  ["_api_key_", "API key"],
  ["_apikey_", "API key"],
  ["_access_key_", "access key"],
  ["_password_", "password"],
  ["_passwd_", "password"],
  ["_token_", "token"],
  ["_secret_", "secret"],
];

/** A name ending in one of these describes a secret (where it is, how long it lives) and is not one. */
const DESCRIBES =
  /^(url|uri|file|path|dir|name|id|endpoint|ttl|expiry|expires|expiration|length|len|count|limit|type|header|prefix|suffix|algorithm|alg|enabled|required|timeout|lifetime|field|param|policy|regex|pattern|min|max|size|version|label|hint|prompt|env|var)$/;

/** What kind of secret a name says it holds, or null. The word must be a whole part of the name. */
function secretKind(name: string): string | null {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  if (parts.length === 0 || DESCRIBES.test(parts[parts.length - 1])) return null;
  const joined = `_${parts.join("_")}_`;
  return SECRET_WORDS.find(([needle]) => joined.includes(needle))?.[1] ?? null;
}

const LOOKS_LIKE_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])/i;

/**
 * Whether a value given to a secret-sounding name is worth hiding. In an env file (UPPER_CASE=value,
 * nothing around the =) anything that is not a placeholder counts. Elsewhere the name alone is weak
 * evidence, since code is full of `token = something`, so the value must also look generated.
 */
function looksSecret(value: string, envStyle: boolean, bare: boolean): boolean {
  if (value.length < 8 || isPlaceholder(value) || LOOKS_LIKE_PATH.test(value)) return false;
  if (envStyle) return true;
  if (/\s/.test(value)) return false;
  // settings.api_key, generate_secret_v2: without quotes, words joined by dots or underscores are code.
  if (bare && /^[A-Za-z_$][\w$.]*$/.test(value) && /[._]/.test(value)) return false;
  return /[A-Za-z]/.test(value) && /[\d!@#$%^&*~]/.test(value);
}

// ── The function ───────────────────────────────────────────────────────────────────────────────

/**
 * Replaces each secret in `text` with a marker such as `[redacted: GitHub token]`, leaving everything
 * around it as it was: in `API_KEY=...` the name stays and only the value goes. Running it on its own
 * output changes nothing.
 */
export function redactSecrets(text: string): Redaction {
  const tally = new Tally();
  let result = redactPrivateKeys(text, tally);

  for (const rule of TOKEN_RULES) {
    result = result.replace(rule.pattern, token => (rule.valid && !rule.valid(token) ? token : tally.add(rule.kind)));
  }
  result = result.replace(AWS_SECRET, (_all, before: string) => before + tally.add("AWS secret key"));
  result = result.replace(JWT, (token, header: string) => (isJwtHeader(header) ? tally.add("JWT") : token));

  result = result.replace(URL_PASSWORD, (all, before: string, password: string, offset: number, whole: string) => {
    const hasScheme = offset > 0 && /[A-Za-z0-9]/.test(whole[offset - 1]);
    if (!hasScheme || password.length < 3 || isPlaceholder(password)) return all;
    return before + tally.add("password");
  });

  const assignment = (all: string, before: string, name: string, separator: string, value: string, quote: string) => {
    const kind = secretKind(name);
    if (!kind) return all;
    const envStyle = separator === "=" && /^[A-Z][A-Z0-9_]*=$/.test(before);
    if (!looksSecret(value, envStyle, quote === "")) return all;
    return before + quote + tally.add(kind) + quote;
  };
  result = result.replace(
    QUOTED_ASSIGNMENT,
    (all, before: string, name: string, separator: string, double?: string, single?: string) =>
      assignment(all, before, name, separator, double ?? single ?? "", double !== undefined ? '"' : "'"),
  );
  result = result.replace(BARE_ASSIGNMENT, (all, before: string, name: string, separator: string, value: string) =>
    assignment(all, before, name, separator, value, ""),
  );
  return { text: result, count: tally.count, kinds: tally.kinds };
}

/**
 * The same for a value a tool returned that is not a string: every string inside arrays and plain
 * objects is redacted and the shape is left alone. Anything else (numbers, buffers, class instances)
 * is passed through untouched.
 */
export function redactDeep(value: unknown): { value: unknown; count: number; kinds: string[] } {
  let count = 0;
  const kinds: string[] = [];
  const seen = new WeakMap<object, unknown>();
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") {
      const hidden = redactSecrets(item);
      count += hidden.count;
      for (const kind of hidden.kinds) if (!kinds.includes(kind)) kinds.push(kind);
      return hidden.text;
    }
    if (typeof item !== "object" || item === null || depth > 20) return item;
    if (seen.has(item)) return seen.get(item);
    if (Array.isArray(item)) {
      const copy: unknown[] = [];
      seen.set(item, copy);
      for (const entry of item) copy.push(walk(entry, depth + 1));
      return copy;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return item;
    const copy: Record<string, unknown> = {};
    seen.set(item, copy);
    for (const [key, entry] of Object.entries(item)) copy[key] = walk(entry, depth + 1);
    return copy;
  };
  return { value: walk(value, 0), count, kinds };
}

/** "2 secrets (GitHub token, private key)": the count and kinds, never the values. */
export function describeRedaction(redaction: { count: number; kinds: string[] }): string {
  return `${redaction.count} secret${redaction.count === 1 ? "" : "s"} (${redaction.kinds.join(", ")})`;
}
