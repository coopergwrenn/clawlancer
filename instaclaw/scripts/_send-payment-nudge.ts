import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { readFileSync } from "fs";
import { resolve } from "path";

const envContent = readFileSync(resolve(".", ".env.local"), "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const resend = new Resend(process.env.RESEND_API_KEY!);

function getFirstName(fullName: string): string {
  const name = fullName.trim().split(/\s+/)[0];
  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function tierLabel(tier: string): string {
  switch (tier) {
    case "pro": return "Pro";
    case "starter": return "Starter";
    case "power": return "Power";
    default: return tier.charAt(0).toUpperCase() + tier.slice(1);
  }
}

function buildHtml(firstName: string, tier: string): string {
  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<style>
:root { color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #111 !important; }
  .email-card { background-color: #1a1a1a !important; }
  .text-primary { color: #fff !important; }
  .text-secondary { color: #ccc !important; }
  .text-muted { color: #888 !important; }
  .divider { border-color: #333 !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f2f2f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-body" style="background-color:#f2f2f2;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="email-card" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">

<tr><td class="divider" style="padding:24px 32px 20px 32px;border-bottom:1px solid #e5e5e5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="text-primary" style="font-family:${font};font-size:20px;font-weight:700;color:#111;letter-spacing:-0.3px;"><img src="https://instaclaw.io/logo.png" alt="" width="24" height="24" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;" />InstaClaw</td></tr>
  </table>
</td></tr>

<tr><td style="padding:28px 32px;">
  <p class="text-primary" style="margin:0 0 18px 0;font-family:${font};font-size:15px;color:#111;line-height:1.7;">Hi ${firstName},</p>
  <p class="text-secondary" style="margin:0 0 14px 0;font-family:${font};font-size:15px;color:#555;line-height:1.7;">
    We weren't able to process your most recent payment for your InstaClaw ${tier} plan. Your agent is still running, but your subscription will be paused if payment isn't updated soon.
  </p>
  <p class="text-secondary" style="margin:0 0 6px 0;font-family:${font};font-size:15px;color:#555;line-height:1.7;font-weight:600;">To update your payment method:</p>
  <ol style="margin:0 0 14px 0;padding-left:20px;font-family:${font};font-size:15px;color:#555;line-height:1.9;">
    <li>Go to <a href="https://instaclaw.io/billing" style="color:#111;text-decoration:underline;">instaclaw.io/billing</a></li>
    <li>Click <strong>Manage Subscription</strong></li>
    <li>Update your card on file</li>
  </ol>
  <p class="text-secondary" style="margin:0 0 18px 0;font-family:${font};font-size:15px;color:#555;line-height:1.7;">It only takes a moment.</p>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr><td align="center" style="background-color:#111;border-radius:8px;" bgcolor="#111111">
    <a href="https://instaclaw.io/billing" target="_blank" style="display:inline-block;padding:14px 36px;font-family:${font};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Update Payment Method</a>
  </td></tr>
  </table>

  <p class="text-muted" style="margin:24px 0 0 0;font-family:${font};font-size:14px;color:#888;line-height:1.7;">
    If you have any questions, just reply to this email.
  </p>
</td></tr>

<tr><td class="divider" style="padding:16px 32px 20px 32px;border-top:1px solid #e5e5e5;">
  <p class="text-muted" style="margin:0;font-family:${font};font-size:12px;color:#888;">&mdash; The InstaClaw Team</p>
  <p style="margin:6px 0 0 0;font-family:${font};font-size:11px;color:#bbb;"><a href="https://instaclaw.io" style="color:#999;text-decoration:underline;">instaclaw.io</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildText(firstName: string, tier: string): string {
  return `Hi ${firstName},

We weren't able to process your most recent payment for your InstaClaw ${tier} plan. Your agent is still running, but your subscription will be paused if payment isn't updated soon.

To update your payment method:

1. Go to https://instaclaw.io/billing
2. Click Manage Subscription
3. Update your card on file

It only takes a moment.

If you have any questions, just reply to this email.

— The InstaClaw Team
instaclaw.io`;
}

async function main() {
  // Find all past_due subscriptions
  const { data: failedSubs } = await sb
    .from("instaclaw_subscriptions")
    .select("user_id, tier, payment_status")
    .or("payment_status.eq.failed,payment_status.eq.past_due,status.eq.past_due");

  if (!failedSubs?.length) {
    console.log("No failed payments found.");
    return;
  }

  console.log(`Found ${failedSubs.length} users with failed/past_due payments.\n`);

  let sent = 0;
  for (const sub of failedSubs) {
    const { data: user } = await sb
      .from("instaclaw_users")
      .select("email, name")
      .eq("id", sub.user_id)
      .single();

    if (!user?.email) {
      console.log(`[SKIP] No email for user ${sub.user_id}`);
      continue;
    }

    const firstName = getFirstName(user.name || "there");
    const tier = tierLabel(sub.tier);

    console.log(`Sending to ${user.email} (${firstName}, ${tier})...`);

    const { error } = await resend.emails.send({
      from: "InstaClaw <noreply@instaclaw.io>",
      replyTo: "help@instaclaw.io",
      to: user.email,
      subject: "Action needed: Update your payment method",
      html: buildHtml(firstName, tier),
      text: buildText(firstName, tier),
      headers: {
        "List-Unsubscribe": "<mailto:help@instaclaw.io?subject=Unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (error) {
      console.log(`  FAILED: ${JSON.stringify(error)}`);
    } else {
      console.log(`  Sent!`);
      sent++;
    }

    // Small delay between sends
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone! Sent ${sent}/${failedSubs.length} emails.`);
}

main().catch(console.error);
