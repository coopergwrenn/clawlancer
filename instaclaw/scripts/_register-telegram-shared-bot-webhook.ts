#!/usr/bin/env tsx
/**
 * Register (or re-register) the Telegram webhook for @myinstaclaw_bot.
 *
 * One-shot bootstrap. Run after deploying the inbound webhook handler
 * (app/api/telegram/shared-bot/inbound/route.ts), or whenever the
 * webhook URL needs to change (preview → production cutover, secret
 * rotation, etc.).
 *
 * What this does:
 *   POST https://api.telegram.org/bot<TOKEN>/setWebhook
 *     { url, secret_token, allowed_updates, drop_pending_updates }
 *
 * After Telegram acknowledges, every inbound `message` update for
 * @myinstaclaw_bot lands at our `/api/telegram/shared-bot/inbound`
 * with the secret in `X-Telegram-Bot-Api-Secret-Token`. Our handler
 * verifies via constant-time compare.
 *
 * Env vars required:
 *   TELEGRAM_SHARED_BOT_TOKEN          (Vercel)
 *   TELEGRAM_SHARED_BOT_WEBHOOK_SECRET (Vercel)
 *   TELEGRAM_SHARED_BOT_WEBHOOK_URL    (CLI flag fallback if unset)
 *
 * Usage:
 *   npx tsx scripts/_register-telegram-shared-bot-webhook.ts
 *   npx tsx scripts/_register-telegram-shared-bot-webhook.ts --url https://preview-xxx.vercel.app/api/telegram/shared-bot/inbound
 *   npx tsx scripts/_register-telegram-shared-bot-webhook.ts --info  (read current webhook config)
 *   npx tsx scripts/_register-telegram-shared-bot-webhook.ts --delete (unregister)
 *
 * Loads env from .env.local (so the script can run from any cwd inside
 * the instaclaw repo without `vercel env pull` first).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = "/Users/cooperwrenn/wild-west-bots/instaclaw";
const ENV_FILES = [
  join(REPO_ROOT, ".env.local"),
  join(REPO_ROOT, ".env.ssh-key"),
];

function loadEnv(): void {
  for (const f of ENV_FILES) {
    if (!existsSync(f)) continue;
    const txt = readFileSync(f, "utf-8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      if (process.env[key]) continue;
      let val = m[2].trim();
      // Strip optional surrounding quotes from .env values.
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

function parseCliArgs(): {
  url?: string;
  mode: "register" | "info" | "delete";
} {
  const args = process.argv.slice(2);
  if (args.includes("--info")) return { mode: "info" };
  if (args.includes("--delete")) return { mode: "delete" };
  const urlIdx = args.indexOf("--url");
  const url =
    urlIdx >= 0 && urlIdx + 1 < args.length ? args[urlIdx + 1] : undefined;
  return { mode: "register", url };
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

async function telegramApi(
  token: string,
  method: string,
  body: Record<string, unknown> | null,
): Promise<TelegramApiResponse> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  return (await res.json()) as TelegramApiResponse;
}

async function main() {
  loadEnv();
  const args = parseCliArgs();

  const token = process.env.TELEGRAM_SHARED_BOT_TOKEN;
  if (!token) {
    console.error(
      "ERROR: TELEGRAM_SHARED_BOT_TOKEN not set.\n" +
        "  Either pull Vercel env (`npx vercel env pull` in instaclaw/) or\n" +
        "  source the value into your shell before running this script.",
    );
    process.exit(1);
  }

  // ── --info mode: print current webhook config and exit ──
  if (args.mode === "info") {
    console.log("Fetching current webhook info for @myinstaclaw_bot...");
    const info = await telegramApi(token, "getWebhookInfo", null);
    console.log(JSON.stringify(info, null, 2));
    process.exit(info.ok ? 0 : 1);
  }

  // ── --delete mode: unregister webhook ──
  if (args.mode === "delete") {
    console.log("Deleting webhook for @myinstaclaw_bot...");
    const del = await telegramApi(token, "deleteWebhook", {
      drop_pending_updates: true,
    });
    console.log(JSON.stringify(del, null, 2));
    process.exit(del.ok ? 0 : 1);
  }

  // ── register mode (default) ──
  const secret = process.env.TELEGRAM_SHARED_BOT_WEBHOOK_SECRET;
  if (!secret) {
    console.error("ERROR: TELEGRAM_SHARED_BOT_WEBHOOK_SECRET not set.");
    process.exit(1);
  }

  // Telegram's secret_token must be 1-256 chars [A-Za-z0-9_-]. Validate
  // before we send so the error is local (not a Telegram 400).
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    console.error(
      "ERROR: TELEGRAM_SHARED_BOT_WEBHOOK_SECRET must be 1-256 chars of [A-Za-z0-9_-]. Telegram requires this shape.",
    );
    process.exit(1);
  }

  const url =
    args.url ||
    process.env.TELEGRAM_SHARED_BOT_WEBHOOK_URL ||
    "https://instaclaw.io/api/telegram/shared-bot/inbound";

  if (!/^https:\/\//.test(url)) {
    console.error(
      `ERROR: webhook URL must be https:// (got "${url}"). Telegram refuses HTTP.`,
    );
    process.exit(1);
  }

  console.log(`Registering webhook:`);
  console.log(`  URL:     ${url}`);
  console.log(`  Secret:  ${secret.slice(0, 4)}*** (${secret.length} chars)`);
  console.log("");

  const result = await telegramApi(token, "setWebhook", {
    url,
    secret_token: secret,
    // Only subscribe to message updates. We don't handle channel_post,
    // edited_message, callback_query, etc. — keeping the subscription
    // narrow reduces the surface area Telegram sends to us.
    allowed_updates: ["message"],
    // Drop pending updates from any prior webhook registration (e.g.,
    // queued messages from a previous test setup). Safe — we don't
    // care about pre-bootstrap messages.
    drop_pending_updates: true,
  });

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    console.error("\nsetWebhook FAILED.");
    process.exit(1);
  }

  console.log("\nsetWebhook OK. Verifying via getWebhookInfo:");
  const info = await telegramApi(token, "getWebhookInfo", null);
  console.log(JSON.stringify(info, null, 2));

  if (!info.ok) {
    console.error("\nVerification fetch failed.");
    process.exit(1);
  }

  console.log("\nDone. Test by texting @myinstaclaw_bot from any Telegram account.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Uncaught error:", err);
  process.exit(1);
});
