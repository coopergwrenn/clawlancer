/**
 * Apply 20260504_matchpool_intent_matching.sql to Supabase production.
 *
 * Idempotent: the migration uses CREATE TABLE IF NOT EXISTS / CREATE INDEX
 * IF NOT EXISTS / CREATE OR REPLACE everywhere, so re-running is safe.
 *
 * Usage: npm exec tsx scripts/_apply-matchpool-migration.ts
 */
import { readFileSync } from "fs";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const MIGRATION_PATH = "supabase/migrations/20260504_matchpool_intent_matching.sql";

const EXPECTED_TABLES = [
  "matchpool_profiles",
  "matchpool_cached_top3",
  "matchpool_deliberations",
  "matchpool_notifications",
  "matchpool_intros",
];

async function main() {
  const sql = readFileSync(MIGRATION_PATH, "utf-8");
  console.log(`Loaded migration: ${MIGRATION_PATH} (${sql.length} bytes)`);

  // Connect via direct Postgres pooler (consistent with other apply scripts)
  const { Pool } = await import("pg");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const projectRef = supabaseUrl.replace("https://", "").split(".")[0];
  const dbPassword = process.env.SUPABASE_DB_PASSWORD;
  if (!dbPassword) {
    throw new Error("SUPABASE_DB_PASSWORD missing from .env.local");
  }

  const pool = new Pool({
    connectionString: `postgresql://postgres.${projectRef}:${dbPassword}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    console.log("\n── Applying migration (single transaction) ──");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("✓ migration committed");

    // Verify each expected table exists
    console.log("\n── Verifying tables ──");
    for (const tbl of EXPECTED_TABLES) {
      const r = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS exists`,
        [tbl]
      );
      const exists = r.rows[0].exists as boolean;
      console.log(`  ${exists ? "✓" : "✗"} ${tbl}`);
      if (!exists) throw new Error(`Table ${tbl} missing after migration`);
    }

    // Verify the trigger
    const triggerCheck = await client.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgname IN ('matchpool_profiles_change_notify',
                        'matchpool_profiles_updated_at',
                        'matchpool_intros_updated_at')`
    );
    console.log("\n── Triggers ──");
    for (const row of triggerCheck.rows) {
      console.log(`  ✓ ${row.tgname}`);
    }
    if (triggerCheck.rows.length !== 3) {
      throw new Error(
        `Expected 3 triggers, found ${triggerCheck.rows.length}`
      );
    }

    // Verify the embedding indexes (HNSW)
    const indexCheck = await client.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'matchpool_profiles'
         AND indexname IN (
           'matchpool_profiles_offering_hnsw',
           'matchpool_profiles_seeking_hnsw',
           'matchpool_profiles_fts_gin'
         )`
    );
    console.log("\n── Critical indexes ──");
    for (const row of indexCheck.rows) {
      console.log(`  ✓ ${row.indexname}`);
    }
    if (indexCheck.rows.length !== 3) {
      throw new Error(
        `Expected 3 critical indexes, found ${indexCheck.rows.length}`
      );
    }

    // Verify pgvector extension is enabled
    const extCheck = await client.query(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`
    );
    console.log("\n── Extensions ──");
    if (extCheck.rows.length === 0) {
      throw new Error("pgvector extension not enabled");
    }
    console.log(`  ✓ vector (pgvector)`);

    // Quick sanity: row counts (all should be 0 since fresh)
    console.log("\n── Initial row counts ──");
    for (const tbl of EXPECTED_TABLES) {
      const r = await client.query(`SELECT COUNT(*) AS n FROM ${tbl}`);
      console.log(`  ${tbl.padEnd(30)} ${r.rows[0].n}`);
    }

    console.log("\n✅ Migration applied successfully.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n✗ Migration failed. Rolled back.");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
