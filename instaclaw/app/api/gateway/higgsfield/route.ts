import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomUUID } from "crypto";
import { createHiggsfieldClient } from "@higgsfield/client/v2";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  HF_MODELS,
  DEFAULT_MODEL,
  estimateVideoCredits,
  validateInput,
  freeCapForTier,
  VIDEO_DAILY_CREDIT_CEILING,
  FRESH_PENDING_TTL_MS,
  utcDayStartISO,
  mapHiggsfieldStatus,
} from "@/lib/higgsfield-models";

export const runtime = "nodejs";
export const maxDuration = 300; // Rule 11 — LLM/slow-API routes

const HF_BASE = "https://platform.higgsfield.ai";

/**
 * Higgsfield Cloud API gateway proxy — GUARDRAIL #1: pre-call credit gate.
 *
 * Flow (Frontier-mirrored hold/settle):
 *   gateway token → VM → VALIDATE (Cloud allowlist + per-model params, pre-submit)
 *   → ESTIMATE (measured cost table) → RESERVE (atomic hold; free-then-paid)
 *   → SUBMIT (only after a successful hold) → return request_id.
 * Completion + SETTLE/RELEASE happen at the sibling webhook route.
 *
 * The §6 calibration passthrough is GONE: there is no arbitrary endpoint/input
 * path. Only allowlisted models with validated, sanitized params reach
 * Higgsfield — closing the "API silently coerces+bills bad params" hole.
 *
 * Auth: the Cloud key (KEY_ID:KEY_SECRET) lives ONLY in process.env.
 * HIGGSFIELD_CLOUD_KEY (never on a VM). VMs auth to THIS proxy with their
 * per-VM GATEWAY_TOKEN.
 *
 * Billing idempotency: we generate our OWN request_id (UUID) as the hold key
 * BEFORE submit (we can't use Higgsfield's id — it only comes back FROM submit),
 * and sign it into the tamper-proof webhook `d` payload so the webhook settles
 * by it. Higgsfield's request_id is used only to re-fetch authoritative status.
 */

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Map a reserve-denial reason to a user-safe message + HTTP status. */
function denialResponse(reason: string, info: Record<string, unknown>) {
  switch (reason) {
    case "insufficient_balance":
      return NextResponse.json(
        { error: "insufficient_credits", message: "You're out of video credits. Top up to keep creating.", ...info },
        { status: 402 },
      );
    case "free_exhausted":
      return NextResponse.json(
        { error: "free_exhausted", message: "You've used your free videos for today. Top up to make more.", ...info },
        { status: 402 },
      );
    case "exceeds_daily_ceiling":
      return NextResponse.json(
        { error: "daily_limit", message: "You've hit today's video limit. It resets at midnight UTC.", ...info },
        { status: 429 },
      );
    case "no_cap_provided":
      // Should be impossible — the route always passes a real cap. Fail closed.
      return NextResponse.json(
        { error: "config_error", message: "Video generation is temporarily unavailable." },
        { status: 503 },
      );
    case "duplicate_request_id":
      return NextResponse.json(
        { error: "duplicate", message: "That request is already in progress." },
        { status: 409 },
      );
    case "invalid_vm":
      return NextResponse.json({ error: "invalid_vm" }, { status: 400 });
    default:
      return NextResponse.json(
        { error: "reserve_denied", message: "Couldn't start that video right now — try again shortly." },
        { status: 503 },
      );
  }
}

export async function POST(req: NextRequest) {
  try {
    // --- HIGGSFIELD_GATE_ENABLED: emergency kill-switch (fail-closed; unset = OFF). ---
    // Tourniquet ahead of full G9 (per-VM granularity / dashboard / alerts). Gates
    // BOTH create AND status before any auth or spend path runs. A live
    // HIGGSFIELD_CLOUD_KEY-spending endpoint never exists on prod without an off button.
    if (process.env.HIGGSFIELD_GATE_ENABLED !== "true") {
      logger.warn("Higgsfield gate disabled (kill-switch)", {
        route: "gateway/higgsfield",
        enabledRaw: process.env.HIGGSFIELD_GATE_ENABLED ?? "(unset)",
      });
      return NextResponse.json(
        { error: "video_disabled", message: "Video generation is temporarily unavailable." },
        { status: 503 },
      );
    }

    // --- Authenticate via gateway token; pull tier for the free allowance. ---
    const authHeader = req.headers.get("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const gatewayToken =
      req.headers.get("x-gateway-token") || req.headers.get("x-api-key") || bearer;
    if (!gatewayToken) {
      return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
    }

    // telegram_chat_id pulled for the A2 server-side delivery fallback (below).
    const vm = await lookupVMByGatewayToken(gatewayToken, "id, tier, telegram_chat_id");
    if (!vm) {
      return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
    }

    // --- Server-side credentials must be configured. ---
    const cloudKey = process.env.HIGGSFIELD_CLOUD_KEY;
    const webhookSecret = process.env.HIGGSFIELD_WEBHOOK_SECRET;
    if (!cloudKey || !webhookSecret) {
      logger.error("Higgsfield proxy not configured", {
        route: "gateway/higgsfield",
        hasCloudKey: !!cloudKey,
        hasWebhookSecret: !!webhookSecret,
      });
      return NextResponse.json({ error: "Video generation not configured" }, { status: 500 });
    }

    const action = req.nextUrl.searchParams.get("action");

    // --- ?action=status: the agent polls Higgsfield job status (G1 Option B). ---
    // A thin authed proxy of /requests/{id}/status. The opaque Higgsfield
    // request_id is the bearer capability — only the owning VM got it back from
    // its own ?action=create, and it's unguessable, so we don't leak across VMs.
    // Settle/release stay in the webhook (keyed by OUR request_id); this is a
    // pure read for the agent's poll loop, which delivers in-conversation.
    if (action === "status") {
      const requestId = req.nextUrl.searchParams.get("request_id") || "";
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
        return NextResponse.json({ error: "invalid_request_id" }, { status: 400 });
      }
      try {
        const res = await fetch(`${HF_BASE}/requests/${requestId}/status`, {
          headers: { Authorization: `Key ${cloudKey}` },
        });
        if (!res.ok) {
          // Unknown id / transient upstream → tell the agent to keep waiting.
          return NextResponse.json({
            status: "unknown",
            done: false,
            ok: false,
            video_url: null,
            http: res.status,
          });
        }
        const authoritative = await res.json();
        return NextResponse.json(mapHiggsfieldStatus(authoritative));
      } catch (err) {
        logger.error("Higgsfield status proxy failed", {
          route: "gateway/higgsfield",
          vmId: vm.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json({ error: "status_unavailable" }, { status: 503 });
      }
    }

    // --- ?action=upload: i2v source-image upload (build order §6). ---
    // The agent POSTs the photo's RAW BYTES (the file is always on the VM
    // disk — media://inbound/<id>.jpg); we validate by magic bytes, store to
    // Supabase Storage (48h TTL), and return the public URL the agent passes
    // back as image_url. Replaces the legacy Muapi-CDN uploader. Raw binary
    // (not JSON/base64) keeps us inside Vercel's body limit without the +33%
    // base64 inflation.
    if (action === "upload") {
      const raw = Buffer.from(await req.arrayBuffer());
      const { uploadSourceImage, MAX_UPLOAD_BYTES } = await import("@/lib/higgsfield-upload");
      const up = await uploadSourceImage(vm.id, raw);
      if (!up.ok) {
        if (up.error === "too_large") {
          return NextResponse.json(
            {
              error: "too_large",
              message: `That image is too large (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB). Ask the user for a smaller photo.`,
            },
            { status: 413 },
          );
        }
        if (up.error === "bad_type") {
          return NextResponse.json(
            { error: "bad_type", message: "That file isn't a JPEG, PNG, or WebP image." },
            { status: 400 },
          );
        }
        return NextResponse.json(
          { error: "storage_unavailable", message: "Couldn't store the image right now. Please try again shortly." },
          { status: 503 },
        );
      }
      logger.info("higgsfield source image uploaded", {
        route: "gateway/higgsfield", vmId: vm.id, bytes: up.bytes, type: up.type, object: up.objectName,
      });
      return NextResponse.json({ url: up.url });
    }

    if (action !== "create") {
      return NextResponse.json(
        { error: "invalid_action", message: "Only ?action=create, ?action=status, and ?action=upload are supported." },
        { status: 400 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      endpoint?: string;
      image_url?: unknown;
      prompt?: unknown;
      duration?: unknown;
      chat_id?: string | number;
      width_and_height?: unknown;
      quality?: unknown;
      aspect_ratio?: unknown;
    };

    // --- 1. VALIDATE model (allowlist) — NO arbitrary endpoint passthrough. ---
    const endpoint = (typeof body.endpoint === "string" && body.endpoint) || DEFAULT_MODEL;
    const model = HF_MODELS[endpoint];
    if (!model) {
      return NextResponse.json(
        { error: "unsupported_model", message: "That video model isn't available." },
        { status: 400 },
      );
    }

    // --- 1b. VALIDATE params (pre-submit; only sanitized fields reach HF). ---
    const validated = validateInput(model, {
      image_url: body.image_url,
      prompt: body.prompt,
      duration: body.duration,
      width_and_height: body.width_and_height,
      quality: body.quality,
      aspect_ratio: body.aspect_ratio,
    });
    if (!validated.ok) {
      return NextResponse.json(
        { error: "invalid_params", message: validated.error },
        { status: 400 },
      );
    }
    const input = validated.input;

    // chat_id resolution — A1 primary, A2 fallback, then settle-only:
    //   A1 (agent): the skill passes --chat-id from the conversation metadata.
    //   A2 (fallback): if the agent omits it, use the VM's stored
    //       telegram_chat_id (populated by the passive backfill on telegram
    //       inbound traffic). Survives across VM restart — server-side state,
    //       which is why webhook delivery beats the agent-poll sketch.
    // IMAGE SUPPRESSION (2026-06-10): an image render is NEVER webhook-delivered.
    // It's either the intermediate source frame of a text->image->video flow
    // (pipeline plumbing the user never asked for) or a standalone image the
    // agent delivers inline from the returned URL. Signing `c` for an image made
    // the webhook ship it via sendTelegramVideo as higgsfield.mp4 -> a 00:00
    // unplayable "video". So for kind:image we force NO chat_id -> the webhook
    // settles only, never delivers. Only kind:image2video webhook-delivers.
    const chatIdFromAgent = body.chat_id != null ? String(body.chat_id) : undefined;
    const chatId =
      model.kind === "image"
        ? undefined
        : chatIdFromAgent ??
          (vm.telegram_chat_id ? String(vm.telegram_chat_id) : undefined);
    const chatIdSource =
      model.kind === "image"
        ? "suppressed_image"
        : chatIdFromAgent
          ? "agent"
          : chatId
            ? "vm_fallback"
            : "none";

    // --- 2. ESTIMATE our video-credit cost (held == charged; flat per model). ---
    const est = estimateVideoCredits(model);

    // --- 3. RESERVE (atomic hold) BEFORE any submit. Free-then-paid. ---
    const supabase = getSupabase();
    const internalRequestId = randomUUID(); // OUR billing idempotency key
    const windowStart = utcDayStartISO();
    const freshPendingCutoff = new Date(Date.now() - FRESH_PENDING_TTL_MS).toISOString();
    const freeCap = freeCapForTier(vm.tier);
    // prompt persisted for the /videos gallery (stage 1, park finding F-1):
    // the verbatim words ARE the creative artifact the lightbox celebrates.
    // Shown only to the owning user; ≤2000 chars (validateInput's cap).
    const metadata = {
      endpoint,
      chat_id: chatId ?? null,
      tier: vm.tier ?? null,
      prompt: typeof input.prompt === "string" ? input.prompt : null,
    };

    async function reserve(isFree: boolean) {
      return supabase.rpc("instaclaw_video_reserve_spend", {
        p_vm_id: vm.id,
        p_request_id: internalRequestId,
        p_endpoint: endpoint,
        p_est_credits: est,
        p_hf_cost_credits: model.hfCostCredits,
        p_is_free: isFree,
        p_free_cap_daily: freeCap,
        // ALWAYS a real cap — never NULL (hole #2 fix at the route layer).
        p_cap_daily: VIDEO_DAILY_CREDIT_CEILING,
        p_window_start: windowStart,
        p_fresh_pending_cutoff: freshPendingCutoff,
        p_metadata: metadata,
      });
    }

    // Free-eligible models try the free allowance first; on exhaustion (which
    // does NOT insert a row), fall through to a paid hold with the SAME id.
    let reserved: { reserved?: boolean; reason?: string; free?: boolean; [k: string]: unknown } | null = null;
    let usedFree = false;
    let usedSeed = false;

    // ── FIRST-VIDEO SEED (build order §4): one free premium text-to-video per
    // VM, granted on the FIRST video request (not at signup — spend only on
    // engaged users). Semantics, hostile-walked:
    //   • Marker-based eligibility: no prior metadata.seed row in
    //     pending/settled. metadata is GATE-constructed (the body has no
    //     metadata passthrough), so a caller can't forge the marker.
    //   • A FAILED seed render does NOT consume the gift — released rows are
    //     excluded, so the user's first impression actually delivers
    //     (mirrors the free-cap's "failed frees the slot" philosophy).
    //   • Credited users get it too: one render, universally delightful,
    //     and the eligibility check stays one indexed query.
    //   • p_free_cap_daily is effectively unbounded for the seed call — the
    //     route-level eligibility IS the gate; the daily soul/dop-lite cap
    //     is a different mechanism (and the (C) migration excludes seed rows
    //     from that count so the gift is additive, not a swap).
    //   • Double-submit race ≈ the ms between check and insert; pending rows
    //     count, so the second check sees the first's row once committed.
    //     Worst case: two seeds, $0.81 each. Accepted + bounded.
    //   • ANY seed-path failure falls through to the normal paid path — the
    //     gift can never block a request.
    if (!model.freeEligible && model.kind === "text2video") {
      try {
        const { data: priorSeed } = await supabase
          .from("instaclaw_video_transactions")
          .select("id")
          .eq("vm_id", vm.id)
          .eq("metadata->>seed", "true")
          .in("status", ["pending", "settled"])
          .limit(1);
        if (!priorSeed || priorSeed.length === 0) {
          const { data: seedRes, error: seedErr } = await supabase.rpc("instaclaw_video_reserve_spend", {
            p_vm_id: vm.id,
            p_request_id: internalRequestId,
            p_endpoint: endpoint,
            p_est_credits: est,
            p_hf_cost_credits: model.hfCostCredits,
            p_is_free: true,
            p_free_cap_daily: 999999, // route-level eligibility is the real gate
            p_cap_daily: VIDEO_DAILY_CREDIT_CEILING,
            p_window_start: windowStart,
            p_fresh_pending_cutoff: freshPendingCutoff,
            p_metadata: { ...metadata, seed: true },
          });
          if (!seedErr && seedRes?.reserved) {
            reserved = seedRes;
            usedFree = true;
            usedSeed = true;
            logger.info("first-video seed granted", {
              route: "gateway/higgsfield", vmId: vm.id, endpoint, internalRequestId,
            });
          }
        }
      } catch (err) {
        logger.warn("first-video seed check failed (falling through to paid)", {
          route: "gateway/higgsfield", vmId: vm.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!reserved?.reserved && model.freeEligible) {
      const { data, error } = await reserve(true);
      if (error) {
        logger.error("video reserve (free) RPC error", {
          route: "gateway/higgsfield", vmId: vm.id, error: error.message,
        });
        return NextResponse.json({ error: "reserve_failed" }, { status: 503 });
      }
      reserved = data;
      if (reserved?.reserved) {
        usedFree = true;
      } else if (reserved?.reason === "free_exhausted") {
        reserved = null; // fall through to paid
      } else {
        return denialResponse(String(reserved?.reason ?? "unknown"), reserved ?? {});
      }
    }

    if (!reserved?.reserved) {
      const { data, error } = await reserve(false);
      if (error) {
        logger.error("video reserve (paid) RPC error", {
          route: "gateway/higgsfield", vmId: vm.id, error: error.message,
        });
        return NextResponse.json({ error: "reserve_failed" }, { status: 503 });
      }
      reserved = data;
      if (!reserved?.reserved) {
        // DENIED → no submit, no spend.
        logger.info("video reserve denied", {
          route: "gateway/higgsfield", vmId: vm.id, reason: reserved?.reason, endpoint,
        });
        return denialResponse(String(reserved?.reason ?? "unknown"), reserved ?? {});
      }
    }

    // --- 4. Hold secured. Sign the delivery target + our request_id, then submit. ---
    // Signed webhook payload. r (our request_id) + v drive settle; t bounds replay.
    // c (chat_id) is included ONLY when present → its presence is the v1/v2 delivery
    // switch: absent (v1) = webhook settles only, the agent delivers; present (v2) =
    // webhook delivers directly. No chat_id is ever fabricated.
    const dPayload: { v: string; t: number; r: string; c?: string } = {
      v: vm.id,
      t: Date.now(),
      r: internalRequestId,
    };
    if (chatId) dPayload.c = chatId;
    const payload = Buffer.from(
      JSON.stringify(dPayload),
    ).toString("base64url");
    const sig = sign(payload, webhookSecret);
    const origin = process.env.HIGGSFIELD_WEBHOOK_BASE || req.nextUrl.origin;
    const webhookUrl = `${origin}/api/gateway/higgsfield/webhook?d=${payload}&s=${sig}`;

    const client = createHiggsfieldClient({ credentials: cloudKey });
    let submit: { request_id?: string; status?: string };
    try {
      submit = await client.subscribe(endpoint, {
        input,
        withPolling: false,
        webhook: { url: webhookUrl, secret: webhookSecret },
      });
    } catch (err) {
      // Submit failed → RELEASE the hold immediately so the user is never charged
      // and the balance availability isn't pinned by an orphaned hold.
      await supabase
        .rpc("instaclaw_video_release", {
          p_vm_id: vm.id,
          p_request_id: internalRequestId,
          p_reason: "submit_failed",
        })
        .then(undefined, () => {}); // best-effort; TTL is the backstop
      logger.error("Higgsfield submit failed; hold released", {
        route: "gateway/higgsfield",
        vmId: vm.id,
        errorName: err instanceof Error ? err.name : undefined,
        error: err instanceof Error ? err.message : String(err),
      });

      // ── L1 central-balance detector (build order §5; Rule 67 pattern). ──
      // The SDK throws a NAMED NotEnoughCreditsError (errors.js:41; thrown by
      // the v2 client on 402) when OUR central account is dry — the one
      // submit-failure that is OUR outage, not the user's quota and not HF
      // capacity. Detect by name AND statusCode AND message (robust to SDK
      // minification), P0-alert with a 1h dedup so the first failing render
      // of an incident wakes the operator without melting the inbox (every
      // render fails during the outage). Fire-and-forget: the alert never
      // delays or breaks the user response. User copy stays the honest
      // "temporarily at capacity" — they can't fix our billing, and the
      // skill's rules forbid "the service is broken" messaging.
      const isCentralBalanceDry =
        err instanceof Error &&
        (err.name === "NotEnoughCreditsError" ||
          (err as { statusCode?: number }).statusCode === 402 ||
          /not enough credits/i.test(err.message));
      if (isCentralBalanceDry) {
        (async () => {
          const dedupKey = "higgsfield_balance_exhausted:central";
          try {
            const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const { data: recent } = await supabase
              .from("instaclaw_admin_alert_log")
              .select("id")
              .eq("alert_key", dedupKey)
              .gte("sent_at", cutoff)
              .limit(1);
            if (recent && recent.length > 0) return;
            await supabase.from("instaclaw_admin_alert_log").insert({
              alert_key: dedupKey,
              vm_count: 1,
              details: `vm=${vm.id} endpoint=${endpoint}`,
            });
            const { sendAdminAlertEmail } = await import("@/lib/email");
            await sendAdminAlertEmail(
              "[P0] Higgsfield central balance EXHAUSTED — renders failing NOW",
              `A real render just failed with NotEnoughCredits: the central Higgsfield account is dry.\n\nvm=${vm.id}\nendpoint=${endpoint}\n\nEvery premium render is failing (users see "temporarily at capacity"; holds are auto-released, no one is charged).\n\nACT NOW: top up at platform.higgsfield.ai and verify auto-top-up (trigger 2000 → ceiling 8000) is enabled. The balance cron (/api/cron/higgsfield-balance-check) should have warned ahead of this — if it didn't, check its last run.`,
            );
          } catch (alertErr) {
            logger.error("higgsfield L1 balance alert failed", {
              route: "gateway/higgsfield",
              error: alertErr instanceof Error ? alertErr.message : String(alertErr),
            });
          }
        })().catch(() => {});
      }

      return NextResponse.json(
        {
          error: "service_unavailable",
          message: "Video generation is temporarily at capacity. Please try again shortly.",
        },
        { status: 503 },
      );
    }

    logger.info("Higgsfield generation submitted", {
      route: "gateway/higgsfield",
      vmId: vm.id,
      requestId: submit?.request_id,
      internalRequestId,
      endpoint,
      held: usedFree ? 0 : est,
      free: usedFree,
      seed: usedSeed,
      delivery: chatId ? "webhook" : "agent_poll",
      chatIdSource, // "agent" (A1) | "vm_fallback" (A2) | "none" — proves the delivery leg
    });

    return NextResponse.json({
      request_id: submit?.request_id ?? null,
      status: submit?.status ?? "queued",
      held: usedFree ? 0 : est,
      free: usedFree,
      // The first-video gift fired — the skill keys its "this one's on us"
      // moment (and the once-only post-delivery upsell guidance) on this.
      seed: usedSeed,
      // "webhook" → the gate will deliver the finished clip itself (chat_id
      // resolved via A1 or A2); "agent_poll" → the agent delivers from its poll
      // loop. The skill keys its hands-off behavior on this.
      delivery: chatId ? "webhook" : "agent_poll",
    });
  } catch (err) {
    logger.error("Higgsfield proxy error", {
      route: "gateway/higgsfield",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}
