import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolError } from "../../shared/errors";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { assertReadOnlySql, formatRows, runSqlite, sqliteAvailable } from "./lib/sqlite";
import { toolsProvider } from "./toolsProvider";

const baseConfig = {
  projectFolder: "",
  allowShell: false,
  maxOutputChars: 20000,
  maxReadBytes: 262144,
  enableNotebookTools: false,
  enableSqlite: true,
  enableDiagnostics: false,
  enableSubagent: false,
  subagentModel: "",
};

// A statement that never finishes, and never hands control back between rows: one long native call.
const ENDLESS = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n";

describe("assertReadOnlySql", () => {
  it.each([
    "SELECT * FROM people",
    "  select 1;  ",
    "SELECT 'a; DROP TABLE people' AS text",
    'SELECT "delete", [update] FROM people -- insert; nothing',
    "/* leading comment */ SELECT 1",
    "WITH top AS (SELECT * FROM people LIMIT 3) SELECT name FROM top",
    "VALUES (1, 'a'), (2, 'b')",
    "EXPLAIN QUERY PLAN SELECT * FROM people WHERE id = 1",
    "PRAGMA table_info(people)",
    'PRAGMA main.index_list("people")',
    "pragma database_list;",
  ])("allows %s", sql => {
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });

  it.each([
    ["INSERT INTO people (name) VALUES ('x')", /read-only/],
    ["UPDATE people SET name = 'x'", /read-only/],
    ["DELETE FROM people", /read-only/],
    ["DROP TABLE people", /read-only/],
    ["CREATE TABLE other (id)", /read-only/],
    ["REPLACE INTO people (id, name) VALUES (1, 'x')", /read-only/],
    ["VACUUM INTO 'copy.db'", /read-only/],
    ["ATTACH DATABASE '../other.db' AS other", /ATTACH and DETACH are not allowed/],
    ["SELECT 1; ATTACH 'x.db' AS x", /Only one statement/],
    ["SELECT 1; DELETE FROM people", /Only one statement/],
    ["WITH gone AS (SELECT 1) DELETE FROM people", /read-only/],
    ["PRAGMA user_version = 5", /PRAGMA is not allowed/],
    ["PRAGMA journal_mode", /PRAGMA is not allowed/],
    ["PRAGMA journal_mode(wal)", /PRAGMA is not allowed/],
    ["PRAGMA table_info(people) = 1", /PRAGMA is not allowed/],
    ["   ", /sql is empty/],
    ["-- only a comment", /sql is empty/],
  ])("refuses %s", (sql, message) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ToolError);
    expect(() => assertReadOnlySql(sql)).toThrow(message);
  });
});

describe("formatRows", () => {
  it("escapes what would break the table", () => {
    const text = formatRows({ kind: "rows", columns: ["a|b"], rows: [["x|y\nz"], [null]], more: false });
    expect(text).toBe("| a\\|b |\n| --- |\n| x\\|y\\nz |\n| NULL |\n\n2 rows.");
  });
});

describe("sqlite_query is offered", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sqlite-offer-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const names = async (config: Record<string, unknown>) =>
    (await toolsProvider(fakeController({ config: { ...baseConfig, projectFolder: root, ...config }, workingDirectory: root }))).map(t => t.name);

  it("not at all while the setting is off", async () => {
    expect(await names({ enableSqlite: false })).not.toContain("sqlite_query");
  });

  it.runIf(sqliteAvailable())("when the setting is on, after the other file tools", async () => {
    expect(await names({})).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "multi_edit",
      "insert_lines",
      "undo_edit",
      "list_dir",
      "glob",
      "grep",
      "sqlite_query",
    ]);
  });
});

describe.runIf(sqliteAvailable())("sqlite_query", () => {
  let base: string;
  let root: string;
  let database: string;
  let outside: string;
  let original: Buffer;
  let tools: any[];

  const query = (params: Record<string, unknown>) => callTool(tools, "sqlite_query", { path: "data/app.db", ...params });
  const unchanged = async () => expect((await readFile(database)).equals(original)).toBe(true);

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "sqlite-tool-"));
    root = join(base, "project");
    await mkdir(join(root, "data"), { recursive: true });
    database = join(root, "data", "app.db");
    outside = join(base, "outside.db");

    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    for (const file of [database, outside]) {
      const db = new DatabaseSync(file);
      // One transaction: each insert on its own is a separate sync to disk, which took a slow CI
      // disk past the hook's time limit.
      db.exec("BEGIN");
      db.exec(`
        CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, photo BLOB, bio TEXT);
        CREATE UNIQUE INDEX people_email ON people (email);
        CREATE TABLE "order items" (order_id INTEGER NOT NULL, sku TEXT NOT NULL, quantity INTEGER, PRIMARY KEY (order_id, sku));
        CREATE VIEW named AS SELECT id, name FROM people;
        CREATE TABLE wide (a, b, c, d, e, f, g, h);
        INSERT INTO wide VALUES (1, 2, 3, 4, 5, 6, 7, NULL);
        CREATE TABLE numbers (n INTEGER);
      `);
      const insert = db.prepare("INSERT INTO people (name, email, photo, bio) VALUES (?, ?, ?, ?)");
      insert.run("Ann", "ann@example.test", new Uint8Array([1, 2, 3, 4, 5]), "x".repeat(450));
      insert.run("Bo | Lee", null, null, "line one\nline two");
      insert.run("Cy", "cy@example.test", null, null);
      const number = db.prepare("INSERT INTO numbers VALUES (?)");
      for (let n = 1; n <= 120; n++) number.run(n);
      db.prepare("INSERT INTO numbers VALUES (9007199254740993)").run();
      db.exec("COMMIT");
      db.close();
    }
    original = await readFile(database);
    tools = await toolsProvider(fakeController({ config: { ...baseConfig, projectFolder: root }, workingDirectory: base }));
  }, 60_000);

  afterAll(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));

  it("describes the schema when no sql is given", async () => {
    expect(await query({})).toBe(
      [
        "table numbers (121 rows)",
        "  n INTEGER",
        "",
        "table order items (0 rows)",
        "  order_id INTEGER primary key, not null",
        "  sku TEXT primary key, not null",
        "  quantity INTEGER",
        "  index sqlite_autoindex_order items_1 (order_id, sku) unique",
        "",
        "table people (3 rows)",
        "  id INTEGER primary key",
        "  name TEXT not null",
        "  email TEXT",
        "  photo BLOB",
        "  bio TEXT",
        "  index people_email (email) unique",
        "",
        "table wide (1 row)",
        "  a",
        "  b",
        "  c",
        "  d",
        "  e",
        "  f",
        "  g",
        "  h",
        "",
        "view named",
        "  id INTEGER",
        "  name TEXT",
      ].join("\n"),
    );
    await unchanged();
  });

  it("runs a SELECT and returns a table", async () => {
    expect(await query({ sql: "SELECT id, name FROM people WHERE email IS NOT NULL ORDER BY id" })).toBe(
      "| id | name |\n| --- | --- |\n| 1 | Ann |\n| 3 | Cy |\n\n2 rows.",
    );
  });

  it("shows NULL, blobs, long text and awkward characters readably", async () => {
    const text = String(await query({ sql: "SELECT name, email, photo, bio FROM people ORDER BY id" }));
    const [, , ann, bo] = text.split("\n");
    expect(ann).toBe(`| Ann | ann@example.test | <blob, 5 bytes> | ${"x".repeat(200)}… (450 chars) |`);
    expect(bo).toBe("| Bo \\| Lee | NULL | NULL | line one\\nline two |");
  });

  it("keeps integers too large for a JavaScript number exact", async () => {
    expect(await query({ sql: "SELECT max(n) AS biggest FROM numbers" })).toContain("| 9007199254740993 |");
  });

  it("keeps both columns when two share a name", async () => {
    expect(await query({ sql: "SELECT 1 AS x, 2 AS x" })).toBe("| x | x |\n| --- | --- |\n| 1 | 2 |\n\n1 row.");
  });

  it("shows one wide row as name: value lines", async () => {
    expect(await query({ sql: "SELECT * FROM wide" })).toBe("a: 1\nb: 2\nc: 3\nd: 4\ne: 5\nf: 6\ng: 7\nh: NULL\n\n1 row.");
  });

  it("says so when there are no rows", async () => {
    expect(await query({ sql: "SELECT id, name FROM people WHERE id > 100" })).toBe("No rows. Columns: id, name");
  });

  it("stops at 50 rows by default and says more exist", async () => {
    const text = String(await query({ sql: "SELECT n FROM numbers ORDER BY n" }));
    expect(text.split("\n").filter(line => /^\| \d+ \|$/.test(line))).toHaveLength(50);
    expect(text).toContain("| 50 |");
    expect(text).not.toContain("| 51 |");
    expect(text).toMatch(/Showing the first 50 rows; there are more\./);
  });

  it("honours max_rows, up to 500", async () => {
    const few = String(await query({ sql: "SELECT n FROM numbers ORDER BY n", max_rows: 3 }));
    expect(few).toMatch(/^\| n \|\n\| --- \|\n\| 1 \|\n\| 2 \|\n\| 3 \|\n\nShowing the first 3 rows; there are more\./);
    const all = String(await query({ sql: "SELECT n FROM numbers", max_rows: 500 }));
    expect(all).toMatch(/\n\n121 rows\.$/);
    await expect(query({ sql: "SELECT 1", max_rows: 501 })).rejects.toThrow(/Failed to parse arguments/);
  });

  it("cuts very large output to Max Output Characters", async () => {
    const small = await toolsProvider(
      fakeController({ config: { ...baseConfig, projectFolder: root, maxOutputChars: 1000 }, workingDirectory: base }),
    );
    const text = String(await callTool(small, "sqlite_query", { path: "data/app.db", sql: "SELECT n, n * 2, n * 3 FROM numbers", max_rows: 500 }));
    expect(text).toContain("characters truncated");
    expect(text.length).toBeLessThan(1200);
  });

  it("allows the PRAGMAs that only read", async () => {
    expect(await query({ sql: "PRAGMA table_info(people)" })).toContain("| 1 | name | TEXT | 1 | NULL | 0 |");
  });

  it("reports a mistake in the SQL as an error the model can fix", async () => {
    expect(await query({ sql: "SELECT nope FROM people" })).toMatch(/^Error: SQLite: no such column: nope/);
    expect(await query({ sql: "SELECT * FROM missing_table" })).toMatch(/^Error: SQLite: no such table: missing_table/);
  });

  it.each([
    "INSERT INTO people (name) VALUES ('Dee')",
    "UPDATE people SET name = 'changed'",
    "DELETE FROM people",
    "DROP TABLE people",
    "CREATE TABLE extra (id INTEGER)",
    "ALTER TABLE people ADD COLUMN age INTEGER",
    "PRAGMA user_version = 7",
    "PRAGMA journal_mode = WAL",
    "SELECT 1; DELETE FROM people",
    "WITH gone AS (SELECT 1) DELETE FROM people",
    "VACUUM",
  ])("refuses %s and leaves the file as it was", async sql => {
    expect(await query({ sql })).toMatch(/^Error: .*(read-only|PRAGMA is not allowed)/);
    await unchanged();
  });

  it("refuses ATTACH, which would open a file outside the project", async () => {
    const result = await query({ sql: `ATTACH DATABASE '${outside.replace(/'/g, "''")}' AS other` });
    expect(result).toMatch(/^Error: ATTACH and DETACH are not allowed/);
    await unchanged();
  });

  it("refuses VACUUM INTO and creates no file", async () => {
    const copy = join(root, "copy.db");
    expect(await query({ sql: `VACUUM INTO '${copy.replace(/'/g, "''")}'` })).toMatch(/^Error: .*read-only/);
    expect(existsSync(copy)).toBe(false);
    await unchanged();
  });

  // The statement check reads keywords, and keywords can be got around. The read-only connection is
  // what actually protects the file, so these go past the check on purpose.
  describe("a write that gets past the statement check", () => {
    it("inside a WITH is refused by SQLite itself", async () => {
      const sql = "WITH fresh(id, name) AS (SELECT 99, 'smuggled') REPLACE INTO people (id, name) SELECT id, name FROM fresh";
      expect(() => assertReadOnlySql(sql)).not.toThrow();
      expect(await query({ sql })).toMatch(/^Error: sqlite_query is read-only.*Nothing was changed\.$/);
      await unchanged();
    });

    it("as a second statement is never run", async () => {
      const result = await runSqlite({ file: database, shown: "data/app.db", sql: "SELECT 7 AS seven; DELETE FROM people" });
      expect(result).toMatchObject({ kind: "rows", rows: [["7"]] });
      expect(await query({ sql: "SELECT count(*) AS people FROM people" })).toContain("| 3 |");
      await unchanged();
    });

    it.each(["DELETE FROM people", "INSERT INTO people (name) VALUES ('x')", "DROP TABLE people", "PRAGMA user_version = 7", "CREATE TABLE extra (id)"])(
      "given straight to the connection is refused: %s",
      async sql => {
        await expect(runSqlite({ file: database, shown: "data/app.db", sql })).rejects.toThrow(/read-only.*Nothing was changed/);
        await unchanged();
      },
    );
  });

  it("refuses a path outside the project folder", async () => {
    expect(await callTool(tools, "sqlite_query", { path: "../outside.db" })).toMatch(/^Error: .*outside the allowed root/);
    expect(await callTool(tools, "sqlite_query", { path: outside })).toMatch(/^Error: .*outside the allowed root/);
  });

  it("says clearly when the file is not a SQLite database", async () => {
    await writeFile(join(root, "notes.txt"), "These are notes, long enough to be read as a header, not a database.");
    await writeFile(join(root, "empty.db"), "");
    expect(await callTool(tools, "sqlite_query", { path: "notes.txt" })).toBe("Error: notes.txt is not a SQLite database.");
    expect(await callTool(tools, "sqlite_query", { path: "empty.db", sql: "SELECT 1" })).toBe("Error: empty.db is not a SQLite database.");
    expect(await callTool(tools, "sqlite_query", { path: "data" })).toBe("Error: data is not a file.");
  });

  it("does not create a file that is missing", async () => {
    expect(await callTool(tools, "sqlite_query", { path: "data/new.db" })).toMatch(/^Error: .*data\/new\.db does not exist/);
    expect(await callTool(tools, "sqlite_query", { path: "data/new.db", sql: "SELECT 1" })).toMatch(/does not exist/);
    expect(existsSync(join(root, "data", "new.db"))).toBe(false);
  });

  it("stops a query that runs too long, and says how to avoid it", async () => {
    const started = Date.now();
    const attempt = runSqlite({ file: database, shown: "data/app.db", sql: ENDLESS, timeoutMs: 1000 });
    await expect(attempt).rejects.toThrow(ToolError);
    await expect(attempt).rejects.toThrow(/ran for more than 1 seconds and was stopped\. Add a LIMIT/);
    expect(Date.now() - started).toBeLessThan(8000);
    // The plugin is still usable afterwards, and the file untouched.
    expect(await query({ sql: "SELECT count(*) AS people FROM people" })).toContain("| 3 |");
    await unchanged();
  });

  it("stops when the tool call is cancelled", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const started = Date.now();
    await expect(runSqlite({ file: database, shown: "data/app.db", sql: ENDLESS, signal: abort.signal })).rejects.toThrow(
      "The query was cancelled.",
    );
    expect(Date.now() - started).toBeLessThan(8000);
  });
});
