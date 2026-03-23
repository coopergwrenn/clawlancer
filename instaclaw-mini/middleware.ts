import { NextRequest, NextResponse } from "next/server";

/**
 * Mini app middleware: protect tab pages from unauthenticated access.
 * API routes handle their own auth. The root page (/) handles onboarding.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = !!req.cookies.get("session")?.value;

  // Protected tab pages — redirect to onboarding if no session
  const protectedPaths = ["/home", "/skills", "/chat", "/settings"];
  const isProtected = protectedPaths.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  if (isProtected && !hasSession) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/home/:path*", "/skills/:path*", "/chat/:path*", "/settings/:path*"],
};
