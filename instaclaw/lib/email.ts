import { Resend } from "resend";
import { getSupabase } from "./supabase";
import { logger } from "./logger";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY!);
  }
  return _resend;
}

const FROM = "InstaClaw <noreply@instaclaw.io>";
const REPLY_TO = "help@instaclaw.io";
const UNSUB_HEADERS = {
  "List-Unsubscribe": "<mailto:help@instaclaw.io?subject=Unsubscribe>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

/**
 * Sanitize NEXTAUTH_URL to prevent broken email links.
 * Strips stray whitespace, control chars, backslashes, trailing slashes,
 * and falls back to the production URL if the env var is missing/malformed.
 */
function getBaseUrl(): string {
  const FALLBACK = "https://instaclaw.io";
  const raw = process.env.NEXTAUTH_URL;
  if (!raw) return FALLBACK;
  // Strip quotes, whitespace, control characters, and backslashes
  const cleaned = raw
    .replace(/^["'\s]+|["'\s]+$/g, "")     // leading/trailing quotes & whitespace
    .replace(/[\x00-\x1f\x7f\\]/g, "")     // control chars + backslash
    .replace(/\/+$/, "");                    // trailing slashes
  // Validate it's a proper URL
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "https:" && url.protocol !== "http:") return FALLBACK;
    return url.origin;
  } catch {
    return FALLBACK;
  }
}

/**
 * Build the invite email HTML. Exported separately so test endpoints can
 * preview the template without actually sending.
 */
export function buildInviteEmailHtml(inviteCode: string, refCode?: string): string {
  const signupUrl = refCode
    ? `${getBaseUrl()}/signup?ref=${encodeURIComponent(refCode)}`
    : `${getBaseUrl()}/signup`;
  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
  const mono = `'Courier New', Courier, monospace`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Your InstaClaw Invite</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #111111 !important; }
  .email-card { background-color: #1a1a1a !important; }
  .code-box { background-color: #000000 !important; border-color: #333333 !important; }
  .text-primary { color: #ffffff !important; }
  .text-secondary { color: #cccccc !important; }
  .text-muted { color: #888888 !important; }
  .text-faint { color: #666666 !important; }
  .divider { border-color: #333333 !important; }
  .btn-td { background-color: #ffffff !important; }
  .btn-link { color: #000000 !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f2f2f2;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f2f2f2;">You just got superpowers. Your own AI agent, always on.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-body" style="background-color:#f2f2f2;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-card" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">

<!-- HEADER -->
<tr><td class="divider" style="padding:24px 32px 20px 32px;border-bottom:1px solid #e5e5e5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="text-primary" style="font-family:${font};font-size:20px;font-weight:700;color:#111111;letter-spacing:-0.3px;"><img src="https://instaclaw.io/logo.png" alt="" width="24" height="24" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;" />InstaClaw</td>
  <td align="right" class="text-muted" style="font-family:${font};font-size:12px;color:#888888;">Your invite is here</td></tr>
  </table>
</td></tr>

<!-- THE HOOK -->
<tr><td style="padding:32px 32px 0 32px;">
  <h1 class="text-primary" style="margin:0 0 14px 0;font-family:${font};font-size:26px;font-weight:700;color:#111111;line-height:1.2;">You just got superpowers.</h1>
  <p class="text-secondary" style="margin:0 0 10px 0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    We're giving you something that didn't exist a year ago &mdash; your own AI employee running on a dedicated server, working for you 24/7.
  </p>
  <p class="text-secondary" style="margin:0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    Not a chatbot. A full autonomous agent with a browser, web search, persistent memory, and a personality that learns you over time. It gets smarter every day.
  </p>
</td></tr>

<!-- INVITE CODE + BUTTON -->
<tr><td style="padding:24px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="code-box" style="background-color:#f7f7f7;border:2px solid #e0e0e0;border-radius:10px;">
  <tr><td style="padding:24px 24px;text-align:center;">
    <p class="text-muted" style="margin:0 0 8px 0;font-family:${font};font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:1.5px;">Your invite code</p>
    <p class="text-primary" style="margin:0 0 18px 0;font-family:${mono};font-size:28px;font-weight:700;color:#111111;letter-spacing:5px;">${inviteCode}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
    <tr><td class="btn-td" align="center" style="background-color:#111111;border-radius:8px;" bgcolor="#111111">
      <a href="${signupUrl}" target="_blank" class="btn-link" style="display:inline-block;padding:14px 36px;font-family:${font};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Deploy Your Agent &#8594;</a>
    </td></tr>
    </table>
    <p class="text-faint" style="margin:12px 0 0 0;font-family:${font};font-size:12px;color:#999999;">Expires in 7 days</p>
  </td></tr>
  </table>
</td></tr>

<!-- WHAT HAPPENS NEXT -->
<tr><td style="padding:0 32px 20px 32px;">
  <h2 class="text-primary" style="margin:0 0 12px 0;font-family:${font};font-size:17px;font-weight:700;color:#111111;">What happens next:</h2>
  <p class="text-secondary" style="margin:0 0 6px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span class="text-primary" style="color:#111111;font-weight:600;">Sign in with Google</span> &mdash; one click, no passwords</p>
  <p class="text-secondary" style="margin:0 0 6px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span class="text-primary" style="color:#111111;font-weight:600;">Name your agent and connect Telegram</span> &mdash; or use the dashboard, or both</p>
  <p class="text-secondary" style="margin:0 0 14px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span class="text-primary" style="color:#111111;font-weight:600;">Start talking</span> &mdash; your agent is live in 60 seconds</p>
  <p class="text-primary" style="margin:0;font-family:${font};font-size:14px;color:#111111;line-height:1.6;font-weight:600;">That's it. 3-day free trial. No credit card required.</p>
</td></tr>

<!-- DIVIDER -->
<tr><td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="divider" style="border-top:1px solid #e5e5e5;height:1px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<!-- WHAT YOUR AGENT CAN DO -->
<tr><td style="padding:20px 32px;">
  <h2 class="text-primary" style="margin:0 0 12px 0;font-family:${font};font-size:17px;font-weight:700;color:#111111;">What your agent can do from day one:</h2>
  <p class="text-secondary" style="margin:0 0 4px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;">Browse real websites and pull live data.</p>
  <p class="text-secondary" style="margin:0 0 4px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;">Write, edit, and analyze code.</p>
  <p class="text-secondary" style="margin:0 0 4px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;">Research any topic and deliver reports.</p>
  <p class="text-secondary" style="margin:0 0 4px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;">Monitor things while you sleep.</p>
  <p class="text-secondary" style="margin:0 0 4px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;">Remember every conversation and build on it.</p>
  <p class="text-secondary" style="margin:0 0 14px 0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;">Execute multi-step tasks autonomously.</p>
  <p class="text-primary" style="margin:0;font-family:${font};font-size:15px;color:#111111;line-height:1.6;font-weight:600;">This isn't a demo. It's your first hire that never clocks out.</p>
</td></tr>

<!-- BOTTOM CTA -->
<tr><td style="padding:8px 32px 28px 32px;text-align:center;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr><td class="btn-td" align="center" style="background-color:#111111;border-radius:8px;" bgcolor="#111111">
    <a href="${signupUrl}" target="_blank" class="btn-link" style="display:inline-block;padding:14px 36px;font-family:${font};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Deploy Your Agent &#8594;</a>
  </td></tr>
  </table>
</td></tr>

<!-- FOOTER -->
<tr><td class="divider" style="padding:16px 32px 20px 32px;border-top:1px solid #e5e5e5;">
  <p class="text-muted" style="margin:0 0 4px 0;font-family:${font};font-size:12px;color:#888888;">Questions? Reply to this email &mdash; we read every message.</p>
  <p class="text-faint" style="margin:0;font-family:${font};font-size:11px;color:#bbbbbb;"><a href="https://instaclaw.io" style="color:#999999;text-decoration:underline;">instaclaw.io</a> &nbsp;&middot;&nbsp; <a href="https://x.com/instaclaws" style="color:#999999;text-decoration:underline;">@instaclaws</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export function buildInviteEmailText(inviteCode: string, refCode?: string): string {
  const signupUrl = refCode
    ? `${getBaseUrl()}/signup?ref=${encodeURIComponent(refCode)}`
    : `${getBaseUrl()}/signup`;
  return `You just got superpowers.

We're giving you something that didn't exist a year ago — your own AI employee running on a dedicated server, working for you 24/7.

Not a chatbot. A full autonomous agent with a browser, web search, persistent memory, and a personality that learns you over time. It gets smarter every day.

YOUR INVITE CODE: ${inviteCode}

Deploy your agent: ${signupUrl}

Expires in 7 days.

WHAT HAPPENS NEXT:
- Sign in with Google — one click, no passwords
- Name your agent and connect Telegram — or use the dashboard, or both
- Start talking — your agent is live in 60 seconds

That's it. 3-day free trial. No credit card required.

WHAT YOUR AGENT CAN DO FROM DAY ONE:
- Browse real websites and pull live data
- Write, edit, and analyze code
- Research any topic and deliver reports
- Monitor things while you sleep
- Remember every conversation and build on it
- Execute multi-step tasks autonomously

This isn't a demo. It's your first hire that never clocks out.

Deploy your agent: ${signupUrl}

Questions? Reply to this email — we read every message.

— InstaClaw
instaclaw.io | @instaclaws`;
}

export async function sendInviteEmail(
  email: string,
  inviteCode: string,
  refCode?: string
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "You're in - here's your InstaClaw invite 💫",
    html: buildInviteEmailHtml(inviteCode, refCode),
    text: buildInviteEmailText(inviteCode, refCode),
    headers: UNSUB_HEADERS,
  });
}

export async function sendVMReadyEmail(
  email: string,
  controlPanelUrl: string
): Promise<void> {
  // Dedup guard: never send this email more than once per email per 24h.
  // Uses instaclaw_admin_alert_log with a unique key to prevent spam.
  const dedupKey = `vm_ready_email:${email}`;
  try {
    const supabase = getSupabase();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", dedupKey)
      .gte("sent_at", oneDayAgo)
      .limit(1);

    if (existing && existing.length > 0) {
      logger.warn("VM ready email suppressed (already sent in last 24h)", {
        route: "lib/email", email: email.slice(0, 3) + "***",
      });
      return;
    }

    // Record the send BEFORE sending to prevent races
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: dedupKey,
      vm_count: 1,
      details: `VM ready email sent to ${email}`,
    });
  } catch (dedupErr) {
    // If dedup check fails, still send the email (better to double-send than not send)
    logger.error("VM ready email dedup check failed", {
      route: "lib/email", error: String(dedupErr),
    });
  }

  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Your OpenClaw Instance is Ready!",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">You're Live!</h1>
        <p style="color: #888; line-height: 1.6;">
          Your OpenClaw instance has been deployed and is ready to use. Your Telegram bot is now active.
        </p>
        <a href="${controlPanelUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Open Dashboard
        </a>
      </div>
    `,
    text: `You're Live!\n\nYour OpenClaw instance has been deployed and is ready to use. Your Telegram bot is now active.\n\nOpen Dashboard: ${controlPanelUrl}\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}

export async function sendPendingEmail(email: string): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Your InstaClaw Setup is Pending",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Almost There</h1>
        <p style="color: #888; line-height: 1.6;">
          We're provisioning your dedicated VM. This usually takes a few minutes, but we're experiencing high demand. We'll email you as soon as your instance is ready.
        </p>
        <p style="margin-top: 16px; font-size: 12px; color: #888;">
          No action needed — we'll notify you when it's live.
        </p>
      </div>
    `,
    text: "Almost There\n\nWe're provisioning your dedicated VM. This usually takes a few minutes, but we're experiencing high demand. We'll email you as soon as your instance is ready.\n\nNo action needed — we'll notify you when it's live.\n\n— InstaClaw",
    headers: UNSUB_HEADERS,
  });
}

export async function sendPaymentFailedEmail(email: string): Promise<void> {
  const resend = getResend();
  const billingUrl = `${getBaseUrl()}/billing`;
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Payment Failed — Action Required",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Payment Failed</h1>
        <p style="color: #888; line-height: 1.6;">
          We were unable to process your latest payment. Please update your payment method to keep your OpenClaw instance running.
        </p>
        <a href="${billingUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Update Payment Method
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          If your payment is not resolved, your instance may be suspended.
        </p>
      </div>
    `,
    text: `Payment Failed\n\nWe were unable to process your latest payment. Please update your payment method to keep your OpenClaw instance running.\n\nUpdate Payment Method: ${billingUrl}\n\nIf your payment is not resolved, your instance may be suspended.\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}

export async function sendHealthAlertEmail(
  email: string,
  vmName: string
): Promise<void> {
  const resend = getResend();
  const dashboardUrl = `${getBaseUrl()}/dashboard`;
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Your OpenClaw Instance Needs Attention",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Health Alert</h1>
        <p style="color: #888; line-height: 1.6;">
          Your OpenClaw instance (${vmName}) has failed multiple health checks. We're attempting an automatic restart. If the issue persists, our team will investigate.
        </p>
        <a href="${dashboardUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Check Dashboard
        </a>
      </div>
    `,
    text: `Health Alert\n\nYour OpenClaw instance (${vmName}) has failed multiple health checks. We're attempting an automatic restart. If the issue persists, our team will investigate.\n\nCheck Dashboard: ${dashboardUrl}\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}

export async function sendTrialEndingEmail(
  email: string,
  daysLeft: number
): Promise<void> {
  const resend = getResend();
  const billingUrl = `${getBaseUrl()}/billing`;
  const plural = daysLeft !== 1 ? "s" : "";
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: `Your Free Trial Ends in ${daysLeft} Day${plural}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Trial Ending Soon</h1>
        <p style="color: #888; line-height: 1.6;">
          Your InstaClaw free trial ends in ${daysLeft} day${plural}. After that, your subscription will automatically convert to a paid plan. No action needed if you'd like to continue.
        </p>
        <p style="color: #888; line-height: 1.6; margin-top: 12px;">
          To cancel before the trial ends, visit your billing page.
        </p>
        <a href="${billingUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Manage Subscription
        </a>
      </div>
    `,
    text: `Trial Ending Soon\n\nYour InstaClaw free trial ends in ${daysLeft} day${plural}. After that, your subscription will automatically convert to a paid plan. No action needed if you'd like to continue.\n\nTo cancel before the trial ends, visit your billing page: ${billingUrl}\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}

export async function sendWelcomeEmail(
  email: string,
  name: string
): Promise<void> {
  const resend = getResend();
  const connectUrl = `${getBaseUrl()}/connect`;
  const displayName = name || "there";
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Welcome to InstaClaw!",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Welcome, ${displayName}!</h1>
        <p style="color: #888; line-height: 1.6;">
          Your InstaClaw account has been created. You're one step away from deploying your own personal AI agent.
        </p>
        <p style="color: #888; line-height: 1.6; margin-top: 12px;">
          Complete your setup to get a dedicated OpenClaw instance with Telegram, Discord, and more.
        </p>
        <a href="${connectUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Start Setup
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          All plans include a 3-day free trial. No charge until the trial ends.
        </p>
      </div>
    `,
    text: `Welcome, ${displayName}!\n\nYour InstaClaw account has been created. You're one step away from deploying your own personal AI agent.\n\nComplete your setup to get a dedicated OpenClaw instance with Telegram, Discord, and more.\n\nStart Setup: ${connectUrl}\n\nAll plans include a 3-day free trial. No charge until the trial ends.\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}

export async function sendAdminAlertEmail(
  subject: string,
  details: string
): Promise<void> {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL;
  if (!adminEmail) return;

  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: adminEmail,
    subject: `[InstaClaw Admin] ${subject}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Admin Alert</h1>
        <p style="color: #888; line-height: 1.6;">${subject}</p>
        <pre style="margin-top: 16px; padding: 16px; background: #0a0a0a; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #ccc; white-space: pre-wrap; font-size: 13px;">${details}</pre>
      </div>
    `,
    text: `Admin Alert: ${subject}\n\n${details}`,
  });
}

export async function sendCanceledEmail(email: string): Promise<void> {
  const resend = getResend();
  const billingUrl = `${getBaseUrl()}/billing`;
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Your InstaClaw Subscription Has Been Canceled",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Subscription Canceled</h1>
        <p style="color: #888; line-height: 1.6;">
          Your InstaClaw subscription has been canceled and your OpenClaw instance has been deactivated. If this was a mistake, you can re-subscribe at any time.
        </p>
        <a href="${billingUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Re-subscribe
        </a>
      </div>
    `,
    text: `Subscription Canceled\n\nYour InstaClaw subscription has been canceled and your OpenClaw instance has been deactivated. If this was a mistake, you can re-subscribe at any time.\n\nRe-subscribe: ${billingUrl}\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}

export async function sendWaitlistUpdateEmail(
  email: string
): Promise<{ from: string; replyTo: string; to: string; subject: string; html: string; text: string; headers: Record<string, string> }> {
  return {
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "InstaClaw — You're Almost In",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Your wait is almost over.</h1>
        <p style="color: #ccc; line-height: 1.6;">
          We've been heads-down building and scaling InstaClaw, and we're ready to open the doors. Starting this week, we're rolling out access to everyone on the waitlist — including you.
        </p>
        <p style="color: #ccc; line-height: 1.6; margin-top: 16px;">
          Here's what to expect:
        </p>
        <ul style="color: #ccc; line-height: 1.8; padding-left: 20px; margin-top: 8px;">
          <li>Invites going out in waves starting this week</li>
          <li>Everyone on the waitlist will have access by Friday</li>
          <li>Your own dedicated OpenClaw instance, ready in minutes</li>
          <li>We'll send you updates as new features land throughout the week</li>
        </ul>
        <p style="color: #ccc; line-height: 1.6; margin-top: 16px;">
          You signed up early, and that matters to us. When your invite arrives, you'll get a 3-day free trial to explore everything — no strings attached.
        </p>
        <p style="color: #ccc; line-height: 1.6; margin-top: 16px;">
          Keep an eye on your inbox. Your invite is coming soon.
        </p>
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.1);">
          <p style="color: #888; font-size: 13px; margin: 0;">
            — The InstaClaw Team
          </p>
        </div>
        <p style="margin-top: 24px; font-size: 11px; color: #555;">
          You're receiving this because you joined the InstaClaw waitlist. No action needed — we'll reach out when it's your turn.
        </p>
      </div>
    `,
    text: "Your wait is almost over.\n\nWe've been heads-down building and scaling InstaClaw, and we're ready to open the doors. Starting this week, we're rolling out access to everyone on the waitlist — including you.\n\nHere's what to expect:\n- Invites going out in waves starting this week\n- Everyone on the waitlist will have access by Friday\n- Your own dedicated OpenClaw instance, ready in minutes\n- We'll send you updates as new features land throughout the week\n\nYou signed up early, and that matters to us. When your invite arrives, you'll get a 3-day free trial to explore everything — no strings attached.\n\nKeep an eye on your inbox. Your invite is coming soon.\n\n— The InstaClaw Team\n\nYou're receiving this because you joined the InstaClaw waitlist.",
    headers: UNSUB_HEADERS,
  };
}

// ── Ambassador Emails ──

export function buildAmbassadorApprovedHtml(
  ambassadorName: string,
  referralCode: string,
  ambassadorNumber: number,
): string {
  const baseUrl = getBaseUrl();
  const referralLink = `${baseUrl}/signup?ref=${referralCode}`;
  const dashboardUrl = `${baseUrl}/ambassador`;
  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
  const mono = `'Courier New', Courier, monospace`;
  const displayName = ambassadorName || "there";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>You're an InstaClaw Ambassador</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #111111 !important; }
  .email-card { background-color: #1a1a1a !important; }
  .code-box { background-color: #000000 !important; border-color: #333333 !important; }
  .text-primary { color: #ffffff !important; }
  .text-secondary { color: #cccccc !important; }
  .text-muted { color: #888888 !important; }
  .text-faint { color: #666666 !important; }
  .divider { border-color: #333333 !important; }
  .btn-td { background-color: #ffffff !important; }
  .btn-link { color: #000000 !important; }
  .step-num { background-color: #333333 !important; color: #ffffff !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f2f2f2;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f2f2f2;">You're officially an InstaClaw Ambassador. Here's your referral link.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-body" style="background-color:#f2f2f2;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-card" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">

<!-- HEADER -->
<tr><td class="divider" style="padding:24px 32px 20px 32px;border-bottom:1px solid #e5e5e5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="text-primary" style="font-family:${font};font-size:20px;font-weight:700;color:#111111;letter-spacing:-0.3px;"><img src="https://instaclaw.io/logo.png" alt="" width="24" height="24" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;" />InstaClaw</td>
  <td align="right" class="text-muted" style="font-family:${font};font-size:12px;color:#888888;">Ambassador Program</td></tr>
  </table>
</td></tr>

<!-- THE HOOK -->
<tr><td style="padding:32px 32px 0 32px;">
  <h1 class="text-primary" style="margin:0 0 14px 0;font-family:${font};font-size:26px;font-weight:700;color:#111111;line-height:1.2;">Welcome aboard, ${displayName}.</h1>
  <p class="text-secondary" style="margin:0 0 10px 0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    You've been approved as <strong>InstaClaw Ambassador #${ambassadorNumber}</strong>. You're now part of a small group helping bring autonomous AI agents to the world.
  </p>
  <p class="text-secondary" style="margin:0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    Here's everything you need to start referring people today.
  </p>
</td></tr>

<!-- REFERRAL LINK BOX -->
<tr><td style="padding:24px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="code-box" style="background-color:#f7f7f7;border:2px solid #e0e0e0;border-radius:10px;">
  <tr><td style="padding:24px 24px;text-align:center;">
    <p class="text-muted" style="margin:0 0 8px 0;font-family:${font};font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:1.5px;">Your referral link</p>
    <p class="text-primary" style="margin:0 0 12px 0;font-family:${mono};font-size:16px;font-weight:700;color:#111111;word-break:break-all;">${referralLink}</p>
    <p class="text-muted" style="margin:0 0 18px 0;font-family:${font};font-size:12px;color:#888888;">Referral code: <strong>${referralCode}</strong></p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
    <tr><td class="btn-td" align="center" style="background-color:#111111;border-radius:8px;" bgcolor="#111111">
      <a href="${dashboardUrl}" target="_blank" class="btn-link" style="display:inline-block;padding:14px 36px;font-family:${font};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Open Ambassador Dashboard &#8594;</a>
    </td></tr>
    </table>
  </td></tr>
  </table>
</td></tr>

<!-- HOW IT WORKS -->
<tr><td style="padding:0 32px 20px 32px;">
  <h2 class="text-primary" style="margin:0 0 16px 0;font-family:${font};font-size:17px;font-weight:700;color:#111111;">How it works:</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="padding:0 0 14px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="top" style="width:28px;padding-top:1px;">
      <div class="step-num" style="width:28px;height:28px;background-color:#f0f0f0;border-radius:50%;text-align:center;font-family:${font};font-size:13px;font-weight:700;color:#111111;line-height:28px;mso-line-height-rule:exactly;">1</div>
    </td>
    <td valign="top" style="padding-left:12px;"><p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><strong class="text-primary" style="color:#111111;">Share your link.</strong> Send it to friends, post it on social media, drop it in group chats &mdash; anywhere.</p></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0 0 14px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="top" style="width:28px;padding-top:1px;">
      <div class="step-num" style="width:28px;height:28px;background-color:#f0f0f0;border-radius:50%;text-align:center;font-family:${font};font-size:13px;font-weight:700;color:#111111;line-height:28px;mso-line-height-rule:exactly;">2</div>
    </td>
    <td valign="top" style="padding-left:12px;"><p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><strong class="text-primary" style="color:#111111;">They get 25% off.</strong> Anyone who signs up with your link gets 25% off their first month.</p></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="top" style="width:28px;padding-top:1px;">
      <div class="step-num" style="width:28px;height:28px;background-color:#f0f0f0;border-radius:50%;text-align:center;font-family:${font};font-size:13px;font-weight:700;color:#111111;line-height:28px;mso-line-height-rule:exactly;">3</div>
    </td>
    <td valign="top" style="padding-left:12px;"><p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><strong class="text-primary" style="color:#111111;">You earn $10.</strong> For every signup that converts to a paid plan, you earn $10. No cap.</p></td>
    </tr></table>
  </td></tr>
  </table>
</td></tr>

<!-- DIVIDER -->
<tr><td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="divider" style="border-top:1px solid #e5e5e5;height:1px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<!-- TRACKING -->
<tr><td style="padding:20px 32px;">
  <p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.7;">
    Track your referrals and earnings anytime on your <a href="${dashboardUrl}" style="color:#111111;font-weight:600;text-decoration:underline;">Ambassador Dashboard</a>. You'll see every signup, every conversion, and your total earnings in real time.
  </p>
</td></tr>

<!-- BOTTOM CTA -->
<tr><td style="padding:8px 32px 28px 32px;text-align:center;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr><td class="btn-td" align="center" style="background-color:#111111;border-radius:8px;" bgcolor="#111111">
    <a href="${dashboardUrl}" target="_blank" class="btn-link" style="display:inline-block;padding:14px 36px;font-family:${font};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">View Your Dashboard &#8594;</a>
  </td></tr>
  </table>
</td></tr>

<!-- FOOTER -->
<tr><td class="divider" style="padding:16px 32px 20px 32px;border-top:1px solid #e5e5e5;">
  <p class="text-muted" style="margin:0 0 4px 0;font-family:${font};font-size:12px;color:#888888;">Questions? Reply to this email &mdash; we read every message.</p>
  <p class="text-faint" style="margin:0;font-family:${font};font-size:11px;color:#bbbbbb;"><a href="https://instaclaw.io" style="color:#999999;text-decoration:underline;">instaclaw.io</a> &nbsp;&middot;&nbsp; <a href="https://x.com/instaclaws" style="color:#999999;text-decoration:underline;">@instaclaws</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export function buildAmbassadorApprovedText(
  ambassadorName: string,
  referralCode: string,
  ambassadorNumber: number,
): string {
  const baseUrl = getBaseUrl();
  const referralLink = `${baseUrl}/signup?ref=${referralCode}`;
  const dashboardUrl = `${baseUrl}/ambassador`;
  const displayName = ambassadorName || "there";

  return `Welcome aboard, ${displayName}.

You've been approved as InstaClaw Ambassador #${ambassadorNumber}. You're now part of a small group helping bring autonomous AI agents to the world.

YOUR REFERRAL LINK: ${referralLink}

REFERRAL CODE: ${referralCode}

HOW IT WORKS:

1. Share your link — send it to friends, post it on social media, drop it in group chats.
2. They get 25% off — anyone who signs up with your link gets 25% off their first month.
3. You earn $10 — for every signup that converts to a paid plan, you earn $10. No cap.

Track your referrals and earnings anytime on your Ambassador Dashboard: ${dashboardUrl}

Questions? Reply to this email — we read every message.

— InstaClaw
instaclaw.io | @instaclaws`;
}

export async function sendAmbassadorApprovedEmail(
  email: string,
  ambassadorName: string,
  referralCode: string,
  ambassadorNumber: number,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: `You're in - welcome to the InstaClaw Ambassador Program`,
    html: buildAmbassadorApprovedHtml(ambassadorName, referralCode, ambassadorNumber),
    text: buildAmbassadorApprovedText(ambassadorName, referralCode, ambassadorNumber),
    headers: UNSUB_HEADERS,
  });
}

export async function sendAmbassadorRejectedEmail(
  email: string,
  ambassadorName: string,
): Promise<void> {
  const resend = getResend();
  const displayName = ambassadorName || "there";
  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Your InstaClaw Ambassador Application",
    html: `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<style>
:root { color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #111111 !important; }
  .email-card { background-color: #1a1a1a !important; }
  .text-primary { color: #ffffff !important; }
  .text-secondary { color: #cccccc !important; }
  .text-muted { color: #888888 !important; }
  .divider { border-color: #333333 !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f2f2f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-body" style="background-color:#f2f2f2;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-card" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">

<tr><td class="divider" style="padding:24px 32px 20px 32px;border-bottom:1px solid #e5e5e5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="text-primary" style="font-family:${font};font-size:20px;font-weight:700;color:#111111;letter-spacing:-0.3px;"><img src="https://instaclaw.io/logo.png" alt="" width="24" height="24" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;" />InstaClaw</td>
  <td align="right" class="text-muted" style="font-family:${font};font-size:12px;color:#888888;">Ambassador Program</td></tr>
  </table>
</td></tr>

<tr><td style="padding:32px 32px 24px 32px;">
  <h1 class="text-primary" style="margin:0 0 14px 0;font-family:${font};font-size:24px;font-weight:700;color:#111111;line-height:1.2;">Thanks for applying, ${displayName}.</h1>
  <p class="text-secondary" style="margin:0 0 14px 0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    We really appreciate your interest in the InstaClaw Ambassador Program. After reviewing applications, we're not able to bring on new ambassadors right now.
  </p>
  <p class="text-secondary" style="margin:0 0 14px 0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    This isn't a reflection of you &mdash; we're keeping the program small as we scale, and we'll be opening more spots soon. We'll keep your application on file and reach out if a spot opens up.
  </p>
  <p class="text-secondary" style="margin:0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    In the meantime, keep using InstaClaw and building cool things with your agent. That's what matters most.
  </p>
</td></tr>

<tr><td class="divider" style="padding:16px 32px 20px 32px;border-top:1px solid #e5e5e5;">
  <p class="text-muted" style="margin:0 0 4px 0;font-family:${font};font-size:12px;color:#888888;">Questions? Reply to this email &mdash; we read every message.</p>
  <p style="margin:0;font-family:${font};font-size:11px;color:#bbbbbb;"><a href="https://instaclaw.io" style="color:#999999;text-decoration:underline;">instaclaw.io</a> &nbsp;&middot;&nbsp; <a href="https://x.com/instaclaws" style="color:#999999;text-decoration:underline;">@instaclaws</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`,
    text: `Thanks for applying, ${displayName}.

We really appreciate your interest in the InstaClaw Ambassador Program. After reviewing applications, we're not able to bring on new ambassadors right now.

This isn't a reflection of you — we're keeping the program small as we scale, and we'll be opening more spots soon. We'll keep your application on file and reach out if a spot opens up.

In the meantime, keep using InstaClaw and building cool things with your agent. That's what matters most.

Questions? Reply to this email — we read every message.

— InstaClaw
instaclaw.io | @instaclaws`,
    headers: UNSUB_HEADERS,
  });
}

export function buildWaitlistOverHtml(): string {
  const signupUrl = `${getBaseUrl()}/signup`;
  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>The Waitlist Is Over</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .email-body { background-color: #111111 !important; }
  .email-card { background-color: #1a1a1a !important; }
  .text-primary { color: #ffffff !important; }
  .text-secondary { color: #cccccc !important; }
  .text-muted { color: #888888 !important; }
  .text-faint { color: #666666 !important; }
  .divider { border-color: #333333 !important; }
  .btn-td { background-color: #DC6743 !important; }
  .btn-link { color: #ffffff !important; }
  .feature-box { background-color: #0a0a0a !important; border-color: #333333 !important; }
  .logo-img { filter: invert(1) !important; }
}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#f2f2f2;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f2f2f2;">No more waitlist. No invite code. Your personal AI agent is ready.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-body" style="background-color:#f2f2f2;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-card" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">

<!-- HEADER -->
<tr><td class="divider" style="padding:24px 32px 20px 32px;border-bottom:1px solid #e5e5e5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="text-primary" style="font-family:${font};font-size:20px;font-weight:700;color:#111111;letter-spacing:-0.3px;"><img src="https://instaclaw.io/logo.png" alt="" width="24" height="24" class="logo-img" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;" />InstaClaw</td>
  <td align="right" class="text-muted" style="font-family:${font};font-size:12px;color:#888888;">March 2026</td></tr>
  </table>
</td></tr>

<!-- THE HOOK -->
<tr><td style="padding:32px 32px 0 32px;">
  <h1 class="text-primary" style="margin:0 0 16px 0;font-family:${font};font-size:28px;font-weight:700;color:#111111;line-height:1.2;">The waitlist is over.</h1>
  <p class="text-secondary" style="margin:0 0 14px 0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    You signed up early. We remember that.
  </p>
  <p class="text-secondary" style="margin:0 0 14px 0;font-family:${font};font-size:15px;color:#555555;line-height:1.7;">
    InstaClaw is now open &mdash; <strong class="text-primary" style="color:#111111;">no invite code, no waitlist, no hoops.</strong> Sign up and your personal AI agent is live in under a minute. Your own dedicated server. Always on. Learning you every day.
  </p>
</td></tr>

<!-- CTA BUTTON -->
<tr><td style="padding:24px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr><td class="btn-td" align="center" style="background-color:#DC6743;border-radius:8px;" bgcolor="#DC6743">
    <a href="${signupUrl}" target="_blank" class="btn-link" style="display:inline-block;padding:16px 48px;font-family:${font};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Claim Your Agent &rarr;</a>
  </td></tr>
  </table>
  <p class="text-muted" style="margin:12px 0 0 0;font-family:${font};font-size:12px;color:#999999;text-align:center;">3-day free trial. No credit card required.</p>
</td></tr>

<!-- WHAT'S CHANGED -->
<tr><td style="padding:0 32px 20px 32px;">
  <h2 class="text-primary" style="margin:0 0 14px 0;font-family:${font};font-size:17px;font-weight:700;color:#111111;">What you get:</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:0 0 8px 0;">
      <p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span style="color:#DC6743;font-weight:600;margin-right:6px;">&#9632;</span> <strong class="text-primary" style="color:#111111;">A server that's only yours</strong> &mdash; not shared, not throttled, fully dedicated</p>
    </td></tr>
    <tr><td style="padding:0 0 8px 0;">
      <p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span style="color:#DC6743;font-weight:600;margin-right:6px;">&#9632;</span> <strong class="text-primary" style="color:#111111;">Browses the real web</strong> &mdash; visits sites, fills forms, pulls live data</p>
    </td></tr>
    <tr><td style="padding:0 0 8px 0;">
      <p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span style="color:#DC6743;font-weight:600;margin-right:6px;">&#9632;</span> <strong class="text-primary" style="color:#111111;">Remembers everything</strong> &mdash; every conversation builds on the last</p>
    </td></tr>
    <tr><td style="padding:0 0 8px 0;">
      <p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span style="color:#DC6743;font-weight:600;margin-right:6px;">&#9632;</span> <strong class="text-primary" style="color:#111111;">Meets you where you are</strong> &mdash; Telegram, Discord, or web dashboard</p>
    </td></tr>
    <tr><td style="padding:0 0 8px 0;">
      <p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.6;"><span style="color:#DC6743;font-weight:600;margin-right:6px;">&#9632;</span> <strong class="text-primary" style="color:#111111;">Never clocks out</strong> &mdash; research, monitoring, writing, coding &mdash; 24/7</p>
    </td></tr>
  </table>
</td></tr>

<!-- DIVIDER -->
<tr><td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="divider" style="border-top:1px solid #e5e5e5;height:1px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<!-- SOCIAL PROOF / SCARCITY -->
<tr><td style="padding:20px 32px;">
  <p class="text-secondary" style="margin:0;font-family:${font};font-size:14px;color:#555555;line-height:1.7;">
    We're running on dedicated cloud servers, so spots are limited. Once they're full, signups close again. You were early to the waitlist &mdash; don't miss the window.
  </p>
</td></tr>

<!-- BOTTOM CTA -->
<tr><td style="padding:8px 32px 28px 32px;text-align:center;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr><td class="btn-td" align="center" style="background-color:#DC6743;border-radius:8px;" bgcolor="#DC6743">
    <a href="${signupUrl}" target="_blank" class="btn-link" style="display:inline-block;padding:16px 48px;font-family:${font};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Get Started Free &rarr;</a>
  </td></tr>
  </table>
</td></tr>

<!-- FOOTER -->
<tr><td class="divider" style="padding:16px 32px 20px 32px;border-top:1px solid #e5e5e5;">
  <p class="text-muted" style="margin:0 0 4px 0;font-family:${font};font-size:12px;color:#888888;">Questions? Reply to this email &mdash; a human reads every one.</p>
  <p class="text-faint" style="margin:0;font-family:${font};font-size:11px;color:#bbbbbb;"><a href="https://instaclaw.io" style="color:#999999;text-decoration:underline;">instaclaw.io</a> &nbsp;&middot;&nbsp; <a href="https://x.com/instaclaws" style="color:#999999;text-decoration:underline;">@instaclaws</a> &nbsp;&middot;&nbsp; <a href="https://discord.gg/instaclaw" style="color:#999999;text-decoration:underline;">Discord</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export function buildWaitlistOverText(): string {
  const signupUrl = `${getBaseUrl()}/signup`;
  return `THE WAITLIST IS OVER.

You signed up early. We remember that.

InstaClaw is now open — no invite code, no waitlist, no hoops. Sign up and your personal AI agent is live in under a minute. Your own dedicated server. Always on. Learning you every day.

CLAIM YOUR AGENT: ${signupUrl}

3-day free trial. No credit card required.

WHAT YOU GET:
- A server that's only yours — not shared, not throttled, fully dedicated
- Browses the real web — visits sites, fills forms, pulls live data
- Remembers everything — every conversation builds on the last
- Meets you where you are — Telegram, Discord, or web dashboard
- Never clocks out — research, monitoring, writing, coding — 24/7

We're running on dedicated cloud servers, so spots are limited. Once they're full, signups close again. You were early to the waitlist — don't miss the window.

GET STARTED FREE: ${signupUrl}

Questions? Reply to this email — a human reads every one.

— InstaClaw
instaclaw.io | @instaclaws | discord.gg/instaclaw`;
}

export { getResend, FROM, REPLY_TO, UNSUB_HEADERS };

export async function sendAutoMigratedEmail(email: string): Promise<void> {
  const resend = getResend();
  const dashboardUrl = `${getBaseUrl()}/dashboard`;
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Your Agent Has Been Automatically Restored",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Agent Restored</h1>
        <p style="color: #888; line-height: 1.6;">
          Your agent experienced a brief infrastructure interruption and has been automatically moved to a new server. It's back online and ready to go.
        </p>
        <p style="color: #888; line-height: 1.6; margin-top: 12px;">
          Your agent's memory and personality have been preserved. If anything seems off, you can use the Repair button on your dashboard.
        </p>
        <a href="${dashboardUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Check Dashboard
        </a>
      </div>
    `,
    text: `Agent Restored\n\nYour agent experienced a brief infrastructure interruption and has been automatically moved to a new server. It's back online and ready to go.\n\nYour agent's memory and personality have been preserved. If anything seems off, you can use the Repair button on your dashboard.\n\nCheck Dashboard: ${dashboardUrl}\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}

export async function sendSuspendedEmail(email: string): Promise<void> {
  const resend = getResend();
  const billingUrl = `${getBaseUrl()}/billing`;
  await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to: email,
    subject: "Your InstaClaw Instance Has Been Suspended",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Service Suspended</h1>
        <p style="color: #888; line-height: 1.6;">
          Your OpenClaw instance has been suspended due to failed payment. Your data is safe, but the bot is no longer responding to messages.
        </p>
        <p style="color: #888; line-height: 1.6; margin-top: 12px;">
          Update your payment method to restore service immediately.
        </p>
        <a href="${billingUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Update Payment Method
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          Your instance will be automatically restored once payment is successful.
        </p>
      </div>
    `,
    text: `Service Suspended\n\nYour OpenClaw instance has been suspended due to failed payment. Your data is safe, but the bot is no longer responding to messages.\n\nUpdate your payment method to restore service immediately: ${billingUrl}\n\nYour instance will be automatically restored once payment is successful.\n\n— InstaClaw`,
    headers: UNSUB_HEADERS,
  });
}
