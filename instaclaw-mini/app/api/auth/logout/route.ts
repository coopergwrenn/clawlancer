import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete("session");
  cookieStore.delete("siwe-nonce");
  return NextResponse.json({ ok: true });
}
