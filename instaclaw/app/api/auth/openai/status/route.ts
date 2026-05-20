/**
 * GET /api/auth/openai/status
 *
 * Read-only endpoint for the dashboard / settings UI to check whether
 * the user has a ChatGPT subscription connected, without triggering
 * any side effects (start route mints a new flow if not connected;
 * status route never does).
 *
 * Session-protected. NO feature-flag gate — the kill switch shouldn't
 * hide an existing connection's state from the user, only prevent new
 * connections (start route handles that).
 *
 * Response shape (matches the P2-A standard):
 *
 *   { status: "connected", summary }
 *   { status: "not_connected", reason: "no_tokens" | "feature_disabled" }
 *   { status: "unauthorized", message }
 *   { status: "error", message }
 *
 * The UI uses this on settings/dashboard mount to:
 *   - Show "Connected as <email> (Pro)" + Disconnect button, OR
 *   - Show "Connect ChatGPT" button (when no_tokens), OR
 *   - Show "Temporarily unavailable" notice (when feature_disabled +
 *     no tokens — kill switch is on and user isn't connected)
 *
 * If the user is connected AND the flag is off (transient state during
 * graceful-downgrade): we still return connected. The user's tokens are
 * still live on disk; the cron will tear them down within ~15min.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { isChatGPTOAuthEnabled } from "@/lib/chatgpt-oauth-feature-flag";
import { getConnectedSummary, type ConnectedSummary } from "@/lib/openai-oauth-db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ConnectedResponse {
  status: "connected";
  summary: ConnectedSummary;
}
interface NotConnectedResponse {
  status: "not_connected";
  reason: "no_tokens" | "feature_disabled";
}
interface ErrorResponse {
  status: "unauthorized" | "error";
  message: string;
}
type Response = ConnectedResponse | NotConnectedResponse | ErrorResponse;

export async function GET(): Promise<NextResponse<Response>> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { status: "unauthorized", message: "Sign in to view ChatGPT connection status." },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  const supabase = getSupabase();
  try {
    const summary = await getConnectedSummary(userId, supabase);
    if (summary.connected) {
      return NextResponse.json({ status: "connected", summary });
    }
    return NextResponse.json({
      status: "not_connected",
      // Disambiguate so the UI can show "Connect ChatGPT" vs "Temporarily
      // unavailable — try later" appropriately.
      reason: isChatGPTOAuthEnabled() ? "no_tokens" : "feature_disabled",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-oauth: status read failed", {
      userId,
      error: msg.slice(0, 400),
    });
    return NextResponse.json(
      {
        status: "error",
        message: "Couldn't read connection status. Please refresh.",
      },
      { status: 500 },
    );
  }
}
