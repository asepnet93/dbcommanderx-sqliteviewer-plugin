import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type BindParams, type Database, type SqlJsStatic } from "sql.js";
import { RawCell } from "./exportUtils";
import { quoteIdent, validateReadOnlySql } from "./sqlGuard";

const MAX_GRID_CELL_CHARS = 1000;

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

export interface TableQueryOptions {
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  filterText?: string;
}

export interface PagedQueryPayload {
  columns: string[];
  rows: DisplayCell[][];
  totalRows: number;
  page: number;
  totalPages: number;
  execMs: number;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  filterText?: string;
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
  const text = String(val);
  return {
    kind: "text",
    text: text.length > MAX_GRID_CELL_CHARS ? `${text.slice(0, MAX_GRID_CELL_CHARS)}…` : text
  };
}

export function sliceRowsForDisplay(
  columns: string[],
  rawRows: RawCell[][],
  page: number,
  pageSize: number,
  execMs: number,
  meta?: TableQueryOptions
): { paged: PagedQueryPayload; pageRawResult: RawResultSet } {
  const totalRows = rawRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const pageSlice = rawRows.slice(start, start + pageSize);

  return {
    paged: {
      columns,
      rows: pageSlice.map((row) => columns.map((_, idx) => formatCellForDisplay(row[idx]))),
      totalRows,
      page: safePage,
      totalPages,
      execMs,
      sortColumn: meta?.sortColumn,
      sortDir: meta?.sortDir,
      filterText: meta?.filterText
    },
    pageRawResult: { columns, rows: pageSlice }
  };
}

function compareRawCells(a: RawCell | undefined, b: RawCell | undefined): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.byteLength - b.byteLength;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function applyInMemorySortFilter(
  raw: RawResultSet,
  options?: TableQueryOptions
): { result: RawResultSet; applied: TableQueryOptions } {
  const term = options?.filterText?.trim() ?? "";
  let rows = raw.rows;

  if (term.length > 0) {
    const lower = term.toLowerCase();
    rows = rows.filter((row) =>
      row.some((cell) => {
        if (cell === null || cell === undefined) return false;
        if (cell instanceof Uint8Array) return `blob (${cell.byteLength} bytes)`.includes(lower);
        return String(cell).toLowerCase().includes(lower);
      })
    );
  }

  let appliedSortCol: string | undefined;
  let appliedSortDir: "asc" | "desc" | undefined;
  const colIdx = options?.sortColumn ? raw.columns.indexOf(options.sortColumn) : -1;

  if (colIdx >= 0 && (options?.sortDir === "asc" || options?.sortDir === "desc")) {
    appliedSortCol = options.sortColumn;
    appliedSortDir = options.sortDir;
    const sign = appliedSortDir === "asc" ? 1 : -1;
    rows = [...rows].sort((ra, rb) => sign * compareRawCells(ra[colIdx], rb[colIdx]));
  }

  return {
    result: { columns: raw.columns, rows },
    applied: {
      sortColumn: appliedSortCol,
      sortDir: appliedSortDir,
      filterText: term || undefined
    }
  };
}

export class SqliteReadOnlyInstance {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static async openFromBytes(
    bytes: Uint8Array,
    wasmDir: string = __dirname
  ): Promise<SqliteReadOnlyInstance> {
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

  getObjectColumns(objectName: string): string[] {
    const res = this.db.exec(`PRAGMA table_info(${quoteIdent(objectName)})`);
    if (res.length === 0) return [];
    return res[0].values.map((row) => String(row[1] ?? ""));
  }

  inspectStructure(
    objectName: string,
    objectType?: string
  ): { columns: string[]; rows: DisplayCell[][] } {
    const pragma = objectType === "index" ? "index_info" : "table_info";
    const res = this.db.exec(`PRAGMA ${pragma}(${quoteIdent(objectName)})`);
    if (res.length === 0) {
      return { columns: [], rows: [] };
    }
    return {
      columns: res[0].columns,
      rows: res[0].values.map((r) =>
        res[0].columns.map((_, idx) => formatCellForDisplay(r[idx] as RawCell))
      )
    };
  }

  private buildTableClauses(
    tableName: string,
    options?: TableQueryOptions
  ): {
    safeIdent: string;
    columns: string[];
    whereClause: string;
    orderClause: string;
    params: Record<string, string | number | Uint8Array | null>;
    displaySql: string;
    applied: TableQueryOptions;
  } {
    const safeIdent = quoteIdent(tableName);
    const columns = this.getObjectColumns(tableName);
    const params: Record<string, string | number | Uint8Array | null> = {};
    const term = options?.filterText?.trim() ?? "";

    let whereClause = "";
    let displayWhere = "";
    if (term.length > 0 && columns.length > 0) {
      const escapedLike = term.replace(/[\\%_]/g, "\\$&");
      params[":q"] = `%${escapedLike}%`;
      const predicates = columns.map((col) => `CAST(${quoteIdent(col)} AS TEXT) LIKE :q ESCAPE '\\'`);
      whereClause = ` WHERE (${predicates.join(" OR ")})`;
      const safeDisplay = term.replace(/'/g, "''");
      displayWhere = ` WHERE /* filter: '${safeDisplay}' */`;
    }

    let orderClause = "";
    let appliedSortCol: string | undefined;
    let appliedSortDir: "asc" | "desc" | undefined;
    if (
      options?.sortColumn &&
      columns.includes(options.sortColumn) &&
      (options.sortDir === "asc" || options.sortDir === "desc")
    ) {
      appliedSortCol = options.sortColumn;
      appliedSortDir = options.sortDir;
      orderClause = ` ORDER BY ${quoteIdent(appliedSortCol)} ${appliedSortDir.toUpperCase()}`;
    }

    const displaySql = `SELECT * FROM ${safeIdent}${displayWhere}${orderClause};`;
    return {
      safeIdent,
      columns,
      whereClause,
      orderClause,
      params,
      displaySql,
      applied: {
        sortColumn: appliedSortCol,
        sortDir: appliedSortDir,
        filterText: term || undefined
      }
    };
  }

  queryTablePage(
    tableName: string,
    page: number,
    pageSize: number,
    options?: TableQueryOptions
  ): { paged: PagedQueryPayload; sql: string; rawResult: RawResultSet } {
    const clauses = this.buildTableClauses(tableName, options);
    const t0 = performance.now();

    let totalRows = 0;
    try {
      const cntRes = this.db.exec(
        `SELECT COUNT(*) FROM ${clauses.safeIdent}${clauses.whereClause}`,
        Object.keys(clauses.params).length > 0 ? clauses.params : undefined
      );
      if (cntRes.length > 0) {
        totalRows = Number(cntRes[0].values[0][0]);
      }
    } catch {
      totalRows = 0;
    }

    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;

    const pageParams: BindParams = {
      ...clauses.params,
      ":lim": pageSize,
      ":off": offset
    };
    const sql = `SELECT * FROM ${clauses.safeIdent}${clauses.whereClause}${clauses.orderClause} LIMIT :lim OFFSET :off;`;
    const res = this.db.exec(sql, pageParams);
    const execMs = Math.max(0.1, performance.now() - t0);

    const columns = res.length > 0 ? res[0].columns : clauses.columns;
    const rawRows = (res.length > 0 ? res[0].values : []) as RawCell[][];

    return {
      paged: {
        columns,
        rows: rawRows.map((row) => columns.map((_, idx) => formatCellForDisplay(row[idx]))),
        totalRows,
        page: safePage,
        totalPages,
        execMs,
        sortColumn: clauses.applied.sortColumn,
        sortDir: clauses.applied.sortDir,
        filterText: clauses.applied.filterText
      },
      sql: clauses.displaySql,
      rawResult: { columns, rows: rawRows }
    };
  }

  executeReadOnlySql(
    sqlText: string,
    page: number,
    pageSize: number,
    options?: TableQueryOptions
  ):
    | {
        ok: true;
        paged: PagedQueryPayload;
        rawResult: RawResultSet;
        pageRawResult: RawResultSet;
      }
    | { ok: false; kind: "guard" | "error"; message: string; keyword?: string } {
    const guard = validateReadOnlySql(sqlText);
    if (!guard.ok) {
      if (guard.reason === "EMPTY") {
        return {
          ok: false,
          kind: "error",
          message: "Enter a SELECT, WITH, PRAGMA, or EXPLAIN query."
        };
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
      const baseRaw: RawResultSet = {
        columns: last ? last.columns : [],
        rows: (last ? last.values : []) as RawCell[][]
      };

      const { result: processed, applied } = applyInMemorySortFilter(baseRaw, options);
      const sliced = sliceRowsForDisplay(
        processed.columns,
        processed.rows,
        page,
        pageSize,
        execMs,
        applied
      );

      return {
        ok: true,
        paged: sliced.paged,
        rawResult: processed,
        pageRawResult: sliced.pageRawResult
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "error", message: `SQLite Error: ${message}` };
    }
  }

  readAllTableRows(tableName: string, options?: TableQueryOptions): RawResultSet {
    const clauses = this.buildTableClauses(tableName, options);
    const hasParams = Object.keys(clauses.params).length > 0;
    const res = this.db.exec(
      `SELECT * FROM ${clauses.safeIdent}${clauses.whereClause}${clauses.orderClause}`,
      hasParams ? clauses.params : undefined
    );
    if (res.length === 0) {
      return { columns: clauses.columns, rows: [] };
    }
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
