/**
 * Find every (terminated|failed|destroyed) VM whose telegram_bot_token
 * matches a token in any active pending_users row. Those stale tokens
 * are blocking new configure attempts via the unique constraint
 * `instaclaw_vms_telegram_bot_token_unique`.
 *
 * Strategy: NULL out telegram_bot_token (and bot_username + chat_id) on
 * the dead VMs. Their data is preserved in last_assigned_to + name; the
 * token is the only thing blocking re-use.
 *
 * SAFE: only touches VMs in (failed|terminated|destroyed) — never
 * touches assigned/ready VMs.
 *
 * Usage:
 *   npx tsx scripts/_clear-stale-tg-tokens.ts          # dry-run
 *   npx tsx scripts/_clear-stale-tg-tokens.ts --exec   # actually clear
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EXEC = process.argv.includes("--exec");

(async () => {
  console.log(`=== Clear stale telegram_bot_tokens on dead VMs (${EXEC ? "EXEC" : "DRY-RUN"}) ===\n`);

  // 1. Pull every active pending_users row that has a telegram_bot_token
  const { data: pending } = await s
    .from("instaclaw_pending_users")
    .select("user_id, telegram_bot_token, telegram_bot_username")
    .is("consumed_at", null)
    .not("telegram_bot_token", "is", null);
  console.log(`Active pending_users with telegram tokens: ${pending?.length ?? 0}`);

  const pendingTokens = new Set<string>();
  for (const p of pending ?? []) {
    if (p.telegram_bot_token) pendingTokens.add(p.telegram_bot_token);
  }

  if (pendingTokens.size === 0) {
    console.log("No active pending tokens — nothing to clear.");
    return;
  }

  // 2. Find dead VMs holding any of those tokens
  const { data: deadConflicts } = await s
    .from("instaclaw_vms")
    .select("id, name, status, telegram_bot_token, telegram_bot_username, assigned_to, last_assigned_to")
    .in("status", ["failed", "terminated", "destroyed"])
    .in("telegram_bot_token", Array.from(pendingTokens));

  console.log(`\nDead VMs blocking active pending tokens: ${deadConflicts?.length ?? 0}\n`);
  for (const v of deadConflicts ?? []) {
    console.log(`  ${v.name?.padEnd(20)} status=${v.status} bot=${v.telegram_bot_username} token=${v.telegram_bot_token?.slice(0, 18)}... last_assigned=${v.last_assigned_to?.slice(0, 8) ?? "null"}`);
  }

  if ((deadConflicts?.length ?? 0) === 0) {
    console.log("No dead VMs blocking active tokens.");
    return;
  }

  if (!EXEC) {
    console.log("\nDRY-RUN — rerun with --exec to NULL out these tokens.");
    return;
  }

  // 3. NULL out the conflicting tokens
  console.log("\nClearing tokens…");
  const ids = (deadConflicts ?? []).map((v) => v.id);
  const { error } = await s
    .from("instaclaw_vms")
    .update({
      telegram_bot_token: null,
      telegram_bot_username: null,
      telegram_chat_id: null,
    })
    .in("id", ids);
  if (error) {
    console.error(`  FAILED: ${error.message}`);
    process.exit(1);
  }
  console.log(`  ✓ cleared ${ids.length} dead VMs' telegram tokens. Constraint should now allow active users to claim them.`);
})();
