import { Resend } from "resend";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY!);
  }
  return _resend;
}

const FROM = "InstaClaw <noreply@instaclaw.io>";

/**
 * Build the invite email HTML. Exported separately so test endpoints can
 * preview the template without actually sending.
 */
export function buildInviteEmailHtml(inviteCode: string): string {
  const signupUrl = `${process.env.NEXTAUTH_URL}/signup`;
  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
  const mono = `'Courier New', Courier, monospace`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your InstaClaw Invite</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#111111;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#111111;">Your own AI agent on a dedicated server, working 24/7. This changes everything.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111111;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#0a0a0a;border-radius:12px;overflow:hidden;">

<!-- HEADER -->
<tr><td style="padding:24px 40px 20px 40px;border-bottom:1px solid #222;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="font-family:${font};font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;"><img src="https://instaclaw.io/logo.png" alt="" width="24" height="24" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;" />InstaClaw</td>
  <td align="right" style="font-family:${font};font-size:12px;color:#666;">Your invite is here</td></tr>
  </table>
</td></tr>

<!-- SECTION 1: THE HOOK -->
<tr><td style="padding:40px 40px 0 40px;">
  <h1 style="margin:0 0 16px 0;font-family:${font};font-size:28px;font-weight:700;color:#ffffff;line-height:1.2;">You're in.</h1>
  <p style="margin:0 0 12px 0;font-family:${font};font-size:16px;color:#cccccc;line-height:1.7;">
    You're about to get your own AI agent running on a dedicated server, working for you 24/7. Not a chatbot. An autonomous agent that searches the web, browses real websites, and handles tasks while you sleep.
  </p>
  <p style="margin:0 0 12px 0;font-family:${font};font-size:16px;color:#cccccc;line-height:1.7;">
    People are already using their agents to find clients, automate outreach, research deals, and build new revenue streams on autopilot. This is a real economic actor that can earn for you. Agents are already earning for their humans on agentic marketplaces, trading on Polymarket, and finding creative ways to generate income that nobody even thought of yet.
  </p>
  <p style="margin:0;font-family:${font};font-size:16px;color:#ffffff;line-height:1.7;font-weight:600;">
    This isn't ChatGPT. This is your own personal AI with superpowers.
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
    <p style="margin:16px 0 0 0;font-family:${font};font-size:12px;color:#666;">Expires in 7 days &middot; <a href="${signupUrl}" style="color:#888;text-decoration:underline;">${signupUrl.replace("https://", "")}</a></p>
  </td></tr>
  </table>
</td></tr>

<!-- SECTION 2: WHAT YOU NEED -->
<tr><td style="padding:0 40px 32px 40px;">
  <h2 style="margin:0 0 16px 0;font-family:${font};font-size:18px;font-weight:700;color:#ffffff;">Here's all you need to unlock it:</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="padding:8px 0;font-family:${font};font-size:15px;color:#cccccc;line-height:1.6;">
    <span style="color:#ffffff;font-weight:600;">Telegram</span> &mdash; this is how you talk to your agent. Grab it free at <a href="https://telegram.org" style="color:#888;text-decoration:underline;">telegram.org</a> if you don't have it yet.
  </td></tr>
  <tr><td style="padding:8px 0;font-family:${font};font-size:15px;color:#cccccc;line-height:1.6;">
    <span style="color:#ffffff;font-weight:600;">5 minutes</span> &mdash; seriously, that's it. We walk you through every single step.
  </td></tr>
  <tr><td style="padding:8px 0;font-family:${font};font-size:15px;color:#cccccc;line-height:1.6;">
    <span style="color:#ffffff;font-weight:600;">A Google account</span> &mdash; one-click sign in. No new passwords to remember.
  </td></tr>
  </table>
  <p style="margin:16px 0 0 0;font-family:${font};font-size:14px;color:#ffffff;line-height:1.6;font-weight:600;">No credit card. No catch. Just your own AI agent, ready to deploy.</p>
</td></tr>

<!-- DIVIDER -->
<tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #222;height:1px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<!-- SECTION 3: HOW SETUP WORKS -->
<tr><td style="padding:32px 40px;">
  <h2 style="margin:0 0 20px 0;font-family:${font};font-size:18px;font-weight:700;color:#ffffff;">You'll be up and running in 5 minutes</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="padding:10px 0;vertical-align:top;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="width:28px;vertical-align:top;"><span style="display:inline-block;width:24px;height:24px;background-color:#222;border-radius:50%;text-align:center;line-height:24px;font-family:${font};font-size:12px;font-weight:700;color:#888;">1</span></td>
    <td style="padding-left:12px;font-family:${font};font-size:15px;color:#cccccc;line-height:1.6;"><span style="color:#ffffff;font-weight:600;">Enter your invite code</span><br>Head to <a href="${signupUrl}" style="color:#888;text-decoration:underline;">instaclaw.io/signup</a> and paste the code above. This is your golden ticket.</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:10px 0;vertical-align:top;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="width:28px;vertical-align:top;"><span style="display:inline-block;width:24px;height:24px;background-color:#222;border-radius:50%;text-align:center;line-height:24px;font-family:${font};font-size:12px;font-weight:700;color:#888;">2</span></td>
    <td style="padding-left:12px;font-family:${font};font-size:15px;color:#cccccc;line-height:1.6;"><span style="color:#ffffff;font-weight:600;">Sign in with Google</span><br>One click. We spin up your account and start provisioning your dedicated server instantly.</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:10px 0;vertical-align:top;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="width:28px;vertical-align:top;"><span style="display:inline-block;width:24px;height:24px;background-color:#222;border-radius:50%;text-align:center;line-height:24px;font-family:${font};font-size:12px;font-weight:700;color:#888;">3</span></td>
    <td style="padding-left:12px;font-family:${font};font-size:15px;color:#cccccc;line-height:1.6;"><span style="color:#ffffff;font-weight:600;">Create your Telegram bot</span><br>Open Telegram, message <span style="color:#ffffff;">@BotFather</span>, follow the prompts. Two minutes and you've got a direct line to your agent. We walk you through every step.</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:10px 0;vertical-align:top;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="width:28px;vertical-align:top;"><span style="display:inline-block;width:24px;height:24px;background-color:#222;border-radius:50%;text-align:center;line-height:24px;font-family:${font};font-size:12px;font-weight:700;color:#888;">4</span></td>
    <td style="padding-left:12px;font-family:${font};font-size:15px;color:#cccccc;line-height:1.6;"><span style="color:#ffffff;font-weight:600;">Say hello to your agent</span><br>Send it your first message and watch it come alive. From this moment, it's running 24/7 on its own server, ready whenever you need it.</td>
    </tr></table>
  </td></tr>
  </table>
</td></tr>

<!-- DIVIDER -->
<tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #222;height:1px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<!-- SECTION 4: WHAT YOUR AGENT CAN DO -->
<tr><td style="padding:32px 40px;">
  <h2 style="margin:0 0 8px 0;font-family:${font};font-size:18px;font-weight:700;color:#ffffff;">Your superpowers</h2>
  <p style="margin:0 0 20px 0;font-family:${font};font-size:15px;color:#999;line-height:1.6;">These are real things people have asked their agent to do. One message. That's it.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
  <tr><td style="padding:12px 16px;background-color:#161616;border-radius:8px;">
    <p style="margin:0 0 6px 0;font-family:${font};font-size:13px;color:#999;line-height:1.5;font-style:italic;">"Find every Y Combinator company in the AI dev tools space from the last 2 batches, go to each of their websites, pull their pricing, and put it all in a comparison table for me."</p>
    <p style="margin:0;font-family:${font};font-size:12px;color:#666;line-height:1.5;">It searched the web, opened 20+ real websites in its browser, extracted data from each one, and came back with a formatted breakdown. Took about 4 minutes. Would've taken you an entire afternoon.</p>
  </td></tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
  <tr><td style="padding:12px 16px;background-color:#161616;border-radius:8px;">
    <p style="margin:0 0 6px 0;font-family:${font};font-size:13px;color:#999;line-height:1.5;font-style:italic;">"Every morning at 7am, check Hacker News, TechCrunch, and Product Hunt. If anything is relevant to my startup, send me a 3-bullet summary before I wake up."</p>
    <p style="margin:0;font-family:${font};font-size:12px;color:#666;line-height:1.5;">Set it once. Now you wake up every day to a personalized briefing that's already waiting for you. It runs on its own, forever.</p>
  </td></tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
  <tr><td style="padding:12px 16px;background-color:#161616;border-radius:8px;">
    <p style="margin:0 0 6px 0;font-family:${font};font-size:13px;color:#999;line-height:1.5;font-style:italic;">"I'm going to Tokyo for 5 days in March. Plan the entire trip. Find flights under $800, boutique hotels in Shibuya, the best ramen spots, a day trip to Hakone, and build me a full day-by-day itinerary."</p>
    <p style="margin:0;font-family:${font};font-size:12px;color:#666;line-height:1.5;">It browsed real travel sites, compared prices, read reviews, and came back with a complete trip plan with links to everything. One message.</p>
  </td></tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
  <tr><td style="padding:12px 16px;background-color:#161616;border-radius:8px;">
    <p style="margin:0 0 6px 0;font-family:${font};font-size:13px;color:#999;line-height:1.5;font-style:italic;">"Write me 5 cold outreach emails to potential investors. Make them sound like me, not like a robot. Reference their recent portfolio companies so they know I did my homework."</p>
    <p style="margin:0;font-family:${font};font-size:12px;color:#666;line-height:1.5;">It researched each investor, found their latest deals, and wrote personalized emails in your voice. The more you use it, the better it knows how you write.</p>
  </td></tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
  <tr><td style="padding:12px 16px;background-color:#161616;border-radius:8px;">
    <p style="margin:0 0 6px 0;font-family:${font};font-size:13px;color:#999;line-height:1.5;font-style:italic;">"Send my mom a handwritten birthday card. Find her address from our last conversation and write something heartfelt."</p>
    <p style="margin:0;font-family:${font};font-size:12px;color:#666;line-height:1.5;">Yes, real pen-and-ink handwritten postcards and greeting cards, mailed to a real address. Your agent finds the address, writes the message, and sends a physical card through the mail. No, we're not kidding.</p>
  </td></tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
  <tr><td style="padding:16px;background-color:#161616;border:1px solid #333;border-radius:8px;">
    <p style="margin:0 0 10px 0;font-family:${font};font-size:15px;font-weight:700;color:#ffffff;">This is just the beginning.</p>
    <p style="margin:0 0 10px 0;font-family:${font};font-size:14px;color:#cccccc;line-height:1.7;">Your agent isn't limited to a list of features. It can do literally anything you can describe in words. Need it to research a legal question? Done. Track a package? Done. Summarize a 40-page PDF? Done. Find apartments in your budget? Done. You just tell it what you want, and it figures out how to do it.</p>
    <p style="margin:0;font-family:${font};font-size:14px;color:#cccccc;line-height:1.7;">And here's the wild part: <span style="color:#ffffff;font-weight:600;">it gets smarter every single day</span>. It remembers everything you've told it, learns your preferences, adapts to how you think, and optimizes itself over time. The agent you have in a month will be 10x more powerful than the one you start with today.</p>
  </td></tr>
  </table>
</td></tr>

<!-- DIVIDER -->
<tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #222;height:1px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<!-- SECTION 5: FAQ -->
<tr><td style="padding:32px 40px;">
  <h2 style="margin:0 0 20px 0;font-family:${font};font-size:18px;font-weight:700;color:#ffffff;">Quick answers</h2>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="padding:0 0 16px 0;">
    <p style="margin:0 0 4px 0;font-family:${font};font-size:14px;font-weight:700;color:#ffffff;">"Do I need to keep Telegram open?"</p>
    <p style="margin:0;font-family:${font};font-size:14px;color:#999;line-height:1.6;">Nope. Your agent lives on its own dedicated server and runs around the clock. It'll ping you on Telegram whenever it has results. You check it on your own time, like any other message.</p>
  </td></tr>
  <tr><td style="padding:0 0 16px 0;">
    <p style="margin:0 0 4px 0;font-family:${font};font-size:14px;font-weight:700;color:#ffffff;">"How is this different from ChatGPT?"</p>
    <p style="margin:0;font-family:${font};font-size:14px;color:#999;line-height:1.6;">Night and day. ChatGPT is a chatbox you visit when you have a question. Your InstaClaw agent is a fully autonomous worker running on its own server. It browses real websites, runs tasks on a schedule, remembers everything you've ever told it, and keeps working even when you're offline. It's the difference between a search engine and an employee.</p>
  </td></tr>
  <tr><td style="padding:0 0 16px 0;">
    <p style="margin:0 0 4px 0;font-family:${font};font-size:14px;font-weight:700;color:#ffffff;">"How much does it cost?"</p>
    <p style="margin:0;font-family:${font};font-size:14px;color:#999;line-height:1.6;">You're starting with a free trial &mdash; no credit card, no strings. Just set up your agent and start using it. We'll give you a heads up before anything changes.</p>
  </td></tr>
  <tr><td style="padding:0 0 16px 0;">
    <p style="margin:0 0 4px 0;font-family:${font};font-size:14px;font-weight:700;color:#ffffff;">"Can I use it from my computer too?"</p>
    <p style="margin:0;font-family:${font};font-size:14px;color:#999;line-height:1.6;">Absolutely. You get a full Command Center at instaclaw.io/dashboard &mdash; chat with your agent, see everything it's done, manage scheduled tasks, all from your browser. Telegram + dashboard = total control from anywhere.</p>
  </td></tr>
  <tr><td style="padding:0;">
    <p style="margin:0 0 4px 0;font-family:${font};font-size:14px;font-weight:700;color:#ffffff;">"What if I get stuck?"</p>
    <p style="margin:0;font-family:${font};font-size:14px;color:#999;line-height:1.6;">Hit reply on this email. We're a small team, we built this ourselves, and we actually read every single message. We've got your back.</p>
  </td></tr>
  </table>
</td></tr>

<!-- BOTTOM CTA -->
<tr><td style="padding:8px 40px 40px 40px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#161616;border:1px solid #333;border-radius:10px;">
  <tr><td style="padding:28px 24px;text-align:center;">
    <p style="margin:0 0 4px 0;font-family:${font};font-size:15px;color:#ffffff;font-weight:600;">Your agent is waiting.</p>
    <p style="margin:0 0 16px 0;font-family:${font};font-size:13px;color:#888;">Use your code to activate it:</p>
    <p style="margin:0 0 20px 0;font-family:${mono};font-size:28px;font-weight:700;color:#ffffff;letter-spacing:5px;">${inviteCode}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr><td style="background-color:#ffffff;border-radius:8px;">
      <a href="${signupUrl}" target="_blank" style="display:inline-block;padding:14px 40px;font-family:${font};font-size:16px;font-weight:700;color:#000000;text-decoration:none;">Activate Your Agent &rarr;</a>
    </td></tr>
    </table>
  </td></tr>
  </table>
</td></tr>

<!-- FOOTER -->
<tr><td style="padding:24px 40px 32px 40px;border-top:1px solid #222;">
  <p style="margin:0 0 8px 0;font-family:${font};font-size:14px;color:#888;">InstaClaw &mdash; Your AI, Your Superpower</p>
  <p style="margin:0 0 16px 0;font-family:${font};font-size:13px;color:#666;">
    <a href="https://instaclaw.io" style="color:#666;text-decoration:underline;">instaclaw.io</a> &nbsp;&middot;&nbsp; <a href="https://x.com/instaclaws" style="color:#666;text-decoration:underline;">@instaclaws</a>
  </p>
  <p style="margin:0;font-family:${font};font-size:11px;color:#444;line-height:1.5;">You're receiving this because you joined the InstaClaw waitlist. If you didn't request this, you can ignore this email.</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export async function sendInviteEmail(
  email: string,
  inviteCode: string
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    replyTo: "coop@valtlabs.com",
    to: email,
    subject: "You're in - here's your InstaClaw invite 💫",
    html: buildInviteEmailHtml(inviteCode),
  });
}

export async function sendVMReadyEmail(
  email: string,
  controlPanelUrl: string
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
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
  });
}

export async function sendPendingEmail(email: string): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
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
  });
}

export async function sendPaymentFailedEmail(email: string): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Payment Failed — Action Required",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Payment Failed</h1>
        <p style="color: #888; line-height: 1.6;">
          We were unable to process your latest payment. Please update your payment method to keep your OpenClaw instance running.
        </p>
        <a href="${process.env.NEXTAUTH_URL}/billing" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Update Payment Method
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          If your payment is not resolved, your instance may be suspended.
        </p>
      </div>
    `,
  });
}

export async function sendHealthAlertEmail(
  email: string,
  vmName: string
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Your OpenClaw Instance Needs Attention",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Health Alert</h1>
        <p style="color: #888; line-height: 1.6;">
          Your OpenClaw instance (${vmName}) has failed multiple health checks. We're attempting an automatic restart. If the issue persists, our team will investigate.
        </p>
        <a href="${process.env.NEXTAUTH_URL}/dashboard" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Check Dashboard
        </a>
      </div>
    `,
  });
}

export async function sendTrialEndingEmail(
  email: string,
  daysLeft: number
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Your Free Trial Ends in ${daysLeft} Day${daysLeft !== 1 ? "s" : ""}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Trial Ending Soon</h1>
        <p style="color: #888; line-height: 1.6;">
          Your InstaClaw free trial ends in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. After that, your subscription will automatically convert to a paid plan. No action needed if you'd like to continue.
        </p>
        <p style="color: #888; line-height: 1.6; margin-top: 12px;">
          To cancel before the trial ends, visit your billing page.
        </p>
        <a href="${process.env.NEXTAUTH_URL}/billing" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Manage Subscription
        </a>
      </div>
    `,
  });
}

export async function sendWelcomeEmail(
  email: string,
  name: string
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Welcome to InstaClaw!",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Welcome, ${name || "there"}!</h1>
        <p style="color: #888; line-height: 1.6;">
          Your InstaClaw account has been created. You're one step away from deploying your own personal AI agent.
        </p>
        <p style="color: #888; line-height: 1.6; margin-top: 12px;">
          Complete your setup to get a dedicated OpenClaw instance with Telegram, Discord, and more.
        </p>
        <a href="${process.env.NEXTAUTH_URL}/connect" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Start Setup
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          All plans include a 3-day free trial. No charge until the trial ends.
        </p>
      </div>
    `,
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
    to: adminEmail,
    subject: `[InstaClaw Admin] ${subject}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Admin Alert</h1>
        <p style="color: #888; line-height: 1.6;">${subject}</p>
        <pre style="margin-top: 16px; padding: 16px; background: #0a0a0a; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #ccc; white-space: pre-wrap; font-size: 13px;">${details}</pre>
      </div>
    `,
  });
}

export async function sendCanceledEmail(email: string): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Your InstaClaw Subscription Has Been Canceled",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Subscription Canceled</h1>
        <p style="color: #888; line-height: 1.6;">
          Your InstaClaw subscription has been canceled and your OpenClaw instance has been deactivated. If this was a mistake, you can re-subscribe at any time.
        </p>
        <a href="${process.env.NEXTAUTH_URL}/signup" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Re-subscribe
        </a>
      </div>
    `,
  });
}

export async function sendWaitlistUpdateEmail(
  email: string
): Promise<{ from: string; to: string; subject: string; html: string }> {
  return {
    from: FROM,
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
  };
}

export { getResend, FROM };

export async function sendSuspendedEmail(email: string): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
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
        <a href="${process.env.NEXTAUTH_URL}/billing" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Update Payment Method
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          Your instance will be automatically restored once payment is successful.
        </p>
      </div>
    `,
  });
}
