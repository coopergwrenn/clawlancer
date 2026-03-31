/**
 * Reclaim safe VMs — recycles VMs from users who never used them or
 * haven't been active in 14+ days AND have no active subscription.
 *
 * Two groups:
 *   A) Never sent a message (assigned but 0 usage)
 *   B) Inactive 14+ days (last message > 14 days ago)
 *
 * Both groups require: no active/trialing/past_due subscription.
 *
 * Usage:
 *   npx tsx scripts/_reclaim-safe-vms.ts --dry-run    # Preview only
 *   npx tsx scripts/_reclaim-safe-vms.ts --test-first  # Reclaim 1, pause, then rest
 *   npx tsx scripts/_reclaim-safe-vms.ts               # Reclaim all safe VMs
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_FIRST = process.argv.includes("--test-first");
const INACTIVE_DAYS = 14;

interface ReclaimCandidate {
  id: string;
  name: string | null;
  assigned_to: string;
  assigned_at: string | null;
  health_status: string;
  ip_address: string;
  tier: string | null;
  group: "never_active" | "inactive_14d";
  last_message_date: string | null;
  sub_status: string | null;
}

async function findCandidates(): Promise<ReclaimCandidate[]> {
  const candidates: ReclaimCandidate[] = [];

  // Get all assigned VMs that are NOT suspended
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, assigned_at, health_status, ip_address, tier, ssh_port, ssh_user")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .neq("health_status", "suspended");

  if (!vms?.length) {
    console.log("No assigned non-suspended VMs found.");
    return [];
  }

  console.log(`Found ${vms.length} assigned non-suspended VMs. Checking eligibility...`);

  for (const vm of vms) {
    // Check subscription
    const { data: sub } = await supabase
      .from("instaclaw_subscriptions")
      .select("status")
      .eq("user_id", vm.assigned_to)
      .single();

    // Skip if user has active/trialing/past_due subscription
    if (sub && ["active", "trialing", "past_due"].includes(sub.status)) {
      continue;
    }

    // Check usage — get most recent message date
    const { data: usage } = await supabase
      .from("instaclaw_daily_usage")
      .select("usage_date, message_count")
      .eq("vm_id", vm.id)
      .gt("message_count", 0)
      .order("usage_date", { ascending: false })
      .limit(1);

    const lastMessageDate = usage?.[0]?.usage_date ?? null;

    if (!lastMessageDate) {
      // Group A: Never sent a message
      candidates.push({
        ...vm,
        group: "never_active",
        last_message_date: null,
        sub_status: sub?.status ?? null,
      });
    } else {
      // Check if inactive 14+ days
      const daysSinceMessage = Math.floor(
        (Date.now() - new Date(lastMessageDate).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysSinceMessage >= INACTIVE_DAYS) {
        candidates.push({
          ...vm,
          group: "inactive_14d",
          last_message_date: lastMessageDate,
          sub_status: sub?.status ?? null,
        });
      }
    }
  }

  return candidates;
}

async function reclaimVM(candidate: ReclaimCandidate): Promise<boolean> {
  const label = candidate.name ?? candidate.id.slice(0, 8);
  console.log(`  Reclaiming ${label} (${candidate.ip_address}) [${candidate.group}]...`);

  try {
    // 1. Stamp last_assigned_to
    await supabase
      .from("instaclaw_vms")
      .update({
        last_assigned_to: candidate.assigned_to,
        telegram_bot_token: null,
        telegram_bot_username: null,
        telegram_chat_id: null,
      })
      .eq("id", candidate.id);

    // 2. DB cleanup via RPC
    const { error: rpcErr } = await supabase.rpc("instaclaw_reclaim_vm", {
      p_user_id: candidate.assigned_to,
    });

    if (rpcErr) {
      console.error(`  ❌ RPC failed for ${label}: ${rpcErr.message}`);
      return false;
    }

    // 3. Wipe filesystem via production API (uses SSH internally)
    // We call the admin endpoint instead of SSH directly to reuse the wipe logic
    const adminKey = process.env.ADMIN_SECRET || process.env.CRON_SECRET || "";
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://instaclaw.io";

    const wipeRes = await fetch(`${baseUrl}/api/admin/vms/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": adminKey,
      },
      body: JSON.stringify({ vmId: candidate.id, action: "wipe" }),
    });

    if (wipeRes.ok) {
      // 4. Mark as ready
      await supabase
        .from("instaclaw_vms")
        .update({ status: "ready" })
        .eq("id", candidate.id);
      console.log(`  ✅ ${label} reclaimed and ready`);
      return true;
    } else {
      // Wipe failed — leave in provisioning state (safe, won't be assigned)
      console.error(`  ⚠️ ${label} DB reclaimed but wipe failed (status ${wipeRes.status}). Left in provisioning.`);
      return false;
    }
  } catch (err) {
    console.error(`  ❌ ${label} failed: ${err}`);
    return false;
  }
}

async function main() {
  console.log(`\n🦀 InstaClaw VM Reclaim Script`);
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN" : TEST_FIRST ? "TEST FIRST" : "FULL RECLAIM"}`);
  console.log(`   Inactive threshold: ${INACTIVE_DAYS} days\n`);

  const candidates = await findCandidates();

  const groupA = candidates.filter((c) => c.group === "never_active");
  const groupB = candidates.filter((c) => c.group === "inactive_14d");

  console.log(`\n📊 Results:`);
  console.log(`   Group A (never active): ${groupA.length} VMs`);
  console.log(`   Group B (inactive ${INACTIVE_DAYS}d+): ${groupB.length} VMs`);
  console.log(`   Total reclaimable: ${candidates.length} VMs`);
  console.log(`   Monthly savings: ~$${candidates.length * 24}/mo (Linode @ $24/VM)\n`);

  if (candidates.length === 0) {
    console.log("Nothing to reclaim. Done.");
    return;
  }

  // Print table
  console.log("   VM Name           | Group         | Sub Status | Last Message    | IP");
  console.log("   " + "-".repeat(85));
  for (const c of candidates) {
    const name = (c.name ?? c.id.slice(0, 8)).padEnd(18);
    const group = c.group.padEnd(13);
    const sub = (c.sub_status ?? "none").padEnd(10);
    const lastMsg = c.last_message_date ?? "never";
    console.log(`   ${name} | ${group} | ${sub} | ${lastMsg.padEnd(15)} | ${c.ip_address}`);
  }

  if (DRY_RUN) {
    console.log("\n🔍 Dry run complete. No VMs were reclaimed.");
    return;
  }

  if (TEST_FIRST && candidates.length > 0) {
    console.log(`\n🧪 Test first: reclaiming 1 VM...`);
    const success = await reclaimVM(candidates[0]);
    if (!success) {
      console.log("❌ Test VM failed. Aborting.");
      return;
    }
    console.log("✅ Test VM succeeded. Waiting for manual approval...");
    console.log("   Run without --test-first to reclaim the remaining VMs.");
    return;
  }

  // Full reclaim
  console.log(`\n🚀 Reclaiming ${candidates.length} VMs...\n`);
  let success = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const result = await reclaimVM(candidate);
    if (result) success++;
    else failed++;

    // Small delay between reclaims to avoid overwhelming SSH
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n📊 Final: ${success} reclaimed, ${failed} failed`);
  console.log(`   Monthly savings: ~$${success * 24}/mo`);
}

main().catch(console.error);
