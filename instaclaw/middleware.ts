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
  const protectedPages = ["/dashboard", "/settings", "/billing", "/admin"];
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
    "/api/gateway",
    "/api/waitlist",
    "/api/invite/validate",
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
    "/api/((?!auth|_next).*)",
  ],
};
