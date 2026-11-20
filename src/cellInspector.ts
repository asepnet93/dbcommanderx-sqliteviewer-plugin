import { RawCell } from "./exportUtils";

const MAX_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_JSON_PARSE_CHARS = 2 * 1024 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 200_000;

export interface InspectedCell {
  columnName: string;
  rowNumber: number;
  dataType: "null" | "json" | "text" | "integer" | "real" | "blob";
  byteLength: number;
  textValue: string | null;
  prettyJson: string | null;
  hexPreview: string | null;
  imageMime: string | null;
  imageDataUrl: string | null;
}

export function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function suggestedExtensionForMime(mime: string | null): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

export function formatHexPreview(bytes: Uint8Array, maxBytes = 512): string {
  const slice = bytes.subarray(0, maxBytes);
  const lines: string[] = [];

  for (let offset = 0; offset < slice.byteLength; offset += 16) {
    const chunk = slice.subarray(offset, offset + 16);
    const addr = offset.toString(16).padStart(4, "0");
    const hexParts: string[] = [];
    let ascii = "";
    for (let i = 0; i < 16; i += 1) {
      if (i < chunk.byteLength) {
        const b = chunk[i];
        hexParts.push(b.toString(16).padStart(2, "0"));
        ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
      } else {
        hexParts.push("  ");
      }
    }
    lines.push(`${addr}: ${hexParts.join(" ")}  |${ascii}|`);
  }

  if (bytes.byteLength > maxBytes) {
    lines.push(`... (+${(bytes.byteLength - maxBytes).toLocaleString()} more bytes)`);
  }
  return lines.join("\n");
}

function tryFormatJson(raw: string): string | null {
  if (raw.length > MAX_JSON_PARSE_CHARS) {
    return null;
  }
  const trimmed = raw.trim();
  if (
    !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
    !(trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    return null;
  }
  return null;
}

export function inspectRawCell(
  raw: RawCell | undefined,
  columnName: string,
  rowIndex: number
): InspectedCell {
  const rowNumber = rowIndex + 1;

  if (raw === null || raw === undefined) {
    return {
      columnName,
      rowNumber,
      dataType: "null",
      byteLength: 0,
      textValue: null,
      prettyJson: null,
      hexPreview: null,
      imageMime: null,
      imageDataUrl: null
    };
  }

  if (raw instanceof Uint8Array) {
    const imageMime = detectImageMime(raw);
    const imageDataUrl =
      imageMime && raw.byteLength <= MAX_IMAGE_PREVIEW_BYTES
        ? `data:${imageMime};base64,${Buffer.from(raw).toString("base64")}`
        : null;

    return {
      columnName,
      rowNumber,
      dataType: "blob",
      byteLength: raw.byteLength,
      textValue: null,
      prettyJson: null,
      hexPreview: formatHexPreview(raw),
      imageMime,
      imageDataUrl
    };
  }

  if (typeof raw === "number") {
    const text = String(raw);
    return {
      columnName,
      rowNumber,
      dataType: Number.isInteger(raw) ? "integer" : "real",
      byteLength: Buffer.byteLength(text, "utf8"),
      textValue: text,
      prettyJson: null,
      hexPreview: null,
      imageMime: null,
      imageDataUrl: null
    };
  }

  const fullStr = String(raw);
  const prettyJson = tryFormatJson(fullStr);
  const textValue =
    fullStr.length > MAX_TEXT_PREVIEW_CHARS
      ? `${fullStr.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n\n... (truncated preview; use Copy Cell or Export for full value)`
      : fullStr;

  return {
    columnName,
    rowNumber,
    dataType: prettyJson ? "json" : "text",
    byteLength: Buffer.byteLength(fullStr, "utf8"),
    textValue,
    prettyJson,
    hexPreview: null,
    imageMime: null,
    imageDataUrl: null
  };
}
