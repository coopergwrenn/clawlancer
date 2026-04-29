/**
 * Output writers for the EE26 research export pipeline.
 *
 * Two formats supported:
 *   - CSV (default, zero-dependency, ships in v0.1.0)
 *   - Parquet (preferred for researcher tooling — DuckDB, pandas, BQ)
 *     Uses @dsnp/parquetjs at runtime; falls back to CSV with a warning
 *     if the package isn't installed.
 *
 * The Parquet path is intentionally optional in v0.1.0 to avoid forcing
 * a new heavy dependency on the platform repo. Researchers can always
 * convert CSV → Parquet trivially with `duckdb -c "COPY (SELECT * FROM
 * read_csv_auto('export.csv')) TO 'export.parquet' (FORMAT PARQUET)"`
 * if they prefer Parquet input.
 *
 * To enable native Parquet output:
 *     npm install --save-optional @dsnp/parquetjs
 *
 * The pipeline auto-detects the package's presence and uses native
 * Parquet when available.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type RowValue = string | number | boolean | null | string[];
export type Row = Record<string, RowValue>;

// ─── CSV writer (always available) ───────────────────────────────────

/**
 * Escape a single CSV field per RFC 4180.
 * - Quote if the field contains comma, double-quote, newline, or starts/ends with whitespace
 * - Double up internal double-quotes
 * - Arrays are joined with `;` then escaped (CSV doesn't have a native array type)
 */
function csvEscape(value: RowValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return csvEscape(value.join(";"));

  const str = typeof value === "string" ? value : String(value);
  const needsQuoting =
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r") ||
    /^\s|\s$/.test(str);

  if (!needsQuoting) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

export async function writeCsv(
  rows: Row[],
  filePath: string,
  columns?: string[]
): Promise<{ rowCount: number; bytes: number }> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (rows.length === 0) {
    // Write empty file with header row only if columns provided, else
    // write a 0-byte file. Parquet has the same behavior.
    const header = columns ? columns.join(",") + "\n" : "";
    await fs.writeFile(filePath, header, "utf-8");
    return { rowCount: 0, bytes: header.length };
  }

  const cols = columns ?? Object.keys(rows[0]);
  const lines: string[] = [cols.join(",")];

  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(row[c] ?? null)).join(","));
  }

  const content = lines.join("\n") + "\n";
  await fs.writeFile(filePath, content, "utf-8");

  return { rowCount: rows.length, bytes: Buffer.byteLength(content, "utf-8") };
}

// ─── Parquet writer (optional, behind dynamic import) ────────────────

interface ParquetSchemaField {
  type: "UTF8" | "INT64" | "DOUBLE" | "BOOLEAN" | "TIMESTAMP_MILLIS";
  optional?: boolean;
  repeated?: boolean;
}

export type ParquetSchema = Record<string, ParquetSchemaField>;

/**
 * Infer a parquet schema from a sample row. For each column:
 *   - string[] → UTF8 repeated
 *   - string   → UTF8
 *   - boolean  → BOOLEAN
 *   - number   → DOUBLE (safe for both ints and floats)
 *   - null     → UTF8 optional (best-guess; caller can override via `schemaOverride`)
 *
 * For columns with mixed types across rows, the caller should pass an
 * explicit schemaOverride.
 */
export function inferSchema(rows: Row[], schemaOverride: ParquetSchema = {}): ParquetSchema {
  const schema: ParquetSchema = {};
  const columns = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) columns.add(k);

  for (const col of columns) {
    if (schemaOverride[col]) {
      schema[col] = schemaOverride[col];
      continue;
    }
    let inferred: ParquetSchemaField | null = null;
    let allNull = true;
    for (const row of rows) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      allNull = false;
      if (Array.isArray(v)) {
        inferred = { type: "UTF8", repeated: true };
        break;
      }
      if (typeof v === "boolean") inferred = { type: "BOOLEAN" };
      else if (typeof v === "number") inferred = { type: "DOUBLE" };
      else inferred = { type: "UTF8" };
      break;
    }
    schema[col] = inferred ?? { type: "UTF8", optional: true };
    if (allNull) schema[col].optional = true;
  }
  return schema;
}

/**
 * Write rows to Parquet if @dsnp/parquetjs is available, else fall back
 * to CSV at the same path with a `.csv` extension and emit a warning.
 *
 * Returns { format: "parquet" | "csv", rowCount, bytes }.
 */
export async function writeParquetOrFallback(
  rows: Row[],
  filePath: string,
  schemaOverride: ParquetSchema = {}
): Promise<{ format: "parquet" | "csv"; rowCount: number; bytes: number }> {
  // Optional peer dep — `@dsnp/parquetjs` may not be installed.
  // Typed as `any` because we don't want to force the type import in a
  // platform repo that hasn't installed the package.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parquetjs: any = null;
  try {
    // Dynamic import via Function() to avoid TS resolving the module at compile time
    parquetjs = await new Function("m", "return import(m)")("@dsnp/parquetjs");
  } catch {
    parquetjs = null;
  }

  if (!parquetjs) {
    const csvPath = filePath.replace(/\.parquet$/, "") + ".csv";
    console.warn(
      `[research-export] @dsnp/parquetjs not installed — falling back to CSV: ${csvPath}`
    );
    const r = await writeCsv(rows, csvPath);
    return { format: "csv", ...r };
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const schema = inferSchema(rows, schemaOverride);

  // Convert our schema to parquetjs ParquetSchema
  const pqSchemaDef: Record<string, { type: string; optional?: boolean; repeated?: boolean }> =
    {};
  for (const [col, f] of Object.entries(schema)) {
    pqSchemaDef[col] = { type: f.type, optional: f.optional, repeated: f.repeated };
  }

  const pqSchema = new parquetjs.ParquetSchema(pqSchemaDef as never);
  const writer = await parquetjs.ParquetWriter.openFile(pqSchema, filePath);
  for (const row of rows) {
    // parquetjs expects null for missing optional fields
    const cleanRow: Record<string, RowValue> = {};
    for (const col of Object.keys(schema)) {
      cleanRow[col] = row[col] === undefined ? null : row[col];
    }
    await writer.appendRow(cleanRow);
  }
  await writer.close();

  const stat = await fs.stat(filePath);
  return { format: "parquet", rowCount: rows.length, bytes: stat.size };
}

// ─── Manifest writer ─────────────────────────────────────────────────

export async function writeManifest(
  manifest: object,
  filePath: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

// ─── Redaction-review log ────────────────────────────────────────────

/**
 * Writes one JSONL record per redaction event. Used by the manual
 * spot-check process to sample the 1% of redactions per the privacy
 * commitment in PRD 4.10.3.
 *
 * The events themselves never contain raw PII (see anonymize.ts), so
 * this file is safe to share with reviewers.
 */
export async function writeRedactionLog(
  events: Array<Record<string, unknown>>,
  filePath: string
): Promise<{ count: number }> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await fs.writeFile(filePath, lines + (events.length > 0 ? "\n" : ""), "utf-8");
  return { count: events.length };
}
