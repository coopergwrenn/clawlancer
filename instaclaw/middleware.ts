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
    "/api/admin/provision",
    "/api/admin/pool-audit",
    "/api/gateway",
    "/api/waitlist",
    "/api/invite/validate",
    "/api/invite/store",
    "/api/health",
    "/api/spots",
    "/api/hq",
  ];

  const isAPI = pathname.startsWith("/api/");
  const isSelfAuth = selfAuthAPIs.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  if (isAPI && !isSelfAuth && !isAuthenticated) {
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
    "/api/((?!auth|_next).*)",
  ],
};
