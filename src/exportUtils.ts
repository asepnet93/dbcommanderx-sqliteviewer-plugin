export type RawCell = string | number | null | Uint8Array;

export function normalizeExportCell(val: RawCell | undefined): string | number | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Uint8Array) return `[BLOB ${val.byteLength} bytes]`;
  return val;
}

export function rowToExportRecord(
  columns: string[],
  row: RawCell[]
): Record<string, string | number | null> {
  const record: Record<string, string | number | null> = {};
  columns.forEach((col, idx) => {
    record[col] = normalizeExportCell(row[idx]);
  });
  return record;
}

function escapeCsvCell(val: RawCell | undefined): string {
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
    lines.push(columns.map((_, idx) => escapeCsvCell(row[idx])).join(","));
  }
  return lines.join("\r\n");
}

export function serializeToJson(columns: string[], rows: RawCell[][]): string {
  const objects = rows.map((row) => rowToExportRecord(columns, row));
  return JSON.stringify(objects, null, 2);
}
