import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getSupabase } from "@/lib/supabase";
import { sendTelegramVideo, sendTelegramNotification } from "@/lib/telegram";
import { HF_MODELS } from "@/lib/higgsfield-models";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300; // Rule 11 — downloads + uploads media

/**
 * Higgsfield Cloud API completion webhook — CANARY.
 *
 * Higgsfield POSTs here when a generation reaches a terminal state. Because the
 * Cloud API does NOT document a webhook signature scheme, we DO NOT trust the
 * body: we treat the callback as a "ping", then RE-FETCH the authoritative
 * status from platform.higgsfield.ai with OUR server key. The only thing we
 * trust from the URL is our own HMAC-signed `d` param (delivery target), which
 * a third party cannot forge.
 *
 * Security shape:
 *   - `d` (base64url {v:vmId, c:chatId, t:ts}) + `s` (HMAC) → verify, gives the
 *     delivery target. Tamper-proof.
 *   - `request_id` from the body → re-fetch /requests/{id}/status with our key.
 *     A forged ping can only point us at one of OUR OWN requests; it cannot
 *     inject an arbitrary video, and the recipient is fixed by the signed `d`.
 *
 * BILLING (guardrail #1): the route reserved a hold under OUR request_id
 * (`target.r`, carried tamper-proof in the signed `d`). Here we close it:
 *   completed              → instaclaw_video_settle (charge the held est_credits;
 *                            the RPC clamps charge ≤ hold, so it can't over-bill).
 *   failed/nsfw/cancelled  → instaclaw_video_release (no charge; provider also
 *                            auto-refunds us, R9).
 * Both are idempotent compare-and-set on `pending`, so Higgsfield's 2-hour
 * retry-until-2xx can't double-charge. Settle/release are best-effort and
 * INDEPENDENT of delivery — a delivery failure never affects the ledger and a
 * ledger miss never blocks delivery.
 *
 * On completed → deliver native Telegram video (50MB → link fallback).
 * On failed/nsfw/cancelled → calm message.
 *
 * Always returns 200 so Higgsfield doesn't infinite-retry; delivery failures
 * are logged, never surfaced raw.
 */

const HF_BASE = "https://platform.higgsfield.ai";
const MAX_TELEGRAM_BYTES = 50 * 1024 * 1024;
const WEBHOOK_TTL_MS = 60 * 60 * 1000; // accept callbacks within 60 min of submit
const ack = () => NextResponse.json({ ok: true }, { status: 200 });

function verifySig(data: string, sig: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig || "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    // --- HIGGSFIELD_GATE_ENABLED: emergency kill-switch (fail-closed; unset = OFF). ---
    // When off, the whole gate is dark — settle/deliver pause too. Higgsfield retries
    // for ~2h, so re-enabling within that window still settles + delivers in-flight
    // renders (deliberately a 503 here, not the usual 200-ack, to keep them retryable).
    if (process.env.HIGGSFIELD_GATE_ENABLED !== "true") {
      logger.warn("Higgsfield webhook disabled (kill-switch)", {
        route: "gateway/higgsfield/webhook",
        enabledRaw: process.env.HIGGSFIELD_GATE_ENABLED ?? "(unset)",
      });
      return NextResponse.json({ error: "video_disabled" }, { status: 503 });
    }

    const secret = process.env.HIGGSFIELD_WEBHOOK_SECRET;
    const cloudKey = process.env.HIGGSFIELD_CLOUD_KEY;
    if (!secret || !cloudKey) {
      logger.error("Higgsfield webhook not configured", { route: "gateway/higgsfield/webhook" });
      return ack();
    }

    // --- Verify our HMAC-signed delivery target ---
    const d = req.nextUrl.searchParams.get("d") || "";
    const s = req.nextUrl.searchParams.get("s") || "";
    if (!d || !verifySig(d, s, secret)) {
      logger.error("Higgsfield webhook bad signature", { route: "gateway/higgsfield/webhook" });
      return ack();
    }

    let target: { v?: string; c?: string; t?: number; r?: string };
    try {
      target = JSON.parse(Buffer.from(d, "base64url").toString("utf-8"));
    } catch {
      return ack();
    }
    // v (VM) + r (our request_id) drive settle/release; c (chat_id) is OPTIONAL
    // (present only on the v2 async-delivery path). v1 agent-poll → no c.
    if (
      !target?.v ||
      !target?.r ||
      typeof target.t !== "number" ||
      Date.now() - target.t > WEBHOOK_TTL_MS
    ) {
      logger.error("Higgsfield webhook target invalid/expired", { route: "gateway/higgsfield/webhook" });
      return ack();
    }

    // --- request_id from the ping (validated by the re-fetch below) ---
    const ping = (await req.json().catch(() => ({}))) as { request_id?: string };
    const requestId = ping?.request_id;
    if (!requestId || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      logger.error("Higgsfield webhook missing/odd request_id", { route: "gateway/higgsfield/webhook" });
      return ack();
    }

    // --- Re-fetch authoritative status from Higgsfield with OUR key ---
    let authoritative: {
      status?: string;
      video?: { url?: string };
      images?: Array<{ url?: string }>;
    };
    try {
      const res = await fetch(`${HF_BASE}/requests/${requestId}/status`, {
        headers: { Authorization: `Key ${cloudKey}` },
      });
      if (!res.ok) {
        logger.info("Higgsfield status re-fetch non-200", {
          route: "gateway/higgsfield/webhook",
          requestId,
          status: res.status,
        });
        return ack();
      }
      authoritative = await res.json();
    } catch (err) {
      logger.error("Higgsfield status re-fetch failed", {
        route: "gateway/higgsfield/webhook",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      return ack();
    }

    const status = authoritative?.status;
    const supabase = getSupabase();

    // --- BILLING (guardrail #1): settle on success, release otherwise. ---
    // Idempotent + independent of delivery. Keyed by OUR signed request_id.
    if (target.r) {
      try {
        if (status === "completed") {
          // Charge the HELD est_credits; the settle RPC clamps charge ≤ hold,
          // so we can never bill more than was reserved. Free holds charge 0.
          const { data: tx } = await supabase
            .from("instaclaw_video_transactions")
            .select("est_credits, is_free, status")
            .eq("vm_id", target.v)
            .eq("request_id", target.r)
            .single();
          if (tx) {
            const { data: settle } = await supabase.rpc("instaclaw_video_settle", {
              p_vm_id: target.v,
              p_request_id: target.r,
              p_actual_credits: Number(tx.est_credits) || 0,
              p_metadata: { hf_request_id: requestId, hf_status: status },
            });
            logger.info("video settle", {
              route: "gateway/higgsfield/webhook",
              vmId: target.v,
              requestId,
              settled: settle?.settled,
              charged: settle?.charged,
            });
          } else {
            logger.info("video settle skipped — no hold row", {
              route: "gateway/higgsfield/webhook", vmId: target.v, requestId,
            });
          }
        } else {
          // failed / nsfw / cancelled → release the hold, no charge.
          const { data: rel } = await supabase.rpc("instaclaw_video_release", {
            p_vm_id: target.v,
            p_request_id: target.r,
            p_reason: status || "unknown",
          });
          logger.info("video release", {
            route: "gateway/higgsfield/webhook",
            vmId: target.v,
            requestId,
            released: rel?.released,
            status,
          });
        }
      } catch (err) {
        // Never let a ledger hiccup block delivery; TTL releases stale holds.
        logger.error("video billing error (non-blocking)", {
          route: "gateway/higgsfield/webhook",
          vmId: target.v,
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- DELIVERY GATE (G1 Option B). ---
    // v1 (agent-poll): no chat_id was signed in → the webhook is SETTLE-ONLY and
    // the agent delivers in-conversation from its ?action=status poll loop. This
    // also makes delivery idempotent-by-construction (the webhook never delivers,
    // so a Higgsfield retry can't double-send). The proven delivery code below is
    // preserved for the v2 async path, which flips on by signing a chat_id (c).
    if (!target.c) {
      logger.info("video webhook settle-only (no chat_id; agent-poll delivery)", {
        route: "gateway/higgsfield/webhook",
        vmId: target.v,
        requestId,
        status,
      });
      return ack();
    }

    // --- Guard 1: registry-kind branch — never webhook-deliver an image. ---
    // (2026-06-10) The gate now suppresses `c` for kind:image, so this is defense
    // in depth: look up the render's endpoint and refuse to ship anything but a
    // video. An image (the intermediate source frame of text->image->video, or a
    // standalone image the agent delivers inline) shipped via sendTelegramVideo
    // as higgsfield.mp4 renders as a 00:00 unplayable "video".
    const { data: kindRow } = await supabase
      .from("instaclaw_video_transactions")
      .select("endpoint, metadata")
      .eq("vm_id", target.v)
      .eq("request_id", target.r)
      .single();
    const modelKind = kindRow?.endpoint ? HF_MODELS[kindRow.endpoint]?.kind : undefined;
    // First-video seed (build order §4): the gift gets its own caption — the
    // wow moment is marked in the delivery itself; the agent lands the
    // once-only upsell conversationally afterward (SKILL.md).
    const isSeed = (kindRow?.metadata as { seed?: boolean } | null)?.seed === true;
    if (modelKind === "image") {
      logger.info("video webhook: image render — delivery suppressed", {
        route: "gateway/higgsfield/webhook",
        vmId: target.v,
        requestId,
        endpoint: kindRow?.endpoint,
      });
      return ack();
    }

    // --- Resolve the delivery bot for this VM (v2 async-delivery path) ---
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("telegram_bot_token")
      .eq("id", target.v)
      .single();
    const botToken: string | undefined = vm?.telegram_bot_token || undefined;
    if (!botToken) {
      logger.error("Higgsfield webhook: no bot token for VM", {
        route: "gateway/higgsfield/webhook",
        vmId: target.v,
        status,
      });
      return ack();
    }

    // --- Guard 2: delivery idempotency, keyed on OUR request_id (1:1 render). ---
    // (2026-06-10) Higgsfield retries the webhook until 2xx, and this handler is
    // slow (fetch asset + upload to Telegram inline before returning), so a retry
    // can land mid-flight and deliver twice — observed: soul/standard's webhook
    // double-fired at 3:57 + 3:58. Atomic CAS a delivered marker on the
    // transaction row; only the winner proceeds. This is a DELIVERY-specific
    // dedup (separate from the settle CAS, per the fix ruling: keyed on the
    // render id, not just the hold) and covers BOTH the completed and the
    // non-completed message below.
    const { data: claimed, error: claimErr } = await supabase.rpc(
      "instaclaw_video_claim_delivery",
      { p_vm_id: target.v, p_request_id: target.r },
    );
    if (claimErr) {
      // FAIL OPEN: if the claim RPC is unavailable (not yet applied to prod, or a
      // transient DB error), deliver anyway. A rare duplicate is far better than
      // dropping the clip entirely. (Makes deploy order RPC-vs-code irrelevant.)
      logger.error("video webhook: claim rpc error — failing open (will deliver)", {
        route: "gateway/higgsfield/webhook",
        vmId: target.v,
        requestId,
        error: claimErr.message,
      });
    } else if (claimed === false) {
      // Definitively already claimed by a prior webhook → skip the duplicate.
      logger.info("video webhook: delivery already claimed — duplicate suppressed", {
        route: "gateway/higgsfield/webhook",
        vmId: target.v,
        requestId,
        status,
      });
      return ack();
    }

    // --- Non-completed terminal states: calm message, no charge logic ---
    // (No em-dashes in user-facing copy — standing rule.)
    if (status !== "completed") {
      const msg =
        status === "nsfw"
          ? "I couldn't make that one. Let's tweak the idea and try again."
          : "That one didn't render this time. Want me to try again?";
      await sendTelegramNotification(botToken, target.c, msg);
      logger.info("Higgsfield non-completed delivered", {
        route: "gateway/higgsfield/webhook",
        vmId: target.v,
        requestId,
        status,
      });
      return ack();
    }

    // --- Completed: deliver the video ---
    // video.url ONLY — never fall back to images[].url (that was the 00:00 bug:
    // an image asset shipped as higgsfield.mp4). A completed video render that
    // returns no video asset is a real failure → the !videoUrl branch tells the
    // user, and never ships an image as a "video".
    const videoUrl = authoritative?.video?.url;
    if (!videoUrl) {
      logger.error("Higgsfield completed but no media url", {
        route: "gateway/higgsfield/webhook",
        vmId: target.v,
        requestId,
      });
      await sendTelegramNotification(
        botToken,
        target.c,
        "Your video finished but I couldn't fetch it. Want me to try again?"
      );
      return ack();
    }

    // Native Telegram video; >50MB or send-failure → link fallback.
    // (Studio gallery pin is a no-op stub this canary pass — the URL is never
    //  lost: it's in the link fallback. Real Studio pin layers on later.)
    let delivered = false;
    try {
      const vidRes = await fetch(videoUrl);
      if (vidRes.ok) {
        const buf = Buffer.from(await vidRes.arrayBuffer());
        if (buf.length <= MAX_TELEGRAM_BYTES) {
          const r = await sendTelegramVideo(
            botToken,
            target.c,
            buf,
            "higgsfield.mp4",
            isSeed
              ? "🎬 Your first cinematic clip · on us. Made by your InstaClaw agent"
              : "🎬 Your cinematic clip · made by your InstaClaw agent"
          );
          delivered = r.success;
          if (!r.success) {
            logger.info("sendTelegramVideo failed; link fallback", {
              route: "gateway/higgsfield/webhook",
              error: r.error,
            });
          }
        } else {
          logger.info("Higgsfield video >50MB; link fallback", {
            route: "gateway/higgsfield/webhook",
            bytes: buf.length,
          });
        }
      } else {
        logger.info("Higgsfield video fetch non-200; link fallback", {
          route: "gateway/higgsfield/webhook",
          status: vidRes.status,
        });
      }
    } catch (err) {
      logger.info("Higgsfield video fetch/send error; link fallback", {
        route: "gateway/higgsfield/webhook",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!delivered) {
      await sendTelegramNotification(
        botToken,
        target.c,
        isSeed
          ? `🎬 Your first cinematic clip (on us) is ready:\n${videoUrl}`
          : `🎬 Your cinematic clip is ready:\n${videoUrl}`
      );
    }

    logger.info("Higgsfield video delivered", {
      route: "gateway/higgsfield/webhook",
      vmId: target.v,
      requestId,
      mode: delivered ? "video" : "link",
    });
    return ack();
  } catch (err) {
    logger.error("Higgsfield webhook error", {
      route: "gateway/higgsfield/webhook",
      error: err instanceof Error ? err.message : String(err),
    });
    return ack();
  }
}
