import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { encryptApiKey } from "@/lib/security";
import { logger } from "@/lib/logger";

/**
 * POST /api/onboarding/save-provider
 *
 * Single entry point for the post-Stripe /onboarding/provider page.
 * Accepts EITHER:
 *   - { apiKey: "sk-ant-…" }       → save Anthropic key path
 *   - {} (no body fields)           → confirm ChatGPT OAuth state path
 *
 * Both paths:
 *   1. Validate the appropriate credential is present.
 *   2. For Anthropic: encrypt + write to instaclaw_pending_users.api_key.
 *   3. Fire-and-forget /api/vm/configure for the user (server-side, admin
 *      key). configureOpenClaw is idempotent — calling it again with the
 *      updated pending row writes the new auth-profiles. If the VM is
 *      still in cloud-init's first 15-min protection window, the configure
 *      endpoint returns {skipped:true} and the on-VM setup.sh picks up
 *      the saved value when it provisions.
 *
 * Returns { ok: true } on success. Errors return 400/401/500 with
 * { error: "..." } for the Provider page to display inline.
 *
 * Loose Anthropic key validation: prefix + length only. The real check
 * is the first API call from the VM. We catch the obvious
 * "user pasted a Stripe key" / "half-key paste" class of mistake; we
 * deliberately don't tighten the regex because Anthropic's segment
 * scheme has changed (sk-ant-api03-…, sk-ant-api04-…, older sk-ant-…
 * without a segment).
 */
const ANTHROPIC_KEY_PREFIX_RE = /^sk-ant-[A-Za-z0-9_-]{8,}$/;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: { apiKey?: string };
  try {
    body = (await req.json()) as { apiKey?: string };
  } catch {
    body = {};
  }

  const rawApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const isAnthropicPath = rawApiKey.length > 0;

  const supabase = getSupabase();

  if (isAnthropicPath) {
    // ── Anthropic path ─────────────────────────────────────────────
    if (!ANTHROPIC_KEY_PREFIX_RE.test(rawApiKey)) {
      return NextResponse.json(
        {
          error:
            "That doesn't look like an Anthropic API key. Keys start with sk-ant-…",
        },
        { status: 400 },
      );
    }

    // Encrypt before persisting. Mirrors the legacy /api/onboarding/save
    // path so existing decryption code (lib/decryptApiKey at
    // app/api/vm/configure/route.ts:321) reads it transparently.
    let encrypted: string;
    try {
      encrypted = await encryptApiKey(rawApiKey);
    } catch (err) {
      logger.error("save-provider: encryptApiKey threw", {
        route: "onboarding/save-provider",
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: "Server encryption error. Please try again." },
        { status: 500 },
      );
    }

    // Upsert by user_id (the table has a UNIQUE constraint on user_id).
    // If the user has a pending row, update its api_key — preserving
    // every other column (tier, telegram tokens, channel, etc.). If they
    // don't have a pending row (legacy edge), create a minimal one so
    // configure-OpenClaw can still read api_key on its next call.
    const { data: existing } = await supabase
      .from("instaclaw_pending_users")
      .select("id")
      .eq("user_id", userId)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing?.id) {
      const { error: updateErr } = await supabase
        .from("instaclaw_pending_users")
        .update({ api_key: encrypted, api_mode: "byok" })
        .eq("id", existing.id);
      if (updateErr) {
        logger.error("save-provider: pending update failed", {
          route: "onboarding/save-provider",
          userId,
          error: String(updateErr),
        });
        return NextResponse.json(
          { error: "Failed to save key. Please try again." },
          { status: 500 },
        );
      }
    } else {
      const { error: insertErr } = await supabase
        .from("instaclaw_pending_users")
        .insert({
          user_id: userId,
          api_mode: "byok",
          api_key: encrypted,
        });
      if (insertErr) {
        logger.error("save-provider: pending insert failed", {
          route: "onboarding/save-provider",
          userId,
          error: String(insertErr),
        });
        return NextResponse.json(
          { error: "Failed to save key. Please try again." },
          { status: 500 },
        );
      }
    }
  } else {
    // ── ChatGPT-OAuth confirmation path ───────────────────────────
    // The modal that opened from /onboarding/provider already wrote
    // openai_oauth_access_token + account_id via /api/auth/openai/
    // device-code/poll. We just verify those are in place and proceed.
    // If the modal failed silently (state desync), refuse with a clear
    // error so the Provider page can re-prompt.
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("openai_oauth_access_token, openai_oauth_account_id")
      .eq("id", userId)
      .maybeSingle();
    const hasOAuth = !!(
      user?.openai_oauth_access_token && user?.openai_oauth_account_id
    );
    if (!hasOAuth) {
      return NextResponse.json(
        {
          error:
            "ChatGPT connection not detected. Try opening the connect dialog again.",
        },
        { status: 400 },
      );
    }
  }

  // ── Fire-and-forget /api/vm/configure ───────────────────────────
  //
  // configureOpenClaw re-reads pending_users.api_key + the user's OAuth
  // row at the top of its body, so the call below picks up our just-
  // written credential. It's idempotent — if a parallel configure
  // (Stripe webhook, checkout/verify) is mid-flight, whichever
  // completes last writes the final auth-profiles, and the reconciler
  // tick is the safety net (≤3 min).
  //
  // We DON'T await this. The Provider page wants a fast redirect; the
  // /deploying or /onboarding/done page already has the polling UX for
  // "VM coming up". Trying to await configure (60-150s) would just
  // stall the redirect. The configure endpoint has its own 300s
  // maxDuration server-side.
  //
  // Errors are absorbed — same pattern as billing/checkout's existing-
  // sub configure fire. The /deploying page surfaces VM problems via
  // its own polling, so we don't double-surface here.
  const adminKey = process.env.ADMIN_API_KEY;
  const nextauthUrl = process.env.NEXTAUTH_URL;
  if (adminKey && nextauthUrl) {
    fetch(`${nextauthUrl}/api/vm/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": adminKey,
      },
      body: JSON.stringify({ userId }),
    }).catch((err) => {
      // Logged but doesn't surface to the user — configure is best-
      // effort here; the reconciler picks up any straggler within 3 min.
      logger.warn("save-provider: configure fire-and-forget failed", {
        route: "onboarding/save-provider",
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return NextResponse.json({ ok: true });
}
