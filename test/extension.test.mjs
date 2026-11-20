import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");

const {
  validateReadOnlySql,
  quoteIdent,
  serializeToCsv,
  serializeToJson,
  getSqlJsRuntime,
  SqliteReadOnlyInstance
} = require(path.join(distDir, "coreBundle.cjs"));

test("quoteIdent escapes double quotes safely", () => {
  assert.equal(quoteIdent("users"), '"users"');
  assert.equal(quoteIdent('weird"name'), '"weird""name"');
});

test("validateReadOnlySql permits read queries and rejects mutating statements", () => {
  assert.deepEqual(validateReadOnlySql("SELECT * FROM users;").ok, true);
  assert.deepEqual(
    validateReadOnlySql("WITH cte AS (SELECT 1) SELECT * FROM cte;").ok,
    true
  );
  assert.deepEqual(validateReadOnlySql("PRAGMA table_info('users');").ok, true);
  assert.deepEqual(
    validateReadOnlySql("EXPLAIN QUERY PLAN SELECT * FROM users;").ok,
    true
  );
  assert.deepEqual(
    validateReadOnlySql("-- leading comment\n/* block */\nSELECT 1;").ok,
    true
  );

  const emptyRes = validateReadOnlySql("   -- only comment   ");
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.reason, "EMPTY");

  for (const sql of [
    "DELETE FROM users;",
    "INSERT INTO users VALUES (1, 'a');",
    "UPDATE users SET name = 'x';",
    "DROP TABLE users;",
    "ALTER TABLE users ADD COLUMN age INT;",
    "CREATE TABLE hack (id INT);",
    "VACUUM;",
    "/* sneak */ DELETE FROM users;",
    "PRAGMA journal_mode = WAL;",
    "SELECT 1; DROP TABLE users;"
  ]) {
    const blocked = validateReadOnlySql(sql);
    assert.equal(blocked.ok, false, `Expected blocked SQL for: ${sql}`);
  }
});

test("SqliteReadOnlyInstance reads real SQLite bytes, paginates, inspects structure, and blocks writes", async () => {
  const SQL = await getSqlJsRuntime(distDir);
  const seedDb = new SQL.Database();
  seedDb.run(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      title TEXT,
      payload BLOB
    );
    CREATE VIEW active_items AS SELECT id, title FROM items WHERE title IS NOT NULL;
    CREATE INDEX idx_items_title ON items(title);
  `);
  const insertStmt = seedDb.prepare(
    "INSERT INTO items (id, title, payload) VALUES (?, ?, ?);"
  );
  for (let i = 1; i <= 250; i += 1) {
    const title = i % 50 === 0 ? null : `Item "${i}", =ROW`;
    const blob = i === 1 ? Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]) : null;
    insertStmt.run([i, title, blob]);
  }
  insertStmt.free();
  const dbBytes = seedDb.export();
  seedDb.close();

  const reader = await SqliteReadOnlyInstance.openFromBytes(dbBytes, distDir);
  try {
    const schema = reader.listSchemaObjects();
    const tableObj = schema.find((item) => item.name === "items" && item.type === "table");
    const viewObj = schema.find(
      (item) => item.name === "active_items" && item.type === "view"
    );
    const idxObj = schema.find(
      (item) => item.name === "idx_items_title" && item.type === "index"
    );

    assert.ok(tableObj);
    assert.equal(tableObj.count, 250);
    assert.ok(viewObj);
    assert.ok(idxObj);

    const page1 = reader.queryTablePage("items", 1, 100);
    assert.equal(page1.paged.totalRows, 250);
    assert.equal(page1.paged.totalPages, 3);
    assert.equal(page1.paged.rows.length, 100);
    assert.equal(page1.paged.rows[0][2].kind, "blob");

    const page3 = reader.queryTablePage("items", 3, 100);
    assert.equal(page3.paged.page, 3);
    assert.equal(page3.paged.rows.length, 50);
    assert.equal(page3.paged.rows[49][1].kind, "null");

    const struct = reader.inspectStructure("items");
    assert.ok(struct.columns.includes("name"));
    assert.equal(struct.rows.length, 3);

    const guardRes = reader.executeReadOnlySql("DELETE FROM items;", 1, 100);
    assert.equal(guardRes.ok, false);
    assert.equal(guardRes.kind, "guard");

    const selectRes = reader.executeReadOnlySql(
      "SELECT COUNT(*) AS cnt FROM items;",
      1,
      100
    );
    assert.equal(selectRes.ok, true);
    assert.equal(selectRes.rawResult.rows[0][0], 250);

    const rawAll = reader.readAllTableRows("items");
    assert.equal(rawAll.rows.length, 250);
  } finally {
    reader.close();
  }
});

test("SqliteReadOnlyInstance rejects non-SQLite invalid header bytes", async () => {
  const garbage = Uint8Array.from(Buffer.from("SQLCipher-or-random-bytes-header"));
  await assert.rejects(
    () => SqliteReadOnlyInstance.openFromBytes(garbage, distDir),
    /file is not a database|SQLite|not a database/i
  );
});

test("serializeToCsv and serializeToJson neutralize spreadsheet formulas and serialize special types", () => {
  const columns = ["id", "note", "blob", "empty"];
  const rows = [
    [1, '=SUM(A1:A2)', Uint8Array.from([0x0a, 0xff]), null],
    [2, 'hello, "world"\nline2', null, "ok"]
  ];

  const csv = serializeToCsv(columns, rows);
  assert.match(csv, /^id,note,blob,empty\r?\n/);
  assert.ok(csv.includes("'=SUM(A1:A2)"), `Expected formula neutralization in CSV: ${csv}`);
  assert.ok(csv.includes('"hello, ""world""\nline2"'));

  const parsedJson = JSON.parse(serializeToJson(columns, rows));
  assert.equal(parsedJson.length, 2);
  assert.equal(parsedJson[0].empty, null);
  assert.equal(parsedJson[1].note, 'hello, "world"\nline2');
});
