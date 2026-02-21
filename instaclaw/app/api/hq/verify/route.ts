import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  const authenticated = await verifyHQAuth();
  return NextResponse.json({ authenticated });
}
