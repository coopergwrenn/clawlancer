import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

const MINI_USER_COOKIE = "ic_gmail_mini_user";

/**
 * GET /g/[code] — Google OAuth pairing code redemption (Route Handler)
 *
 * World Mini App users get a 6-char code. They open this URL in their
 * phone browser or WebView. Validates the code, sets the mini-user cookie,
 * and redirects to Google OAuth.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const supabase = getSupabase();

  // Look up the pairing code
  const { data: pairing, error } = await supabase
    .from("instaclaw_google_pairings")
    .select("user_id, expires_at, used")
    .eq("code", code.toUpperCase())
    .single();

  if (!pairing || error) {
    return new NextResponse(
      `<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 2rem;max-width:400px;margin:0 auto">
        <h2 style="font-size:1.25rem;margin-bottom:0.75rem">Invalid code</h2>
        <p style="color:#666;font-size:0.875rem">This pairing code doesn't exist. Go back to World App and tap "Connect Google" to get a new one.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  if (pairing.used) {
    return new NextResponse(
      `<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 2rem;max-width:400px;margin:0 auto">
        <h2 style="font-size:1.25rem;margin-bottom:0.75rem">Code already used</h2>
        <p style="color:#666;font-size:0.875rem">Go back to World App and tap "Connect Google" to get a new one.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  if (new Date(pairing.expires_at) < new Date()) {
    return new NextResponse(
      `<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 2rem;max-width:400px;margin:0 auto">
        <h2 style="font-size:1.25rem;margin-bottom:0.75rem">Code expired</h2>
        <p style="color:#666;font-size:0.875rem">Go back to World App and tap "Connect Google" to get a new one.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  // Mark code as used
  await supabase
    .from("instaclaw_google_pairings")
    .update({ used: true })
    .eq("code", code.toUpperCase());

  // Encode userId + CSRF in the state parameter instead of cookies.
  // This works even when Google OAuth opens in an external browser
  // (cookies set in the WebView aren't available in Chrome).
  const csrf = crypto.randomUUID();
  const statePayload = JSON.stringify({ userId: pairing.user_id, csrf, source: "mini-pair" });
  const state = Buffer.from(statePayload).toString("base64url");

  // Build Google OAuth URL
  const oauthParams = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${process.env.NEXTAUTH_URL}/api/gmail/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });

  // Return a "trampoline" page that:
  // 1. Redirects to Google OAuth (World App opens Chrome)
  // 2. When user returns to World App, auto-navigates back to mini app
  const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?${oauthParams.toString()}`;
  const miniAppHome = "https://mini.instaclaw.io/home?gmail=connected";

  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connecting to Google...</title>
<style>*{margin:0;padding:0}body{background:#000;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100dvh;text-align:center}p{font-size:14px;color:#999}.dot{animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}</style>
</head><body>
<div>
  <p>Opening Google<span class="dot">...</span></p>
  <p style="margin-top:12px;font-size:12px;color:#555">Complete sign-in, then come back here</p>
</div>
<script>
// Redirect to Google OAuth — World App will open this in Chrome
setTimeout(function() { window.location.href = "${googleUrl.replace(/"/g, '\\"')}"; }, 300);

// When user returns to this page (switches back from Chrome),
// navigate back to the mini app
document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === "visible") {
    window.location.href = "${miniAppHome}";
  }
});

// Fallback: if still on this page after 5 seconds, redirect back
setTimeout(function() {
  window.location.href = "${miniAppHome}";
}, 60000);
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
