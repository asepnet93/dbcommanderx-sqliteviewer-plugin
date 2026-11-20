import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  detectImageMime,
  inspectRawCell,
  suggestedExtensionForMime
} from "./cellInspector";
import {
  rowToExportRecord,
  serializeToCsv,
  serializeToJson
} from "./exportUtils";
import {
  PagedQueryPayload,
  RawResultSet,
  SchemaObject,
  SqliteReadOnlyInstance,
  TableQueryOptions
} from "./sqliteEngine";

export const VIEW_TYPE = "dbcommanderx.sqliteViewer";
const DEFAULT_PAGE_SIZE = 100;
const AUTO_RELOAD_DEBOUNCE_MS = 400;
const ALLOWED_EXTERNAL_HOSTS = new Set([
  "dbcx.rubrikpulsa.com",
  "apps.microsoft.com",
  "play.google.com"
]);

type ExportSource =
  | { kind: "table"; tableName: string; options: TableQueryOptions }
  | { kind: "sql"; rawResult: RawResultSet }
  | null;

interface ActiveViewState {
  mode: "table" | "sql";
  objectName?: string;
  sqlText?: string;
  page: number;
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  filterText?: string;
}

type WebviewRequest =
  | { type: "ready" }
  | { type: "reload" }
  | { type: "setAutoReload"; enabled: boolean }
  | { type: "selectObject"; name: string }
  | {
      type: "queryView";
      mode: "table" | "sql";
      targetName?: string;
      sqlText?: string;
      page?: number;
      sortColumn?: string;
      sortDir?: "asc" | "desc";
      filterText?: string;
      updateSqlBox?: boolean;
    }
  | { type: "runSql"; sqlText: string }
  | { type: "inspectCell"; rowIndex: number; colIndex: number }
  | { type: "saveBlob"; rowIndex: number; colIndex: number }
  | { type: "copyText"; text: string; label?: string }
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
    let currentPageRaw: RawResultSet | null = null;
    let autoReloadEnabled = true;
    let isReloading = false;
    let reloadTimer: NodeJS.Timeout | undefined;
    let viewState: ActiveViewState = { mode: "table", page: 1 };

    const getQueryOptions = (): TableQueryOptions => ({
      sortColumn: viewState.sortColumn,
      sortDir: viewState.sortDir,
      filterText: viewState.filterText
    });

    const sendSchemaHeader = (reason: "init" | "reloaded"): void => {
      const fileName = path.basename(document.uri.fsPath || document.uri.path);
      if (document.initError || !document.engine) {
        currentPageRaw = null;
        lastExportSource = null;
        void webviewPanel.webview.postMessage({
          type: "initError",
          fileName,
          fileSizeBytes: document.fileSizeBytes,
          autoReloadEnabled,
          message: document.initError ?? "Failed to open SQLite file."
        });
        return;
      }

      void webviewPanel.webview.postMessage({
        type: "init",
        reason,
        fileName,
        fileSizeBytes: document.fileSizeBytes,
        autoReloadEnabled,
        schema: document.schema
      });
    };

    const pickDefaultObject = (): SchemaObject | undefined =>
      document.schema.find((item) => item.type === "table") ??
      document.schema.find((item) => item.type === "view") ??
      document.schema[0];

    const runCurrentView = (options?: {
      updateSqlBox?: boolean;
      resetTabOnIndex?: boolean;
    }): void => {
      if (!document.engine) {
        return;
      }
      const queryOpts = getQueryOptions();

      if (viewState.mode === "sql" && typeof viewState.sqlText === "string") {
        const res = document.engine.executeReadOnlySql(
          viewState.sqlText,
          viewState.page,
          DEFAULT_PAGE_SIZE,
          queryOpts
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
        viewState.page = res.paged.page;
        viewState.sortColumn = res.paged.sortColumn;
        viewState.sortDir = res.paged.sortDir;
        viewState.filterText = res.paged.filterText;
        currentPageRaw = res.pageRawResult;
        lastExportSource = { kind: "sql", rawResult: res.rawResult };

        void webviewPanel.webview.postMessage({
          type: "viewData",
          mode: "sql",
          paged: res.paged,
          sql: viewState.sqlText,
          updateSqlBox: Boolean(options?.updateSqlBox)
        });
        return;
      }

      const targetObj =
        (viewState.objectName
          ? document.schema.find((item) => item.name === viewState.objectName)
          : undefined) ?? pickDefaultObject();

      if (!targetObj) {
        currentPageRaw = null;
        lastExportSource = null;
        return;
      }

      viewState.mode = "table";
      viewState.objectName = targetObj.name;

      try {
        const structure = document.engine.inspectStructure(targetObj.name, targetObj.type);
        if (targetObj.type === "table" || targetObj.type === "view") {
          const result = document.engine.queryTablePage(
            targetObj.name,
            viewState.page,
            DEFAULT_PAGE_SIZE,
            queryOpts
          );
          viewState.page = result.paged.page;
          viewState.sortColumn = result.paged.sortColumn;
          viewState.sortDir = result.paged.sortDir;
          viewState.filterText = result.paged.filterText;
          currentPageRaw = result.rawResult;
          lastExportSource = {
            kind: "table",
            tableName: targetObj.name,
            options: queryOpts
          };

          void webviewPanel.webview.postMessage({
            type: "viewData",
            mode: "table",
            object: targetObj,
            sql: result.sql,
            updateSqlBox: options?.updateSqlBox !== false,
            paged: result.paged,
            structure,
            defaultTab: options?.resetTabOnIndex ? "data" : undefined
          });
          return;
        }

        currentPageRaw = null;
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
          type: "viewData",
          mode: "table",
          object: targetObj,
          sql: "",
          updateSqlBox: false,
          paged: emptyPaged,
          structure,
          defaultTab: options?.resetTabOnIndex ? "ddl" : undefined
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

    const reloadFromDisk = async (reason: "manual" | "auto"): Promise<void> => {
      if (isReloading) {
        return;
      }
      isReloading = true;
      try {
        await document.reload();
        sendSchemaHeader("reloaded");
        if (document.engine) {
          runCurrentView({ updateSqlBox: reason === "manual", resetTabOnIndex: false });
          if (reason === "auto") {
            void webviewPanel.webview.postMessage({
              type: "toast",
              message: "Database updated on disk — view refreshed."
            });
          }
        }
      } finally {
        isReloading = false;
      }
    };

    const disposables: vscode.Disposable[] = [];
    if (document.uri.scheme === "file" && document.uri.fsPath) {
      const dir = path.dirname(document.uri.fsPath);
      const base = path.basename(document.uri.fsPath);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), base)
      );
      const scheduleAutoReload = (): void => {
        if (!autoReloadEnabled || isReloading) {
          return;
        }
        if (reloadTimer) {
          clearTimeout(reloadTimer);
        }
        reloadTimer = setTimeout(() => {
          reloadTimer = undefined;
          void reloadFromDisk("auto");
        }, AUTO_RELOAD_DEBOUNCE_MS);
      };
      disposables.push(
        watcher,
        watcher.onDidChange(scheduleAutoReload),
        watcher.onDidCreate(scheduleAutoReload)
      );
    }

    const handleExport = async (format: "csv" | "json"): Promise<void> => {
      if (!document.engine || !lastExportSource) {
        void vscode.window.showInformationMessage("No query results available to export.");
        return;
      }

      let raw: RawResultSet;
      let stem: string;
      try {
        if (lastExportSource.kind === "table") {
          raw = document.engine.readAllTableRows(
            lastExportSource.tableName,
            lastExportSource.options
          );
          stem = lastExportSource.tableName;
        } else {
          raw = lastExportSource.rawResult;
          const base = path.basename(
            document.uri.fsPath || "query",
            path.extname(document.uri.fsPath)
          );
          stem = `${base}_query`;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Export failed: ${detail}`);
        return;
      }

      const safeStem = stem.replace(/[^a-zA-Z0-9._-]+/g, "_") || "export";
      const ext = format === "csv" ? "csv" : "json";
      const parentDir = document.uri.fsPath ? path.dirname(document.uri.fsPath) : "";
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
        type: "toast",
        message: `Saved ${raw.rows.length.toLocaleString()} rows to ${path.basename(targetUri.fsPath)}`
      });
    };

    const handleSaveBlob = async (rowIndex: number, colIndex: number): Promise<void> => {
      if (!currentPageRaw) {
        return;
      }
      const row = currentPageRaw.rows[rowIndex];
      const cell = row?.[colIndex];
      if (!(cell instanceof Uint8Array)) {
        return;
      }
      const colName = currentPageRaw.columns[colIndex] || "blob";
      const mime = detectImageMime(cell);
      const ext = suggestedExtensionForMime(mime);
      const safeCol = colName.replace(/[^a-zA-Z0-9._-]+/g, "_") || "blob";
      const parentDir = document.uri.fsPath ? path.dirname(document.uri.fsPath) : "";
      const defaultUri = parentDir
        ? vscode.Uri.file(path.join(parentDir, `${safeCol}_row${rowIndex + 1}.${ext}`))
        : undefined;

      const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: mime ? { Image: [ext], "Binary File": ["*"] } : { "Binary File": [ext, "*"] },
        saveLabel: "Save BLOB"
      });
      if (!targetUri) {
        return;
      }
      await vscode.workspace.fs.writeFile(targetUri, cell);
      void webviewPanel.webview.postMessage({
        type: "toast",
        message: `Saved BLOB (${cell.byteLength.toLocaleString()} B) to ${path.basename(targetUri.fsPath)}`
      });
    };

    const handleInspectCell = (rowIndex: number, colIndex: number): void => {
      if (!currentPageRaw) {
        return;
      }
      const row = currentPageRaw.rows[rowIndex];
      if (!row || colIndex < 0 || colIndex >= currentPageRaw.columns.length) {
        return;
      }
      const columnName = currentPageRaw.columns[colIndex];
      const detail = inspectRawCell(row[colIndex], columnName, rowIndex);
      const rowJson = JSON.stringify(rowToExportRecord(currentPageRaw.columns, row), null, 2);

      void webviewPanel.webview.postMessage({
        type: "cellInspected",
        rowIndex,
        colIndex,
        detail,
        rowJson
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
          case "ready": {
            sendSchemaHeader("init");
            if (document.engine) {
              const first = pickDefaultObject();
              if (first) {
                viewState = { mode: "table", objectName: first.name, page: 1 };
                runCurrentView({ updateSqlBox: true, resetTabOnIndex: true });
              }
            }
            break;
          }
          case "reload":
            await reloadFromDisk("manual");
            break;
          case "setAutoReload":
            autoReloadEnabled = Boolean(msg.enabled);
            break;
          case "selectObject":
            if (typeof msg.name === "string") {
              viewState = {
                mode: "table",
                objectName: msg.name,
                page: 1
              };
              runCurrentView({ updateSqlBox: true, resetTabOnIndex: true });
            }
            break;
          case "queryView":
            viewState = {
              mode: msg.mode === "sql" ? "sql" : "table",
              objectName:
                typeof msg.targetName === "string" ? msg.targetName : viewState.objectName,
              sqlText: typeof msg.sqlText === "string" ? msg.sqlText : viewState.sqlText,
              page:
                typeof msg.page === "number" && Number.isFinite(msg.page)
                  ? Math.max(1, Math.floor(msg.page))
                  : 1,
              sortColumn:
                typeof msg.sortColumn === "string" && msg.sortColumn.length > 0
                  ? msg.sortColumn
                  : undefined,
              sortDir:
                msg.sortDir === "asc" || msg.sortDir === "desc" ? msg.sortDir : undefined,
              filterText: typeof msg.filterText === "string" ? msg.filterText : undefined
            };
            runCurrentView({ updateSqlBox: Boolean(msg.updateSqlBox) });
            break;
          case "runSql":
            if (typeof msg.sqlText === "string") {
              viewState = {
                mode: "sql",
                objectName: viewState.objectName,
                sqlText: msg.sqlText,
                page: 1
              };
              runCurrentView({ updateSqlBox: false });
            }
            break;
          case "inspectCell":
            if (Number.isInteger(msg.rowIndex) && Number.isInteger(msg.colIndex)) {
              handleInspectCell(msg.rowIndex, msg.colIndex);
            }
            break;
          case "saveBlob":
            if (Number.isInteger(msg.rowIndex) && Number.isInteger(msg.colIndex)) {
              await handleSaveBlob(msg.rowIndex, msg.colIndex);
            }
            break;
          case "copyText":
            if (typeof msg.text === "string") {
              await vscode.env.clipboard.writeText(msg.text);
              void webviewPanel.webview.postMessage({
                type: "toast",
                message: `${msg.label || "Copied"} to clipboard.`
              });
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

    disposables.push(msgDisposable);

    webviewPanel.onDidDispose(() => {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
      for (const d of disposables) {
        d.dispose();
      }
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
      `img-src ${webview.cspSource} data:`,
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
        <button id="btn-auto-reload" type="button" class="btn btn-toggle active" title="Automatically refresh when the database file changes on disk">Auto-Reload: On</button>
        <button id="btn-reload" type="button" class="btn btn-secondary" title="Reload database bytes from disk">Reload</button>
        <button id="btn-full-ide" type="button" class="btn btn-link" title="Edit tables, unlock SQLCipher DBs, and manage servers in DB CommanderX">Full IDE ↗</button>
      </div>
    </header>

    <div class="workspace">
      <aside class="sidebar">
        <div class="sidebar-header">
          <input id="schema-filter" type="search" placeholder="Filter schema…" aria-label="Filter schema objects" />
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
            <div id="row-filter-wrap" class="row-filter-wrap">
              <input id="row-filter" type="search" placeholder="Filter rows…" aria-label="Quick filter rows" />
            </div>
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

        <section id="cell-inspector" class="cell-inspector hidden" aria-label="Cell inspector">
          <div class="inspector-header">
            <div class="inspector-meta">
              <strong id="insp-col" class="insp-col"></strong>
              <span id="insp-row" class="insp-badge"></span>
              <span id="insp-type" class="insp-badge insp-type"></span>
            </div>
            <div class="inspector-actions">
              <button id="btn-insp-toggle-json" type="button" class="btn btn-secondary hidden">Raw / Pretty</button>
              <button id="btn-insp-save-blob" type="button" class="btn btn-secondary hidden">Save BLOB…</button>
              <button id="btn-insp-copy-cell" type="button" class="btn btn-secondary">Copy Cell</button>
              <button id="btn-insp-copy-row" type="button" class="btn btn-secondary">Copy Row JSON</button>
              <button id="btn-insp-close" type="button" class="btn btn-secondary" title="Close cell inspector">×</button>
            </div>
          </div>
          <div id="insp-body" class="inspector-body">
            <img id="insp-image" class="insp-image hidden" alt="BLOB image preview" />
            <pre id="insp-text" class="insp-text"></pre>
          </div>
        </section>

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
