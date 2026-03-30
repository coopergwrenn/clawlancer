import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const GMAIL_TOKEN_COOKIE = "ic_gmail_token";
const GMAIL_STATE_COOKIE = "ic_gmail_state";
const MINI_USER_COOKIE = "ic_gmail_mini_user";
const TOKEN_MAX_AGE_SECONDS = 300;
const MINI_APP_BASE = "https://world.org/mini-app?app_id=app_a4e2de774b1bda0426e78cda2ddb8cfd";

/** Redirect helper: sends mini app users back to World App, web users to dashboard */
function redirectFor(isMini: boolean, req: NextRequest, errorParam?: string): NextResponse {
  const url = isMini
    ? `${MINI_APP_BASE}${errorParam ? `&gmail_error=${encodeURIComponent(errorParam)}` : "&gmail=connected"}`
    : new URL(`/dashboard${errorParam ? `?gmail_error=${errorParam}` : ""}`, req.url).toString();
  const res = NextResponse.redirect(url);
  res.cookies.set(MINI_USER_COOKIE, "", { maxAge: 0, path: "/" });
  res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}

/**
 * GET /api/gmail/callback
 *
 * Handles the OAuth callback after the user grants gmail.readonly scope.
 * Supports both web dashboard users (NextAuth) and mini app users (cookie).
 * Exchanges the authorization code for tokens, stores them in the database,
 * and redirects appropriately.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = searchParams.get("state");

  // ── Try to extract userId from state parameter (mini-app pairing flow) ──
  let miniPairUserId: string | null = null;
  let isMiniPair = false;
  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
      if (decoded.source === "mini-pair" && decoded.userId) {
        miniPairUserId = decoded.userId;
        isMiniPair = true;
      }
    } catch {
      // Not a mini-pair state — proceed with normal flow
    }
  }

  // Auth priority: mini-pair state > mini-app cookie > NextAuth session
  // When isMiniPair is true, ALWAYS use the pairing userId — even if
  // the user has a NextAuth session in Chrome (could be a different account).
  let userId: string | undefined;
  let isMiniApp = false;

  if (isMiniPair && miniPairUserId) {
    userId = miniPairUserId;
    isMiniApp = true;
  } else {
    const miniCookieUserId = req.cookies.get(MINI_USER_COOKIE)?.value;
    if (miniCookieUserId) {
      userId = miniCookieUserId;
      isMiniApp = true;
    } else {
      const session = await auth();
      userId = session?.user?.id;
    }
  }

  if (!userId) {
    return NextResponse.redirect(new URL("/signin", req.url));
  }

  // ── CSRF validation ───────────────────────────────────────────────
  // Mini-pair flow: CSRF is embedded in the state (no cookie needed)
  // Normal flow: validate state matches cookie
  if (!isMiniPair) {
    const stateCookie = req.cookies.get(GMAIL_STATE_COOKIE)?.value;
    if (!state || !stateCookie || state !== stateCookie) {
      logger.error("Gmail OAuth CSRF mismatch", {
        hasState: !!state,
        hasCookie: !!stateCookie,
        userId,
        route: "gmail/callback",
      });
      return redirectFor(isMiniApp, req, "csrf");
    }
  }

  // User denied the permission
  if (error) {
    logger.warn("Gmail OAuth denied", { error, userId, route: "gmail/callback" });
    return redirectFor(isMiniApp, req, "denied");
  }

  if (!code) {
    logger.error("Gmail OAuth callback missing code", { userId, route: "gmail/callback" });
    return redirectFor(isMiniApp, req, "missing_code");
  }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${process.env.NEXTAUTH_URL}/api/gmail/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.error("Gmail token exchange failed", { status: tokenRes.status, body: errBody, route: "gmail/callback" });
      return redirectFor(isMiniApp, req, "token_exchange");
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    if (!accessToken) {
      logger.error("Gmail token exchange returned no access_token", { route: "gmail/callback" });
      return redirectFor(isMiniApp, req, "no_token");
    }

    // Store tokens in database for the authenticating user
    const supabase = getSupabase();
    const gmailFields = {
      gmail_connected: true,
      gmail_access_token: accessToken,
      gmail_refresh_token: refreshToken || null,
      gmail_connected_at: new Date().toISOString(),
    };
    const { error: dbError } = await supabase
      .from("instaclaw_users")
      .update(gmailFields)
      .eq("id", userId);

    if (dbError) {
      logger.error("Failed to store Gmail tokens", { error: String(dbError), userId, route: "gmail/callback" });
      if (isMiniApp) return redirectFor(true, req, "db_write_failed");
      // Web users: continue with cookie-based flow as fallback
    }

    // ── Propagate Gmail tokens to linked accounts ──
    // If this user has a wallet or World ID, sync tokens to all accounts sharing them
    try {
      const { data: thisUser } = await supabase
        .from("instaclaw_users")
        .select("world_wallet_address, world_id_nullifier_hash")
        .eq("id", userId)
        .single();

      if (thisUser) {
        const conditions: string[] = [];
        if (thisUser.world_wallet_address) {
          conditions.push(`world_wallet_address.eq.${thisUser.world_wallet_address}`);
        }
        if (thisUser.world_id_nullifier_hash) {
          conditions.push(`world_id_nullifier_hash.eq.${thisUser.world_id_nullifier_hash}`);
        }
        if (conditions.length > 0) {
          const { error: propError, count } = await supabase
            .from("instaclaw_users")
            .update(gmailFields)
            .or(conditions.join(","))
            .neq("id", userId);
          if (count && count > 0) {
            logger.info("Propagated Gmail tokens to linked accounts", { userId, count, route: "gmail/callback" });
          }
          if (propError) {
            logger.warn("Gmail propagation failed (non-fatal)", { error: String(propError), route: "gmail/callback" });
          }
        }
      }
    } catch (propErr) {
      logger.warn("Gmail propagation error (non-fatal)", { error: String(propErr), route: "gmail/callback" });
    }

    if (isMiniApp) {
      return redirectFor(true, req);  // success — no error param
    }

    // Store access token in httpOnly cookie for immediate insights fetch
    const res = NextResponse.redirect(
      new URL("/dashboard?gmail_ready=1", req.url)
    );
    res.cookies.set(GMAIL_TOKEN_COOKIE, accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: TOKEN_MAX_AGE_SECONDS,
      path: "/",
    });
    res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  } catch (err) {
    logger.error("Gmail callback error", { error: String(err), route: "gmail/callback" });
    return redirectFor(isMiniApp, req, "callback_failed");
  }
}
