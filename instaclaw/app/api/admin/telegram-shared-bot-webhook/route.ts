/**
 * Admin endpoint for managing the @myinstaclaw_bot webhook registration.
 *
 * Why this exists: TELEGRAM_SHARED_BOT_TOKEN is marked Sensitive in Vercel
 * (good hygiene per Rule 49) so `vercel env pull` returns it as an empty
 * string. The one-shot `scripts/_register-telegram-shared-bot-webhook.ts`
 * therefore can't be run from a local shell. This endpoint runs in
 * Vercel's serverless context where the secret IS available, and exposes
 * GET (read current webhook info) + POST (set webhook to canonical URL).
 *
 * Auth: X-Admin-Key header (matches ADMIN_API_KEY env var). Per CLAUDE.md
 * Rule 13, must be added to middleware.ts selfAuthAPIs allow-list.
 *
 * Usage:
 *
 *   # Check current registration
 *   curl https://instaclaw.io/api/admin/telegram-shared-bot-webhook \
 *     -H "X-Admin-Key: $ADMIN_API_KEY"
 *
 *   # (Re-)register webhook to canonical URL with our shared secret
 *   curl -X POST https://instaclaw.io/api/admin/telegram-shared-bot-webhook \
 *     -H "X-Admin-Key: $ADMIN_API_KEY"
 *
 * Expected response after POST:
 *   { ok: true, telegram: { ok: true, result: true, description: "..." } }
 *
 * Then GET to confirm:
 *   {
 *     ok: true,
 *     info: {
 *       url: "https://instaclaw.io/api/telegram/shared-bot/inbound",
 *       has_custom_certificate: false,
 *       pending_update_count: 0,
 *       last_error_message: null,    // ← MUST be null/absent
 *       last_error_date: null,
 *       max_connections: 40,
 *       allowed_updates: ["message"]
 *     }
 *   }
 *
 * If `last_error_message` is non-null after registration, Telegram's
 * delivery attempts are failing. Common causes: wrong URL, our secret
 * mismatch, our endpoint returning 5xx.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const CANONICAL_WEBHOOK_PATH = "/api/telegram/shared-bot/inbound";

function authOk(req: NextRequest): boolean {
  const provided = req.headers.get("x-admin-key");
  const expected = process.env.ADMIN_API_KEY;
  return !!expected && !!provided && provided === expected;
}

/**
 * Compose the canonical webhook URL from NEXTAUTH_URL. Per
 * lib/auth.ts pattern, NEXTAUTH_URL is the single source of truth for
 * "this deployment's external URL" — preview deploys override it so
 * `setWebhook` lands on the preview URL when running there.
 */
function canonicalWebhookUrl(): string {
  const base = (process.env.NEXTAUTH_URL ?? "https://instaclaw.io").replace(
    /\/+$/,
    "",
  );
  return `${base}${CANONICAL_WEBHOOK_PATH}`;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = process.env.TELEGRAM_SHARED_BOT_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, reason: "TELEGRAM_SHARED_BOT_TOKEN not set on this deployment" },
      { status: 500 },
    );
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getWebhookInfo`,
      { signal: AbortSignal.timeout(10_000) },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await res.json();
    return NextResponse.json({
      ok: !!body?.ok,
      info: body?.result ?? null,
      canonicalUrl: canonicalWebhookUrl(),
    });
  } catch (err) {
    logger.error("admin/telegram-shared-bot-webhook GET failed", {
      route: "admin/telegram-shared-bot-webhook",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        ok: false,
        reason: "telegram api unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.TELEGRAM_SHARED_BOT_TOKEN;
  const secret = process.env.TELEGRAM_SHARED_BOT_WEBHOOK_SECRET;
  if (!token) {
    return NextResponse.json(
      { ok: false, reason: "TELEGRAM_SHARED_BOT_TOKEN not set on this deployment" },
      { status: 500 },
    );
  }
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "TELEGRAM_SHARED_BOT_WEBHOOK_SECRET not set — webhook handler would 500 on every incoming update",
      },
      { status: 500 },
    );
  }

  const webhookUrl = canonicalWebhookUrl();

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secret,
          // Only subscribe to message updates. We don't handle
          // edited_message, channel_post, callback_query, etc.
          allowed_updates: ["message"],
          // Drop any pending updates that piled up before this
          // registration — they're either stale onboarding attempts
          // or test traffic, never something we should still process.
          drop_pending_updates: true,
        }),
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await res.json();

    logger.info("admin/telegram-shared-bot-webhook POST: setWebhook called", {
      route: "admin/telegram-shared-bot-webhook",
      webhookUrl,
      telegramOk: !!body?.ok,
      telegramDescription: body?.description ?? null,
    });

    return NextResponse.json(
      {
        ok: !!body?.ok,
        registeredUrl: webhookUrl,
        telegram: body,
      },
      { status: body?.ok ? 200 : 502 },
    );
  } catch (err) {
    logger.error("admin/telegram-shared-bot-webhook POST failed", {
      route: "admin/telegram-shared-bot-webhook",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        ok: false,
        reason: "telegram api unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
