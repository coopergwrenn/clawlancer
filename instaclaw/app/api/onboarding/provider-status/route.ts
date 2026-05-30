import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

/**
 * GET /api/onboarding/provider-status
 *
 * Returns the user's current "provider state" — used by the post-Stripe
 * /onboarding/provider page to decide whether to (a) render the
 * configure-provider UI or (b) short-circuit forward to /deploying or
 * /onboarding/done because the user already has a credential.
 *
 * Sensitive values are NEVER returned:
 *   - The Anthropic API key column is reported as a boolean (`hasAnthropicKey`)
 *   - The OAuth access token is reported as a boolean (`hasChatGPTOAuth`)
 *   - Only the ChatGPT plan type ("plus" / "pro" / "team") is returned as
 *     a string — that's a low-sensitivity display value (and OpenAI exposes
 *     it on the user's profile anyway).
 *
 * `channel` decides where the Provider page redirects after completion:
 *   - "imessage" / "telegram" / "discord" / "slack" → /onboarding/done
 *   - null → /deploying
 *
 * Auth: requires a session. Response shape matches the Provider client's
 * useEffect contract so the page can be rendered against this single call.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const supabase = getSupabase();

  // Two parallel single-row reads. The pending row may be null for
  // legacy onboarding shapes (skip-flow users, edge attendees who
  // bypassed /plan). The user row is always present at this point.
  const [{ data: pending }, { data: user }] = await Promise.all([
    supabase
      .from("instaclaw_pending_users")
      .select("id, api_mode, api_key, channel")
      .eq("user_id", userId)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("instaclaw_users")
      .select(
        "openai_oauth_access_token, openai_oauth_account_id, chatgpt_plan_type",
      )
      .eq("id", userId)
      .maybeSingle(),
  ]);

  // Reliable "currently connected to ChatGPT" signal: account_id is
  // nulled by disconnectUser (openai-oauth-db.ts:524-529). Checking it
  // alongside access_token guards against the disconnect-mid-rotation
  // race where access_token might briefly outlive account_id.
  const hasChatGPTOAuth = !!(
    user?.openai_oauth_access_token && user?.openai_oauth_account_id
  );
  const hasAnthropicKey = !!pending?.api_key;

  return NextResponse.json({
    pendingId: pending?.id ?? null,
    apiMode: (pending?.api_mode as "byok" | "all_inclusive" | null) ?? null,
    channel: (pending?.channel as string | null) ?? null,
    hasAnthropicKey,
    hasChatGPTOAuth,
    // Lowercase, OpenAI's canonical casing. Null if the user hasn't
    // connected ChatGPT (Google-only signins) or if it's an unrecognized
    // value (we treat unknown plans the same as no-plan for display).
    chatgptPlanType:
      (user?.chatgpt_plan_type as string | null | undefined) ?? null,
  });
}
