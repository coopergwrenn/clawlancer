/**
 * invite-blast.ts — Reclaim churned VMs + send invite blast to waitlist
 *
 * Usage:
 *   npx tsx scripts/invite-blast.ts
 */

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
const envPath = resolve(".", ".env.local");
const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const resend = new Resend(process.env.RESEND_API_KEY!);

// Invite code generation (same as lib/security.ts)
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateCode(): string {
  const parts: string[] = [];
  for (let p = 0; p < 3; p++) {
    let segment = "";
    for (let i = 0; i < 4; i++) {
      segment += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
    parts.push(segment);
  }
  return parts.join("-");
}

// ── Step 1: Reclaim VMs from churned users ──

const CHURNED_EMAILS = [
  "yanisdollinger@gmail.com",
  "soundmanpicasso@gmail.com",
  "ontusk3@gmail.com",
  "paul21maestas@gmail.com",
  "fadehari86@gmail.com",
];

async function reclaimVMs() {
  console.log("\n=== STEP 1: Reclaiming VMs from churned users ===\n");

  let reclaimed = 0;
  for (const email of CHURNED_EMAILS) {
    // Find the user
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("id, vm_id")
      .eq("email", email)
      .single();

    if (!user) {
      console.log(`  ${email}: user not found, skipping`);
      continue;
    }

    if (!user.vm_id) {
      console.log(`  ${email}: no VM assigned, skipping`);
      continue;
    }

    // Get VM info
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, name, status")
      .eq("id", user.vm_id)
      .single();

    if (!vm) {
      console.log(`  ${email}: VM ${user.vm_id} not found in DB, skipping`);
      continue;
    }

    // Reset VM to ready
    const { error: vmError } = await supabase
      .from("instaclaw_vms")
      .update({
        status: "ready",
        assigned_to: null,
        gateway_url: null,
        gateway_token: null,
        control_ui_url: null,
        default_model: null,
        api_mode: null,
        tier: null,
      })
      .eq("id", vm.id);

    if (vmError) {
      console.log(`  ${email}: VM reset failed - ${vmError.message}`);
      continue;
    }

    // Clear user's VM assignment
    const { error: userError } = await supabase
      .from("instaclaw_users")
      .update({
        vm_id: null,
        onboarding_complete: false,
      })
      .eq("id", user.id);

    if (userError) {
      console.log(`  ${email}: user update failed - ${userError.message}`);
      continue;
    }

    reclaimed++;
    console.log(`  ${email}: VM ${vm.name} reclaimed (was ${vm.status})`);
  }

  console.log(`\n  Total reclaimed: ${reclaimed}/${CHURNED_EMAILS.length}`);
  return reclaimed;
}

// ── Step 2: Send invite blast ──

async function sendInviteBlast(count: number) {
  console.log(`\n=== STEP 2: Sending ${count} invite emails ===\n`);

  // Import email template builder
  const { buildInviteEmailHtml } = await import("../lib/email.js");

  // Get next waitlist entries that haven't been invited
  const { data: entries, error: wlError } = await supabase
    .from("instaclaw_waitlist")
    .select("id, email, position")
    .is("invite_sent_at", null)
    .order("position", { ascending: true })
    .limit(count);

  if (wlError) {
    console.error("  Failed to fetch waitlist:", wlError.message);
    return;
  }

  if (!entries?.length) {
    console.log("  No un-invited waitlist entries found!");
    return;
  }

  console.log(`  Found ${entries.length} waitlist entries to invite:\n`);

  let sent = 0;
  let failed = 0;
  const results: { email: string; code: string; status: string }[] = [];

  for (const entry of entries) {
    const code = generateCode();
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Create invite code in DB
    const { error: inviteError } = await supabase
      .from("instaclaw_invites")
      .insert({
        code,
        email: entry.email,
        max_uses: 1,
        expires_at: expiresAt,
        created_by: "admin-blast",
      });

    if (inviteError) {
      console.log(`  ${entry.email}: invite creation failed - ${inviteError.message}`);
      results.push({ email: entry.email, code, status: "DB_ERROR" });
      failed++;
      continue;
    }

    // Send email via Resend
    try {
      const html = buildInviteEmailHtml(code);
      await resend.emails.send({
        from: "InstaClaw <noreply@instaclaw.io>",
        replyTo: "coop@valtlabs.com",
        to: entry.email,
        subject: "You're in - here's your InstaClaw invite 💫",
        html,
      });

      // Update waitlist entry
      await supabase
        .from("instaclaw_waitlist")
        .update({
          invite_sent_at: new Date().toISOString(),
          invite_code: code,
        })
        .eq("id", entry.id);

      sent++;
      results.push({ email: entry.email, code, status: "SENT" });
      console.log(`  [${sent}/${entries.length}] ${entry.email} — ${code} — SENT`);

      // Small delay to avoid rate limiting (Resend free tier)
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [!] ${entry.email} — FAILED: ${msg}`);
      results.push({ email: entry.email, code, status: `FAILED: ${msg}` });
      failed++;
    }
  }

  console.log(`\n  Sent: ${sent}  |  Failed: ${failed}  |  Total: ${entries.length}`);

  // Print summary table
  console.log("\n  === INVITE SUMMARY ===");
  console.log("  | # | Email                              | Code           | Status |");
  console.log("  |---|-------------------------------------|----------------|--------|");
  results.forEach((r, i) => {
    console.log(
      `  | ${String(i + 1).padStart(2)} | ${r.email.padEnd(35)} | ${r.code.padEnd(14)} | ${r.status.padEnd(6)} |`
    );
  });

  return sent;
}

// ── Main ──

async function main() {
  // Step 1: Reclaim VMs
  const reclaimed = await reclaimVMs();

  // Step 2: Count available VMs
  const { data: readyVMs } = await supabase
    .from("instaclaw_vms")
    .select("id, name")
    .eq("status", "ready")
    .is("assigned_to", null);

  const totalReady = readyVMs?.length ?? 0;
  const reserved = 5;
  const availableForBlast = totalReady - reserved;

  console.log(`\n=== VM AVAILABILITY ===`);
  console.log(`  Total ready VMs: ${totalReady}`);
  console.log(`  Reserved (buffer): ${reserved}`);
  console.log(`  Available for blast: ${availableForBlast}`);

  // Send invites (capped at available VMs, max 14 as requested)
  const toSend = Math.min(14, availableForBlast);

  if (toSend <= 0) {
    console.log("\n  Not enough VMs available for blast!");
    return;
  }

  console.log(`  Sending: ${toSend} invites`);

  // Step 3: Send the blast
  await sendInviteBlast(toSend);

  // Final fleet status
  const { data: allVMs } = await supabase
    .from("instaclaw_vms")
    .select("status, assigned_to");

  const ready = allVMs?.filter((v: any) => v.status === "ready" && !v.assigned_to).length ?? 0;
  const assigned = allVMs?.filter((v: any) => v.assigned_to).length ?? 0;

  console.log(`\n=== FINAL FLEET STATUS ===`);
  console.log(`  Ready (unassigned): ${ready}`);
  console.log(`  Assigned: ${assigned}`);
  console.log(`  Total: ${allVMs?.length ?? 0}`);
  console.log(`\nDone!`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
