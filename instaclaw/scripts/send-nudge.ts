/**
 * send-nudge.ts — Send follow-up nudge to users with unredeemed invite codes
 *
 * Usage:
 *   npx tsx scripts/send-nudge.ts
 *   npx tsx scripts/send-nudge.ts --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { readFileSync } from "fs";
import { resolve } from "path";

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

const dryRun = process.argv.includes("--dry-run");

const REPLY_TO = "support@instaclaw.io";
const UNSUB_HEADERS = {
  "List-Unsubscribe": "<mailto:support@instaclaw.io?subject=Unsubscribe>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

function buildNudgeText(inviteCode: string, expiresAt: string): string {
  const signupUrl = `${process.env.NEXTAUTH_URL}/signup`;
  const expiresDate = new Date(expiresAt);
  const daysLeft = Math.max(0, Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  return `Your agent is still waiting.

We sent you an invite to InstaClaw - your own AI agent on a dedicated server, working for you 24/7. You haven't activated it yet.

Setup takes under 60 seconds. Your agent can research, automate tasks, browse the web, earn on marketplaces, and do literally anything you ask - all while you sleep.

Your invite expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. Don't miss it.

YOUR INVITE CODE: ${inviteCode}

Activate your agent: ${signupUrl}

All you need: Telegram + a Google account + under 60 seconds.

Questions? Reply to this email — we read everything.

— InstaClaw
instaclaw.io | @instaclaws`;
}

function buildNudgeHtml(inviteCode: string, expiresAt: string): string {
  const signupUrl = `${process.env.NEXTAUTH_URL}/signup`;
  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
  const mono = `'Courier New', Courier, monospace`;

  const expiresDate = new Date(expiresAt);
  const daysLeft = Math.max(0, Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your InstaClaw invite is waiting</title>
</head>
<body style="margin:0;padding:0;background-color:#111111;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#111111;">Your agent is still waiting. Your invite expires in ${daysLeft} days.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111111;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#0a0a0a;border-radius:12px;overflow:hidden;">

<!-- HEADER -->
<tr><td style="padding:24px 40px 20px 40px;border-bottom:1px solid #222;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="font-family:${font};font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;"><img src="https://instaclaw.io/logo.png" alt="" width="24" height="24" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;" />InstaClaw</td>
  <td align="right" style="font-family:${font};font-size:12px;color:#666;">Friendly reminder</td></tr>
  </table>
</td></tr>

<!-- BODY -->
<tr><td style="padding:40px 40px 0 40px;">
  <h1 style="margin:0 0 16px 0;font-family:${font};font-size:26px;font-weight:700;color:#ffffff;line-height:1.2;">Your agent is still waiting.</h1>
  <p style="margin:0 0 12px 0;font-family:${font};font-size:16px;color:#cccccc;line-height:1.7;">
    We sent you an invite to InstaClaw - your own AI agent on a dedicated server, working for you 24/7. You haven't activated it yet.
  </p>
  <p style="margin:0 0 12px 0;font-family:${font};font-size:16px;color:#cccccc;line-height:1.7;">
    Setup takes under 60 seconds. Your agent can research, automate tasks, browse the web, earn on marketplaces, and do literally anything you ask - all while you sleep.
  </p>
  <p style="margin:0;font-family:${font};font-size:16px;color:#ffffff;line-height:1.7;font-weight:600;">
    Your invite expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. Don't miss it.
  </p>
</td></tr>

<!-- INVITE CODE BOX -->
<tr><td style="padding:32px 40px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#161616;border:1px solid #333;border-radius:10px;">
  <tr><td style="padding:28px 24px;text-align:center;">
    <p style="margin:0 0 12px 0;font-family:${font};font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1.5px;">Your invite code</p>
    <p style="margin:0 0 24px 0;font-family:${mono};font-size:32px;font-weight:700;color:#ffffff;letter-spacing:6px;">${inviteCode}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr><td style="background-color:#ffffff;border-radius:8px;">
      <a href="${signupUrl}" target="_blank" style="display:inline-block;padding:14px 40px;font-family:${font};font-size:16px;font-weight:700;color:#000000;text-decoration:none;">Activate Your Agent &rarr;</a>
    </td></tr>
    </table>
    <p style="margin:16px 0 0 0;font-family:${font};font-size:12px;color:#666;">Expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""} &middot; <a href="${signupUrl}" style="color:#888;text-decoration:underline;">${signupUrl.replace("https://", "")}</a></p>
  </td></tr>
  </table>
</td></tr>

<!-- QUICK REMINDER -->
<tr><td style="padding:0 40px 32px 40px;">
  <p style="margin:0 0 8px 0;font-family:${font};font-size:14px;color:#999;line-height:1.6;">All you need: <span style="color:#ffffff;">Telegram</span> + <span style="color:#ffffff;">a Google account</span> + <span style="color:#ffffff;">under 60 seconds</span>.</p>
  <p style="margin:0;font-family:${font};font-size:14px;color:#999;line-height:1.6;">Questions? Just reply to this email - we read everything.</p>
</td></tr>

<!-- FOOTER -->
<tr><td style="padding:24px 40px 32px 40px;border-top:1px solid #222;">
  <p style="margin:0 0 8px 0;font-family:${font};font-size:14px;color:#888;">InstaClaw - Your AI, Your Superpower</p>
  <p style="margin:0 0 16px 0;font-family:${font};font-size:13px;color:#666;">
    <a href="https://instaclaw.io" style="color:#666;text-decoration:underline;">instaclaw.io</a> &nbsp;&middot;&nbsp; <a href="https://x.com/instaclaws" style="color:#666;text-decoration:underline;">@instaclaws</a>
  </p>
  <p style="margin:0;font-family:${font};font-size:11px;color:#444;line-height:1.5;">You're receiving this because you were invited to InstaClaw and haven't activated yet.</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function main() {
  console.log(dryRun ? "=== DRY RUN — no emails will be sent ===\n" : "=== Sending nudge emails ===\n");

  // Get all active, unused, non-expired invites
  const { data: unused } = await supabase
    .from("instaclaw_invites")
    .select("code, email, created_at, expires_at")
    .eq("is_active", true)
    .eq("times_used", 0)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true });

  if (!unused?.length) {
    console.log("No unredeemed invites found!");
    return;
  }

  console.log(`Found ${unused.length} unredeemed invites\n`);

  let sent = 0;
  let failed = 0;

  for (const inv of unused) {
    if (dryRun) {
      const daysLeft = Math.max(0, Math.ceil((new Date(inv.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
      console.log(`[DRY] ${inv.email} | ${inv.code} | expires in ${daysLeft}d`);
      sent++;
      continue;
    }

    try {
      const html = buildNudgeHtml(inv.code, inv.expires_at);
      await resend.emails.send({
        from: "InstaClaw <noreply@instaclaw.io>",
        replyTo: REPLY_TO,
        to: inv.email,
        subject: "Your AI agent is still waiting - activate before your invite expires",
        html,
        text: buildNudgeText(inv.code, inv.expires_at),
        headers: UNSUB_HEADERS,
      });

      sent++;
      console.log(`[${sent}/${unused.length}] ${inv.email} — nudge sent`);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      failed++;
      console.log(`[!] ${inv.email} — FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone! ${dryRun ? "Would send" : "Sent"}: ${sent} | Failed: ${failed}`);
}

main().catch(console.error);
