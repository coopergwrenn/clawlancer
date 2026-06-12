/**
 * Failure-mode test for the video credit-pack path (build order §3, Rule 31).
 *
 * RUNS ONLY AFTER `pending_migrations/20260611220000_video_add_credits_rpc.sql`
 * is applied to prod (the migration is HELD for Cooper's batch). Until then the
 * RPC doesn't exist and this exits with a clear message.
 *
 * What it proves on a THROWAWAY test VM row (never a real customer):
 *   1. instaclaw_add_video_credits increments video_credit_balance by the pack amount.
 *   2. It writes an instaclaw_credit_ledger row (source=video_topup, reference_id=PI)
 *      — the row the webhook's idempotency probe relies on.
 *   3. A second call with the SAME amount (simulating the webhook re-running after a
 *      ledger-miss) increments again — proving the RPC itself is a pure increment and
 *      that idempotency MUST live in the caller (the instaclaw_credit_purchases claim),
 *      exactly like the proven credit_balance path.
 *
 * Usage: npx tsx scripts/_test-video-credit-pack.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const sb = createClient(
  "https://qvrnuyzfqjrsjljcqbub.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // Use vm-050 (the canary) as the test subject; record + restore its balance.
  const VM = "4922f655-f0c1-4161-b8ff-79b24e1a3166";
  const PI = `test_pi_video_${Date.now()}`;

  const { data: before, error: be } = await sb
    .from("instaclaw_vms").select("video_credit_balance").eq("id", VM).single();
  if (be) { console.error("read failed:", be.message); process.exit(1); }
  const start = Number(before!.video_credit_balance);
  console.log(`vm-050 video_credit_balance before: ${start}`);

  // 1 + 2: first top-up (Taste pack = 52 vc)
  const { data: bal1, error: e1 } = await sb.rpc("instaclaw_add_video_credits", {
    p_vm_id: VM, p_credits: 52, p_reference_id: PI, p_source: "video_topup",
  });
  if (e1) {
    if (/function .* does not exist|PGRST202/i.test(e1.message)) {
      console.log("⏸  RPC not yet applied — apply 20260611220000 then re-run. (held for batch)");
      process.exit(0);
    }
    console.error("RPC1 failed:", e1.message); process.exit(1);
  }
  console.log(`after +52: ${bal1}  ${Number(bal1) === start + 52 ? "✅ +52" : "❌ wrong"}`);

  // ledger row written?
  const { data: led } = await sb.from("instaclaw_credit_ledger")
    .select("amount,source,reference_id").eq("vm_id", VM).eq("reference_id", PI);
  const ok2 = led && led.length === 1 && led[0].source === "video_topup" && Number(led[0].amount) === 52;
  console.log(`ledger row: ${JSON.stringify(led)}  ${ok2 ? "✅" : "❌"}`);

  // 3: second call (pure increment — idempotency is the caller's job)
  const { data: bal2 } = await sb.rpc("instaclaw_add_video_credits", {
    p_vm_id: VM, p_credits: 52, p_reference_id: PI, p_source: "video_topup",
  });
  console.log(`after 2nd +52: ${bal2}  ${Number(bal2) === start + 104 ? "✅ pure-increment confirmed (caller must dedup)" : "❌"}`);

  // RESTORE: subtract the 104 we added, delete the test ledger rows.
  await sb.rpc("instaclaw_add_video_credits", { p_vm_id: VM, p_credits: -104, p_reference_id: `${PI}_restore`, p_source: "test_restore" });
  await sb.from("instaclaw_credit_ledger").delete().eq("vm_id", VM).eq("reference_id", PI);
  await sb.from("instaclaw_credit_ledger").delete().eq("vm_id", VM).eq("reference_id", `${PI}_restore`);
  const { data: after } = await sb.from("instaclaw_vms").select("video_credit_balance").eq("id", VM).single();
  console.log(`restored balance: ${after!.video_credit_balance}  ${Number(after!.video_credit_balance) === start ? "✅ clean" : "⚠️ DRIFT — check manually"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
