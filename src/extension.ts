import * as vscode from "vscode";
import { SqliteCustomEditorProvider, VIEW_TYPE } from "./sqliteCustomEditor";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SqliteCustomEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbcommanderx.openSqliteFile",
      async (resourceUri?: vscode.Uri) => {
        let targetUri = resourceUri;
        if (!targetUri) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "Open SQLite File",
            filters: {
              "SQLite Databases": ["sqlite", "sqlite3", "db", "db3", "s3db"],
              "All Files": ["*"]
            }
          });
          targetUri = picked?.[0];
        }
        if (!targetUri) {
          return;
        }
        await vscode.commands.executeCommand("vscode.openWith", targetUri, VIEW_TYPE);
      }
    )
  );
}

export function deactivate(): void {
  // Resources are disposed via ExtensionContext.subscriptions and CustomDocument.dispose.
}
