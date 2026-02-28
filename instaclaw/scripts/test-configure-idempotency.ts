/**
 * Pre-deploy integration test: Validates the configure pipeline preserves
 * tokens across a double-configure (no pending record).
 *
 * Run before any deploy that touches configure/ssh code:
 *   npx tsx instaclaw/scripts/test-configure-idempotency.ts
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const BASE_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3001";

// Use vm-050 (Cooper's test VM) by default, or pass a VM name as arg
const TARGET_VM = process.argv[2] ?? "instaclaw-vm-050";

async function main() {
  console.log(`\n=== Token Preservation Test (${TARGET_VM}) ===\n`);

  // 1. Find the target VM
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, telegram_bot_token, discord_bot_token, health_status, gateway_url")
    .eq("name", TARGET_VM)
    .single();

  if (vmErr || !vm) {
    console.error(`FAIL: Could not find VM ${TARGET_VM}:`, vmErr?.message);
    process.exit(1);
  }

  if (!vm.assigned_to) {
    console.error(`FAIL: ${TARGET_VM} has no assigned user — cannot test configure`);
    process.exit(1);
  }

  const beforeTelegram = vm.telegram_bot_token;
  const beforeDiscord = vm.discord_bot_token;

  console.log(`VM:        ${vm.name} (${vm.id})`);
  console.log(`User:      ${vm.assigned_to}`);
  console.log(`Health:    ${vm.health_status}`);
  console.log(`Telegram:  ${beforeTelegram ? beforeTelegram.slice(0, 10) + "..." : "(none)"}`);
  console.log(`Discord:   ${beforeDiscord ? beforeDiscord.slice(0, 10) + "..." : "(none)"}`);

  // 2. Verify no pending record exists (simulates the bug scenario)
  const { data: pending } = await supabase
    .from("instaclaw_pending_users")
    .select("id")
    .eq("user_id", vm.assigned_to)
    .is("consumed_at", null)
    .single();

  if (pending) {
    console.log(`\nWARN: Active pending record exists for user — test still valid but less realistic`);
  }

  // 3. Call /api/vm/configure (force=true to bypass idempotency guard)
  console.log(`\nCalling configure (force=true)...`);
  const res = await fetch(`${BASE_URL}/api/vm/configure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": ADMIN_KEY,
    },
    body: JSON.stringify({ userId: vm.assigned_to, force: true }),
  });

  const body = await res.json();
  console.log(`Status: ${res.status}`, body);

  if (!res.ok) {
    console.error(`FAIL: Configure returned ${res.status}`);
    process.exit(1);
  }

  // 4. Re-read tokens from DB
  const { data: afterVm } = await supabase
    .from("instaclaw_vms")
    .select("telegram_bot_token, discord_bot_token, health_status")
    .eq("id", vm.id)
    .single();

  if (!afterVm) {
    console.error("FAIL: Could not re-read VM after configure");
    process.exit(1);
  }

  const afterTelegram = afterVm.telegram_bot_token;
  const afterDiscord = afterVm.discord_bot_token;

  console.log(`\n--- After configure ---`);
  console.log(`Health:    ${afterVm.health_status}`);
  console.log(`Telegram:  ${afterTelegram ? afterTelegram.slice(0, 10) + "..." : "(none)"}`);
  console.log(`Discord:   ${afterDiscord ? afterDiscord.slice(0, 10) + "..." : "(none)"}`);

  // 5. Assert tokens are unchanged
  let passed = true;

  if (beforeTelegram && afterTelegram !== beforeTelegram) {
    console.error(`\nFAIL: Telegram token CHANGED!`);
    console.error(`  Before: ${beforeTelegram.slice(0, 10)}...`);
    console.error(`  After:  ${afterTelegram?.slice(0, 10) ?? "(null)"}...`);
    passed = false;
  } else if (beforeTelegram) {
    console.log(`\nPASS: Telegram token preserved`);
  }

  if (beforeDiscord && afterDiscord !== beforeDiscord) {
    console.error(`\nFAIL: Discord token CHANGED!`);
    console.error(`  Before: ${beforeDiscord.slice(0, 10)}...`);
    console.error(`  After:  ${afterDiscord?.slice(0, 10) ?? "(null)"}...`);
    passed = false;
  } else if (beforeDiscord) {
    console.log(`PASS: Discord token preserved`);
  }

  if (!beforeTelegram && !beforeDiscord) {
    console.log(`\nWARN: No tokens to verify — VM has no tokens set`);
  }

  // 6. Test idempotency: second call should be skipped
  console.log(`\nCalling configure again (no force)...`);
  const res2 = await fetch(`${BASE_URL}/api/vm/configure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": ADMIN_KEY,
    },
    body: JSON.stringify({ userId: vm.assigned_to }),
  });

  const body2 = await res2.json();
  console.log(`Status: ${res2.status}`, body2);

  if (body2.skipped) {
    console.log(`PASS: Second configure was skipped (idempotency guard)`);
  } else {
    console.log(`INFO: Second configure was NOT skipped — VM may not have been healthy yet`);
  }

  // Final result
  console.log(`\n=== ${passed ? "ALL CHECKS PASSED" : "CHECKS FAILED"} ===\n`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
