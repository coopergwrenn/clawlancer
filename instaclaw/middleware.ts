import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/lib/auth.config";

/**
 * Next.js middleware for centralized route protection.
 *
 * Uses the Edge-compatible auth config (auth.config.ts) — no server-side
 * imports. The full auth config with Supabase callbacks lives in auth.ts.
 *
 * Defense-in-depth: individual route handlers still perform their own auth
 * checks. This middleware provides a first layer of protection so new routes
 * cannot accidentally be exposed without authentication.
 */
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isAuthenticated = !!req.auth?.user;

  // --- Protected page routes: redirect to sign-in if unauthenticated ---
  // NOTE: Pages under the (dashboard) route group resolve WITHOUT the group
  // prefix (e.g. /tasks, not /dashboard/tasks). Each must be listed here.
  const protectedPages = [
    "/dashboard", "/settings", "/billing", "/admin",
    "/tasks", "/history", "/files", "/scheduled", "/env-vars",
    "/ambassador", "/live", "/floor",
  ];
  const isProtectedPage = protectedPages.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  if (isProtectedPage && !isAuthenticated) {
    const signInUrl = new URL("/api/auth/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  // --- Protected API routes: return 401 JSON if unauthenticated ---
  // Excludes routes with their own auth mechanisms:
  //   /api/auth/*        — NextAuth routes
  //   /api/billing/webhook — Stripe signature verification
  //   /api/cron/*        — CRON_SECRET bearer token
  //   /api/vm/configure  — X-Admin-Key header
  //   /api/gateway/*     — X-Gateway-Token header
  //   /api/waitlist       — public
  //   /api/invite/validate — public
  const selfAuthAPIs = [
    "/api/auth",
    "/api/x402/facilitator", // x402 facilitator proxy — own auth via X-X402-Proxy-Secret header; relays verify/settle to CDP facilitator with CDP creds held backend-side (VMs never hold CDP_API_KEY_SECRET)
    "/api/billing/webhook",
    "/api/cron",
    "/api/vm/configure",
    "/api/vm/cloud-init-config", // Self-auth via X-Cloud-Init-Config-Token header — one-time-use per-VM token, atomic claim-and-invalidate at the route. Used by cloud-init bootstrap to fetch per-VM tarball. See app/api/vm/cloud-init-config/route.ts + plan §5.
    "/api/vm/cloud-init-callback", // Self-auth via X-Cloud-Init-Callback-Token header — one-time-use per-VM token (separate from config-token; in tarball, NOT in userdata). Companion to cloud-init-config; called by setup.sh §1.38 to mark VM healthy+assigned. See app/api/vm/cloud-init-callback/route.ts + plan §6.2.
    "/api/vm/resync-token",
    "/api/admin/provision",
    "/api/admin/pool-audit",
    "/api/admin/audit-identity",
    "/api/admin/lock-status", // public — operational metadata for partner-integrator coordination (Timour feedback #4 / P1-6)
    "/api/gateway",
    "/api/waitlist",
    "/api/invite/validate",
    "/api/invite/store",
    "/api/health",
    "/api/spots",
    "/api/hq",
    "/api/ambassador/badge",
    "/api/ambassador/validate-referral", // Public — read-only ambassador-code lookup. Returns {valid, discount, ambassadorName} given a referral code; ambassadorName is intentionally surfaced to the user typing the code ("referred by X" UX on /signin's referral expand + legacy /signup field). No DB writes; no PII beyond the public display name. Pre-existing bug exposed by the 2026-05-28 /signin auth-consolidation (Moves 1+2+5): the endpoint was missing from the allowlist since the ambassador system shipped, so /signup's silent fetch had been 401-ing for every unauthenticated user since day one. /signin makes the failure visible (red border + "referral code not found." copy on every valid code) which surfaced the bug. Rule 13 retroactively applied. /api/ambassador/apply + /status are correctly middleware-gated — their internal auth() check matches the middleware 401 outcome.
    "/api/agentbook/lookup",
    "/api/agentbook/register",
    "/api/agentbook/notify-complete",
    "/api/vm/heartbeat",
    "/api/virtuals/agent-auth-url",
    "/api/virtuals/agent-complete-auth",
    "/api/vm/identity",
    "/api/vm/validate",
    "/api/vm/fix-infra",
    "/api/vm/files/delivered",
    "/api/imessage/inbound", // Self-auth via sendblue-signature HMAC-SHA256 header verified against SENDBLUE_WEBHOOK_SECRET. See app/api/imessage/inbound/route.ts + docs/prd/onboarding-redesign-2026-05-26.md §6.5.4.
    "/api/channels/waitlist", // Public — channel waitlist signup form on /channels. Rate-limited by hashed IP (same ratchet as /api/waitlist). Always-open (not gated by WAITLIST_MODE) because channel waitlist is a separate UX surface from the legacy landing waitlist.
    "/api/telegram/shared-bot/inbound", // Self-auth via X-Telegram-Bot-Api-Secret-Token header verified against TELEGRAM_SHARED_BOT_WEBHOOK_SECRET. Mirrors /api/imessage/inbound's pattern for the Telegram shared bot path. See app/api/telegram/shared-bot/inbound/route.ts + docs/prd/onboarding-redesign-2026-05-26.md §6.5.4.
    "/api/imessage/vcard", // Public — serves the RFC 6350 vCard for our Sendblue number so users can "Save Contact" before texting (preempts iMessage Unknown Senders quarantine). Heavily cacheable static content; no PII, no DB.
    "/api/f",
    "/api/webhooks",
    "/api/instagram/token",
    "/api/notify",
    "/api/well-known",
    "/api/vm/dispatch-pair", // Pairing code redemption is public (code = auth)
    "/api/admin/setup-xmtp-clean", // X-Admin-Key header auth
    "/api/admin/xmtp-send", // X-Admin-Key header auth
    "/api/admin/xmtp-probe", // X-Admin-Key header auth
    "/api/admin/propagate-world-id", // CRON_SECRET header auth
    "/api/admin/fleet-push-workspace", // CRON_SECRET header auth
    "/api/admin/verify-workspace", // CRON_SECRET header auth
    "/api/admin/vm-fix", // CRON_SECRET header auth
    "/api/admin/restart-unhealthy", // CRON_SECRET header auth
    "/api/admin/xmtp-send-to-user", // Mini app proxy token or admin key
    "/api/admin/xmtp-refresh-token", // X-Admin-Key header auth
    "/api/admin/privacy-override", // X-Admin-Key header auth — legal-compliance kill switch for Maximum Privacy Mode
    "/api/admin/delete-user-archives", // X-Admin-Key header auth — GDPR Article 17 right-to-erasure for freeze-v2 archives (PRD §16.5). Prefix-matches /[userId].
    "/api/admin/reconcile-vm", // X-Admin-Key header auth — on-demand single-VM reconcile (Phase 2c stages + canary scripts)
    "/api/admin/telegram-shared-bot-webhook", // X-Admin-Key header auth — read/register the @myinstaclaw_bot webhook. Lives here because TELEGRAM_SHARED_BOT_TOKEN is Sensitive-flagged in Vercel so the equivalent local script can't read it.
    "/api/bankr/maintenance", // Public read-only — surfaces the Bankr maintenance flag to unauthenticated client surfaces (marketing /token page). Returns { maintenance: boolean }; no side effects. See app/api/bankr/maintenance/route.ts + lib/bankr-maintenance.ts.
    "/api/partner/tag", // Self-auth: handles both logged-in (updates user/VM record) and logged-out (sets cookie for next signup) cases; validates partner against VALID_PARTNERS allow-list
    "/api/partner/tag-redirect", // GET handler — NextAuth callbackUrl target for the /edge/claim "Sign in to claim it for Edge" link. Tags as edge_city + 302s to /dashboard. Handler enforces session internally; bounces unauth callers to /signin?callbackUrl=. (See app/api/partner/tag-redirect/route.ts.)
    "/api/edge/verify-ticket", // Public — the /edge/claim ticket verification gate. Pre-auth surface: an anonymous attendee submits their email, we round-trip EdgeOS, mint a 15-min HMAC-signed cookie + the instaclaw_partner cookie. Handler reads session inline so already-logged-in users get the column written immediately. Already-claimed check is gated by the partial UNIQUE on instaclaw_users.edge_verified_email.
    "/api/edge/start-email-login", // Public — 2026-05-22 three-auth-paths refactor. Anonymous attendees who chose the Email-code auth path POST {email} → we fire an EdgeOS OTP via requestEmailLoginOtp (third-party-login endpoint). Gated server-side by the edge_verified_email signed cookie set by /api/edge/verify-ticket above — refuses to fire OTPs for emails that haven't passed silent verify first.
    "/api/edge/verify-otp", // Public — 2026-05-22 three-auth-paths refactor. Anonymous attendees POST {email, code} → we call EdgeOS authenticate, create/link the instaclaw_users row, mint a one-shot HMAC token (lib/edge-otp-token.ts), return to the client which calls signIn(EDGE_EMAIL_OTP_PROVIDER_ID, {otpToken}). Gated server-side by the edge_verified_email signed cookie.
    "/api/internal", // X-Gateway-Token header auth (VM-side internal endpoints, e.g. check-privacy-mode for the SSH bridge)
    "/api/match", // Authorization: Bearer or X-Gateway-Token (matchpool VM bridge endpoints — POST /v1/profile, etc.)
    "/api/agent-economy/transaction", // Authorization: Bearer or X-Gateway-Token (Frontier VM reports a settled transaction). vm_id from token never body; idempotent on (vm_id, request_id). Record-only — no value moves here. See app/api/agent-economy/transaction/route.ts.
    "/api/agent-economy/offerings", // DUAL-AUTH: gateway token (agent frontier.add_offering) OR session (dashboard). Route's resolveVm() self-auths either way and scopes to one vmId. Listed so the gateway-token path isn't 401'd by the session gate. See app/api/agent-economy/offerings/route.ts.
    "/api/agent-economy/reputation", // Authorization: Bearer or X-Gateway-Token (Frontier VM queues ERC-8004 feedback). from_vm_id from token; feedback must anchor to the caller's own transaction. Covers /reputation/queue. See app/api/agent-economy/reputation/queue/route.ts.
    "/api/agent-economy/refund", // Authorization: Bearer or X-Gateway-Token (seller VM refunds a buyer). Atomic settled→refunded compare-and-set prevents double-refund; queues an on-chain refund for the worker (no funds move in-API). See app/api/agent-economy/refund/route.ts.
    "/api/agent-economy/authorize", // Authorization: Bearer or X-Gateway-Token (Frontier spend gate). vm_id from token never body. Reads the VM's track record → earned budget → policy → decision; reserves an authorized spend as a pending hold (idempotent on (vm_id, request_id)). No value moves — the wallet/chain is the financial backstop. See app/api/agent-economy/authorize/route.ts.
    "/api/agent-economy/settle", // Authorization: Bearer or X-Gateway-Token (Frontier spend settle — closes the feedback loop). vm_id from token. Atomic pending→settled|failed compare-and-set; records tx_hash (claim) + result_used (§7.3.2). Amount immutable from authorize. See app/api/agent-economy/settle/route.ts.
    "/api/agent-economy/settings", // Authorization: Bearer or X-Gateway-Token (agent-facing economy-settings write path). vm_id from token never body. STRUCTURALLY tighten-only: every field is combined monotonic-toward-safe against current effective (lib/frontier-settings-monotonic); loosenings apply to nothing and route to the session-authed dashboard. ON is dashboard-only. See app/api/agent-economy/settings/route.ts.
    "/api/agent/toolrouter/record-usage", // Authorization: Bearer or X-Gateway-Token (K.4 wrapper reports a ToolRouter tool call from each VM). vm_id + user_id resolved from token, NEVER body. Idempotent on trace_id via consume RPC. See app/api/agent/toolrouter/record-usage/route.ts.
    "/api/webhook/index-encounter", // X-Index-Signature HMAC-SHA256 auth (Index Network opportunity.accepted webhook → matchpool_outcomes INSERT)
  ];

  const isAPI = pathname.startsWith("/api/");
  const isSelfAuth = selfAuthAPIs.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  // Allow requests with X-Mini-App-Token through — the route handler validates the token.
  // These come from the World mini app (mini.instaclaw.io) proxy.
  const hasMiniAppToken = !!req.headers.get("x-mini-app-token");

  if (isAPI && !isSelfAuth && !isAuthenticated && !hasMiniAppToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
});

export const config = {
  // Run middleware on protected pages and API routes (skip static assets, _next, etc.)
  matcher: [
    "/dashboard/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/admin/:path*",
    "/tasks/:path*",
    "/history/:path*",
    "/files/:path*",
    "/scheduled/:path*",
    "/env-vars/:path*",
    "/ambassador/:path*",
    "/live/:path*",
    // The authed owner view + any future sub-routes (edge-auth parity with the
    // sibling pages above). NOTE: when the PUBLIC share view at /floor/[handle]
    // ships, exclude it from `protectedPages` so it stays reachable logged-out.
    "/floor/:path*",
    "/api/((?!auth|_next).*)",
  ],
};
