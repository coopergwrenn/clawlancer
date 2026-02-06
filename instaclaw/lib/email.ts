import { Resend } from "resend";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY!);
  }
  return _resend;
}

const FROM = "InstaClaw <noreply@instaclaw.io>";

export async function sendInviteEmail(
  email: string,
  inviteCode: string
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Your InstaClaw Invite",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">You're In!</h1>
        <p style="color: #888; line-height: 1.6;">
          Your spot on InstaClaw is ready. Use the invite code below to create your account and deploy your own OpenClaw instance.
        </p>
        <div style="margin: 24px 0; padding: 16px; background: #0a0a0a; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; text-align: center;">
          <code style="font-size: 24px; letter-spacing: 4px; color: #fff;">${inviteCode}</code>
        </div>
        <a href="${process.env.NEXTAUTH_URL}/signup" style="display: inline-block; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Get Started
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          This invite code expires in 7 days. If you didn't request this, you can ignore this email.
        </p>
      </div>
    `,
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
