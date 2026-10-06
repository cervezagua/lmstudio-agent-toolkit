import { open } from "fs/promises";
import { dirname } from "path";
import { ToolError } from "../../../shared/errors";
import { runProcess } from "../../../shared/process";

/**
 * Read-only access to SQLite files through Node's built-in `node:sqlite` (Node 22.5+), so nothing has
 * to be installed.
 *
 * The database is opened in a separate Node process, not in the plugin and not in a worker thread.
 * `DatabaseSync` is synchronous, and a single slow statement (a `count(*)` over a runaway recursive
 * query, say) is one long native call: `Worker.terminate()` cannot interrupt it, and the thread then
 * also keeps the host process from exiting. A process can always be killed. Its source is the string
 * below rather than a file because the plugin is bundled into one CommonJS file, next to which a
 * separate script would not exist; it uses only `node:` built-ins.
 */

export const SQLITE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ROWS = 50;
export const MAX_MAX_ROWS = 500;
const MAX_CELL_CHARS = 200;
/** One row with more columns than this is easier to read as "name: value" lines than as a table. */
const WIDE_ROW_COLUMNS = 6;

/** Whether this Node has `node:sqlite`. Looked up on first use, and absent on older runtimes. */
export function sqliteAvailable(): boolean {
  try {
    return typeof process.getBuiltinModule === "function" && Boolean(process.getBuiltinModule("node:sqlite"));
  } catch {
    return false;
  }
}

// ── What the child process runs ────────────────────────────────────────────────────────────────

/**
 * Reads one JSON request from stdin, answers with one JSON line on stdout. The connection is opened
 * read-only and put in query_only mode before anything else, and that, not the statement check in
 * this file, is what keeps the database from being changed.
 */
const CHILD_SOURCE = String.raw`
const { DatabaseSync } = require("node:sqlite");

const quote = name => '"' + String(name).replace(/"/g, '""') + '"';

function cell(value, maxChars) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return "<blob, " + value.length + " bytes>";
  const text = String(value);
  return text.length > maxChars ? text.slice(0, maxChars) + "… (" + text.length + " chars)" : text;
}

function query(db, request) {
  const statement = db.prepare(request.sql);
  if (statement.setReadBigInts) statement.setReadBigInts(true);
  let columns = statement.columns ? statement.columns().map(column => column.name) : null;
  const arrays = Boolean(columns && statement.setReturnArrays);
  if (arrays) statement.setReturnArrays(true);
  const rows = [];
  let more = false;
  for (const row of statement.iterate ? statement.iterate() : statement.all()) {
    if (rows.length >= request.maxRows) {
      more = true;
      break;
    }
    if (!columns) columns = Object.keys(row);
    const values = arrays ? row : columns.map(name => row[name]);
    rows.push(values.map(value => cell(value, request.maxCellChars)));
  }
  return { ok: true, kind: "rows", columns: columns || [], rows, more };
}

function schema(db, request) {
  const started = Date.now();
  const all = db
    .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
  const objects = all.slice(0, request.maxObjects).map(object => {
    const columns = db.prepare("PRAGMA table_info(" + quote(object.name) + ")").all().map(column => ({
      name: column.name,
      type: column.type,
      notNull: Boolean(column.notnull),
      primaryKey: Number(column.pk) > 0,
    }));
    let rowCount = null;
    let indexes = [];
    if (object.type === "table") {
      // Counting reads the whole table, so stop counting once it has taken a while.
      if (Date.now() - started < request.countBudgetMs) {
        try {
          rowCount = String(db.prepare("SELECT count(*) AS n FROM " + quote(object.name)).get().n);
        } catch {}
      }
      try {
        indexes = db.prepare("PRAGMA index_list(" + quote(object.name) + ")").all().map(index => ({
          name: index.name,
          unique: Boolean(index.unique),
          columns: db.prepare("PRAGMA index_info(" + quote(index.name) + ")").all().map(part => part.name === null ? "<expression>" : part.name),
        }));
      } catch {}
    }
    return { type: object.type, name: object.name, columns, rowCount, indexes };
  });
  return { ok: true, kind: "schema", objects, total: all.length };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => (input += chunk));
process.stdin.on("end", () => {
  let answer;
  try {
    const request = JSON.parse(input);
    const db = new DatabaseSync(request.file, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON");
      answer = request.sql === null ? schema(db, request) : query(db, request);
    } finally {
      db.close();
    }
  } catch (error) {
    answer = { ok: false, message: String((error && error.message) || error), errcode: error && error.errcode };
  }
  process.stdout.write(JSON.stringify(answer));
});
`;

// ── Results ────────────────────────────────────────────────────────────────────────────────────

export interface SqliteRows {
  kind: "rows";
  columns: string[];
  /** Cells already made printable by the child: text cut short, blobs described, null for NULL. */
  rows: Array<Array<string | null>>;
  /** True when the statement had more rows than were asked for. */
  more: boolean;
}

export interface SqliteSchema {
  kind: "schema";
  objects: Array<{
    type: "table" | "view";
    name: string;
    columns: Array<{ name: string; type: string; notNull: boolean; primaryKey: boolean }>;
    /** A string because a count can exceed what a number holds; null for views and uncounted tables. */
    rowCount: string | null;
    indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
  }>;
  total: number;
}

type ChildAnswer = ({ ok: true } & (SqliteRows | SqliteSchema)) | { ok: false; message: string; errcode?: number };

const READ_ONLY_REFUSAL =
  "sqlite_query is read-only: it runs one SELECT (or WITH ... SELECT, VALUES, EXPLAIN, or a PRAGMA that only reads) and cannot change a database.";

// ── Checking the statement ─────────────────────────────────────────────────────────────────────

/**
 * The statement with comments removed and every string and quoted name emptied, so that keywords and
 * semicolons can be looked for without being fooled by `SELECT 'a; DROP TABLE t'`.
 */
function skeleton(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          // A doubled quote inside a string is an escaped quote, not its end.
          if (close === "]" || sql[j + 1] !== close) break;
          j++;
        }
        j++;
      }
      i = j + 1;
      out += char === "'" ? "''" : " x ";
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

const READ_ONLY_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "database_list",
]);

/**
 * Refuses anything that is not a single reading statement, with a message the model can act on.
 * This is a courtesy, to answer clearly before opening the file, plus the two things a read-only
 * connection does not stop by itself: ATTACH (which opens another file) and VACUUM INTO (which
 * creates one). Writes that get past it are refused by SQLite, because the connection is read-only.
 */
export function assertReadOnlySql(sql: string): void {
  const bare = skeleton(sql).replace(/[\s;]+$/, "").trim();
  if (!bare) throw new ToolError("sql is empty. Leave it out to see the schema.");
  if (bare.includes(";")) throw new ToolError(`Only one statement per call. ${READ_ONLY_REFUSAL}`);
  if (/\b(attach|detach)\b/i.test(bare)) {
    throw new ToolError(`ATTACH and DETACH are not allowed: they would open another file. ${READ_ONLY_REFUSAL}`);
  }
  const keyword = /^[A-Za-z]+/.exec(bare)?.[0].toUpperCase() ?? "";
  if (keyword === "SELECT" || keyword === "VALUES" || keyword === "EXPLAIN") return;
  if (keyword === "WITH") {
    if (/\b(insert|update|delete)\b/i.test(bare)) throw new ToolError(READ_ONLY_REFUSAL);
    return;
  }
  if (keyword === "PRAGMA") {
    const pragma = /^pragma\s+(?:\w+\s*\.\s*)?(\w+)\s*(?:\([^()]*\))?$/i.exec(bare);
    if (pragma && READ_ONLY_PRAGMAS.has(pragma[1].toLowerCase())) return;
    throw new ToolError(
      `That PRAGMA is not allowed. The ones that only read are: ${[...READ_ONLY_PRAGMAS].join(", ")}, e.g. PRAGMA table_info(name). ${READ_ONLY_REFUSAL}`,
    );
  }
  throw new ToolError(READ_ONLY_REFUSAL);
}

// ── Running it ─────────────────────────────────────────────────────────────────────────────────

export interface SqliteRunOptions {
  /** Absolute path of an existing file. */
  file: string;
  /** How the file is named to the model. */
  shown: string;
  /** The statement, or null for the schema. Not checked here: see `assertReadOnlySql`. */
  sql: string | null;
  maxRows?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Runs the statement (or reads the schema) in a child process that is killed if it takes too long. */
export async function runSqlite(options: SqliteRunOptions): Promise<SqliteRows | SqliteSchema> {
  const timeoutMs = options.timeoutMs ?? SQLITE_TIMEOUT_MS;
  const request = {
    file: options.file,
    sql: options.sql,
    maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
    maxCellChars: MAX_CELL_CHARS,
    maxObjects: 200,
    countBudgetMs: Math.floor(timeoutMs / 3),
  };
  const result = await runProcess(process.execPath, ["--no-warnings", "-e", CHILD_SOURCE], {
    cwd: dirname(options.file),
    timeoutMs,
    signal: options.signal,
    stdin: JSON.stringify(request),
  });
  if (result.aborted) throw new ToolError("The query was cancelled.");
  if (result.timedOut) {
    throw new ToolError(
      `The query ran for more than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Add a LIMIT, or make the query narrower.`,
    );
  }
  let answer: ChildAnswer;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    const reason = result.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit code ${result.exitCode}`;
    throw new ToolError(`SQLite could not be run here: ${reason}`);
  }
  if (answer.ok) return answer;
  // SQLite's primary result code is the low byte: 8 = SQLITE_READONLY, 26 = SQLITE_NOTADB.
  const code = typeof answer.errcode === "number" ? answer.errcode & 0xff : -1;
  if (code === 8) throw new ToolError(`${READ_ONLY_REFUSAL} Nothing was changed.`);
  if (code === 26) throw new ToolError(`${options.shown} is not a SQLite database.`);
  throw new ToolError(`SQLite: ${answer.message}`);
}

/** A SQLite file starts with these 16 bytes; checked first so a text file gets a clear answer. */
const SQLITE_HEADER = "SQLite format 3\u0000";

export async function assertSqliteFile(file: string, shown: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    if (bytesRead < 16 || buffer.toString("latin1") !== SQLITE_HEADER) {
      throw new ToolError(`${shown} is not a SQLite database.`);
    }
  } finally {
    await handle.close();
  }
}

// ── Showing the result ─────────────────────────────────────────────────────────────────────────

const show = (cell: string | null) => (cell === null ? "NULL" : cell);
const inTable = (cell: string | null) => show(cell).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n|\r/g, "\\n");

export function formatRows(result: SqliteRows): string {
  const { columns, rows, more } = result;
  if (rows.length === 0) return columns.length ? `No rows. Columns: ${columns.join(", ")}` : "No rows.";
  const note = more
    ? `Showing the first ${rows.length} rows; there are more. Narrow the query, page with LIMIT and OFFSET, or raise max_rows (up to ${MAX_MAX_ROWS}).`
    : `${rows.length} row${rows.length === 1 ? "" : "s"}.`;
  if (rows.length === 1 && columns.length > WIDE_ROW_COLUMNS) {
    return `${columns.map((name, i) => `${name}: ${show(rows[0][i])}`).join("\n")}\n\n${note}`;
  }
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const table = [line(columns.map(inTable)), line(columns.map(() => "---")), ...rows.map(row => line(row.map(inTable)))];
  return `${table.join("\n")}\n\n${note}`;
}

export function formatSchema(result: SqliteSchema, shown: string): string {
  if (result.objects.length === 0) return `${shown} has no tables or views.`;
  const blocks = result.objects.map(object => {
    const rows = object.rowCount === null ? "" : ` (${object.rowCount} row${object.rowCount === "1" ? "" : "s"})`;
    const columns = object.columns.map(column => {
      const flags = [column.primaryKey ? "primary key" : "", column.notNull ? "not null" : ""].filter(Boolean).join(", ");
      return `  ${[column.name, column.type, flags].filter(Boolean).join(" ")}`;
    });
    const indexes = object.indexes.map(
      index => `  index ${index.name} (${index.columns.join(", ")})${index.unique ? " unique" : ""}`,
    );
    return [`${object.type} ${object.name}${rows}`, ...columns, ...indexes].join("\n");
  });
  const hidden = result.total - result.objects.length;
  const more = hidden > 0 ? `\n\n[${hidden} more tables and views not shown; list them with SELECT name FROM sqlite_master]` : "";
  return `${blocks.join("\n\n")}${more}`;
}

/** The whole tool: checks the file and the statement, runs it, and returns text for the model. */
export async function sqliteQuery(options: SqliteRunOptions): Promise<string> {
  if (options.sql !== null) assertReadOnlySql(options.sql);
  await assertSqliteFile(options.file, options.shown);
  const result = await runSqlite(options);
  return result.kind === "schema" ? formatSchema(result, options.shown) : formatRows(result);
}
