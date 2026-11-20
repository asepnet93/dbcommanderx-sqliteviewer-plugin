(() => {
  const vscode = acquireVsCodeApi();
  const HUB_URL = "https://dbcx.rubrikpulsa.com/";

  const el = {
    dbName: document.getElementById("db-name"),
    dbStats: document.getElementById("db-stats"),
    schemaFilter: document.getElementById("schema-filter"),
    schemaList: document.getElementById("schema-list"),
    sqlInput: document.getElementById("sql-input"),
    btnAutoReload: document.getElementById("btn-auto-reload"),
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
    rowFilterWrap: document.getElementById("row-filter-wrap"),
    rowFilter: document.getElementById("row-filter"),
    queryMeta: document.getElementById("query-meta"),
    btnExportCsv: document.getElementById("btn-export-csv"),
    btnExportJson: document.getElementById("btn-export-json"),
    emptyState: document.getElementById("empty-state"),
    tableWrap: document.getElementById("table-wrap"),
    gridHead: document.querySelector("#data-grid thead"),
    gridBody: document.querySelector("#data-grid tbody"),
    ddlView: document.getElementById("ddl-view"),
    cellInspector: document.getElementById("cell-inspector"),
    inspCol: document.getElementById("insp-col"),
    inspRow: document.getElementById("insp-row"),
    inspType: document.getElementById("insp-type"),
    btnInspToggleJson: document.getElementById("btn-insp-toggle-json"),
    btnInspSaveBlob: document.getElementById("btn-insp-save-blob"),
    btnInspCopyCell: document.getElementById("btn-insp-copy-cell"),
    btnInspCopyRow: document.getElementById("btn-insp-copy-row"),
    btnInspClose: document.getElementById("btn-insp-close"),
    inspImage: document.getElementById("insp-image"),
    inspText: document.getElementById("insp-text"),
    paginationBar: document.getElementById("pagination-bar"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    pageInfo: document.getElementById("page-info")
  };

  const state = {
    schema: [],
    schemaFilterText: "",
    selectedName: null,
    selectedObject: null,
    activeTab: "data",
    queryMode: "table",
    activeSql: "",
    sortColumn: null,
    sortDir: null,
    rowFilterText: "",
    dataPaged: null,
    structure: null,
    dbReady: false,
    autoReloadEnabled: true,
    selectedCell: null,
    inspected: null,
    inspectedRowJson: "",
    jsonPrettyMode: true,
    toastTimer: null,
    filterTimer: null
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

  function updateAutoReloadButton() {
    el.btnAutoReload.classList.toggle("active", state.autoReloadEnabled);
    el.btnAutoReload.textContent = state.autoReloadEnabled
      ? "Auto-Reload: On"
      : "Auto-Reload: Off";
  }

  function showBanner(kind, message, showIdeButton, autoHideMs) {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    el.statusBanner.className = `status-banner ${kind}`;
    el.statusText.textContent = message;
    el.btnBannerIde.classList.toggle("hidden", !showIdeButton);
    if (autoHideMs && autoHideMs > 0) {
      state.toastTimer = setTimeout(hideBanner, autoHideMs);
    }
  }

  function hideBanner() {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    el.statusBanner.className = "status-banner hidden";
    el.statusText.textContent = "";
    el.btnBannerIde.classList.add("hidden");
  }

  function closeInspector() {
    state.selectedCell = null;
    state.inspected = null;
    state.inspectedRowJson = "";
    el.cellInspector.classList.add("hidden");
    const prevSelected = el.gridBody.querySelector("td.cell-selected");
    if (prevSelected) {
      prevSelected.classList.remove("cell-selected");
    }
  }

  function renderInspector() {
    const detail = state.inspected;
    if (!detail) {
      el.cellInspector.classList.add("hidden");
      return;
    }

    el.cellInspector.classList.remove("hidden");
    el.inspCol.textContent = detail.columnName;
    el.inspRow.textContent = `Row ${detail.rowNumber}`;
    el.inspType.textContent = detail.imageMime
      ? `BLOB · ${detail.imageMime} (${formatBytes(detail.byteLength)})`
      : detail.dataType === "blob"
        ? `BLOB (${formatBytes(detail.byteLength)})`
        : `${detail.dataType.toUpperCase()} (${formatBytes(detail.byteLength)})`;

    const isJson = detail.dataType === "json" && Boolean(detail.prettyJson);
    const isBlob = detail.dataType === "blob";

    el.btnInspToggleJson.classList.toggle("hidden", !isJson);
    el.btnInspToggleJson.textContent = state.jsonPrettyMode ? "Show Raw" : "Pretty JSON";
    el.btnInspSaveBlob.classList.toggle("hidden", !isBlob);
    el.btnInspCopyCell.disabled = detail.dataType === "null" && detail.textValue === null;

    if (detail.imageDataUrl) {
      el.inspImage.src = detail.imageDataUrl;
      el.inspImage.classList.remove("hidden");
    } else {
      el.inspImage.removeAttribute("src");
      el.inspImage.classList.add("hidden");
    }

    if (detail.dataType === "null") {
      el.inspText.textContent = "NULL";
    } else if (isBlob) {
      el.inspText.textContent = detail.hexPreview || "";
    } else if (isJson && state.jsonPrettyMode) {
      el.inspText.textContent = detail.prettyJson;
    } else {
      el.inspText.textContent = detail.textValue ?? "";
    }
  }

  function setActiveTab(tabName) {
    state.activeTab = tabName;
    for (const tabBtn of el.tabs) {
      tabBtn.classList.toggle("active", tabBtn.dataset.tab === tabName);
    }
    el.rowFilterWrap.classList.toggle("hidden", tabName !== "data");
    if (tabName !== "data") {
      closeInspector();
    }
    renderActiveTab();
  }

  function renderSchemaList() {
    el.schemaList.textContent = "";
    const term = state.schemaFilterText.trim().toLowerCase();
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
        state.sortColumn = null;
        state.sortDir = null;
        state.rowFilterText = "";
        el.rowFilter.value = "";
        closeInspector();
        vscode.postMessage({ type: "selectObject", name: obj.name });
      });

      li.appendChild(btn);
      el.schemaList.appendChild(li);
    }
  }

  function requestViewUpdate(pageNumber, updateSqlBox) {
    if (!state.dbReady) return;
    vscode.postMessage({
      type: "queryView",
      mode: state.queryMode,
      targetName: state.selectedName,
      sqlText: state.activeSql,
      page: pageNumber,
      sortColumn: state.sortColumn || "",
      sortDir: state.sortDir || "",
      filterText: state.rowFilterText,
      updateSqlBox: Boolean(updateSqlBox)
    });
  }

  function toggleSort(columnName) {
    if (state.sortColumn !== columnName) {
      state.sortColumn = columnName;
      state.sortDir = "asc";
    } else if (state.sortDir === "asc") {
      state.sortDir = "desc";
    } else {
      state.sortColumn = null;
      state.sortDir = null;
    }
    closeInspector();
    requestViewUpdate(1, state.queryMode === "table");
  }

  function renderGrid(columns, rows, emptyMessage, interactiveDataGrid) {
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
      const inner = document.createElement("span");
      inner.className = "th-inner";

      const label = document.createElement("span");
      label.textContent = col;
      inner.appendChild(label);

      if (interactiveDataGrid) {
        th.classList.add("sortable");
        const isSorted = state.sortColumn === col && state.sortDir;
        if (isSorted) {
          th.classList.add("sorted");
          const ind = document.createElement("span");
          ind.className = "sort-ind";
          ind.textContent = state.sortDir === "asc" ? "▲" : "▼";
          inner.appendChild(ind);
        }
        th.title = "Click to sort column";
        th.addEventListener("click", () => toggleSort(col));
      }

      th.appendChild(inner);
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
    rows.forEach((row, rowIdx) => {
      const tr = document.createElement("tr");
      row.forEach((cell, colIdx) => {
        const td = document.createElement("td");
        if (interactiveDataGrid) {
          td.classList.add("clickable-cell");
          if (
            state.selectedCell &&
            state.selectedCell.rowIndex === rowIdx &&
            state.selectedCell.colIndex === colIdx
          ) {
            td.classList.add("cell-selected");
          }
          td.addEventListener("click", () => {
            const prev = el.gridBody.querySelector("td.cell-selected");
            if (prev) prev.classList.remove("cell-selected");
            td.classList.add("cell-selected");
            state.selectedCell = { rowIndex: rowIdx, colIndex: colIdx };
            vscode.postMessage({ type: "inspectCell", rowIndex: rowIdx, colIndex: colIdx });
          });
        }

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
      });
      fragment.appendChild(tr);
    });
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
        "Select a table, view, or index to inspect its structure.",
        false
      );
      el.queryMeta.textContent =
        struct && struct.rows ? `${struct.rows.length} entries` : "";
      return;
    }

    const paged = state.dataPaged;
    if (!paged) {
      el.paginationBar.classList.add("hidden");
      renderGrid([], [], "Select a table from the sidebar or run a read-only SQL query.", false);
      el.queryMeta.textContent = "";
      return;
    }

    const emptyText = state.rowFilterText.trim()
      ? `No rows match "${state.rowFilterText.trim()}".`
      : "Query returned 0 rows.";
    renderGrid(paged.columns, paged.rows, emptyText, true);

    const filterSuffix = paged.filterText ? " (filtered)" : "";
    el.queryMeta.textContent = `${paged.totalRows.toLocaleString()} rows${filterSuffix} · ${paged.execMs.toFixed(1)} ms`;

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
    closeInspector();
    state.sortColumn = null;
    state.sortDir = null;
    state.rowFilterText = "";
    el.rowFilter.value = "";
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
    state.schemaFilterText = el.schemaFilter.value;
    renderSchemaList();
  });

  el.rowFilter.addEventListener("input", () => {
    if (state.filterTimer) {
      clearTimeout(state.filterTimer);
    }
    state.filterTimer = setTimeout(() => {
      state.filterTimer = null;
      state.rowFilterText = el.rowFilter.value;
      closeInspector();
      requestViewUpdate(1, state.queryMode === "table");
    }, 200);
  });

  el.btnAutoReload.addEventListener("click", () => {
    state.autoReloadEnabled = !state.autoReloadEnabled;
    updateAutoReloadButton();
    vscode.postMessage({ type: "setAutoReload", enabled: state.autoReloadEnabled });
  });

  el.btnReload.addEventListener("click", () => {
    hideBanner();
    closeInspector();
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
    closeInspector();
    requestViewUpdate(state.dataPaged.page - 1, false);
  });

  el.btnNext.addEventListener("click", () => {
    if (!state.dataPaged || state.dataPaged.page >= state.dataPaged.totalPages) return;
    closeInspector();
    requestViewUpdate(state.dataPaged.page + 1, false);
  });

  el.btnExportCsv.addEventListener("click", () => {
    vscode.postMessage({ type: "export", format: "csv" });
  });

  el.btnExportJson.addEventListener("click", () => {
    vscode.postMessage({ type: "export", format: "json" });
  });

  el.btnInspClose.addEventListener("click", closeInspector);

  el.btnInspToggleJson.addEventListener("click", () => {
    state.jsonPrettyMode = !state.jsonPrettyMode;
    renderInspector();
  });

  el.btnInspCopyCell.addEventListener("click", () => {
    if (!state.inspected) return;
    const rawText =
      state.inspected.dataType === "null"
        ? "NULL"
        : state.inspected.dataType === "blob"
          ? state.inspected.hexPreview || ""
          : state.inspected.prettyJson && state.jsonPrettyMode
            ? state.inspected.prettyJson
            : state.inspected.textValue ?? "";
    vscode.postMessage({ type: "copyText", text: rawText, label: "Cell value copied" });
  });

  el.btnInspCopyRow.addEventListener("click", () => {
    if (!state.inspectedRowJson) return;
    vscode.postMessage({
      type: "copyText",
      text: state.inspectedRowJson,
      label: "Row JSON copied"
    });
  });

  el.btnInspSaveBlob.addEventListener("click", () => {
    if (!state.selectedCell) return;
    vscode.postMessage({
      type: "saveBlob",
      rowIndex: state.selectedCell.rowIndex,
      colIndex: state.selectedCell.colIndex
    });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "init": {
        state.dbReady = true;
        state.schema = Array.isArray(msg.schema) ? msg.schema : [];
        if (typeof msg.autoReloadEnabled === "boolean") {
          state.autoReloadEnabled = msg.autoReloadEnabled;
          updateAutoReloadButton();
        }
        el.dbName.textContent = msg.fileName || "SQLite Database";
        const tablesCount = state.schema.filter((s) => s.type === "table").length;
        const viewsCount = state.schema.filter((s) => s.type === "view").length;
        el.dbStats.textContent = `${tablesCount} tables · ${viewsCount} views · ${formatBytes(msg.fileSizeBytes)}`;
        el.btnRunSql.disabled = false;
        if (msg.reason === "init") {
          state.selectedName = null;
          state.selectedObject = null;
          state.dataPaged = null;
          state.structure = null;
          hideBanner();
        }
        renderSchemaList();
        renderActiveTab();
        updateExportButtons();
        break;
      }

      case "initError": {
        state.dbReady = false;
        state.schema = [];
        state.dataPaged = null;
        closeInspector();
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

      case "viewData": {
        state.queryMode = msg.mode === "sql" ? "sql" : "table";
        if (msg.object) {
          state.selectedObject = msg.object;
          state.selectedName = msg.object.name;
        }
        if (msg.structure) {
          state.structure = msg.structure;
        }
        state.dataPaged = msg.paged || null;
        state.sortColumn = msg.paged?.sortColumn || null;
        state.sortDir = msg.paged?.sortDir || null;
        state.rowFilterText = msg.paged?.filterText || "";
        if (el.rowFilter.value !== state.rowFilterText) {
          el.rowFilter.value = state.rowFilterText;
        }
        if (msg.updateSqlBox && typeof msg.sql === "string" && msg.sql.length > 0) {
          el.sqlInput.value = msg.sql;
        }
        renderSchemaList();
        if (msg.defaultTab) {
          setActiveTab(msg.defaultTab);
        } else if (msg.mode === "sql") {
          setActiveTab("data");
        } else {
          renderActiveTab();
        }
        updateExportButtons();
        break;
      }

      case "cellInspected": {
        state.inspected = msg.detail || null;
        state.inspectedRowJson = msg.rowJson || "";
        state.jsonPrettyMode = true;
        renderInspector();
        break;
      }

      case "sqlError": {
        const isGuard = msg.kind === "guard";
        showBanner(isGuard ? "guard" : "error", msg.message || "SQL execution failed.", isGuard);
        break;
      }

      case "toast": {
        showBanner("info", msg.message || "Done.", false, 3000);
        break;
      }
    }
  });

  vscode.postMessage({ type: "ready" });
})();
