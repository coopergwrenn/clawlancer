/**
 * Threshold calibration analysis — CLI.
 *
 * Queries production matchpool_outcomes, runs the calibration analysis
 * for both predictors (mutual_score Layer 1 cutoff + deliberation_score
 * Layer 3 cutoff), and outputs a markdown report.
 *
 * Usage:
 *   npx tsx scripts/_calibrate-thresholds.ts                      # all outcomes
 *   npx tsx scripts/_calibrate-thresholds.ts --engine instaclaw   # filter by engine
 *   npx tsx scripts/_calibrate-thresholds.ts --since 2026-05-30   # since date (Edge start)
 *   npx tsx scripts/_calibrate-thresholds.ts --save               # write to docs/calibration-reports/
 *
 * Library: lib/matchpool/calibration.ts + calibration-fetch.ts
 * Sibling: app/api/match/v1/calibration/route.ts serves the same data
 *          to the /edge-city/plaza dashboard widget.
 *
 * Methodology (codified in the library):
 *   - Positive label: rating_post_meeting >= 4
 *   - Negative label: counterpart_response='declined' OR meeting didn't happen
 *   - Optimize: F-beta with beta=0.5 (precision-weighted — bad matches
 *     waste attendees' time)
 *   - Confidence: Wilson score 95% CI on precision at recommended threshold
 *   - Min N for actionable recommendation: 30 labelled outcomes
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { runCalibration } from "../lib/matchpool/calibration-fetch";
import { formatMarkdownReport } from "../lib/matchpool/calibration";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // Best-effort env load; in CI we expect env to be set by the runner.
  }
}

interface Args {
  engine?: "instaclaw" | "index";
  since?: string;
  save: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { save: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v !== "instaclaw" && v !== "index") {
        throw new Error(`--engine must be 'instaclaw' or 'index' (got ${v})`);
      }
      out.engine = v;
    } else if (a === "--since" && i + 1 < argv.length) {
      const v = argv[++i];
      const parsed = new Date(v);
      if (Number.isNaN(parsed.getTime())) throw new Error(`--since must be parseable date (got ${v})`);
      out.since = parsed.toISOString();
    } else if (a === "--save") {
      out.save = true;
    } else if (a === "-h" || a === "--help") {
      console.log("Usage: npx tsx scripts/_calibrate-thresholds.ts [--engine instaclaw|index] [--since DATE] [--save]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { results, total_rows, excluded_rows } = await runCalibration(supabase, {
    matchEngine: args.engine,
    since: args.since,
  });

  const filterDesc: string[] = [];
  if (args.engine) filterDesc.push(`engine=${args.engine}`);
  if (args.since) filterDesc.push(`since=${args.since.slice(0, 10)}`);
  const filter = filterDesc.length ? ` (${filterDesc.join(", ")})` : "";

  const md = formatMarkdownReport(results);
  const header = `> Source: matchpool_outcomes${filter}. Total ${total_rows} rows; ${excluded_rows} excluded (no_reply or ambiguous rating).\n\n`;
  const report = `${md.split("\n").slice(0, 4).join("\n")}\n${header}${md.split("\n").slice(4).join("\n")}`;

  console.log(report);

  if (args.save) {
    const dir = "/Users/cooperwrenn/wild-west-bots/instaclaw/docs/calibration-reports";
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = args.engine ? `-${args.engine}` : "";
    const path = join(dir, `${stamp}${suffix}.md`);
    writeFileSync(path, report);
    console.error(`\nSaved to ${path}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
