/**
 * CLI entry point for the EE26 research data export.
 *
 * Usage:
 *
 *   # Default: CSV to ./research-exports/, all dates
 *   npx tsx instaclaw/scripts/_export-research-data.ts
 *
 *   # Parquet output (requires @dsnp/parquetjs installed)
 *   npx tsx instaclaw/scripts/_export-research-data.ts --format=parquet
 *
 *   # Date-filtered to one week
 *   npx tsx instaclaw/scripts/_export-research-data.ts \
 *       --from=2026-05-30 --to=2026-06-06
 *
 *   # Custom output dir
 *   npx tsx instaclaw/scripts/_export-research-data.ts --out=/data/ee26
 *
 * Environment variables required:
 *   NEXT_PUBLIC_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY         — read access to research.* schema
 *   EDGE_CITY_RESEARCH_SALT           — 32+ char random hex (held only
 *                                       by InstaClaw, rotated post-village)
 *
 * Optional:
 *   EDGE_CITY_RESEARCH_SALT_VERSION   — short version tag for the salt
 *                                       (default: "ee26-v1")
 *   RESEARCH_EXPORT_DIR               — default output directory
 *                                       (default: ./research-exports)
 *
 * Generate a salt:
 *   openssl rand -hex 32
 */

import * as path from "node:path";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { runResearchExport, type RunOptions } from "../lib/research-export/pipeline";

// Load env from .env.local first, then .env
dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

interface ParsedArgs {
  format: "csv" | "parquet";
  outputDir: string;
  dateRange?: { from: string; to: string };
  saltVersion: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const get = (name: string): string | undefined => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : undefined;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);

  const formatRaw = get("format") ?? "csv";
  if (formatRaw !== "csv" && formatRaw !== "parquet") {
    throw new Error(`--format must be 'csv' or 'parquet' (got '${formatRaw}')`);
  }

  const from = get("from");
  const to = get("to");
  let dateRange: ParsedArgs["dateRange"] = undefined;
  if (from || to) {
    if (!from || !to) {
      throw new Error("--from and --to must both be provided when filtering by date");
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
      throw new Error("--from and --to must be ISO dates (YYYY-MM-DD)");
    }
    dateRange = { from, to };
  }

  const outputDir = get("out") ?? process.env.RESEARCH_EXPORT_DIR ?? "./research-exports";
  const saltVersion = process.env.EDGE_CITY_RESEARCH_SALT_VERSION ?? "ee26-v1";

  return {
    format: formatRaw as "csv" | "parquet",
    outputDir,
    dateRange,
    saltVersion,
    verbose: !flag("quiet"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const salt = process.env.EDGE_CITY_RESEARCH_SALT;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!supabaseKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!salt) missing.push("EDGE_CITY_RESEARCH_SALT");
  if (missing.length > 0) {
    console.error("missing required env vars: " + missing.join(", "));
    console.error("");
    console.error("generate a salt: openssl rand -hex 32");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl as string, supabaseKey as string, {
    db: { schema: "research" },
    auth: { persistSession: false },
  });

  const opts: RunOptions = {
    supabase,
    salt: salt as string,
    saltVersion: args.saltVersion,
    outputDir: args.outputDir,
    format: args.format,
    dateRange: args.dateRange,
    verbose: args.verbose,
  };

  const result = await runResearchExport(opts);

  console.log("");
  console.log("export complete:");
  console.log(`  id:           ${result.exportId}`);
  console.log(`  output:       ${result.outputPath}`);
  console.log(`  total rows:   ${Object.values(result.rowCounts).reduce((a, b) => a + b, 0)}`);
  console.log(`  redactions:   ${result.totalRedactions}`);
  console.log("");
  console.log("per-table:");
  for (const [table, count] of Object.entries(result.rowCounts)) {
    const redactions = result.redactionCounts[table as keyof typeof result.redactionCounts];
    console.log(`  ${table.padEnd(22)} ${String(count).padStart(7)} rows  ${redactions} redactions`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
