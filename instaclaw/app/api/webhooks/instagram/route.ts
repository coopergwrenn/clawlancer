import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/webhooks/instagram
 * Webhook verification — Meta sends a GET request with hub.challenge
 * to verify the endpoint during subscription setup.
 */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === process.env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    logger.info("Instagram webhook verified", { route: "webhooks/instagram" });
    // Must return the challenge as plain text, not JSON
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

/**
 * POST /api/webhooks/instagram
 * Receives real-time events from Meta (DMs, comments, story replies, mentions).
 *
 * Must respond with 200 within 5 seconds — process async.
 * Verifies X-Hub-Signature-256 header using HMAC-SHA256 with App Secret.
 */
export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-hub-signature-256");
  const rawBody = await req.text();

  // Verify signature
  if (!signature || !(await verifySignature(rawBody, signature))) {
    logger.warn("Instagram webhook signature verification failed", {
      route: "webhooks/instagram",
      hasSignature: !!signature,
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  let body: WebhookPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Must be an instagram object
  if (body.object !== "instagram") {
    return NextResponse.json({ received: true });
  }

  // Process each entry asynchronously (respond 200 immediately)
  // Using waitUntil pattern via edge runtime isn't available in Node,
  // so we process inline but keep it fast
  const supabase = getSupabase();

  for (const entry of body.entry ?? []) {
    const igAccountId = entry.id;

    // Look up which user owns this Instagram account
    const { data: integration } = await supabase
      .from("instaclaw_instagram_integrations")
      .select("user_id, instagram_username")
      .eq("instagram_user_id", igAccountId)
      .eq("status", "active")
      .single();

    if (!integration) {
      logger.warn("Instagram webhook for unknown account", {
        route: "webhooks/instagram",
        igAccountId,
      });
      continue;
    }

    // Update last webhook timestamp
    await supabase
      .from("instaclaw_instagram_integrations")
      .update({ last_webhook_at: new Date().toISOString() })
      .eq("instagram_user_id", igAccountId);

    // Get user's VM to forward the event
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, gateway_url, gateway_token")
      .eq("assigned_to", integration.user_id)
      .eq("status", "assigned")
      .single();

    if (!vm?.gateway_url || !vm.gateway_token) {
      logger.warn("Instagram webhook: user has no active VM", {
        route: "webhooks/instagram",
        userId: integration.user_id,
      });
      continue;
    }

    // Process messaging events
    for (const messaging of entry.messaging ?? []) {
      await processMessagingEvent(
        messaging,
        vm,
        integration.user_id,
        igAccountId
      );
    }

    // Process comment/mention changes
    for (const change of entry.changes ?? []) {
      await processChangeEvent(
        change,
        vm,
        integration.user_id,
        igAccountId
      );
    }
  }

  return NextResponse.json({ received: true });
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

async function processMessagingEvent(
  messaging: MessagingEvent,
  vm: { gateway_url: string; gateway_token: string },
  userId: string,
  igAccountId: string
) {
  // Skip echo messages (sent by the business, not the customer)
  if (messaging.message?.is_echo) return;

  const eventType = messaging.message
    ? "dm"
    : messaging.postback
      ? "postback"
      : messaging.referral
        ? "referral"
        : "unknown";

  logger.info("Instagram event received", {
    route: "webhooks/instagram",
    eventType,
    userId,
    senderId: messaging.sender?.id,
  });

  // Forward to the user's VM gateway as a tool call
  try {
    await fetch(`${vm.gateway_url}/api/instagram-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vm.gateway_token}`,
      },
      body: JSON.stringify({
        type: eventType,
        sender_id: messaging.sender?.id,
        recipient_id: messaging.recipient?.id,
        timestamp: messaging.timestamp,
        message: messaging.message,
        postback: messaging.postback,
        referral: messaging.referral,
        ig_account_id: igAccountId,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.error("Failed to forward Instagram event to VM", {
      route: "webhooks/instagram",
      userId,
      error: String(err),
    });
  }
}

async function processChangeEvent(
  change: ChangeEvent,
  vm: { gateway_url: string; gateway_token: string },
  userId: string,
  igAccountId: string
) {
  const field = change.field;
  if (!["comments", "mentions", "story_insights"].includes(field)) return;

  logger.info("Instagram change event received", {
    route: "webhooks/instagram",
    field,
    userId,
  });

  try {
    await fetch(`${vm.gateway_url}/api/instagram-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vm.gateway_token}`,
      },
      body: JSON.stringify({
        type: field,
        value: change.value,
        ig_account_id: igAccountId,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.error("Failed to forward Instagram change to VM", {
      route: "webhooks/instagram",
      userId,
      error: String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

async function verifySignature(
  rawBody: string,
  signatureHeader: string
): Promise<boolean> {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return false;

  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const providedSignature = signatureHeader.slice(expectedPrefix.length);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody)
  );

  const computed = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (computed.length !== providedSignature.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ providedSignature.charCodeAt(i);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookPayload {
  object: string;
  entry?: WebhookEntry[];
}

interface WebhookEntry {
  id: string; // Instagram account ID
  time: number;
  messaging?: MessagingEvent[];
  changes?: ChangeEvent[];
}

interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: Array<{
      type: string;
      payload: { url?: string };
    }>;
    is_echo?: boolean;
  };
  postback?: { title: string; payload: string };
  referral?: { ref: string; source: string; type: string };
}

interface ChangeEvent {
  field: string;
  value: Record<string, unknown>;
}
