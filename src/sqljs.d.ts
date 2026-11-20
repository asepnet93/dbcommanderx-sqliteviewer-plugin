declare module "sql.js" {
  export type SqlValue = number | string | Uint8Array | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    run(values?: SqlValue[] | Record<string, SqlValue>): void;
    free(): boolean;
  }

  export interface Database {
    exec(sql: string): QueryExecResult[];
    run(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Database;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsConfig {
    wasmBinary?: ArrayBuffer | ArrayBufferLike | Uint8Array;
    locateFile?: (filename: string, prefix: string) => string;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
