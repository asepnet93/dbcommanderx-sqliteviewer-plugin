export type ReadOnlyCheck =
  | { ok: true; statements: string[] }
  | { ok: false; reason: "EMPTY" | "MUTATING" | "UNSUPPORTED"; keyword?: string };

const READ_ONLY_PREFIXES = new Set(["SELECT", "WITH", "PRAGMA", "EXPLAIN", "VALUES"]);
const MUTATING_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "UPSERT",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "VACUUM",
  "REINDEX",
  "ATTACH",
  "DETACH"
]);

export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Splits SQL into statements outside string literals/comments and ensures every
 * top-level statement is strictly read-only.
 */
export function validateReadOnlySql(sql: string): ReadOnlyCheck {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < n) {
        current += sql[i];
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            i++;
            current += sql[i];
          } else {
            i++;
            break;
          }
        }
        i++;
      }
      continue;
    }
    if (ch === ";") {
      if (current.trim().length > 0) statements.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim().length > 0) statements.push(current.trim());

  if (statements.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }

  for (const stmt of statements) {
    const cleanLead = stmt.trimStart();
    const match = cleanLead.match(/^([A-Za-z_]+)/);
    const firstWord = match ? match[1].toUpperCase() : "";
    if (!READ_ONLY_PREFIXES.has(firstWord)) {
      return {
        ok: false,
        reason: MUTATING_KEYWORDS.has(firstWord) ? "MUTATING" : "UNSUPPORTED",
        keyword: firstWord || "STATEMENT"
      };
    }
    if (firstWord === "PRAGMA" && /=/.test(cleanLead)) {
      return { ok: false, reason: "MUTATING", keyword: "PRAGMA =" };
    }
  }

  return { ok: true, statements };
}
