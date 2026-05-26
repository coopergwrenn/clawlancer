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
    "/ambassador", "/live",
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
    "/api/bankr/maintenance", // Public read-only — surfaces the Bankr maintenance flag to unauthenticated client surfaces (marketing /token page). Returns { maintenance: boolean }; no side effects. See app/api/bankr/maintenance/route.ts + lib/bankr-maintenance.ts.
    "/api/partner/tag", // Self-auth: handles both logged-in (updates user/VM record) and logged-out (sets cookie for next signup) cases; validates partner against VALID_PARTNERS allow-list
    "/api/partner/tag-redirect", // GET handler — NextAuth callbackUrl target for the /edge/claim "Sign in to claim it for Edge" link. Tags as edge_city + 302s to /dashboard. Handler enforces session internally; bounces unauth callers to /signin?callbackUrl=. (See app/api/partner/tag-redirect/route.ts.)
    "/api/edge/verify-ticket", // Public — the /edge/claim ticket verification gate. Pre-auth surface: an anonymous attendee submits their email, we round-trip EdgeOS, mint a 15-min HMAC-signed cookie + the instaclaw_partner cookie. Handler reads session inline so already-logged-in users get the column written immediately. Already-claimed check is gated by the partial UNIQUE on instaclaw_users.edge_verified_email.
    "/api/edge/start-email-login", // Public — 2026-05-22 three-auth-paths refactor. Anonymous attendees who chose the Email-code auth path POST {email} → we fire an EdgeOS OTP via requestEmailLoginOtp (third-party-login endpoint). Gated server-side by the edge_verified_email signed cookie set by /api/edge/verify-ticket above — refuses to fire OTPs for emails that haven't passed silent verify first.
    "/api/edge/verify-otp", // Public — 2026-05-22 three-auth-paths refactor. Anonymous attendees POST {email, code} → we call EdgeOS authenticate, create/link the instaclaw_users row, mint a one-shot HMAC token (lib/edge-otp-token.ts), return to the client which calls signIn(EDGE_EMAIL_OTP_PROVIDER_ID, {otpToken}). Gated server-side by the edge_verified_email signed cookie.
    "/api/internal", // X-Gateway-Token header auth (VM-side internal endpoints, e.g. check-privacy-mode for the SSH bridge)
    "/api/match", // Authorization: Bearer or X-Gateway-Token (matchpool VM bridge endpoints — POST /v1/profile, etc.)
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
    "/api/((?!auth|_next).*)",
  ],
};
