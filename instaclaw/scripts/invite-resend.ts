/**
 * invite-resend.ts — Resend invite emails to unredeemed users from specific batches.
 * Does NOT generate new codes — resends the same existing invite code.
 *
 * Usage:
 *   npx tsx scripts/invite-resend.ts --batch-id batch-20260218-002 --batch-id batch-20260218-003 --unredeemed-only
 *   npx tsx scripts/invite-resend.ts --batch-id batch-20260218-002 --dry-run
 *   npx tsx scripts/invite-resend.ts --batch-id batch-20260218-002 --unredeemed-only --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load env
for (const envFile of [".env.local", ".env.ssh-temp"]) {
  try {
    const c = readFileSync(resolve(".", envFile), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[k] || envFile === ".env.ssh-temp") process.env[k] = v;
      }
    }
  } catch {}
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const unredeemedOnly = args.includes("--unredeemed-only");

const batchIds: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--batch-id" && args[i + 1]) {
    batchIds.push(args[i + 1]);
    i++;
  }
}

if (batchIds.length === 0) {
  console.error("Usage: npx tsx scripts/invite-resend.ts --batch-id <id> [--batch-id <id2>] [--unredeemed-only] [--dry-run]");
  process.exit(1);
}

async function main() {
  console.log(`\n=== INVITE RESEND${dryRun ? " (DRY RUN)" : ""} ===`);
  console.log(`  Batches: ${batchIds.join(", ")}`);
  console.log(`  Filter: ${unredeemedOnly ? "unredeemed only" : "all invites from batches"}\n`);

  // Fetch all invites created by these batch IDs
  const { data: invites, error } = await sb
    .from("instaclaw_invites")
    .select("code, email, is_active, times_used, expires_at, created_by")
    .in("created_by", batchIds)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to fetch invites:", error.message);
    process.exit(1);
  }

  if (!invites?.length) {
    console.log("  No invites found for those batch IDs.");
    return;
  }

  console.log(`  Found ${invites.length} total invites across batches\n`);

  // Split into redeemed vs unredeemed
  const redeemed = invites.filter((i) => i.times_used > 0);
  const unredeemed = invites.filter((i) => i.times_used === 0);

  console.log(`  Redeemed (will skip): ${redeemed.length}`);
  console.log(`  Unredeemed: ${unredeemed.length}\n`);

  const toResend = unredeemedOnly ? unredeemed : invites;

  if (toResend.length === 0) {
    console.log("  Nothing to resend!");
    return;
  }

  // Import email builders
  const { buildInviteEmailHtml, buildInviteEmailText, REPLY_TO, UNSUB_HEADERS } = await import("../lib/email");
  const resend = new Resend(process.env.RESEND_API_KEY!);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const inv of toResend) {
    // Skip redeemed if filtering
    if (unredeemedOnly && inv.times_used > 0) {
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY] ${inv.email} | ${inv.code} | batch: ${inv.created_by} | used: ${inv.times_used}`);
      sent++;
      continue;
    }

    try {
      await resend.emails.send({
        from: "InstaClaw <noreply@instaclaw.io>",
        replyTo: REPLY_TO,
        to: inv.email,
        subject: "You're in - here's your InstaClaw invite \u{1F4AB}",
        html: buildInviteEmailHtml(inv.code),
        text: buildInviteEmailText(inv.code),
        headers: UNSUB_HEADERS,
      });

      sent++;
      console.log(`  [${sent}/${toResend.length}] ${inv.email} — ${inv.code} — RESENT`);

      // 500ms delay for Resend rate limits
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      failed++;
      console.error(`  [!] ${inv.email} — FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  ${dryRun ? "Would resend" : "Resent"}: ${sent}`);
  console.log(`  Skipped (redeemed): ${redeemed.length}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total in batches: ${invites.length}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
