import { NextResponse } from "next/server";

/**
 * GET /api/spots — Proxy to instaclaw.io/api/spots to avoid CORS.
 * Falls back to hardcoded count if upstream is unreachable.
 */
export async function GET() {
  try {
    const res = await fetch("https://instaclaw.io/api/spots", {
      next: { revalidate: 60 },
    });
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json(data);
    }
  } catch {
    // upstream unreachable
  }

  // Fallback
  return NextResponse.json({ available: 62 });
}
