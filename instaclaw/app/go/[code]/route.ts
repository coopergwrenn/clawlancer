/**
 * /go/:code — short-link resolver for channel-onboarding flow.
 *
 * Welcome Message 3 (the bare URL in its own iMessage / Telegram
 * bubble) points here. The user taps the link, lands on this route,
 * we look up the pending_users.short_code in the DB, and hand off
 * to /auth?session=<id>.
 *
 * Why HTML response (not bare 302) on the happy path:
 *   iMessage / Twitter / Slack / Discord all fetch the URL when it
 *   arrives and look for OG meta tags to build the preview card.
 *   A 302 gives the crawler nothing — it shows up as a gray
 *   "Tap to Load Preview" with just the domain. Returning HTML with
 *   og:title / og:description / og:image gives the crawler a rich
 *   branded card while the user's browser still redirects via meta
 *   refresh (0s delay) + JS replace. Net effect: bots see a real
 *   preview, humans land at /auth nearly instantly.
 *
 * Behavior table:
 *   - Malformed code (regex fail)    → 302 /?go=invalid
 *   - Code not found in DB           → 302 /?go=notfound
 *   - Code found, already consumed   → 302 /dashboard
 *   - Code found, still in-flight    → 200 HTML with OG + redirect
 *
 * The non-happy-path branches stay as 302 because:
 *   - They're terminal user-facing destinations (not waiting for an
 *     OG-preview moment to land).
 *   - A pasted-as-URL link to a malformed/notfound short_code
 *     shouldn't get the rich-card treatment — that would imply the
 *     destination is valid.
 *
 * Public route: no auth required (per design — the URL itself is
 * the only credential). The middleware matcher in middleware.ts
 * does NOT include /go/*, so requests reach this handler directly.
 *
 * Why .select("*") over a column list:
 *   Per CLAUDE.md Rule 19, safety-critical reads use .select("*")
 *   to avoid silent column-grant gotchas under RLS. Here we need
 *   id + consumed_at + short_code itself, plus this is the entry
 *   point to onboarding — being wrong here means a paying user
 *   sees a broken link.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { VALID_PARTNERS } from "@/lib/partner-tag";

/**
 * Cookie name set when ?p=<slug> is present + valid (P1-A fix, 2026-05-27).
 *
 * Mirrors the cookie set by /api/partner/tag and /edge/claim — same name,
 * same SameSite=Lax, same 7-day TTL. Once set, the signIn callback at
 * lib/auth.ts:234 reads it and applies tagUserAsPartner during OAuth.
 *
 * The web-only partner paths (clicking "Claim" on /edge or /edge-city)
 * already set this cookie via /api/partner/tag. The cold-text path
 * (poster QR → text → Welcome 3 link with ?p=) now hits the same
 * pipeline via this handler. One mechanism, two entry points.
 */
const PARTNER_COOKIE = "instaclaw_partner";
const PARTNER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7d (survives OAuth roundtrip)

// Short_code format: 4-8 chars, lowercase alphanumeric.
// Migration column: VARCHAR(8). Generator: 5 chars [a-z0-9].
// Tolerant of 4-8 in case we ever change the length and the user
// has an older link cached.
const SHORT_CODE_REGEX = /^[a-z0-9]{4,8}$/;

// Pin to the canonical preview URL. The /opengraph-image route
// (app/opengraph-image.tsx) renders the branded card at this path.
// Absolute URL is required — crawlers don't follow relative og:image
// references reliably.
const OG_IMAGE_URL = "https://instaclaw.io/opengraph-image";
const OG_TITLE = "instaclaw";
const OG_DESCRIPTION =
  "your personalized agent, with its own computer. live in minutes.";

/**
 * 302 redirect with anti-caching + anti-indexing headers.
 *
 * Cache-Control: no-store prevents browsers and CDNs from caching
 * the redirect. We need every visit to re-resolve because the
 * underlying pending_users.consumed_at can change between visits
 * (active → consumed) — a cached 302 would send a returning user
 * to the wrong destination.
 *
 * X-Robots-Tag: noindex, nofollow keeps these URLs out of search
 * indexes if they ever leak (screenshotted, shared, etc.).
 */
function redirectWithNoCache(target: URL): NextResponse {
  const response = NextResponse.redirect(target, { status: 302 });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

/**
 * Escape a URL or text for safe embedding in an HTML attribute /
 * meta content. Belt-and-suspenders — the `pendingId` is a UUID
 * from our own DB so it can't contain user-controlled HTML, but
 * we'd rather have one tiny escape helper than risk a future
 * variant landing user-controlled text in this template.
 */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render the OG-bearing HTML page. iMessage / Twitter / Slack /
 * Discord crawlers scrape the meta tags; browsers follow the
 * meta-refresh + JS replace to /auth.
 *
 * The fallback <a> handles the rare case where both meta-refresh
 * AND JS are disabled (text-mode browsers, accessibility tools).
 * Tapping the visible "continuing to InstaClaw" link in those
 * environments completes the handoff.
 *
 * Body styles deliberately minimal — the page exists for 100ms
 * before redirect; we don't ship the whole landing CSS, just a
 * brief brand-consistent message so the redirect feels intentional
 * rather than a blank flash.
 */
function htmlWithOgRedirect(target: string): string {
  const safeTarget = escapeHtmlAttr(target);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtmlAttr(OG_TITLE)}</title>
  <meta name="description" content="${escapeHtmlAttr(OG_DESCRIPTION)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="instaclaw" />
  <meta property="og:title" content="${escapeHtmlAttr(OG_TITLE)}" />
  <meta property="og:description" content="${escapeHtmlAttr(OG_DESCRIPTION)}" />
  <meta property="og:image" content="${escapeHtmlAttr(OG_IMAGE_URL)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="instaclaw — your personalized agent, with its own computer." />
  <meta property="og:url" content="https://instaclaw.io/" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@instaclaws" />
  <meta name="twitter:title" content="${escapeHtmlAttr(OG_TITLE)}" />
  <meta name="twitter:description" content="${escapeHtmlAttr(OG_DESCRIPTION)}" />
  <meta name="twitter:image" content="${escapeHtmlAttr(OG_IMAGE_URL)}" />
  <meta http-equiv="refresh" content="0; url=${safeTarget}" />
  <meta name="robots" content="noindex, nofollow" />
  <link rel="canonical" href="https://instaclaw.io/" />
  <script>window.location.replace(${JSON.stringify(target)});</script>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #f8f7f4;
      color: #333334;
      font-family: ui-serif, Georgia, "Times New Roman", serif;
      height: 100%;
    }
    main {
      min-height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
    }
    a { color: #E96F4D; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <p style="font-size:18px;opacity:0.7">continuing to <a href="${safeTarget}">instaclaw</a>…</p>
  </main>
</body>
</html>`;
}

function htmlResponseWithOg(target: string): NextResponse {
  const body = htmlWithOgRedirect(target);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Allow crawlers to cache the OG-bearing HTML briefly so they
      // don't pound our DB on every preview retry. The browser
      // experience is fast even on cache miss (one DB lookup).
      "cache-control": "public, max-age=120, s-maxage=120",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: rawCode } = await params;

  // iOS Safari and Telegram in-app browsers preserve URL case
  // exactly as the user tapped, but iMessage's auto-link sometimes
  // capitalizes the first letter when the URL is right after a
  // period. Normalize to lowercase before the regex + DB lookup.
  const code = (rawCode || "").toLowerCase().trim();

  if (!SHORT_CODE_REGEX.test(code)) {
    logger.warn("[/go] malformed short_code", {
      rawCodeLength: rawCode?.length ?? 0,
    });
    return redirectWithNoCache(new URL("/?go=invalid", req.url));
  }

  // P1-A: validate `?p=<slug>` partner hint. Source is the inbound
  // webhook's detectPartnerFromText (cold-text edge attendees). We
  // re-validate against VALID_PARTNERS so an attacker forwarding a
  // crafted link can't tag themselves into a partner cohort they
  // shouldn't be in. Unknown/invalid → null (drop silently).
  const rawPartner = req.nextUrl.searchParams.get("p");
  const partnerHint =
    rawPartner && VALID_PARTNERS.has(rawPartner) ? rawPartner : null;

  const supabase = getSupabase();

  const { data: pending, error } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .eq("short_code", code)
    .maybeSingle();

  if (error) {
    logger.error("[/go] DB error looking up short_code", {
      code,
      errorMessage: error.message,
    });
    // Treat as not-found from the user's POV. We don't want to
    // leak DB state to the channel-onboarding flow.
    return redirectWithNoCache(new URL("/?go=notfound", req.url));
  }

  if (!pending) {
    logger.info("[/go] short_code not found", { code });
    return redirectWithNoCache(new URL("/?go=notfound", req.url));
  }

  // Already consumed (VM ready, M_RETURN fired). The link served
  // its purpose; the user is fully onboarded. Send them to the
  // dashboard — the auth-session check there will redirect to
  // /signin if they're not logged in, which is the right
  // affordance for a returning user revisiting an old link.
  if (pending.consumed_at) {
    logger.info("[/go] short_code already consumed; redirecting to dashboard", {
      code,
      consumedAt: pending.consumed_at,
    });
    return redirectWithNoCache(new URL("/dashboard", req.url));
  }

  // Active in-flight signup. Return HTML with OG meta so the link
  // preview card looks branded. Browsers follow the meta-refresh +
  // JS replace to /auth?session=<id> nearly instantly.
  //
  // P1-A: when a valid partner hint is present, set the
  // instaclaw_partner cookie BEFORE the response. The signIn callback
  // (lib/auth.ts:234) reads this cookie during OAuth and applies
  // tagUserAsPartner — putting the user on the sponsored path without
  // ever requiring a web /edge visit.
  logger.info("[/go] resolved to active session; serving OG HTML + redirect", {
    code,
    pendingId: pending.id,
    channel: pending.channel,
    partnerHint,
  });
  const response = htmlResponseWithOg(`/auth?session=${pending.id}`);
  if (partnerHint) {
    response.cookies.set(PARTNER_COOKIE, partnerHint, {
      path: "/",
      maxAge: PARTNER_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
  }
  return response;
}
