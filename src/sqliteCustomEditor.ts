import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { serializeToCsv, serializeToJson } from "./exportUtils";
import {
  PagedQueryPayload,
  RawResultSet,
  SchemaObject,
  SqliteReadOnlyInstance
} from "./sqliteEngine";

export const VIEW_TYPE = "dbcommanderx.sqliteViewer";
const DEFAULT_PAGE_SIZE = 100;
const ALLOWED_EXTERNAL_HOSTS = new Set([
  "dbcx.rubrikpulsa.com",
  "apps.microsoft.com",
  "play.google.com"
]);

type ExportSource =
  | { kind: "table"; tableName: string }
  | { kind: "sql"; rawResult: RawResultSet }
  | null;

type WebviewRequest =
  | { type: "ready" }
  | { type: "reload" }
  | { type: "selectObject"; name: string }
  | {
      type: "paginate";
      mode: "table" | "sql";
      targetName?: string;
      sqlText?: string;
      page: number;
    }
  | { type: "runSql"; sqlText: string }
  | { type: "export"; format: "csv" | "json" }
  | { type: "openExternal"; url: string };

class SqliteDocument implements vscode.CustomDocument {
  public engine: SqliteReadOnlyInstance | null;
  public schema: SchemaObject[];
  public fileSizeBytes: number;
  public initError: string | null;

  private constructor(
    public readonly uri: vscode.Uri,
    private readonly wasmDir: string,
    fileSizeBytes: number,
    engine: SqliteReadOnlyInstance | null,
    schema: SchemaObject[],
    initError: string | null
  ) {
    this.fileSizeBytes = fileSizeBytes;
    this.engine = engine;
    this.schema = schema;
    this.initError = initError;
  }

  public static async create(uri: vscode.Uri, wasmDir: string): Promise<SqliteDocument> {
    const doc = new SqliteDocument(uri, wasmDir, 0, null, [], null);
    await doc.reload();
    return doc;
  }

  public async reload(): Promise<void> {
    this.engine?.close();
    this.engine = null;
    this.schema = [];
    this.initError = null;

    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      this.fileSizeBytes = bytes.byteLength;
      const engine = await SqliteReadOnlyInstance.openFromBytes(bytes, this.wasmDir);
      this.engine = engine;
      this.schema = engine.listSchemaObjects();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.initError =
        detail || "Unable to open database (encrypted SQLCipher or invalid SQLite header).";
    }
  }

  public dispose(): void {
    this.engine?.close();
    this.engine = null;
  }
}

export class SqliteCustomEditorProvider
  implements vscode.CustomReadonlyEditorProvider<SqliteDocument>
{
  private readonly wasmDir: string;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.wasmDir = path.join(context.extensionPath, "dist");
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<SqliteDocument> {
    return SqliteDocument.create(uri, this.wasmDir);
  }

  public async resolveCustomEditor(
    document: SqliteDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media");
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot]
    };
    webviewPanel.webview.html = this.buildWebviewHtml(webviewPanel.webview);

    let lastExportSource: ExportSource = null;

    const sendInitialState = (): void => {
      const fileName = path.basename(document.uri.fsPath || document.uri.path);
      if (document.initError || !document.engine) {
        void webviewPanel.webview.postMessage({
          type: "initError",
          fileName,
          fileSizeBytes: document.fileSizeBytes,
          message: document.initError ?? "Failed to open SQLite file."
        });
        return;
      }

      void webviewPanel.webview.postMessage({
        type: "init",
        fileName,
        fileSizeBytes: document.fileSizeBytes,
        schema: document.schema
      });

      const firstSelectable =
        document.schema.find((item) => item.type === "table") ??
        document.schema.find((item) => item.type === "view") ??
        document.schema[0];

      if (firstSelectable) {
        selectObject(firstSelectable.name);
      }
    };

    const selectObject = (objectName: string): void => {
      if (!document.engine) {
        return;
      }
      const obj = document.schema.find((item) => item.name === objectName);
      if (!obj) {
        return;
      }

      try {
        const structure = document.engine.inspectStructure(obj.name);
        if (obj.type === "table" || obj.type === "view") {
          const result = document.engine.queryTablePage(obj.name, 1, DEFAULT_PAGE_SIZE);
          lastExportSource = { kind: "table", tableName: obj.name };
          void webviewPanel.webview.postMessage({
            type: "objectLoaded",
            object: obj,
            sql: result.sql,
            paged: result.paged,
            structure,
            defaultTab: "data"
          });
          return;
        }

        lastExportSource = null;
        const emptyPaged: PagedQueryPayload = {
          columns: [],
          rows: [],
          totalRows: 0,
          page: 1,
          totalPages: 1,
          execMs: 0
        };
        void webviewPanel.webview.postMessage({
          type: "objectLoaded",
          object: obj,
          sql: "",
          paged: emptyPaged,
          structure,
          defaultTab: "ddl"
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        void webviewPanel.webview.postMessage({
          type: "sqlError",
          kind: "error",
          message: detail
        });
      }
    };

    const handlePaginate = (msg: Extract<WebviewRequest, { type: "paginate" }>): void => {
      if (!document.engine) {
        return;
      }
      const page = Number.isFinite(msg.page) ? Math.max(1, Math.floor(msg.page)) : 1;

      try {
        if (msg.mode === "table" && msg.targetName) {
          const result = document.engine.queryTablePage(
            msg.targetName,
            page,
            DEFAULT_PAGE_SIZE
          );
          lastExportSource = { kind: "table", tableName: msg.targetName };
          void webviewPanel.webview.postMessage({
            type: "pageLoaded",
            paged: result.paged
          });
          return;
        }

        if (msg.mode === "sql" && typeof msg.sqlText === "string") {
          const res = document.engine.executeReadOnlySql(
            msg.sqlText,
            page,
            DEFAULT_PAGE_SIZE
          );
          if (!res.ok) {
            void webviewPanel.webview.postMessage({
              type: "sqlError",
              kind: res.kind,
              message: res.message,
              keyword: res.keyword ?? null
            });
            return;
          }
          lastExportSource = { kind: "sql", rawResult: res.rawResult };
          void webviewPanel.webview.postMessage({
            type: "pageLoaded",
            paged: res.paged
          });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        void webviewPanel.webview.postMessage({
          type: "sqlError",
          kind: "error",
          message: detail
        });
      }
    };

    const handleRunSql = (sqlText: string): void => {
      if (!document.engine) {
        return;
      }
      const res = document.engine.executeReadOnlySql(sqlText, 1, DEFAULT_PAGE_SIZE);
      if (!res.ok) {
        void webviewPanel.webview.postMessage({
          type: "sqlError",
          kind: res.kind,
          message: res.message,
          keyword: res.keyword ?? null
        });
        return;
      }
      lastExportSource = { kind: "sql", rawResult: res.rawResult };
      void webviewPanel.webview.postMessage({
        type: "sqlResult",
        paged: res.paged
      });
    };

    const handleExport = async (format: "csv" | "json"): Promise<void> => {
      if (!document.engine || !lastExportSource) {
        void vscode.window.showInformationMessage("No query results available to export.");
        return;
      }

      let raw: RawResultSet;
      let stem: string;
      try {
        if (lastExportSource.kind === "table") {
          raw = document.engine.readAllTableRows(lastExportSource.tableName);
          stem = lastExportSource.tableName;
        } else {
          raw = lastExportSource.rawResult;
          const base = path.basename(document.uri.fsPath || "query", path.extname(document.uri.fsPath));
          stem = `${base}_query`;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Export failed: ${detail}`);
        return;
      }

      const safeStem = stem.replace(/[^a-zA-Z0-9._-]+/g, "_") || "export";
      const ext = format === "csv" ? "csv" : "json";
      const parentDir = path.dirname(document.uri.fsPath || "");
      const defaultUri = parentDir
        ? vscode.Uri.file(path.join(parentDir, `${safeStem}.${ext}`))
        : undefined;

      const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: format === "csv" ? { CSV: ["csv"] } : { JSON: ["json"] },
        saveLabel: `Export ${format.toUpperCase()}`
      });
      if (!targetUri) {
        return;
      }

      const content =
        format === "csv"
          ? serializeToCsv(raw.columns, raw.rows)
          : serializeToJson(raw.columns, raw.rows);

      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
      void webviewPanel.webview.postMessage({
        type: "exportDone",
        message: `Saved ${raw.rows.length} rows to ${path.basename(targetUri.fsPath)}`
      });
    };

    const handleOpenExternal = (rawUrl: string): void => {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "https:" || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
          return;
        }
        void vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
      } catch {
        // Ignore malformed URLs from untrusted messages.
      }
    };

    const msgDisposable = webviewPanel.webview.onDidReceiveMessage(
      async (msg: WebviewRequest) => {
        if (!msg || typeof msg.type !== "string") {
          return;
        }
        switch (msg.type) {
          case "ready":
            sendInitialState();
            break;
          case "reload":
            lastExportSource = null;
            await document.reload();
            sendInitialState();
            break;
          case "selectObject":
            if (typeof msg.name === "string") {
              selectObject(msg.name);
            }
            break;
          case "paginate":
            handlePaginate(msg);
            break;
          case "runSql":
            if (typeof msg.sqlText === "string") {
              handleRunSql(msg.sqlText);
            }
            break;
          case "export":
            if (msg.format === "csv" || msg.format === "json") {
              await handleExport(msg.format);
            }
            break;
          case "openExternal":
            if (typeof msg.url === "string") {
              handleOpenExternal(msg.url);
            }
            break;
        }
      }
    );

    webviewPanel.onDidDispose(() => {
      msgDisposable.dispose();
    });
  }

  private buildWebviewHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, "webview.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, "webview.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SQLite Viewer — DB CommanderX</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="app">
    <header class="toolbar">
      <div class="toolbar-left">
        <span class="brand-badge">DBX</span>
        <span id="db-name" class="db-name">Opening…</span>
        <span id="db-stats" class="db-stats"></span>
      </div>
      <div class="toolbar-right">
        <span class="readonly-pill" title="Database is opened in read-only mode inside VS Code">Read-Only</span>
        <button id="btn-reload" type="button" class="btn btn-secondary" title="Reload database bytes from disk">Reload</button>
        <button id="btn-full-ide" type="button" class="btn btn-link" title="Edit tables, unlock SQLCipher DBs, and manage servers in DB CommanderX">Full IDE ↗</button>
      </div>
    </header>

    <div class="workspace">
      <aside class="sidebar">
        <div class="sidebar-header">
          <input id="schema-filter" type="search" placeholder="Filter tables & views…" aria-label="Filter schema objects" />
        </div>
        <ul id="schema-list" class="schema-list" aria-label="Database objects"></ul>
      </aside>

      <main class="content">
        <section class="sql-bar">
          <div class="sql-controls">
            <div class="preset-group">
              <button type="button" class="chip" data-preset="select">SELECT *</button>
              <button type="button" class="chip" data-preset="pragma">PRAGMA table_info</button>
              <button type="button" class="chip" data-preset="schema">sqlite_master</button>
            </div>
            <div class="sql-actions">
              <button id="btn-clear-sql" type="button" class="btn btn-secondary">Clear</button>
              <button id="btn-run-sql" type="button" class="btn btn-primary">Run (Ctrl+Enter)</button>
            </div>
          </div>
          <textarea id="sql-input" rows="3" spellcheck="false" placeholder="SELECT * FROM table_name LIMIT 100;"></textarea>
        </section>

        <div id="status-banner" class="status-banner hidden" role="status">
          <span id="status-text" class="status-text"></span>
          <div class="status-actions">
            <button id="btn-banner-ide" type="button" class="btn btn-link hidden">Open DB CommanderX ↗</button>
            <button id="btn-banner-dismiss" type="button" class="btn btn-secondary">Dismiss</button>
          </div>
        </div>

        <div class="results-toolbar">
          <div class="tabs" role="tablist">
            <button type="button" class="tab active" data-tab="data" role="tab">Data</button>
            <button type="button" class="tab" data-tab="structure" role="tab">Structure</button>
            <button type="button" class="tab" data-tab="ddl" role="tab">DDL</button>
          </div>
          <div class="results-actions">
            <span id="query-meta" class="query-meta"></span>
            <button id="btn-export-csv" type="button" class="btn btn-secondary" disabled>CSV</button>
            <button id="btn-export-json" type="button" class="btn btn-secondary" disabled>JSON</button>
          </div>
        </div>

        <div id="results-viewport" class="results-viewport">
          <div id="empty-state" class="empty-state hidden"></div>
          <div id="table-wrap" class="table-wrap hidden">
            <table id="data-grid">
              <thead></thead>
              <tbody></tbody>
            </table>
          </div>
          <pre id="ddl-view" class="ddl-view hidden"></pre>
        </div>

        <footer id="pagination-bar" class="pagination-bar hidden">
          <button id="btn-prev" type="button" class="btn btn-secondary">Prev</button>
          <span id="page-info" class="page-info">Page 1 / 1</span>
          <button id="btn-next" type="button" class="btn btn-secondary">Next</button>
        </footer>
      </main>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
