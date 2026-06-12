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
import { NextRequest, after } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyRevokeToken } from "@/lib/frontier-approvals";
import { recordSpendEvent } from "@/lib/frontier-spend-log";
import { runInterdiction, buildInterdictionEvents, revokeConfirmationCopy } from "@/lib/frontier-revoke";
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
    .select("id, assigned_to, frontier_spend_enabled")
    .eq("id", v.vmId)
    .maybeSingle();
  if (readErr || !vm) {
    logger.warn("revoke-spend: vm not found", { route: "agent-economy/revoke-spend", code: readErr?.code });
    return htmlPage("Couldn't find that agent", "We couldn't locate the agent for this link. Please use your dashboard.", 404);
  }

  if (vm.frontier_spend_enabled !== true) {
    // Already off (or never on) — idempotent for the FLAG, but NOT a no-op anymore.
    // Travel decouple (2026-06-12): session-required categories (travel) reserve
    // holds WITHOUT the standing opt-in (the per-spend session tap is their mandate),
    // so a never-opted-in VM can have live pending holds. Pre-decouple this early
    // return was airtight ("no opt-in ⇒ no holds possible"); post-decouple, skipping
    // interdiction here would make the panic link falsely report "no action was
    // needed" while a tapped travel hold stays live. So: ALWAYS interdict. Same
    // atomic status='pending' flip; settle's CAS then blocks any in-flight pay from
    // settling. Honest copy reports what was actually cancelled.
    const { holds: lateInterdicted, errored } = await runInterdiction(supabase, v.vmId);
    if (errored) {
      logger.warn("revoke-spend: interdiction (already-off path) failed (best-effort)", {
        route: "agent-economy/revoke-spend", vmId: v.vmId,
      });
    }
    if (lateInterdicted.length > 0) {
      const events = buildInterdictionEvents(v.vmId, (vm.assigned_to as string | null) ?? null, lateInterdicted);
      after(() => Promise.all(events.map((ev) => recordSpendEvent(supabase, ev))));
      return htmlPage(
        "Spending is off",
        `Autonomous spending was already turned off. We also cancelled ${lateInterdicted.length} in-flight spend hold${lateInterdicted.length === 1 ? "" : "s"} that ${lateInterdicted.length === 1 ? "was" : "were"} still pending.`,
        200,
      );
    }
    return htmlPage("Spending is off", "Autonomous spending for this agent is already turned off. No in-flight spends were pending.", 200);
  }

  // (1) FUTURE-spend gate — the existing master opt-in. Flip first; if this fails
  // we don't proceed to interdiction (the gate is the load-bearing half).
  const { error: updErr } = await supabase
    .from("instaclaw_vms")
    .update({ frontier_spend_enabled: false })
    .eq("id", v.vmId);
  if (updErr) {
    logger.error("revoke-spend: disable failed", { route: "agent-economy/revoke-spend", vmId: v.vmId, code: updErr.code });
    return htmlPage("Something went wrong", "We couldn't turn spending off just now. Please use your dashboard to disable it.", 500);
  }

  // (2) INTERDICT in-flight holds (Tier-0 G, mechanism C). One guarded UPDATE flips
  // every still-pending spend hold for this VM to 'revoked'. It is ATOMIC on
  // status='pending' — Postgres serializes it against settle's CAS (same guard), so
  // a hold either revokes here (and settle then finds 0 pending → loses cleanly) or
  // settles first (and is not in our flipped set). The returned rows ARE the
  // interdicted set. BEST-EFFORT: pre-migration the 'revoked' value violates the OLD
  // CHECK → the UPDATE is rejected → 0 flipped → caught → revoke still disabled future
  // spend (no regression), copy honestly reports 0 cancelled. No on-chain money is
  // touched here — this can only stop a hold from settling, never reverse a payment
  // the agent already broadcast.
  const { holds: interdicted, errored: interdictErrored } = await runInterdiction(supabase, v.vmId);
  if (interdictErrored) {
    logger.warn("revoke-spend: interdiction update failed (best-effort; 'revoked' enum may be pre-migration)", {
      route: "agent-economy/revoke-spend", vmId: v.vmId,
    });
  }

  // (3) One verdict-log row per interdicted hold (deny / revoked_in_flight) carrying
  // its transaction_id + amount — the complete trace for H's "revoke didn't
  // interdict" query. Post-response (after()), best-effort, never blocks.
  if (interdicted.length > 0) {
    const events = buildInterdictionEvents(v.vmId, (vm.assigned_to as string | null) ?? null, interdicted);
    after(() => Promise.all(events.map((ev) => recordSpendEvent(supabase, ev))));
  }

  logger.info("revoke-spend: disabled", {
    route: "agent-economy/revoke-spend", vmId: v.vmId, interdicted: interdicted.length,
  });
  const copy = revokeConfirmationCopy(interdicted.length);
  return htmlPage(copy.title, copy.body, 200);
}
