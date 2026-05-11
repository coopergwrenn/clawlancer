/**
 * Selective stuck-head flip — per Cooper's call: only flip VMs whose
 * billing-status SoT (lib/billing-status.ts, Rule 14) reports !isPaying.
 * Stripe-verified for each so we don't get burned by local DB drift
 * (Rule 14 companion lesson).
 *
 * Same eligibility criteria as _oneshot-flip-stuck-head.ts:
 *   status='assigned' AND health_status='healthy' AND config_version < 84
 *   AND updated_at older than 14 days
 *   AND last_user_activity_at older than 7 days
 *
 * Then for each: getBillingStatusVerified(supabase, stripe, vmId).
 *   isPaying === true  → leave healthy, log for manual review
 *   isPaying === false → flip to unhealthy
 *
 * Usage:
 *   npx tsx scripts/_selective-flip-stuck-head.ts         # dry-run (default)
 *   npx tsx scripts/_selective-flip-stuck-head.ts --apply
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getBillingStatusVerified } from "../lib/billing-status";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const APPLY = process.argv.includes("--apply");
const CV_BEHIND = 84;
const RECONCILE_STALE_DAYS = 14;
const USER_INACTIVE_DAYS = 7;

async function main() {
  const reconcileCutoff = new Date(Date.now() - RECONCILE_STALE_DAYS * 86400_000).toISOString();
  const userCutoff = new Date(Date.now() - USER_INACTIVE_DAYS * 86400_000).toISOString();

  console.log(`\n=== selective-flip-stuck-head ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`Filtering: cv<${CV_BEHIND}, healthy, updated_at<${reconcileCutoff.slice(0, 10)}, last_user_activity<${userCutoff.slice(0, 10)}\n`);

  const { data: candidates, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, config_version, assigned_to, updated_at, last_user_activity_at")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .lt("config_version", CV_BEHIND)
    .lt("updated_at", reconcileCutoff)
    .order("updated_at", { ascending: true });

  if (error) {
    console.error("candidate query failed:", error.message);
    process.exit(1);
  }

  // Filter on user-inactive (NULL = abandoned)
  const filtered = (candidates ?? []).filter((v) => {
    if (!v.last_user_activity_at) return true;
    return new Date(v.last_user_activity_at).toISOString() < userCutoff;
  });

  console.log(`Initial candidates: ${filtered.length}`);
  console.log(`Now checking billing status (Stripe-verified) for each...\n`);

  const flipList: typeof filtered = [];
  const keepList: Array<{ vm: typeof filtered[number]; reason: string }> = [];
  const errors: Array<{ vm: typeof filtered[number]; err: string }> = [];

  let i = 0;
  for (const vm of filtered) {
    i++;
    process.stdout.write(`  [${String(i).padStart(2)}/${filtered.length}] ${(vm.name ?? vm.id).padEnd(22)}  cv=${vm.config_version}  `);
    try {
      const status = await getBillingStatusVerified(sb, stripe, vm.id);
      if (!status) {
        errors.push({ vm, err: "getBillingStatusVerified returned null (no VM or no assignee)" });
        console.log(`NULL → flip`);
        flipList.push(vm);
        continue;
      }
      if (status.isPaying) {
        keepList.push({ vm, reason: status.classification ?? "isPaying=true" });
        console.log(`PAYING (${status.classification ?? "unspecified"}) → KEEP`);
      } else {
        flipList.push(vm);
        console.log(`NOT-PAYING (${status.classification ?? "?"}) → flip`);
      }
    } catch (e) {
      errors.push({ vm, err: (e as Error).message });
      console.log(`ERR: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Flip:  ${flipList.length}`);
  console.log(`Keep:  ${keepList.length}`);
  console.log(`Errors: ${errors.length}`);

  if (keepList.length) {
    console.log(`\nKept (paying — leave healthy, investigate individually):`);
    for (const k of keepList) {
      console.log(`  ${k.vm.name?.padEnd(22)}  cv=${k.vm.config_version}  reason=${k.reason}`);
    }
  }
  if (errors.length) {
    console.log(`\nErrors:`);
    for (const e of errors) {
      console.log(`  ${e.vm.name?.padEnd(22)}  ${e.err.slice(0, 100)}`);
    }
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN — no changes made. Re-run with --apply to commit the flip set.`);
    return;
  }
  if (flipList.length === 0) {
    console.log(`\nNothing to flip.`);
    return;
  }

  console.log(`\nFlipping ${flipList.length} VMs to unhealthy...`);
  const ids = flipList.map((v) => v.id);
  const { error: updErr, count } = await sb
    .from("instaclaw_vms")
    .update({ health_status: "unhealthy" }, { count: "exact" })
    .in("id", ids);
  if (updErr) {
    console.error("update failed:", updErr.message);
    process.exit(1);
  }
  console.log(`OK — flipped ${count ?? "?"} VMs.`);
  console.log(`\nPer-VM recovery: UPDATE instaclaw_vms SET health_status='healthy' WHERE id='<uuid>';`);
}

main().then(() => process.exit(0));
