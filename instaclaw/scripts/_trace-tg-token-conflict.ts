import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TOKEN = "8632364416:AAEICAqctbZKRcMgcYvCmaK24x48yk6ZGMs";
const USER_ID = "48d2aa1e-45d1-4003-af7c-5c0b7e54c6c8"; // ikhsansufi1

(async () => {
  console.log(`=== Where is the telegram_bot_token from? ===\n`);

  // 1. ikhsansufi1's currently-assigned VM
  console.log("[1] Currently-assigned VM for ikhsansufi1:");
  const { data: theirVm } = await s.from("instaclaw_vms")
    .select("id, name, status, telegram_bot_token, telegram_bot_username, last_assigned_to, assigned_at")
    .eq("assigned_to", USER_ID).maybeSingle();
  if (theirVm) {
    console.log(`  ${theirVm.name} status=${theirVm.status} tg_token=${theirVm.telegram_bot_token ? "SET (matches conflict? " + (theirVm.telegram_bot_token === TOKEN) + ")" : "null"}`);
    console.log(`    last_assigned_to: ${theirVm.last_assigned_to ?? "none"}`);
  } else {
    console.log("  no current VM");
  }

  // 2. ALL VMs holding the conflicting token
  console.log(`\n[2] All VMs (any status) holding token ${TOKEN.slice(0, 18)}...:`);
  const { data: tokenHolders } = await s.from("instaclaw_vms")
    .select("id, name, status, health_status, assigned_to, last_assigned_to, telegram_bot_username")
    .eq("telegram_bot_token", TOKEN);
  for (const v of tokenHolders ?? []) {
    console.log(`  ${v.name?.padEnd(20)} status=${v.status} health=${v.health_status} assigned_to=${v.assigned_to?.slice(0, 8) ?? "null"} last_assigned_to=${v.last_assigned_to?.slice(0, 8) ?? "null"} bot=${v.telegram_bot_username ?? "none"}`);
  }
  console.log(`  total holders: ${tokenHolders?.length ?? 0}`);

  // 3. ikhsansufi1's pending_users row
  console.log(`\n[3] ikhsansufi1's pending_users row:`);
  const { data: pend } = await s.from("instaclaw_pending_users")
    .select("telegram_bot_token, telegram_bot_username, tier, consumed_at, created_at")
    .eq("user_id", USER_ID).maybeSingle();
  if (pend) {
    console.log(`  tier=${pend.tier} tg_token=${pend.telegram_bot_token ? "SET (matches? " + (pend.telegram_bot_token === TOKEN) + ")" : "null"} consumed_at=${pend.consumed_at}`);
  } else {
    console.log("  NONE");
  }

  // 4. Find which user originally owned the token
  console.log(`\n[4] Look up the original Telegram bot owner via pending_users (token in their pending row):`);
  const { data: ownerPend } = await s.from("instaclaw_pending_users")
    .select("user_id, telegram_bot_username, created_at, consumed_at")
    .eq("telegram_bot_token", TOKEN);
  for (const op of ownerPend ?? []) {
    console.log(`  user=${op.user_id.slice(0, 8)} bot=${op.telegram_bot_username ?? "?"} created=${op.created_at} consumed=${op.consumed_at}`);
  }
})();
