/**
 * send-vip-invite.ts — Send a single VIP invite to a specific email.
 * Creates invite code, stores in DB, sends email, logs to batch-log.json.
 *
 * Usage:
 *   npx tsx scripts/send-vip-invite.ts mondofresca@aol.com
 *   npx tsx scripts/send-vip-invite.ts mondofresca@aol.com --dry-run
 */
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

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

const email = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!email || email.startsWith("--")) {
  console.error("Usage: npx tsx scripts/send-vip-invite.ts <email> [--dry-run]");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const seg = () =>
    Array.from({ length: 4 }, () =>
      CHARSET[Math.floor(Math.random() * CHARSET.length)]
    ).join("");
  return `${seg()}-${seg()}-${seg()}`;
}

async function main() {
  console.log(`\n=== VIP INVITE: ${email} ===\n`);

  // 1. Check for existing active invite
  const { data: existing } = await sb
    .from("instaclaw_invites")
    .select("code, is_active, times_used, expires_at")
    .eq("email", email)
    .eq("is_active", true)
    .gt("expires_at", new Date().toISOString())
    .limit(1);

  if (existing?.length) {
    console.log(
      `WARNING: User already has an active invite code: ${existing[0].code}`
    );
    console.log(`  Used: ${existing[0].times_used}, Expires: ${existing[0].expires_at}`);
    console.log("  Skipping — no duplicate invite created.");
    return;
  }

  // 2. Check if already a user
  const { data: existingUser } = await sb
    .from("instaclaw_users")
    .select("id, email")
    .eq("email", email)
    .limit(1);

  if (existingUser?.length) {
    console.log(`WARNING: ${email} is already a registered user (id: ${existingUser[0].id}).`);
    console.log("  Skipping — no invite needed.");
    return;
  }

  // 3. Generate invite code
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log(`  Invite code: ${code}`);
  console.log(`  Expires: ${expiresAt}`);

  if (dryRun) {
    console.log("\n  DRY RUN — no invite created or email sent.");
    return;
  }

  // 4. Store in DB
  const { error: insertErr } = await sb.from("instaclaw_invites").insert({
    code,
    email,
    max_uses: 1,
    times_used: 0,
    is_active: true,
    expires_at: expiresAt,
    created_by: "vip-manual",
  });

  if (insertErr) {
    console.error("Failed to create invite:", insertErr.message);
    process.exit(1);
  }
  console.log("  Invite stored in DB");

  // 5. Send email
  const { buildInviteEmailHtml, buildInviteEmailText, REPLY_TO, UNSUB_HEADERS } = await import("../lib/email");
  const resend = new Resend(process.env.RESEND_API_KEY!);

  const { error: emailErr } = await resend.emails.send({
    from: "InstaClaw <noreply@instaclaw.io>",
    replyTo: REPLY_TO,
    to: email,
    subject: "You're in - here's your InstaClaw invite \u{1F4AB}",
    html: buildInviteEmailHtml(code),
    text: buildInviteEmailText(code),
    headers: UNSUB_HEADERS,
  });

  if (emailErr) {
    console.error("Failed to send email:", emailErr);
    process.exit(1);
  }
  console.log("  Email sent via Resend");

  // 6. Update waitlist if they're on it
  const { data: waitlistEntry } = await sb
    .from("instaclaw_waitlist")
    .select("id")
    .eq("email", email)
    .limit(1);

  if (waitlistEntry?.length) {
    await sb
      .from("instaclaw_waitlist")
      .update({
        invite_sent_at: new Date().toISOString(),
        invite_code: code,
      })
      .eq("id", waitlistEntry[0].id);
    console.log("  Waitlist entry updated");
  }

  // 7. Log to batch-log.json
  const batchLogPath = resolve(".", "scripts/batch-log.json");
  try {
    const log = JSON.parse(readFileSync(batchLogPath, "utf-8"));
    log.batches.push({
      id: `vip-${Date.now()}`,
      date: new Date().toISOString().split("T")[0],
      type: "vip-invite",
      count: 1,
      recipients: [email],
      note: `Individual VIP invite sent manually.`,
      nudge_sent: null,
      nudge_count: 0,
    });
    writeFileSync(batchLogPath, JSON.stringify(log, null, 2) + "\n");
    console.log("  Logged to batch-log.json");
  } catch {
    console.log("  (batch-log.json not updated — file not found)");
  }

  console.log(`\n  DONE — invite sent to ${email}`);
  console.log(`  Code: ${code}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
