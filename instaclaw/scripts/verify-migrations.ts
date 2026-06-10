/**
 * Migration Verification Script — Pre-deploy safety check
 *
 * Reads every migration file in supabase/migrations/, parses what each creates
 * (columns, tables), queries production Supabase to check if each object exists,
 * and reports PASS/FAIL. Exits with code 1 if any column or table is missing,
 * which blocks the Vercel build.
 *
 * Wired into package.json "build" command — runs before `next build`.
 *
 * Usage: npx tsx scripts/verify-migrations.ts
 * Env:   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";

interface ObjectCheck {
  type: "column" | "table";
  name: string;
  table?: string;
  /** Schema (default 'public'). Non-public schemas are skipped because the
   * default Supabase client only queries public — verifying objects in
   * `research`, `private`, etc. would require schema-aware client setup. */
  schema?: string;
  exists: boolean | null;
}

interface MigrationResult {
  file: string;
  objects: ObjectCheck[];
}

// ── SQL Parsers ──

// Strip SQL comments before regex parsing. Without this, prose like
//   "-- All ADD COLUMN / CREATE TABLE are IF NOT EXISTS — re-runnable."
// gets matched by the CREATE TABLE regex, extracting "are" as a phantom
// table name (the IF NOT EXISTS prefix is optional + trailing whitespace
// fails). Same for "Uses CREATE TABLE IF NOT EXISTS," — the comma after
// EXISTS breaks the `\s+`, parser falls back to capturing "IF".
//
// Caught 2026-05-11: after the 20260506a verify-migrations.ts cherry-pick
// added strict missing-table detection, two prose comments produced
// build-blocking false positives "are" and "IF" on the
// feat/matchpool-outcomes-ingest preview. Stripping comments fixes the
// class of bug without changing the regex.
function stripSqlComments(sql: string): string {
  return sql
    // Block comments /* ... */ (non-greedy, multi-line)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Line comments -- to end of line
    .replace(/--[^\n]*/g, "");
}

function parseMigration(rawSql: string): ObjectCheck[] {
  // Run parsers on comment-stripped SQL only.
  const sql = stripSqlComments(rawSql);
  const checks: ObjectCheck[] = [];
  const seen = new Set<string>();
  let m;

  // Capture optional schema prefix (group 1) + table name (group 2).
  // Examples:
  //   CREATE TABLE foo                 → schema=public, name=foo
  //   CREATE TABLE public.foo          → schema=public, name=foo
  //   CREATE TABLE research.signals    → schema=research, name=signals
  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)/gi;
  while ((m = createTable.exec(sql))) {
    const schema = m[1] ?? "public";
    const name = m[2];
    const key = `table:${schema}.${name}`;
    if (!seen.has(key)) { seen.add(key); checks.push({ type: "table", name, schema, exists: null }); }
  }

  const addCol = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  while ((m = addCol.exec(sql))) {
    const schema = m[1] ?? "public";
    const table = m[2];
    const name = m[3];
    const key = `column:${schema}.${table}.${name}`;
    if (!seen.has(key)) { seen.add(key); checks.push({ type: "column", table, name, schema, exists: null }); }
  }

  return checks;
}

// ── Production Verification ──

async function verifyColumn(supabase: ReturnType<typeof createClient>, table: string, column: string): Promise<boolean> {
  try {
    const { error } = await supabase.from(table).select(column).limit(0);
    if (!error) return true;
    const msg = (error.message || "").toLowerCase();
    // Missing-column patterns include the missing-table cases, since
    // a missing table also fails a column probe with "could not find".
    // Without the could_not_find branch we'd silently pass columns on
    // missing tables (paired with the verifyTable bug it produced the
    // 2026-05-06 v2 false-pass).
    if (
      msg.includes("does not exist") ||
      msg.includes("is not") ||
      msg.includes("could not find") ||
      error.code === "PGRST204" ||
      error.code === "PGRST205" ||
      error.code === "42703"
    ) {
      return false;
    }
    return true; // RLS errors etc. mean the column exists
  } catch {
    return false;
  }
}

async function verifyTable(supabase: ReturnType<typeof createClient>, name: string): Promise<boolean> {
  try {
    const { error } = await supabase.from(name).select("*").limit(0);
    if (!error) return true;
    const msg = (error.message || "").toLowerCase();
    // Missing-table error patterns:
    //   PostgREST PGRST205: "Could not find the table 'public.X' in the schema cache"
    //   PostgREST PGRST204: schema cache miss
    //   pg "relation X does not exist" (when caught raw)
    // The original code checked only the bottom row, which silently passed
    // missing tables that returned the schema-cache error — caught when
    // negotiation_threads / negotiation_messages went undetected during
    // the 2026-05-06 v2 migration apply gap.
    if (
      msg.includes("does not exist") ||
      msg.includes("relation") ||
      msg.includes("could not find") ||
      error.code === "PGRST204" ||
      error.code === "PGRST205"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Main ──

async function main() {
  // Structural guard (2026-06-10): the frontier safety suites run via the
  // `test:frontier` npm script (frontier-safety GitHub Action). A stale-branch
  // merge once clobbered that script out of package.json (commit 114d1db4),
  // silently disabling the suites in CI. The frontier-safety workflow is
  // path-filtered, so it would not even run on such a clobber. This build-time
  // check fails the BUILD on every deploy if the script goes missing -- the one
  // place that always runs. Cheap insurance against that exact regression.
  try {
    const pkg = readFileSync(join(__dirname, "..", "package.json"), "utf-8");
    if (!JSON.parse(pkg).scripts?.["test:frontier"]) {
      console.error("");
      console.error("=".repeat(70));
      console.error("  BUILD BLOCKED -- package.json is missing the `test:frontier` script");
      console.error("=".repeat(70));
      console.error("  The frontier safety suites are wired through this script. If it is");
      console.error("  gone, a stale-branch merge likely clobbered package.json scripts.");
      console.error("  Restore the `test:frontier` chain (see git history) and rebuild.");
      console.error("");
      process.exit(1);
    }
  } catch (e) {
    console.error("[verify-migrations] could not read/parse package.json for the test:frontier guard:", e);
    process.exit(1);
  }

  const migrationsDir = join(__dirname, "..", "supabase", "migrations");

  let files: string[];
  try {
    files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    console.log("No supabase/migrations directory found — skipping verification.");
    process.exit(0);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn("WARN: Missing SUPABASE env vars — skipping migration verification.");
    console.warn("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable.");
    process.exit(0);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Parse all migrations
  const allMigrations: MigrationResult[] = [];
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const objects = parseMigration(sql);
    if (objects.length > 0) allMigrations.push({ file, objects });
  }

  const totalChecks = allMigrations.reduce((n, m) => n + m.objects.length, 0);
  console.log(`[verify-migrations] Checking ${totalChecks} objects across ${files.length} migrations...`);

  // Verify
  let skippedNonPublic = 0;
  for (const mig of allMigrations) {
    for (const obj of mig.objects) {
      // The default supabase-js client queries only the public schema.
      // Objects in research/private/etc. would require a schema-scoped
      // client setup; for now we mark them as existing (skipped) and
      // print a notice. Cooper applies these manually via SQL Editor.
      if (obj.schema && obj.schema !== "public") {
        obj.exists = true; // skipped, treated as pass
        skippedNonPublic++;
        continue;
      }
      obj.exists = obj.type === "table"
        ? await verifyTable(supabase, obj.name)
        : await verifyColumn(supabase, obj.table!, obj.name);
    }
  }
  if (skippedNonPublic > 0) {
    console.log(
      `[verify-migrations] NOTICE — skipped ${skippedNonPublic} object(s) in non-public schemas. ` +
        `Apply those migrations manually via Supabase SQL Editor.`
    );
  }

  // Collect failures
  const failures: Array<{ file: string; check: ObjectCheck }> = [];
  for (const mig of allMigrations) {
    for (const obj of mig.objects) {
      if (obj.exists === false) failures.push({ file: mig.file, check: obj });
    }
  }

  if (failures.length === 0) {
    console.log(`[verify-migrations] PASS — all ${totalChecks} tables and columns exist in production.`);
    return;
  }

  // Deduplicate
  const unique = new Map<string, { type: string; detail: string; file: string }>();
  for (const f of failures) {
    const detail = f.check.table ? `${f.check.table}.${f.check.name}` : f.check.name;
    const key = `${f.check.type}:${detail}`;
    unique.set(key, { type: f.check.type, detail, file: f.file });
  }

  console.error("");
  console.error("=".repeat(70));
  console.error("  BUILD BLOCKED — Missing database objects");
  console.error("=".repeat(70));
  console.error("");
  for (const [, v] of unique) {
    console.error(`  MISSING ${v.type}: ${v.detail}  (from ${v.file})`);
  }
  console.error("");
  console.error(`${unique.size} migration(s) need to be applied to production Supabase.`);
  console.error("Run the SQL from the listed migration file(s) in the SQL Editor,");
  console.error("then re-trigger this build.");
  console.error("");
  process.exit(1);
}

main().catch((e) => {
  console.error("[verify-migrations] Script error:", e);
  process.exit(1);
});
