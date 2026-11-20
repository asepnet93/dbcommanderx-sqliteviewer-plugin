import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { RawCell } from "./exportUtils";
import { quoteIdent, validateReadOnlySql } from "./sqlGuard";

export interface SchemaObject {
  name: string;
  type: "table" | "view" | "index" | string;
  sql: string;
  count: number | null;
}

export interface DisplayCell {
  kind: "null" | "blob" | "text";
  text: string;
}

export interface PagedQueryPayload {
  columns: string[];
  rows: DisplayCell[][];
  totalRows: number;
  page: number;
  totalPages: number;
  execMs: number;
}

export interface RawResultSet {
  columns: string[];
  rows: RawCell[][];
}

let cachedSqlModule: Promise<SqlJsStatic> | null = null;

export async function getSqlJsRuntime(wasmDir: string = __dirname): Promise<SqlJsStatic> {
  if (!cachedSqlModule) {
    const wasmPath = path.join(wasmDir, "sql-wasm.wasm");
    const wasmBytes = await fs.promises.readFile(wasmPath);
    const wasmBinary = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength
    );
    cachedSqlModule = initSqlJs({ wasmBinary });
  }
  return cachedSqlModule;
}

export function formatCellForDisplay(val: RawCell | undefined): DisplayCell {
  if (val === null || val === undefined) {
    return { kind: "null", text: "NULL" };
  }
  if (val instanceof Uint8Array) {
    return { kind: "blob", text: `BLOB (${val.byteLength} bytes)` };
  }
  return { kind: "text", text: String(val) };
}

export function sliceRowsForDisplay(
  columns: string[],
  rawRows: RawCell[][],
  page: number,
  pageSize: number,
  execMs: number
): PagedQueryPayload {
  const totalRows = rawRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const pageSlice = rawRows.slice(start, start + pageSize);

  return {
    columns,
    rows: pageSlice.map((row) => columns.map((_, idx) => formatCellForDisplay(row[idx]))),
    totalRows,
    page: safePage,
    totalPages,
    execMs
  };
}

export class SqliteReadOnlyInstance {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static async openFromBytes(bytes: Uint8Array, wasmDir: string = __dirname): Promise<SqliteReadOnlyInstance> {
    if (bytes.byteLength > 0) {
      const header = new TextDecoder().decode(bytes.slice(0, 15));
      if (header !== "SQLite format 3") {
        throw new Error("Invalid SQLite 3 database ('SQLite format 3' header missing).");
      }
    }
    const SQL = await getSqlJsRuntime(wasmDir);
    const db = new SQL.Database(bytes);
    return new SqliteReadOnlyInstance(db);
  }

  listSchemaObjects(): SchemaObject[] {
    const res = this.db.exec(`
      SELECT name, type, COALESCE(sql, '') AS sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY
        CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END,
        LOWER(name)
    `);
    const list: SchemaObject[] = [];
    if (res.length === 0) return list;

    for (const row of res[0].values) {
      const name = String(row[0]);
      const type = String(row[1]);
      const sql = String(row[2] ?? "");
      let count: number | null = null;
      if (type === "table" || type === "view") {
        try {
          const cntRes = this.db.exec(`SELECT COUNT(*) FROM ${quoteIdent(name)}`);
          if (cntRes.length > 0) {
            count = Number(cntRes[0].values[0][0]);
          }
        } catch {
          count = null;
        }
      }
      list.push({ name, type, sql, count });
    }
    return list;
  }

  inspectStructure(objectName: string): { columns: string[]; rows: DisplayCell[][] } {
    const res = this.db.exec(`PRAGMA table_info(${quoteIdent(objectName)})`);
    if (res.length === 0) {
      return { columns: [], rows: [] };
    }
    return {
      columns: res[0].columns,
      rows: res[0].values.map((r) => res[0].columns.map((_, idx) => formatCellForDisplay(r[idx] as RawCell)))
    };
  }

  queryTablePage(
    tableName: string,
    page: number,
    pageSize: number
  ): { paged: PagedQueryPayload; sql: string; rawResult: RawResultSet } {
    const safeIdent = quoteIdent(tableName);
    const t0 = performance.now();
    let totalRows = 0;
    try {
      const cntRes = this.db.exec(`SELECT COUNT(*) FROM ${safeIdent}`);
      if (cntRes.length > 0) totalRows = Number(cntRes[0].values[0][0]);
    } catch {
      totalRows = 0;
    }

    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;

    const sql = `SELECT * FROM ${safeIdent} LIMIT ${pageSize} OFFSET ${offset};`;
    const res = this.db.exec(sql);
    const execMs = Math.max(0.1, performance.now() - t0);

    const columns = res.length > 0 ? res[0].columns : this.inspectStructure(tableName).rows.map((r) => r[1]?.text ?? "");
    const rawRows = (res.length > 0 ? res[0].values : []) as RawCell[][];

    return {
      paged: {
        columns,
        rows: rawRows.map((row) => columns.map((_, idx) => formatCellForDisplay(row[idx]))),
        totalRows,
        page: safePage,
        totalPages,
        execMs
      },
      sql: `SELECT * FROM ${safeIdent};`,
      rawResult: { columns, rows: rawRows }
    };
  }

  executeReadOnlySql(
    sqlText: string,
    page: number,
    pageSize: number
  ):
    | { ok: true; paged: PagedQueryPayload; rawResult: RawResultSet }
    | { ok: false; kind: "guard" | "error"; message: string; keyword?: string } {
    const guard = validateReadOnlySql(sqlText);
    if (!guard.ok) {
      if (guard.reason === "EMPTY") {
        return { ok: false, kind: "error", message: "Enter a SELECT, WITH, PRAGMA, or EXPLAIN query." };
      }
      return {
        ok: false,
        kind: "guard",
        keyword: guard.keyword,
        message: `Blocked (${guard.keyword}): Read-Only Viewer does not modify your database file.`
      };
    }

    const t0 = performance.now();
    try {
      const results = this.db.exec(sqlText);
      const execMs = Math.max(0.1, performance.now() - t0);
      const last = results.length > 0 ? results[results.length - 1] : null;
      const columns = last ? last.columns : [];
      const rawRows = (last ? last.values : []) as RawCell[][];

      return {
        ok: true,
        paged: sliceRowsForDisplay(columns, rawRows, page, pageSize, execMs),
        rawResult: { columns, rows: rawRows }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "error", message: `SQLite Error: ${message}` };
    }
  }

  /**
   * Fetches all rows of a table specifically for full-table CSV/JSON export.
   */
  readAllTableRows(tableName: string): RawResultSet {
    const res = this.db.exec(`SELECT * FROM ${quoteIdent(tableName)}`);
    if (res.length === 0) return { columns: [], rows: [] };
    return {
      columns: res[0].columns,
      rows: res[0].values as RawCell[][]
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore already closed instance
    }
  }
}
