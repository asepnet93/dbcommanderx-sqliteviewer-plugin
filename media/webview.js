(() => {
  const vscode = acquireVsCodeApi();
  const HUB_URL = "https://dbcx.rubrikpulsa.com/";

  const el = {
    dbName: document.getElementById("db-name"),
    dbStats: document.getElementById("db-stats"),
    schemaFilter: document.getElementById("schema-filter"),
    schemaList: document.getElementById("schema-list"),
    sqlInput: document.getElementById("sql-input"),
    btnReload: document.getElementById("btn-reload"),
    btnFullIde: document.getElementById("btn-full-ide"),
    btnClearSql: document.getElementById("btn-clear-sql"),
    btnRunSql: document.getElementById("btn-run-sql"),
    statusBanner: document.getElementById("status-banner"),
    statusText: document.getElementById("status-text"),
    btnBannerIde: document.getElementById("btn-banner-ide"),
    btnBannerDismiss: document.getElementById("btn-banner-dismiss"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    presets: Array.from(document.querySelectorAll("[data-preset]")),
    queryMeta: document.getElementById("query-meta"),
    btnExportCsv: document.getElementById("btn-export-csv"),
    btnExportJson: document.getElementById("btn-export-json"),
    emptyState: document.getElementById("empty-state"),
    tableWrap: document.getElementById("table-wrap"),
    gridHead: document.querySelector("#data-grid thead"),
    gridBody: document.querySelector("#data-grid tbody"),
    ddlView: document.getElementById("ddl-view"),
    paginationBar: document.getElementById("pagination-bar"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    pageInfo: document.getElementById("page-info")
  };

  const state = {
    schema: [],
    filterText: "",
    selectedName: null,
    selectedObject: null,
    activeTab: "data",
    queryMode: "table",
    activeSql: "",
    dataPaged: null,
    structure: null,
    dbReady: false
  };

  function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function showBanner(kind, message, showIdeButton) {
    el.statusBanner.className = `status-banner ${kind}`;
    el.statusText.textContent = message;
    el.btnBannerIde.classList.toggle("hidden", !showIdeButton);
  }

  function hideBanner() {
    el.statusBanner.className = "status-banner hidden";
    el.statusText.textContent = "";
    el.btnBannerIde.classList.add("hidden");
  }

  function setActiveTab(tabName) {
    state.activeTab = tabName;
    for (const tabBtn of el.tabs) {
      tabBtn.classList.toggle("active", tabBtn.dataset.tab === tabName);
    }
    renderActiveTab();
  }

  function renderSchemaList() {
    el.schemaList.textContent = "";
    const term = state.filterText.trim().toLowerCase();
    const visible = state.schema.filter((item) =>
      !term ? true : item.name.toLowerCase().includes(term)
    );

    if (visible.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = state.schema.length === 0 ? "No objects in database" : "No matching objects";
      el.schemaList.appendChild(li);
      return;
    }

    for (const obj of visible) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `schema-item${state.selectedName === obj.name ? " active" : ""}`;

      const left = document.createElement("span");
      left.className = "schema-label";

      const badge = document.createElement("span");
      badge.className = `schema-kind ${obj.type}`;
      badge.textContent = obj.type === "table" ? "TBL" : obj.type === "view" ? "VW" : "IDX";

      const nameSpan = document.createElement("span");
      nameSpan.className = "schema-name";
      nameSpan.textContent = obj.name;
      nameSpan.title = obj.name;

      left.appendChild(badge);
      left.appendChild(nameSpan);
      btn.appendChild(left);

      if (typeof obj.count === "number") {
        const countSpan = document.createElement("span");
        countSpan.className = "schema-count";
        countSpan.textContent = String(obj.count);
        btn.appendChild(countSpan);
      }

      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "selectObject", name: obj.name });
      });

      li.appendChild(btn);
      el.schemaList.appendChild(li);
    }
  }

  function renderGrid(columns, rows, emptyMessage) {
    el.gridHead.textContent = "";
    el.gridBody.textContent = "";
    el.ddlView.classList.add("hidden");

    if (!columns || columns.length === 0) {
      el.tableWrap.classList.add("hidden");
      el.emptyState.textContent = emptyMessage;
      el.emptyState.classList.remove("hidden");
      return;
    }

    const headRow = document.createElement("tr");
    for (const col of columns) {
      const th = document.createElement("th");
      th.textContent = col;
      headRow.appendChild(th);
    }
    el.gridHead.appendChild(headRow);

    if (!rows || rows.length === 0) {
      el.tableWrap.classList.remove("hidden");
      el.emptyState.textContent = emptyMessage;
      el.emptyState.classList.remove("hidden");
      return;
    }

    el.emptyState.classList.add("hidden");
    el.tableWrap.classList.remove("hidden");

    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        if (cell && cell.kind === "null") {
          const span = document.createElement("span");
          span.className = "cell-null";
          span.textContent = "NULL";
          td.appendChild(span);
        } else if (cell && cell.kind === "blob") {
          const span = document.createElement("span");
          span.className = "cell-blob";
          span.textContent = cell.text;
          td.appendChild(span);
        } else {
          const text = cell ? String(cell.text) : "";
          td.textContent = text;
          if (text.length > 64) {
            td.title = text;
          }
        }
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }
    el.gridBody.appendChild(fragment);
  }

  function renderActiveTab() {
    if (!state.dbReady) {
      return;
    }

    if (state.activeTab === "ddl") {
      el.tableWrap.classList.add("hidden");
      el.emptyState.classList.add("hidden");
      el.paginationBar.classList.add("hidden");
      el.ddlView.classList.remove("hidden");
      el.ddlView.textContent =
        state.selectedObject && state.selectedObject.sql
          ? state.selectedObject.sql
          : "-- No DDL stored in sqlite_master for this object.";
      el.queryMeta.textContent = state.selectedObject
        ? `${state.selectedObject.type.toUpperCase()} DDL`
        : "";
      return;
    }

    if (state.activeTab === "structure") {
      el.paginationBar.classList.add("hidden");
      const struct = state.structure;
      renderGrid(
        struct ? struct.columns : [],
        struct ? struct.rows : [],
        "Select a table, view, or index to inspect its structure."
      );
      el.queryMeta.textContent =
        struct && struct.rows ? `${struct.rows.length} entries` : "";
      return;
    }

    const paged = state.dataPaged;
    if (!paged) {
      el.paginationBar.classList.add("hidden");
      renderGrid([], [], "Select a table from the sidebar or run a read-only SQL query.");
      el.queryMeta.textContent = "";
      return;
    }

    renderGrid(paged.columns, paged.rows, "Query returned 0 rows.");
    el.queryMeta.textContent = `${paged.totalRows.toLocaleString()} rows · ${paged.execMs.toFixed(1)} ms`;

    const showPaging = paged.totalPages > 1;
    el.paginationBar.classList.toggle("hidden", !showPaging);
    el.pageInfo.textContent = `Page ${paged.page} / ${paged.totalPages}`;
    el.btnPrev.disabled = paged.page <= 1;
    el.btnNext.disabled = paged.page >= paged.totalPages;
  }

  function updateExportButtons() {
    const enabled =
      state.dbReady && Boolean(state.dataPaged && state.dataPaged.columns.length > 0);
    el.btnExportCsv.disabled = !enabled;
    el.btnExportJson.disabled = !enabled;
  }

  function runCurrentSql() {
    if (!state.dbReady) return;
    hideBanner();
    const sqlText = el.sqlInput.value;
    state.queryMode = "sql";
    state.activeSql = sqlText;
    vscode.postMessage({ type: "runSql", sqlText });
  }

  function applyPreset(presetKey) {
    const firstTable = state.schema.find((item) => item.type === "table" || item.type === "view");
    const targetName =
      state.selectedObject &&
      (state.selectedObject.type === "table" || state.selectedObject.type === "view")
        ? state.selectedObject.name
        : firstTable?.name;

    if (presetKey === "select" && targetName) {
      el.sqlInput.value = `SELECT * FROM ${quoteIdent(targetName)} LIMIT 100;`;
    } else if (presetKey === "pragma" && targetName) {
      el.sqlInput.value = `PRAGMA table_info(${quoteIdent(targetName)});`;
    } else if (presetKey === "schema") {
      el.sqlInput.value = "SELECT type, name, sql FROM sqlite_master ORDER BY type, name;";
    }
    el.sqlInput.focus();
  }

  el.schemaFilter.addEventListener("input", () => {
    state.filterText = el.schemaFilter.value;
    renderSchemaList();
  });

  el.btnReload.addEventListener("click", () => {
    hideBanner();
    vscode.postMessage({ type: "reload" });
  });

  el.btnFullIde.addEventListener("click", () => {
    vscode.postMessage({ type: "openExternal", url: HUB_URL });
  });

  el.btnBannerIde.addEventListener("click", () => {
    vscode.postMessage({ type: "openExternal", url: HUB_URL });
  });

  el.btnBannerDismiss.addEventListener("click", hideBanner);

  el.btnClearSql.addEventListener("click", () => {
    el.sqlInput.value = "";
    el.sqlInput.focus();
  });

  el.btnRunSql.addEventListener("click", runCurrentSql);

  el.sqlInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runCurrentSql();
    }
  });

  for (const presetBtn of el.presets) {
    presetBtn.addEventListener("click", () => applyPreset(presetBtn.dataset.preset));
  }

  for (const tabBtn of el.tabs) {
    tabBtn.addEventListener("click", () => setActiveTab(tabBtn.dataset.tab));
  }

  el.btnPrev.addEventListener("click", () => {
    if (!state.dataPaged || state.dataPaged.page <= 1) return;
    vscode.postMessage({
      type: "paginate",
      mode: state.queryMode,
      targetName: state.selectedName,
      sqlText: state.activeSql,
      page: state.dataPaged.page - 1
    });
  });

  el.btnNext.addEventListener("click", () => {
    if (!state.dataPaged || state.dataPaged.page >= state.dataPaged.totalPages) return;
    vscode.postMessage({
      type: "paginate",
      mode: state.queryMode,
      targetName: state.selectedName,
      sqlText: state.activeSql,
      page: state.dataPaged.page + 1
    });
  });

  el.btnExportCsv.addEventListener("click", () => {
    vscode.postMessage({ type: "export", format: "csv" });
  });

  el.btnExportJson.addEventListener("click", () => {
    vscode.postMessage({ type: "export", format: "json" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "init": {
        state.dbReady = true;
        state.schema = Array.isArray(msg.schema) ? msg.schema : [];
        state.selectedName = null;
        state.selectedObject = null;
        state.dataPaged = null;
        state.structure = null;
        el.dbName.textContent = msg.fileName || "SQLite Database";
        const tablesCount = state.schema.filter((s) => s.type === "table").length;
        const viewsCount = state.schema.filter((s) => s.type === "view").length;
        el.dbStats.textContent = `${tablesCount} tables · ${viewsCount} views · ${formatBytes(msg.fileSizeBytes)}`;
        el.btnRunSql.disabled = false;
        hideBanner();
        renderSchemaList();
        renderActiveTab();
        updateExportButtons();
        break;
      }

      case "initError": {
        state.dbReady = false;
        state.schema = [];
        state.dataPaged = null;
        el.dbName.textContent = msg.fileName || "SQLite Database";
        el.dbStats.textContent = formatBytes(msg.fileSizeBytes);
        el.btnRunSql.disabled = true;
        renderSchemaList();
        el.tableWrap.classList.add("hidden");
        el.ddlView.classList.add("hidden");
        el.paginationBar.classList.add("hidden");
        el.emptyState.textContent =
          "Could not open this database in read-only mode (encrypted SQLCipher or invalid SQLite header).";
        el.emptyState.classList.remove("hidden");
        showBanner("error", msg.message || "Unable to read database.", true);
        updateExportButtons();
        break;
      }

      case "objectLoaded": {
        hideBanner();
        state.selectedObject = msg.object || null;
        state.selectedName = msg.object ? msg.object.name : null;
        state.structure = msg.structure || null;
        state.dataPaged = msg.paged || null;
        state.queryMode = "table";
        if (msg.sql) {
          el.sqlInput.value = msg.sql;
        }
        renderSchemaList();
        setActiveTab(msg.defaultTab || "data");
        updateExportButtons();
        break;
      }

      case "sqlResult": {
        hideBanner();
        state.dataPaged = msg.paged || null;
        setActiveTab("data");
        updateExportButtons();
        break;
      }

      case "pageLoaded": {
        state.dataPaged = msg.paged || null;
        setActiveTab("data");
        updateExportButtons();
        break;
      }

      case "sqlError": {
        const isGuard = msg.kind === "guard";
        showBanner(isGuard ? "guard" : "error", msg.message || "SQL execution failed.", isGuard);
        break;
      }

      case "exportDone": {
        showBanner("info", msg.message || "Export completed.", false);
        break;
      }
    }
  });

  vscode.postMessage({ type: "ready" });
})();
