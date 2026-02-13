import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";

export async function GET() {
  const authenticated = await verifyHQAuth();
  return NextResponse.json({ authenticated });
}
