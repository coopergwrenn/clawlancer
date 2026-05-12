/**
 * CLI for manually running the matchpool_outcomes → research bridge.
 *
 * Usage:
 *   # Standard: read salt from env, sync everything
 *   EDGE_CITY_RESEARCH_SALT=$(openssl rand -hex 32) \
 *   EDGE_CITY_RESEARCH_SALT_VERSION=ee26-v1 \
 *   npx tsx scripts/_sync-research-outcomes.ts
 *
 *   # Dry run (preview only, no writes)
 *   npx tsx scripts/_sync-research-outcomes.ts --dry-run
 *
 *   # Smaller batch (for testing)
 *   npx tsx scripts/_sync-research-outcomes.ts --batch 100
 *
 * The cron route at /api/cron/research-export-sync runs this same
 * library on a daily Vercel cron. Use this CLI for:
 *   - One-shot test after applying the migration
 *   - Manual mid-day re-sync if Vendrov needs a fresh snapshot
 *   - Post-rotation full re-sync (after EDGE_CITY_RESEARCH_SALT changes)
 *
 * Per the bridge library docs: --dry-run reads what WOULD be synced
 * without writing. Useful for sanity-checking before a salt rotation.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { runMatchpoolBridgeSync, anonymizeRow } from "../lib/research-export/matchpool-bridge";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // env will be checked below
  }
}

interface Args {
  dryRun: boolean;
  batch?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--batch" && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 1) throw new Error("--batch must be a positive int");
      out.batch = n;
    } else if (a === "-h" || a === "--help") {
      console.log("Usage: npx tsx scripts/_sync-research-outcomes.ts [--dry-run] [--batch N]");
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const salt = process.env.EDGE_CITY_RESEARCH_SALT;
  const saltVersion = process.env.EDGE_CITY_RESEARCH_SALT_VERSION ?? "ee26-v1";

  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  if (!salt || salt.length < 32) {
    console.error("Missing or too-short EDGE_CITY_RESEARCH_SALT (need 32+ char hex)");
    console.error("Generate via: openssl rand -hex 32");
    process.exit(1);
  }

  const sb = createClient(url, key);

  if (args.dryRun) {
    // Preview: fetch what WOULD sync, anonymize in memory, count
    // redactions, but don't call the upsert RPC.
    const { data: stateData } = await sb.rpc("research_export_state_get", {
      p_source_table: "matchpool_outcomes",
    });
    const lastSynced = (stateData?.[0]?.last_synced_at as string | undefined)
      ?? "1970-01-01T00:00:00Z";
    console.log(`Prior watermark: ${lastSynced}`);
    console.log(`Salt version:    ${saltVersion}`);
    console.log(`Prior salt ver:  ${stateData?.[0]?.last_salt_version ?? "(none)"}`);

    const { data: rowsData, error: rowsErr } = await sb
      .from("matchpool_outcomes")
      .select("*")
      .gt("updated_at", lastSynced)
      .order("updated_at", { ascending: true })
      .limit(args.batch ?? 1000);
    if (rowsErr) {
      console.error(`Fetch failed: ${rowsErr.message}`);
      process.exit(1);
    }
    const rows = rowsData ?? [];
    console.log(`Rows that would sync: ${rows.length}`);
    let redactions = 0;
    for (const r of rows) {
      const out = anonymizeRow(r as Parameters<typeof anonymizeRow>[0], salt, saltVersion);
      redactions += out.redactions.length;
    }
    console.log(`Redactions that would fire: ${redactions}`);
    console.log(`\nDRY RUN. Re-run without --dry-run to actually sync.`);
    return;
  }

  const result = await runMatchpoolBridgeSync(sb, { salt, saltVersion, batchSize: args.batch });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
