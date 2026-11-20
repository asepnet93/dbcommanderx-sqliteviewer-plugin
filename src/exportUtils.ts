export type RawCell = string | number | null | Uint8Array;

function normalizeExportCell(val: RawCell): string | number | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Uint8Array) return `[BLOB ${val.byteLength} bytes]`;
  return val;
}

function escapeCsvCell(val: RawCell): string {
  const norm = normalizeExportCell(val);
  if (norm === null) return "";
  const str = String(norm);
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function serializeToCsv(columns: string[], rows: RawCell[][]): string {
  if (columns.length === 0) return "";
  const lines = [columns.map((c) => escapeCsvCell(c)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((_, idx) => escapeCsvCell(row[idx] ?? null)).join(","));
  }
  return lines.join("\r\n");
}

export function serializeToJson(columns: string[], rows: RawCell[][]): string {
  const objects = rows.map((row) => {
    const record: Record<string, string | number | null> = {};
    columns.forEach((col, idx) => {
      record[col] = normalizeExportCell(row[idx] ?? null);
    });
    return record;
  });
  return JSON.stringify(objects, null, 2);
}
