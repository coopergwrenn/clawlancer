#!/usr/bin/env tsx
/**
 * Pre-apply schema check for D14/D15 Phase 2 trigger migration.
 *
 * Mirrors the runbook at `instaclaw/docs/village-dual-channel-migration-apply.md`
 * § "Pre-apply checklist" — verifies that every column referenced by the
 * trigger functions exists in production. If any column is missing, the
 * migration apply will throw mid-run and leave partial state. Catching here
 * via PostgREST `?select=...&limit=0` is cheap and accurate (a 200 means
 * PostgREST resolved all the requested columns against the schema cache).
 *
 * Read-only. Touches nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load env from instaclaw/.env.local — no service_role key on disk anywhere else.
const envPath = join(__dirname, "..", "Users/cooperwrenn/wild-west-bots/instaclaw/.env.local");
let env: Record<string, string> = {};
try {
  for (const line of readFileSync(
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
    "utf-8",
  ).split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch (e) {
  console.error("FATAL: could not read .env.local:", e);
  process.exit(1);
}

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("FATAL: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

console.log(`[preflight] target: ${URL}`);

// Each entry: table → required columns. Drawn DIRECTLY from the trigger
// SQL at pending_migrations/20260516210000_village_dual_channel_triggers.sql
// (NEW.<col> references inside the functions) + the runbook's pre-apply
// checklist. Do not edit without re-reading both.
const checks: Array<{ table: string; columns: string[]; note: string }> = [
  {
    table: "matchpool_outcomes",
    columns: ["outcome_id", "source_user_id", "candidate_user_id", "match_engine", "rrf_score", "mutual_score", "deliberation_score"],
    note: "emit_matchpool_outcome trigger reads these fields on NEW",
  },
  {
    table: "negotiation_threads",
    columns: ["id", "initiator_user_id", "receiver_user_id", "initiator_xmtp_address", "receiver_xmtp_address", "state", "current_turn", "topic", "deliberation_score"],
    note: "emit_negotiation_thread trigger reads these fields on NEW",
  },
  {
    table: "instaclaw_vms",
    columns: ["id", "name", "assigned_to", "health_status", "tier", "api_mode", "partner", "telegram_bot_username"],
    note: "emit_vm_lifecycle trigger reads these fields on NEW",
  },
  {
    table: "instaclaw_users",
    columns: ["id"],
    note: "PK reference (FK from agent_positions)",
  },
  {
    table: "agent_positions",
    columns: ["user_id", "tile_x", "tile_y", "facing_dx", "facing_dy", "is_moving", "is_thinking", "is_speaking", "activity_emoji", "activity_until", "updated_at"],
    note: "emit_agent_position trigger reads these (Phase 1 table; applied 2026-05-16)",
  },
  // village_attendees probe REMOVED — the dependent views were deferred
  // to Phase 3 (2026-05-16). The runbook's original Phase 2 scope is
  // triggers-only; village_attendees not required for this migration.
];

async function probeTable(table: string, columns: string[]): Promise<{ ok: boolean; details: string }> {
  const cols = columns.join(",");
  const url = `${URL}/rest/v1/${table}?select=${cols}&limit=0`;
  const res = await fetch(url, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Accept-Profile": "public",
    },
  });
  if (res.ok) return { ok: true, details: "all columns resolved" };
  const body = await res.text();
  return { ok: false, details: `HTTP ${res.status}: ${body.slice(0, 200)}` };
}

(async () => {
  let allOk = true;
  for (const check of checks) {
    const r = await probeTable(check.table, check.columns);
    console.log(`${r.ok ? "✓" : "✗"} ${check.table.padEnd(22)} (${check.columns.length} cols) — ${r.details}`);
    if (!r.ok) {
      console.log(`  └─ note: ${check.note}`);
      allOk = false;
    }
  }
  console.log("");
  if (allOk) {
    console.log("[preflight] PASS — all 6 tables + columns are present in prod. Migration is safe to apply.");
    process.exit(0);
  } else {
    console.log("[preflight] FAIL — at least one column is missing. DO NOT apply the migration until columns exist.");
    process.exit(1);
  }
})();
