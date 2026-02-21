import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { sendInviteEmail, buildInviteEmailHtml } from "@/lib/email";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    const apiKey = req.headers.get("x-api-key");
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { to, code } = await req.json();
  if (!to) {
    return NextResponse.json(
      { error: "Missing 'to' email address" },
      { status: 400 }
    );
  }

  const testCode = code || "TEST-XXXX-1234";

  try {
    await sendInviteEmail(to, testCode);
    return NextResponse.json({ sent: true, to, code: testCode });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Send failed" },
      { status: 500 }
    );
  }
}

/** GET returns the raw HTML for browser preview */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    const apiKey = req.nextUrl.searchParams.get("key");
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const code = req.nextUrl.searchParams.get("code") || "ABCD-EFGH-1234";
  const html = buildInviteEmailHtml(code);

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
