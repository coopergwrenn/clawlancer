import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const cookieStore = await cookies();
  cookieStore.set("siwe-nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });
  return NextResponse.json({ nonce });
}
