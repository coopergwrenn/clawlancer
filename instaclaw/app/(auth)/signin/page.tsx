import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignInClient } from "./signin-client";

/**
 * /signin server-component wrapper.
 *
 * W5 audit fix (2026-05-22): the previous client-only implementation
 * always rendered the sign-in buttons, even for already-authenticated
 * users. A logged-in user hitting /signin (via back-button, bookmark,
 * or direct nav) saw the buttons as if they weren't authed. Clicking
 * Google re-triggered OAuth (NextAuth gracefully no-op'd but the UI
 * showed the wrong state). For an Edge attendee who completed Google
 * OAuth then back-buttoned, this was disorienting.
 *
 * Server-side now:
 *   1. Call `auth()` to detect existing session.
 *   2. Parse + validate `?callbackUrl=` from searchParams.
 *   3. If session exists, redirect to callbackUrl.
 *   4. Otherwise, render the client component with the validated
 *      callbackUrl prop.
 *
 * No Suspense boundary needed — the previous Suspense wrapper existed
 * only because useSearchParams suspends. Now that the URL param parsing
 * lives server-side, the client component receives callbackUrl as a
 * prop and renders synchronously.
 *
 * ## callbackUrl validation
 *
 * The URL param is attacker-controlled (any user can craft a /signin
 * link with arbitrary callbackUrl). We validate:
 *
 *   - Must be a relative path (starts with "/"). Rejects external URLs
 *     like `https://attacker.com` (open-redirect prevention).
 *   - Must NOT be /signin itself or any /signin/* path (loop
 *     prevention — authed user → redirect to /signin → server sees
 *     session → redirect to callbackUrl=/signin → ...).
 *   - Fallback: /dashboard.
 *
 * Both NextAuth's signIn() call and our /api/auth/openai/signup/poll
 * flow ultimately call signIn() with the callbackUrl, and NextAuth
 * does its own external-URL prevention — but defense-in-depth here
 * means a stale link wouldn't even reach signIn() with garbage.
 */

const DEFAULT_CALLBACK_URL = "/dashboard";

function sanitizeCallbackUrl(raw: string | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_CALLBACK_URL;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_CALLBACK_URL;
  // Decode in case the param arrives URL-encoded ("%2Fconnect").
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
  // Open-redirect prevention: must be a relative path.
  if (!decoded.startsWith("/")) return DEFAULT_CALLBACK_URL;
  // Protocol-relative URL ("//attacker.com/...") — also reject.
  if (decoded.startsWith("//")) return DEFAULT_CALLBACK_URL;
  // Loop prevention: redirecting back to /signin would just bounce.
  if (decoded === "/signin" || decoded.startsWith("/signin?") || decoded.startsWith("/signin/")) {
    return DEFAULT_CALLBACK_URL;
  }
  return decoded;
}

/**
 * Sanitize the ?ref= query param — the referral code passed through
 * by ambassador campaign URLs (e.g. /signin?ref=cooper-1 directly,
 * or /signup?ref=cooper-1 which Move 3's redirect rewrites to
 * /signin?ref=cooper-1).
 *
 * Allowed shape: alphanumeric + hyphen + underscore, 1-64 chars.
 * Matches the format ambassadors generate via the admin tools.
 * Anything outside that shape is rejected to prevent stored-XSS
 * vectors via the input's value re-render — the input would echo
 * arbitrary user-controlled strings into the DOM otherwise.
 *
 * Returns undefined if no ref is provided OR the value is malformed
 * (treated equivalently — the client just doesn't auto-open the
 * referral expand on mount). The validate-referral endpoint also
 * rejects malformed codes server-side, so this is defense in depth.
 */
function sanitizeRef(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim().slice(0, 64);
  if (!trimmed) return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export default async function SignInPage({
  searchParams,
}: {
  // Next 15: searchParams arrives as a Promise in server components.
  searchParams: Promise<{
    callbackUrl?: string | string[];
    ref?: string | string[];
    new?: string | string[];
  }>;
}) {
  const params = await searchParams;
  // searchParams values are string | string[]; we only use the first.
  const rawCallback = Array.isArray(params.callbackUrl)
    ? params.callbackUrl[0]
    : params.callbackUrl;
  const callbackUrl = sanitizeCallbackUrl(rawCallback);

  // Ref param (Move 2): passed through from ambassador campaign URLs
  // or from /signup?ref= via Move 3's redirect. Sanitized server-side
  // (alphanumeric/hyphen/underscore, ≤64 chars) and handed to the
  // client as `initialRef` — the client uses it to auto-open the
  // referral expand and pre-fill the input on mount.
  const rawRef = Array.isArray(params.ref) ? params.ref[0] : params.ref;
  const initialRef = sanitizeRef(rawRef);

  // ── Newcomer intent (2026-05-30) ─────────────────────────────────
  //
  // A user arriving from the landing-page "Claim My Agent" CTA, or
  // mid-funnel via the /channels → /onboarding/web path, is here to
  // CLAIM something — not to return to an existing account. /signin
  // detects this state and swaps the headline from "sign in." →
  // "claim your agent." so the emotional energy of the click is
  // honored on landing.
  //
  // Two detection signals (OR'd):
  //   1. Explicit `?new=1` query param (appended by hero CTAs we
  //      control — landing "Claim My Agent" + nav "get started").
  //   2. `callbackUrl` pointing into the onboarding funnel
  //      (/onboarding/*, /plan, /channels). These callbackUrls only
  //      get set when middleware redirects an unauth user away from
  //      a mid-funnel page — which means they're CLAIMING an agent,
  //      not returning to one. (The default /dashboard callbackUrl
  //      stays as a "returning" signal because it covers both
  //      back-button traffic and direct dashboard visits.)
  //
  // Why server-side: the server wrapper already does all param
  // parsing (W5 audit fix, 2026-05-22). Keeping `isNewUser` server-
  // side avoids a Suspense boundary and prevents headline flicker
  // on hydration.
  //
  // The default ("sign in.") still wins for direct visits, nav-"sign
  // in" clicks, marketing-page links, and dashboard-callback
  // middleware bounces. False negatives (a new user gets the boring
  // copy) are tolerable; false positives (a returning user gets
  // "claim your agent.") would be jarring, so the gates are strict.
  const rawNew = Array.isArray(params.new) ? params.new[0] : params.new;
  const isExplicitNew = rawNew === "1";
  const isFunnelMid =
    callbackUrl.startsWith("/onboarding/") ||
    callbackUrl.startsWith("/plan") ||
    callbackUrl.startsWith("/channels") ||
    callbackUrl.startsWith("/connect") ||
    callbackUrl.startsWith("/deploying");
  const isNewUser = isExplicitNew || isFunnelMid;

  const session = await auth();
  if (session?.user?.id) {
    // Already authenticated — skip the buttons, go straight to the
    // intended destination. This also catches the Edge-attendee
    // back-button case (completed OAuth, back-buttoned to /signin,
    // would otherwise see the buttons re-rendered).
    redirect(callbackUrl);
  }

  return (
    <SignInClient
      callbackUrl={callbackUrl}
      initialRef={initialRef}
      isNewUser={isNewUser}
    />
  );
}
