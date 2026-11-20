# SQLite Viewer — DB CommanderX

Fast, offline, **read-only SQLite database viewer** right inside Visual Studio Code — powered by WebAssembly (`sql.js`).

Click any `.sqlite`, `.sqlite3`, `.db`, `.db3`, or `.s3db` file in the Explorer to browse tables, views, indexes, column structure, and DDL, inspect JSON or BLOB image cells, sort & filter rows, or run read-only SQL queries and export results to CSV or JSON without modifying your database file.

## Features
- **Zero Setup & Offline:** Runs locally inside VS Code via WebAssembly (`sql.js`) — no external SQLite binary required. Works across Windows, Linux, WSL, and Remote workspaces.
- **Click-to-Sort & Quick Row Filter:** Click any column header (`ASC` / `DESC`) or filter visible rows instantly across columns.
- **Cell, JSON & Image BLOB Inspector:** Click any cell to view full unclipped values, pretty-printed JSON, hex dumps, inline PNG/JPEG/GIF/WebP previews, copy row/cell JSON, or save raw BLOB bytes.
- **Auto-Reload Watcher:** Automatically refreshes the active view when external processes update the database file on disk (with toolbar toggle).
- **Read-Only Safety:** Protects local `.sqlite` / `.db` files from accidental modification (`SELECT`, `WITH`, `PRAGMA`, `EXPLAIN` supported).
- **Data, Structure & DDL Tabs:** Paginated grid (100 rows per page), `table_info` / `index_info` inspector, and `CREATE` DDL view.
- **CSV & JSON Export:** Export active table or query results safely via VS Code Save dialog.
- **Native VS Code Theme:** Automatically matches your Dark, Light, or High Contrast VS Code theme.

## Need Full Editing, SQLCipher, SSH Tunnels, or Cloud RDBMS?
Explore the full **DB CommanderX** ecosystem by **RUBRIKPULSA SOFTWARE, CO.**:
- **DB CommanderX Web Viewer:** [https://dbcx.rubrikpulsa.com/](https://dbcx.rubrikpulsa.com/)
- **DB CommanderX SQL Client (Windows Desktop — Microsoft Store):** [https://apps.microsoft.com/detail/9NH5VBF0667C](https://apps.microsoft.com/detail/9NH5VBF0667C)
- **DB CommanderX SQL Client (Android — Google Play):** [https://play.google.com/store/apps/details?id=com.dbcommanderx.sqluniversal](https://play.google.com/store/apps/details?id=com.dbcommanderx.sqluniversal)
- **DB CommanderX for SQLite (Android — Google Play):** [https://play.google.com/store/apps/details?id=com.rubrikpulsa.sqlite.dbcommander](https://play.google.com/store/apps/details?id=com.rubrikpulsa.sqlite.dbcommander)

## Privacy
All `.sqlite` / `.db` bytes are inspected strictly locally inside your editor. Zero database files, schemas, or queries are uploaded to any server.

## License
MIT &copy; 2026 RUBRIKPULSA SOFTWARE, CO. Includes `sql.js` (MIT — see `NOTICE.txt`).
