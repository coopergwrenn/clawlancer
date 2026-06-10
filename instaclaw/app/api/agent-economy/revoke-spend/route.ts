/**
 * GET /api/agent-economy/revoke-spend?token=<hmac>  --  the one-tap revoke
 * (Frontier human_approved hardening, Surface 3).
 *
 * The detection notification ("your agent spent $X with your approval -- was that
 * you?") carries a Revoke URL-button pointing here. Tapping it DISABLES autonomous
 * spend for that VM (instaclaw_vms.frontier_spend_enabled = false -- the existing
 * fail-closed master opt-in). The /authorize gate then denies every spend with
 * reason "spend_not_enabled" until the human re-enables it from the dashboard.
 *
 * AUTH: an HMAC token over (vm_id, issued_at) signed with NEXTAUTH_SECRET (verified
 * via lib/frontier-approvals.verifyRevokeToken). A signed one-tap GET is the right
 * shape here and NOT a session, by deliberate asymmetry:
 *   - ENABLING spend is the dangerous direction -> routes through the NextAuth session
 *     (/spend-settings). An agent must never be able to enable its own spend.
 *   - DISABLING spend is the fail-safe direction -> one-tap. The worst an attacker
 *     with a leaked link can do is turn a customer's spend OFF (an annoyance, never a
 *     loss). The HMAC makes the link unguessable + unforgeable by the agent (it never
 *     holds NEXTAUTH_SECRET).
 *
 * Self-auth route (the token is the auth) -> MUST be in middleware selfAuthAPIs (Rule 13).
 * Returns a small HTML page (opened in the user's browser from the Telegram button).
 */
import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyRevokeToken } from "@/lib/frontier-approvals";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const APP_URL =
  process.env.INSTACLAW_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://instaclaw.io";

function htmlPage(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#0b0b0c;color:#e8e8ea;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{max-width:440px;width:100%;background:#161617;border:1px solid #2a2a2c;border-radius:16px;padding:28px 24px;text-align:center}
  h1{font-size:19px;margin:0 0 10px}
  p{font-size:15px;line-height:1.5;color:#b6b6bb;margin:0 0 18px}
  a{display:inline-block;background:#3b6cf6;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-size:15px}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p>
<a href="${APP_URL}/economy">Open spending settings</a></div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const v = verifyRevokeToken(token, Date.now());
  if (!v.ok) {
    const why =
      v.reason === "expired"
        ? "This revoke link has expired. You can turn spending off from your dashboard."
        : "This revoke link is invalid. You can turn spending off from your dashboard.";
    return htmlPage("Link not valid", why, 400);
  }

  const supabase = getSupabase();
  // Confirm the VM exists, then disable autonomous spend (fail-safe direction).
  const { data: vm, error: readErr } = await supabase
    .from("instaclaw_vms")
    .select("id, frontier_spend_enabled")
    .eq("id", v.vmId)
    .maybeSingle();
  if (readErr || !vm) {
    logger.warn("revoke-spend: vm not found", { route: "agent-economy/revoke-spend", code: readErr?.code });
    return htmlPage("Couldn't find that agent", "We couldn't locate the agent for this link. Please use your dashboard.", 404);
  }

  if (vm.frontier_spend_enabled !== true) {
    // Already off (or never on) — idempotent success.
    return htmlPage("Spending is off", "Autonomous spending for this agent is already turned off. No action was needed.", 200);
  }

  const { error: updErr } = await supabase
    .from("instaclaw_vms")
    .update({ frontier_spend_enabled: false })
    .eq("id", v.vmId);
  if (updErr) {
    logger.error("revoke-spend: disable failed", { route: "agent-economy/revoke-spend", vmId: v.vmId, code: updErr.code });
    return htmlPage("Something went wrong", "We couldn't turn spending off just now. Please use your dashboard to disable it.", 500);
  }

  logger.info("revoke-spend: disabled", { route: "agent-economy/revoke-spend", vmId: v.vmId });
  return htmlPage(
    "Spending turned off",
    "Autonomous spending for this agent is now off. Your agent will ask before any further payments. You can re-enable it any time from your dashboard.",
    200,
  );
}
