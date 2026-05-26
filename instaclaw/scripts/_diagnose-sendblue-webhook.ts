#!/usr/bin/env tsx
/**
 * Diagnose why Sendblue isn't dispatching inbound webhooks to us.
 *
 * Cooper texted "hi" 3x to our dedicated number; zero requests reached
 * /api/imessage/inbound on prod. Our endpoint returns 401 "Missing
 * signing secret" to unsigned probes — proving the route is live and
 * the env var is set. So the disconnect is Sendblue-side.
 *
 * Per https://docs.sendblue.com/getting-started/webhooks/index.md:
 *   - Webhooks are ACCOUNT-LEVEL (all lines share the same endpoints).
 *   - There are SEVEN event types: receive, outbound, typing_indicator,
 *     call_log, line_blocked, line_assigned, contact_created.
 *   - `receive` is the one we need for inbound messages.
 *   - Endpoints: GET/POST/PUT/DELETE /api/account/webhooks.
 *
 * This script is READ-ONLY. It:
 *   1. Auths against /accounts/me to confirm creds are valid.
 *   2. GETs /api/account/webhooks and dumps the full response.
 *   3. Checks: is `receive` registered? Does it point to our URL?
 *      Is the global/per-webhook secret matching what we expect?
 *   4. GETs /api/lines to confirm the dedicated number is on this
 *      account (sanity check against wrong-account misconfig).
 *   5. Prints a verdict + the EXACT curl command to fix it (we don't
 *      write — Cooper reviews before mutating prod webhook config).
 *
 * Run:
 *   export SENDBLUE_API_KEY_ID=...     # from Vercel sensitive env
 *   export SENDBLUE_API_SECRET_KEY=...
 *   export SENDBLUE_WEBHOOK_SECRET=... # what's set in Vercel (the
 *                                      # static secret our route compares
 *                                      # against sb-signing-secret header)
 *   npx tsx instaclaw/scripts/_diagnose-sendblue-webhook.ts
 */

const SENDBLUE_API_BASE =
  process.env.SENDBLUE_API_BASE_URL || "https://api.sendblue.co/api";

const EXPECTED_WEBHOOK_URL = "https://instaclaw.io/api/imessage/inbound";
const EXPECTED_FROM_PHONE = process.env.SENDBLUE_FROM_PHONE || "+14072425197";

const KEY_ID = process.env.SENDBLUE_API_KEY_ID;
const SECRET = process.env.SENDBLUE_API_SECRET_KEY;
const OUR_WEBHOOK_SECRET = process.env.SENDBLUE_WEBHOOK_SECRET;

if (!KEY_ID || !SECRET) {
  console.error("✘ SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET_KEY must be exported.");
  console.error("");
  console.error("They are Sensitive in Vercel — `vercel env pull` returns empty.");
  console.error("Grab from Vercel dashboard (Settings → Environment Variables → Reveal)");
  console.error("and `export` them before running this script.");
  process.exit(2);
}

const headers = {
  "sb-api-key-id": KEY_ID,
  "sb-api-secret-key": SECRET,
  Accept: "application/json",
} as const;

async function api(path: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${SENDBLUE_API_BASE}${path}`, { headers });
  const text = await r.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

function header(label: string) {
  console.log("");
  console.log("═".repeat(70));
  console.log(label);
  console.log("═".repeat(70));
}

function pretty(o: unknown) {
  return JSON.stringify(o, null, 2);
}

async function main() {
  header("Step 1: confirm auth works (GET /accounts/me)");
  const me = await api("/accounts/me");
  console.log(`HTTP ${me.status}`);
  console.log(pretty(me.body));
  if (me.status !== 200) {
    console.error("");
    console.error("✘ Auth failed. Stop and verify SENDBLUE_API_KEY_ID +");
    console.error("  SENDBLUE_API_SECRET_KEY match what's in Vercel production.");
    process.exit(1);
  }

  header("Step 2: list current webhook config (GET /api/account/webhooks)");
  const hooks = await api("/account/webhooks");
  console.log(`HTTP ${hooks.status}`);
  console.log(pretty(hooks.body));

  header("Step 3: analyze webhook config against the 'receive' event");
  // Response shape per docs is not fully specified; defensively probe
  // multiple shapes. Sendblue's response could be:
  //   A) Flat keyed: { receive: "url"|null, outbound: ..., globalSecret: "..." }
  //   B) Object-form: { receive: { url, secret }, ... }
  //   C) Array-form: [{ event: "receive", url, secret }, ...]
  // We handle all three.
  const hb: any = hooks.body;
  let receiveUrl: string | null = null;
  let receiveSecret: string | null = null;
  let globalSecret: string | null = null;

  if (hb && typeof hb === "object" && !Array.isArray(hb)) {
    globalSecret =
      typeof hb.globalSecret === "string"
        ? hb.globalSecret
        : typeof hb.global_secret === "string"
          ? hb.global_secret
          : typeof hb.secret === "string"
            ? hb.secret // legacy root-level secret
            : null;
    const rcv = hb.receive;
    if (typeof rcv === "string") {
      receiveUrl = rcv;
    } else if (rcv && typeof rcv === "object") {
      receiveUrl = typeof rcv.url === "string" ? rcv.url : null;
      receiveSecret = typeof rcv.secret === "string" ? rcv.secret : null;
    }
  } else if (Array.isArray(hb)) {
    for (const w of hb) {
      if (w && typeof w === "object" && w.event === "receive") {
        receiveUrl = typeof w.url === "string" ? w.url : null;
        receiveSecret = typeof w.secret === "string" ? w.secret : null;
      }
    }
  }

  console.log(`  receiveUrl     = ${JSON.stringify(receiveUrl)}`);
  console.log(`  receiveSecret  = ${receiveSecret ? `<set, len=${receiveSecret.length}>` : "null"}`);
  console.log(`  globalSecret   = ${globalSecret ? `<set, len=${globalSecret.length}>` : "null"}`);
  console.log("");

  // Diagnose
  const findings: string[] = [];
  if (!receiveUrl) {
    findings.push(
      "✘ CRITICAL: 'receive' event is NOT registered. Sendblue will never dispatch inbound messages without it. The dashboard's webhook URL field may have set it for a different event (e.g., 'outbound' or 'line_assigned'), or not saved at all.",
    );
  } else if (receiveUrl !== EXPECTED_WEBHOOK_URL) {
    findings.push(
      `✘ CRITICAL: 'receive' URL is ${JSON.stringify(receiveUrl)} but should be ${JSON.stringify(EXPECTED_WEBHOOK_URL)}.`,
    );
  } else {
    findings.push(`✓ 'receive' URL is correct: ${receiveUrl}`);
  }

  if (OUR_WEBHOOK_SECRET) {
    const matchedSecret = receiveSecret || globalSecret;
    if (!matchedSecret) {
      findings.push(
        "⚠ Neither a per-webhook secret nor globalSecret is set on Sendblue's side. Our /api/imessage/inbound REQUIRES a `sb-signing-secret` header on every inbound — without a configured secret, Sendblue won't send one and we'll 401 every call. (But this isn't the current symptom — current symptom is zero deliveries, which points to missing 'receive' registration.)",
      );
    } else if (matchedSecret !== OUR_WEBHOOK_SECRET) {
      findings.push(
        `⚠ Sendblue's configured secret (len=${matchedSecret.length}) does NOT match SENDBLUE_WEBHOOK_SECRET (len=${OUR_WEBHOOK_SECRET.length}) in Vercel. Even if 'receive' is registered, our 401 'Invalid signing secret' would fire on every delivery. Fix both sides to match.`,
      );
    } else {
      findings.push(`✓ Sendblue's configured secret matches Vercel's SENDBLUE_WEBHOOK_SECRET.`);
    }
  } else {
    findings.push(
      "ℹ Skipping secret comparison: SENDBLUE_WEBHOOK_SECRET not exported in this shell.",
    );
  }

  header("Step 4: list account lines (GET /api/lines)");
  const lines = await api("/lines");
  console.log(`HTTP ${lines.status}`);
  console.log(pretty(lines.body));
  if (lines.status === 200) {
    const linesList: any[] = Array.isArray(lines.body)
      ? lines.body
      : (lines.body as any)?.lines || (lines.body as any)?.data || [];
    const phones = linesList
      .map((l) => l?.phone || l?.phone_number || l?.number || l?.e164)
      .filter(Boolean);
    console.log(`  phones on account: ${JSON.stringify(phones)}`);
    if (phones.includes(EXPECTED_FROM_PHONE)) {
      findings.push(`✓ Dedicated number ${EXPECTED_FROM_PHONE} is on this account.`);
    } else if (phones.length === 0) {
      findings.push(
        `⚠ Could not parse lines list shape — manual review needed. Body shape above.`,
      );
    } else {
      findings.push(
        `✘ CRITICAL: Dedicated number ${EXPECTED_FROM_PHONE} is NOT on this account. Account holds: ${JSON.stringify(phones)}. Webhook config on this account will never receive messages destined for a number on a DIFFERENT account.`,
      );
    }
  }

  header("Step 5: did Sendblue actually RECEIVE the inbound iMessages?");
  // GET /api/v2/messages?is_outbound=false&sendblue_number=...
  // If this returns rows → Sendblue's infrastructure received them but
  //   FAILED to dispatch the webhook. Bug is in Sendblue's dispatcher
  //   (account-level config we can't see, or internal infra issue).
  // If empty → Sendblue NEVER received them. Bug is upstream — the Mac
  //   in Sendblue's farm bound to this number's Apple ID isn't actually
  //   receiving the iMessages. "Delivered" status in the sender's
  //   Messages app would NOT show in that case.
  const qs = new URLSearchParams({
    is_outbound: "false",
    sendblue_number: EXPECTED_FROM_PHONE,
    limit: "20",
    order_by: "createdAt",
    order_direction: "desc",
  });
  const msgs = await api(`/v2/messages?${qs.toString()}`);
  console.log(`HTTP ${msgs.status}`);
  console.log(pretty(msgs.body));

  if (msgs.status === 200) {
    const data: any[] = (msgs.body as any)?.data || [];
    console.log(`  inbound count (last 20): ${data.length}`);
    if (data.length > 0) {
      console.log("  most-recent 5 inbound:");
      for (const m of data.slice(0, 5)) {
        console.log(
          `    ${m.date_sent} ${m.service} from=${m.from_number} content=${JSON.stringify((m.content || "").slice(0, 40))}`,
        );
      }
      findings.push(
        `✘ ROOT CAUSE: Sendblue RECEIVED the inbound messages (${data.length} in last 20) but did NOT dispatch them to our webhook. The 'receive' event is registered and the URL is correct, yet dispatch never happened. This is a Sendblue-internal issue: either (a) per-event dispatch is disabled at account level, (b) the webhook subscription is in a half-state the GET doesn't reveal, or (c) Sendblue's webhook worker is broken for this account. ACTION: file support ticket with Sendblue including the message_handle of one of these inbound rows and the timestamp.`,
      );
    } else {
      findings.push(
        `✘ ROOT CAUSE: Sendblue NEVER RECEIVED the inbound iMessages from Cooper. Outbound works (the Mac in their farm can send via Apple ID), but inbound iMessages are not reaching them. The blue iMessage bubble in Cooper's Messages app only confirms Apple's iMessage registry says the number is iMessage-capable — not that delivery succeeded. ACTION: (1) Have Cooper check "Delivered" status under "hi" in his Messages app. If absent, message is queued at Apple's side. (2) Have Cooper long-press send button → "Send as Text Message" to force SMS routing. If SMS inbound shows up here → iMessage receiving is the broken layer for this dedicated line. (3) File support ticket with Sendblue with the timestamps Cooper sent.`,
      );
    }
  } else {
    findings.push(
      `⚠ /api/v2/messages returned HTTP ${msgs.status} — could not confirm whether Sendblue received inbound. Body above.`,
    );
  }

  header("Verdict");
  for (const f of findings) {
    console.log("  " + f);
  }

  // If 'receive' is missing, print the exact curl to fix.
  if (!receiveUrl) {
    console.log("");
    console.log("─".repeat(70));
    console.log("Suggested fix (DO NOT RUN until you confirm the diagnosis above):");
    console.log("─".repeat(70));
    console.log("");
    console.log("# POST appends to existing config (per docs); use this if other");
    console.log("# events are already registered and you only want to ADD receive.");
    console.log("# If you want to REPLACE all webhook config, use PUT instead.");
    console.log("");
    console.log(`curl -X POST "${SENDBLUE_API_BASE}/account/webhooks" \\`);
    console.log(`  -H "sb-api-key-id: $SENDBLUE_API_KEY_ID" \\`);
    console.log(`  -H "sb-api-secret-key: $SENDBLUE_API_SECRET_KEY" \\`);
    console.log(`  -H "content-type: application/json" \\`);
    if (OUR_WEBHOOK_SECRET) {
      console.log(
        `  -d '{"receive": {"url": "${EXPECTED_WEBHOOK_URL}", "secret": "<SENDBLUE_WEBHOOK_SECRET-value>"}}'`,
      );
    } else {
      console.log(
        `  -d '{"receive": {"url": "${EXPECTED_WEBHOOK_URL}", "secret": "<set-to-match-Vercel-SENDBLUE_WEBHOOK_SECRET>"}}'`,
      );
    }
    console.log("");
    console.log("# Or simpler form (global secret applies):");
    console.log(`#   -d '{"receive": "${EXPECTED_WEBHOOK_URL}"}'`);
  }
}

main().catch((err) => {
  console.error("");
  console.error("Diagnostic script crashed:", err);
  process.exit(1);
});
