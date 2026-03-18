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
  exists: boolean | null;
}

interface MigrationResult {
  file: string;
  objects: ObjectCheck[];
}

// ── SQL Parsers ──

function parseMigration(sql: string): ObjectCheck[] {
  const checks: ObjectCheck[] = [];
  const seen = new Set<string>();
  let m;

  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
  while ((m = createTable.exec(sql))) {
    const key = `table:${m[1]}`;
    if (!seen.has(key)) { seen.add(key); checks.push({ type: "table", name: m[1], exists: null }); }
  }

  const addCol = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  while ((m = addCol.exec(sql))) {
    const key = `column:${m[1]}.${m[2]}`;
    if (!seen.has(key)) { seen.add(key); checks.push({ type: "column", table: m[1], name: m[2], exists: null }); }
  }

  return checks;
}

// ── Production Verification ──

async function verifyColumn(supabase: ReturnType<typeof createClient>, table: string, column: string): Promise<boolean> {
  try {
    const { error } = await supabase.from(table).select(column).limit(0);
    if (!error) return true;
    const msg = (error.message || "").toLowerCase();
    if (msg.includes("does not exist") || msg.includes("is not") || error.code === "PGRST204" || error.code === "42703") {
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
    if (msg.includes("does not exist") || msg.includes("relation") || error.code === "PGRST204") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Main ──

async function main() {
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
  for (const mig of allMigrations) {
    for (const obj of mig.objects) {
      obj.exists = obj.type === "table"
        ? await verifyTable(supabase, obj.name)
        : await verifyColumn(supabase, obj.table!, obj.name);
    }
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
