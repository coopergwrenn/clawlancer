/**
 * Unit tests for writers.ts (CSV path — Parquet path tested manually
 * since it requires the optional @dsnp/parquetjs dependency).
 *
 * Run: npx tsx instaclaw/lib/research-export/__tests__/writers.test.ts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeCsv, writeManifest, writeRedactionLog, inferSchema } from "../writers";

let failures = 0;
const tmpDir = path.join(os.tmpdir(), `wwb-research-test-${Date.now()}`);

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail !== undefined ? "  →  " + JSON.stringify(detail) : ""}`);
    failures++;
  }
}

async function main() {
  await fs.mkdir(tmpDir, { recursive: true });

  console.log("\n# writeCsv — basic");

  const csvPath = path.join(tmpDir, "basic.csv");
  const r1 = await writeCsv(
    [
      { agent_id: "a1b2c3d4e5f60718", week: 1, interests: ["ai", "biotech"] },
      { agent_id: "98765432abcdef01", week: 2, interests: ["governance"] },
    ],
    csvPath
  );

  check("returns row count", r1.rowCount === 2);
  check("returns byte count", r1.bytes > 0);

  const csvContent = await fs.readFile(csvPath, "utf-8");
  check("has header row", csvContent.startsWith("agent_id,week,interests\n"));
  check("encodes array as ;-joined", csvContent.includes("ai;biotech"));
  check("preserves agent_id hex", csvContent.includes("a1b2c3d4e5f60718"));

  console.log("\n# writeCsv — escaping");

  const escapePath = path.join(tmpDir, "escape.csv");
  await writeCsv(
    [
      {
        col_a: 'has "quotes" in it',
        col_b: "contains, comma",
        col_c: "line\nbreak",
      },
    ],
    escapePath
  );
  const escContent = await fs.readFile(escapePath, "utf-8");
  check(
    "double-quotes escaped by doubling",
    escContent.includes('"has ""quotes"" in it"')
  );
  check("comma triggers quoting", escContent.includes('"contains, comma"'));
  check("newline triggers quoting", escContent.includes('"line\nbreak"'));

  console.log("\n# writeCsv — empty rows");

  const emptyPath = path.join(tmpDir, "empty.csv");
  const rEmpty = await writeCsv([], emptyPath, ["a", "b", "c"]);
  check("empty rows + columns → header only", rEmpty.rowCount === 0);
  const emptyContent = await fs.readFile(emptyPath, "utf-8");
  check("empty file has header", emptyContent === "a,b,c\n");

  console.log("\n# writeCsv — null handling");

  const nullPath = path.join(tmpDir, "null.csv");
  await writeCsv([{ a: null, b: "x", c: 5 }], nullPath, ["a", "b", "c"]);
  const nullContent = await fs.readFile(nullPath, "utf-8");
  check("null serialized as empty field", nullContent.includes(",x,5"));

  console.log("\n# inferSchema");

  const sch = inferSchema([
    { agent_id: "abc", week: 1, interests: ["ai"], optional_field: null },
    { agent_id: "def", week: 2, interests: [], optional_field: "x" },
  ]);
  check("string → UTF8", sch.agent_id?.type === "UTF8");
  check("number → DOUBLE", sch.week?.type === "DOUBLE");
  check("array → UTF8 repeated", sch.interests?.type === "UTF8" && sch.interests?.repeated === true);
  check(
    "field with null in first row uses second-row inference",
    sch.optional_field?.type === "UTF8"
  );

  console.log("\n# writeManifest");

  const manifestPath = path.join(tmpDir, "manifest.json");
  await writeManifest({ export_id: "xyz", row_counts: { agent_signals: 100 } }, manifestPath);
  const manifestContent = await fs.readFile(manifestPath, "utf-8");
  check("manifest is valid JSON", (() => {
    try {
      JSON.parse(manifestContent);
      return true;
    } catch {
      return false;
    }
  })());
  check("manifest is pretty-printed", manifestContent.includes("  \"export_id\""));

  console.log("\n# writeRedactionLog");

  const logPath = path.join(tmpDir, "redactions.jsonl");
  const r2 = await writeRedactionLog(
    [
      { rowId: "r1", column: "interests", reason: "email" },
      { rowId: "r2", column: "goals", reason: "wallet" },
    ],
    logPath
  );
  check("returns event count", r2.count === 2);
  const logContent = await fs.readFile(logPath, "utf-8");
  const lines = logContent.trim().split("\n");
  check("one line per event", lines.length === 2);
  check("each line is valid JSON", lines.every((l) => {
    try {
      JSON.parse(l);
      return true;
    } catch {
      return false;
    }
  }));

  // Empty log file edge case
  const emptyLogPath = path.join(tmpDir, "empty-redactions.jsonl");
  await writeRedactionLog([], emptyLogPath);
  const emptyLog = await fs.readFile(emptyLogPath, "utf-8");
  check("empty redaction log is empty file (not '\\n')", emptyLog === "");

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n❌ ${failures} test(s) failed`);
    process.exit(1);
  } else {
    console.log("\n✅ all writer tests passed");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
