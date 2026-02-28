import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Temporary diagnostic endpoint — tests a Telegram token from Vercel's
// serverless environment and returns the raw Telegram API response.
// This helps us see exactly why token validation is failing.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { token } = await req.json();
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const rawLength = token.length;

  // Apply the same sanitization as settings/update
  const sanitized = token.replace(/[^a-zA-Z0-9:_-]/g, "");
  const sanitizedLength = sanitized.length;
  const charsStripped = rawLength - sanitizedLength;

  // Show what characters were stripped (by char code)
  const strippedChars: string[] = [];
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (!/[a-zA-Z0-9:_-]/.test(ch)) {
      strippedChars.push(`U+${token.charCodeAt(i).toString(16).padStart(4, "0")}`);
    }
  }

  // Call Telegram getMe with the sanitized token
  let telegramResponse: unknown = null;
  let telegramStatus = 0;
  let fetchError: string | null = null;
  try {
    const url = `https://api.telegram.org/bot${sanitized}/getMe`;
    const res = await fetch(url);
    telegramStatus = res.status;
    telegramResponse = await res.json();
  } catch (err) {
    fetchError = String(err);
  }

  return NextResponse.json({
    rawLength,
    sanitizedLength,
    charsStripped,
    strippedChars,
    tokenPrefix: sanitized.slice(0, 10),
    tokenSuffix: sanitized.slice(-5),
    telegramStatus,
    telegramResponse,
    fetchError,
  });
}
