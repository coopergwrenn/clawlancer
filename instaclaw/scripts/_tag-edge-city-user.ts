/**
 * Tag a user as edge_city.
 *
 * Sets `instaclaw_users.partner = 'edge_city'` for the given email AND
 * syncs `instaclaw_vms.partner = 'edge_city'` for every VM assigned to
 * that user (CLAUDE.md Rule 9 — partner tags must be kept in sync
 * across users + their VMs).
 *
 * For Edge Esmeralda attendees who signed up via the regular /signup
 * flow before the /edge portal existed, or for cases where the partner
 * tag drifted between user and VM rows. Logs to instaclaw_vm_lifecycle_log
 * for forensic trace.
 *
 * Idempotent: re-running on an already-tagged user is a no-op (still
 * writes a log row marking the verification touch).
 *
 * Usage:
 *   npx tsx scripts/_tag-edge-city-user.ts user@example.com
 *   npx tsx scripts/_tag-edge-city-user.ts user@example.com --dry-run
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env.ssh-key is optional for this script
  }
}

const PARTNER = "edge_city";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!email) {
  console.error("Usage: npx tsx scripts/_tag-edge-city-user.ts <email> [--dry-run]");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(`\n=== Tag user as ${PARTNER} ===`);
  console.log(`email:   ${email}`);
  console.log(`dry-run: ${dryRun ? "YES" : "no"}\n`);

  // 1. Find the user.
  const { data: user, error: userErr } = await sb
    .from("instaclaw_users")
    .select("id, email, partner, name, created_at")
    .eq("email", email)
    .maybeSingle();

  if (userErr) {
    console.error(`✗ user lookup failed: ${userErr.message}`);
    process.exit(2);
  }
  if (!user) {
    console.error(`✗ no user found with email "${email}"`);
    process.exit(3);
  }

  console.log(`User found:`);
  console.log(`  id:        ${user.id}`);
  console.log(`  name:      ${user.name ?? "(unset)"}`);
  console.log(`  partner:   ${user.partner ?? "(null)"}`);
  console.log(`  created:   ${user.created_at}\n`);

  const userAlreadyTagged = user.partner === PARTNER;
  if (user.partner && user.partner !== PARTNER) {
    console.error(
      `✗ user is already tagged as "${user.partner}". Refusing to overwrite a different partner.`,
    );
    console.error(`  If this is intentional, clear it first with a manual UPDATE.`);
    process.exit(4);
  }

  // 2. Find assigned VMs.
  const { data: vms, error: vmsErr } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, partner, status, health_status, assigned_to")
    .eq("assigned_to", user.id);

  if (vmsErr) {
    console.error(`✗ vm lookup failed: ${vmsErr.message}`);
    process.exit(5);
  }

  console.log(`Assigned VMs: ${vms?.length ?? 0}`);
  for (const vm of vms ?? []) {
    const tag = vm.partner === PARTNER ? "✓ already tagged" : vm.partner ? `⚠ tagged as "${vm.partner}"` : "needs tag";
    console.log(`  - ${vm.name} (${vm.ip_address ?? "no-ip"}) status=${vm.status} health=${vm.health_status} — ${tag}`);
  }
  console.log();

  // Refuse if any VM has a conflicting partner — same defensive policy as the user check.
  const conflictVm = (vms ?? []).find((v) => v.partner && v.partner !== PARTNER);
  if (conflictVm) {
    console.error(
      `✗ VM ${conflictVm.name} is tagged as "${conflictVm.partner}". Refusing to overwrite.`,
    );
    process.exit(6);
  }

  if (dryRun) {
    console.log("(dry-run) no writes performed. Re-run without --dry-run to apply.");
    return;
  }

  // 3. Apply writes.
  if (!userAlreadyTagged) {
    const { error: updateUserErr } = await sb
      .from("instaclaw_users")
      .update({ partner: PARTNER })
      .eq("id", user.id);
    if (updateUserErr) {
      console.error(`✗ user update failed: ${updateUserErr.message}`);
      process.exit(7);
    }
    console.log(`✓ user.partner = ${PARTNER}`);
  } else {
    console.log(`· user.partner already = ${PARTNER} (no-op)`);
  }

  const vmsNeedingTag = (vms ?? []).filter((v) => v.partner !== PARTNER);
  for (const vm of vmsNeedingTag) {
    const { error: updateVmErr } = await sb
      .from("instaclaw_vms")
      .update({ partner: PARTNER })
      .eq("id", vm.id);
    if (updateVmErr) {
      console.error(`✗ vm ${vm.name} update failed: ${updateVmErr.message}`);
      process.exit(8);
    }
    console.log(`✓ vm.partner[${vm.name}] = ${PARTNER}`);
  }
  if (vmsNeedingTag.length === 0 && (vms?.length ?? 0) > 0) {
    console.log(`· all ${vms!.length} VMs already tagged (no-op)`);
  }

  // 4. Forensic log row per VM (or one row marker if no VMs yet).
  const logRows =
    (vms ?? []).length > 0
      ? (vms ?? []).map((vm) => ({
          vm_id: vm.id,
          vm_name: vm.name,
          ip_address: vm.ip_address,
          user_id: user.id,
          user_email: user.email,
          subscription_status: null,
          credit_balance: 0,
          action: "partner_tag_applied",
          reason: `tag-edge-city-user: set partner=${PARTNER} via admin script`,
          provider_server_id: null,
        }))
      : [
          {
            vm_id: null,
            vm_name: null,
            ip_address: null,
            user_id: user.id,
            user_email: user.email,
            subscription_status: null,
            credit_balance: 0,
            action: "partner_tag_applied",
            reason: `tag-edge-city-user: set user.partner=${PARTNER} (no VMs assigned yet)`,
            provider_server_id: null,
          },
        ];

  const { error: logErr } = await sb.from("instaclaw_vm_lifecycle_log").insert(logRows);
  if (logErr) {
    console.error(`⚠ lifecycle log insert failed (non-fatal): ${logErr.message}`);
  } else {
    console.log(`✓ wrote ${logRows.length} row(s) to instaclaw_vm_lifecycle_log`);
  }

  console.log(`\nDone. User ${email} is now ${PARTNER}.`);
  if ((vms ?? []).length === 0) {
    console.log("Note: user has no assigned VMs yet — the partner tag will sync to their VM");
    console.log("at provision time via configureOpenClaw (the partner flows through users → vm).");
  } else {
    console.log("The Edge City nav item + dashboard card will appear on their next page load.");
    console.log("Their bot's reconciler will pick up partner-gated skills/env on the next cycle.");
  }
}

main().catch((err) => {
  console.error("✗ unexpected error:", err);
  process.exit(99);
});
