import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { describeRedaction, redactDeep, redactSecrets } from "./redact";

// Every value here is made up. They are assembled from pieces so that no line of this file is itself
// a format-valid token, which would set off secret scanners on the repository.
const lower = (length: number) => "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6".repeat(4).slice(0, length);
const mixed = (length: number) => "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z".repeat(8).slice(0, length);
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const GITHUB = "ghp" + "_" + lower(36);
const GITHUB_PAT = "github" + "_pat_" + mixed(22) + "_" + mixed(59);
const ANTHROPIC = "sk-" + "ant-api03-" + mixed(93) + "AA";
const OPENAI = "sk-" + mixed(48);
const OPENAI_PROJECT = "sk-" + "proj-" + mixed(60) + "_" + mixed(40);
const AWS_ID = "AKIA" + "IOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY";
const GOOGLE = "AIza" + mixed(35);
const SLACK = "xoxb" + "-1234567890-1234567890123-" + mixed(24);
const STRIPE = "sk" + "_live_" + mixed(24);
const STRIPE_RESTRICTED = "rk" + "_live_" + mixed(24);
const NPM = "npm" + "_" + mixed(36);
const HUGGING_FACE = "hf" + "_" + mixed(34);
const JWT = [b64url({ alg: "HS256", typ: "JWT" }), b64url({ sub: "1234567890", name: "Test" }), mixed(43)].join(".");
const PEM_BODY = [mixed(64), mixed(64), mixed(40) + "=="];
const pem = (type: string, newline = "\n") =>
  [`-----BEGIN ${type}PRIVATE KEY-----`, ...PEM_BODY, `-----END ${type}PRIVATE KEY-----`].join(newline);

const redact = (text: string) => redactSecrets(text).text;

describe("redactSecrets", () => {
  it.each([
    ["GitHub token", GITHUB],
    ["GitHub token", "gho" + "_" + lower(36)],
    ["GitHub token", "ghs" + "_" + lower(36)],
    ["GitHub token", GITHUB_PAT],
    ["Anthropic API key", ANTHROPIC],
    ["OpenAI-style API key", OPENAI],
    ["OpenAI-style API key", OPENAI_PROJECT],
    ["AWS access key ID", AWS_ID],
    ["AWS access key ID", "ASIA" + "IOSFODNN7EXAMPLE"],
    ["Google API key", GOOGLE],
    ["Slack token", SLACK],
    ["Stripe live key", STRIPE],
    ["Stripe live key", STRIPE_RESTRICTED],
    ["npm token", NPM],
    ["Hugging Face token", HUGGING_FACE],
    ["JWT", JWT],
  ])("hides a %s and keeps the text around it", (kind, secret) => {
    const result = redactSecrets(`before ${secret} after\nheader: Bearer ${secret}`);
    expect(result.text).toBe(`before [redacted: ${kind}] after\nheader: Bearer [redacted: ${kind}]`);
    expect(result).toMatchObject({ count: 2, kinds: [kind] });
  });

  describe("private keys", () => {
    it.each(["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED ", "DSA "])("hides a whole %sprivate key block", type => {
      const result = redactSecrets(`key:\n${pem(type)}\ndone`);
      expect(result.text).toBe("key:\n[redacted: private key]\ndone");
      expect(result).toMatchObject({ count: 1, kinds: ["private key"] });
    });

    it("handles Windows line endings, and two keys in one text", () => {
      const result = redactSecrets(`${pem("RSA ", "\r\n")}\r\nbetween\r\n${pem("")}`);
      expect(result.text).toBe("[redacted: private key]\r\nbetween\r\n[redacted: private key]");
      expect(result.count).toBe(2);
    });

    it("hides one written on a single line, as in a service-account JSON file", () => {
      const text = `{"private_key": "${pem("", "\\n")}\\n", "client_email": "a@b.test"}`;
      expect(redact(text)).toBe('{"private_key": "[redacted: private key]\\n", "client_email": "a@b.test"}');
    });

    it("hides one seen through read_file's line numbers", () => {
      const numbered = pem("OPENSSH ").split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
      expect(redact(numbered)).toBe("1\t[redacted: private key]");
    });

    it("hides the part that is there when the output was cut before the END line", () => {
      const cut = ["-----BEGIN RSA PRIVATE KEY-----", ...PEM_BODY].join("\n") + "\n\n... [900 characters truncated] ...";
      expect(redact(cut)).toBe("[redacted: private key]... [900 characters truncated] ...");
    });

    it("does not swallow what lies between an unfinished key and a later, different one", () => {
      const text = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY[0]}\nnotes in between\n${pem("EC ")}\nend`;
      expect(redact(text)).toBe("[redacted: private key]notes in between\n[redacted: private key]\nend");
    });

    it("leaves a public key, a certificate and a mention of the header alone", () => {
      for (const text of [
        `-----BEGIN PUBLIC KEY-----\n${PEM_BODY.join("\n")}\n-----END PUBLIC KEY-----`,
        `-----BEGIN CERTIFICATE-----\n${PEM_BODY.join("\n")}\n-----END CERTIFICATE-----`,
        "A key file starts with -----BEGIN PRIVATE KEY----- on its first line.",
      ]) {
        expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [] });
      }
    });
  });

  describe("AWS", () => {
    it("hides the secret access key on a line that names it, and keeps the name", () => {
      const text = `[default]\naws_access_key_id = ${AWS_ID}\naws_secret_access_key = ${AWS_SECRET}\nregion = eu-west-1`;
      const result = redactSecrets(text);
      expect(result.text).toBe(
        "[default]\naws_access_key_id = [redacted: AWS access key ID]\naws_secret_access_key = [redacted: AWS secret key]\nregion = eu-west-1",
      );
      expect(result.kinds).toEqual(["AWS access key ID", "AWS secret key"]);
    });

    it("hides it in an env file and in JSON too", () => {
      expect(redact(`AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`)).toBe("AWS_SECRET_ACCESS_KEY=[redacted: AWS secret key]");
      expect(redact(`{"SecretAccessKey": "${AWS_SECRET}"}`)).toBe('{"SecretAccessKey": "[redacted: AWS secret key]"}');
    });

    it("leaves 40 base64 characters alone when nothing names them", () => {
      expect(redactSecrets(`checksum ${AWS_SECRET}`).count).toBe(0);
    });
  });

  describe("URLs with credentials", () => {
    it.each([
      ["postgres://app:s3cr3t-Pa55@db.internal:5432/app", "postgres://app:[redacted: password]@db.internal:5432/app"],
      ["https://deploy:hunter2hunter2@example.test/repo.git", "https://deploy:[redacted: password]@example.test/repo.git"],
      ["redis://:onlyapassword1@127.0.0.1:6379/0", "redis://:[redacted: password]@127.0.0.1:6379/0"],
      ["mongodb+srv://u:pw-12345@[::1]/db", "mongodb+srv://u:[redacted: password]@[::1]/db"],
    ])("hides only the password in %s", (url, expected) => {
      const result = redactSecrets(`DATABASE_URL=${url}`);
      expect(result.text).toBe(`DATABASE_URL=${expected}`);
      expect(result).toMatchObject({ count: 1, kinds: ["password"] });
    });

    it.each([
      "http://localhost:8080/path@2x.png",
      "https://example.test:443/a?b=c",
      "ssh://git@example.test:22/repo.git",
      "postgres://user:${DB_PASSWORD}@db/app",
      "postgres://user:<password>@db/app",
      "postgres://user:password@db/app",
      "mysql://user:%s@db/app",
      "See http://example.test: mail me@example.test",
    ])("leaves %s alone", url => {
      expect(redactSecrets(url)).toEqual({ text: url, count: 0, kinds: [] });
    });
  });

  describe("assignments to a name that says secret", () => {
    it.each([
      ["DB_PASSWORD=correcthorsebattery", "DB_PASSWORD=[redacted: password]"],
      ['DB_PASSWORD="correct horse battery"', 'DB_PASSWORD="[redacted: password]"'],
      ["MYSQL_PASSWD='hunter2hunter2'", "MYSQL_PASSWD='[redacted: password]'"],
      ["export SESSION_SECRET=abcdefghijklmnop", "export SESSION_SECRET=[redacted: secret]"],
      ["  - GITLAB_TOKEN=glpat-abcdefghijkl", "  - GITLAB_TOKEN=[redacted: token]"],
      ["SERVICE_API_KEY=abcdef0123456789 # production", "SERVICE_API_KEY=[redacted: API key] # production"],
      ["SERVICE_APIKEY=abcdef0123456789", "SERVICE_APIKEY=[redacted: API key]"],
      ["SIGNING_PRIVATE_KEY=abcdef0123456789abcdef", "SIGNING_PRIVATE_KEY=[redacted: private key]"],
      ["STORAGE_ACCESS_KEY=abcdef0123456789", "STORAGE_ACCESS_KEY=[redacted: access key]"],
      ['{"password": "hunter2hunter2", "user": "ann"}', '{"password": "[redacted: password]", "user": "ann"}'],
      ['  "apiKey": "abcdef0123456789",', '  "apiKey": "[redacted: API key]",'],
      ["  client_secret: abcdef0123456789", "  client_secret: [redacted: secret]"],
      ["  api-key: 'abcdef0123456789'", "  api-key: '[redacted: API key]'"],
      ["db.password = h4rd-to-guess", "db.password = [redacted: password]"],
      ['$env:DEPLOY_TOKEN = "abcdef0123456789"', '$env:DEPLOY_TOKEN = "[redacted: token]"'],
      ["tool login --password=hunter2hunter2", "tool login --password=[redacted: password]"],
      ["X-Api-Key: abcdef0123456789", "X-Api-Key: [redacted: API key]"],
    ])("hides the value and keeps the name: %s", (line, expected) => {
      const result = redactSecrets(`# settings\n${line}\nPORT=8080`);
      expect(result.text).toBe(`# settings\n${expected}\nPORT=8080`);
      expect(result.count).toBe(1);
    });

    it("handles Windows line endings", () => {
      expect(redact("A=1\r\nDB_PASSWORD=correcthorsebattery\r\nB=2\r\n")).toBe("A=1\r\nDB_PASSWORD=[redacted: password]\r\nB=2\r\n");
    });

    it.each([
      "DB_PASSWORD=",
      "DB_PASSWORD=changeme",
      "DB_PASSWORD=change-me-please",
      "API_KEY=your-api-key-here",
      "API_KEY=YOUR_API_KEY",
      "API_KEY=xxxxxxxxxxxxxxxx",
      "API_KEY=<your key here>",
      "API_KEY=${API_KEY}",
      "API_KEY=$OTHER_VARIABLE",
      'API_KEY="{{ vault_api_key }}"',
      "SESSION_SECRET=example-secret-value",
      "AUTH_TOKEN=null",
      "USE_TOKEN=true",
      "DB_PASSWORD=********",
      '"password": "undefined"',
      "TOKEN=short1",
    ])("leaves a placeholder alone: %s", line => {
      expect(redactSecrets(line)).toEqual({ text: line, count: 0, kinds: [] });
    });

    it.each([
      // The word is part of a longer one, or the name describes a secret instead of holding one.
      "TOKENIZER_MODEL=bert-base-uncased-v2",
      "MAX_TOKENS=100000000",
      "SECRETARY_NAME=annabelle1990",
      "PASSWORD_MIN_LENGTH=12345678",
      "TOKEN_URL=https://auth.example.test/oauth2/token",
      "PASSWORD_FILE=/run/secrets/db_password_v2",
      "API_KEY_HEADER=x-custom-key-v2",
      "KEYBOARD_LAYOUT=us-international-2",
      // Code, where the name is weak evidence.
      "const token = await getToken(request2);",
      "token = self.tokens[index1]",
      "password = input('Password for db1: ')",
      "    password: Optional[str] = None,",
      "  token: process.env.GITHUB_TOKEN,",
      "if (password === 'hunter2hunter2') {",
      "let secret = generate_secret_v2",
      '"token_type": "bearer_token_v2"',
      '"password": "Enter your password 1"',
      "token: string;",
      "api_key = settings.api_key",
      "  secret: refresh-token-name",
      "https://example.test/callback?token=abcdef0123456789&state=1",
    ])("leaves ordinary text alone: %s", line => {
      expect(redactSecrets(line)).toEqual({ text: line, count: 0, kinds: [] });
    });
  });

  describe("what must not be touched", () => {
    it.each([
      ["prose", "The quick brown fox reads the token bucket docs and resets its password policy every 90 days."],
      ["a git SHA", "commit 4bc0136f8a2d1e5c7b9a3f6d0e4c8b2a1f5d7e93"],
      ["a sha256", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  archive.tar.gz"],
      ["a UUID", "request id 123e4567-e89b-12d3-a456-426614174000"],
      ["a lockfile integrity string", '"integrity": "sha512-' + mixed(86) + '=="'],
      ["a base64 image", "![x](data:image/png;base64," + Buffer.from(mixed(3000)).toString("base64") + ")"],
      ["a hyphenated name starting with sk-", "class sk-circle-fade-dot-with-a-very-long-descriptive-name"],
      ["an identifier starting with hf_", "def hf_download_and_cache_the_model_snapshot_locally(repo):"],
      ["a short sk- word", "sk-learn and sk-image are Python packages"],
      ["a token-shaped word that is too short", "ghp" + "_tooshort and npm" + "_run_build"],
      ["three dotted words", "eyJub3QiOiJhIGp3dCJ9.config.example"],
      ["a JWT-shaped string whose header has no alg", [b64url({ typ: "x" }), b64url({ a: 1 }), mixed(20)].join(".")],
      ["a test Stripe key", "sk" + "_test_" + mixed(24)],
      ["an AKIA lookalike inside a longer word", "XAKIA" + "IOSFODNN7EXAMPLEX"],
      ["a TypeScript snippet", "export function tokenCount(text: string): number {\n  return text.split(/\\s+/).length;\n}"],
      ["a diff", "@@ -1,3 +1,3 @@\n-const secretary = people[0];\n+const secretary = people[1];"],
    ])("%s", (_name, text) => {
      expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [] });
    });

    it("this repository's own instructions and lockfile", async () => {
      for (const file of ["AGENTS.md", "package-lock.json", "plugin/src/config.ts"]) {
        const text = await readFile(join(process.cwd(), file), "utf-8");
        expect(redactSecrets(text), file).toEqual({ text, count: 0, kinds: [] });
      }
    });
  });

  const everything = [
    `GITHUB_TOKEN=${GITHUB}`,
    `pat: ${GITHUB_PAT}`,
    `ANTHROPIC_API_KEY="${ANTHROPIC}"`,
    `openai ${OPENAI} ${OPENAI_PROJECT}`,
    `aws_access_key_id=${AWS_ID}`,
    `aws_secret_access_key=${AWS_SECRET}`,
    `google ${GOOGLE} slack ${SLACK}`,
    `stripe ${STRIPE} ${STRIPE_RESTRICTED}`,
    `//registry.npmjs.org/:_authToken=${NPM}`,
    `HF_TOKEN=${HUGGING_FACE}`,
    `Authorization: Bearer ${JWT}`,
    "DATABASE_URL=postgres://app:s3cr3t-Pa55@db.internal:5432/app",
    "DB_PASSWORD=correcthorsebattery",
    '{"client_secret": "abcdef0123456789"}',
    pem("OPENSSH "),
    `{"private_key": "${pem("", "\\n")}\\n"}`,
    "plain text at the end",
  ].join("\n");

  it("counts each secret once, even where two rules could claim it", () => {
    const result = redactSecrets(everything);
    expect(result.count).toBe(19);
    expect(result.kinds).toEqual([
      "private key",
      "GitHub token",
      "Anthropic API key",
      "OpenAI-style API key",
      "AWS access key ID",
      "Google API key",
      "Slack token",
      "Stripe live key",
      "npm token",
      "Hugging Face token",
      "AWS secret key",
      "JWT",
      "password",
      "secret",
    ]);
    for (const secret of [GITHUB, GITHUB_PAT, ANTHROPIC, OPENAI, AWS_ID, AWS_SECRET, GOOGLE, SLACK, STRIPE, NPM, HUGGING_FACE, JWT, PEM_BODY[0]]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.text).toContain("GITHUB_TOKEN=[redacted: GitHub token]");
    expect(result.text).toContain('ANTHROPIC_API_KEY="[redacted: Anthropic API key]"');
    expect(result.text).toContain("plain text at the end");
  });

  it("changes nothing when run on its own output", () => {
    const once = redactSecrets(everything);
    expect(redactSecrets(once.text)).toEqual({ text: once.text, count: 0, kinds: [] });
  });

  it("stays fast on 2 MB of near-matches", () => {
    const pieces = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\n",
      "sk-sk-sk-sk-",
      "sk-" + "a".repeat(31) + "-",
      "ghp" + "_" + "a".repeat(35) + " ",
      "github" + "_pat_",
      "hf" + "_" + "a".repeat(29) + "_",
      "eyJhbGciOiJIUzI1NiJ9.eyJhbGciOiJIUzI1NiJ9 ",
      "eyJ.eyJ.eyJ.",
      "AKIA" + "AKIA" + "ASIA",
      "AIza".repeat(9),
      "xoxb-xoxb-",
      "://a:b:c:d://u:",
      "http://a:",
      'password="' + "x".repeat(40),
      "password = ",
      " token:   \t  ",
      " token: " + "a_".repeat(40) + "-\n",
      "\nSECRET=" + "<".repeat(20) + "\n",
      "a-b-c-d-e-f.g.h_i=",
      "secret_access_key = " + "A".repeat(39) + " ",
      '"api_key": "',
      "=".repeat(30),
      "-".repeat(30),
    ];
    const repeated = pieces.map(piece => piece.repeat(Math.ceil(80_000 / piece.length)));
    const text = (repeated.join("") + pieces.join("")).repeat(2).slice(0, 2 * 1024 * 1024) + "a".repeat(200_000);
    expect(text.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);

    const started = performance.now();
    const result = redactSecrets(text);
    const elapsed = performance.now() - started;
    expect(result.text.length).toBeGreaterThan(0);
    // Linear work on this input takes tens of milliseconds; a quadratic pattern would take minutes.
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("redactDeep", () => {
  it("redacts the strings inside arrays and objects and leaves the shape alone", () => {
    const bytes = Buffer.from("raw");
    const when = new Date(0);
    const input = { ok: true, rows: 3, lines: [`token ${GITHUB}`, "plain"], nested: { env: "DB_PASSWORD=correcthorsebattery", bytes, when, none: null } };
    const { value, count, kinds } = redactDeep(input);
    expect(value).toEqual({
      ok: true,
      rows: 3,
      lines: ["token [redacted: GitHub token]", "plain"],
      nested: { env: "DB_PASSWORD=[redacted: password]", bytes, when, none: null },
    });
    expect((value as typeof input).nested.bytes).toBe(bytes);
    expect({ count, kinds }).toEqual({ count: 2, kinds: ["GitHub token", "password"] });
    // The original is not changed.
    expect(input.lines[0]).toContain(GITHUB);
  });

  it("passes through values that are not strings, and survives a cycle", () => {
    expect(redactDeep(42)).toEqual({ value: 42, count: 0, kinds: [] });
    expect(redactDeep(undefined)).toEqual({ value: undefined, count: 0, kinds: [] });
    const loop: Record<string, unknown> = { name: "x" };
    loop.self = loop;
    const copy = redactDeep(loop).value as Record<string, unknown>;
    expect(copy.self).toBe(copy);
  });
});

describe("describeRedaction", () => {
  it("names the count and the kinds, never the values", () => {
    expect(describeRedaction({ count: 1, kinds: ["JWT"] })).toBe("1 secret (JWT)");
    expect(describeRedaction({ count: 3, kinds: ["GitHub token", "private key"] })).toBe("3 secrets (GitHub token, private key)");
  });
});
