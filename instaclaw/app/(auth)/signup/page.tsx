import { redirect } from "next/navigation";

/**
 * /signup — historical signup form, now a thin redirect to /signin.
 *
 * Why: /signin's "Sign in with Google" creates a new InstaClaw user on
 * first authentication (lib/auth.ts:194-548 — Google signIn callback
 * INSERTs the user row if google_id isn't found). There is no
 * difference between "sign in" and "sign up" at the OAuth layer, so
 * maintaining two pages with the same primary action just creates
 * visual + voice drift (legacy /signup was title-case "Create your
 * account" while /signin is lowercase "sign in.").
 *
 * The Edge variant of /signup ("Claim your agent" + olive ink when
 * partner=edge_city cookie is set) was dead code — Edge attendees
 * authenticate inline on /edge/claim and never reach /signup. The
 * Title-case "Already have an account? Sign in" cross-link to /signin
 * is also gone with the page.
 *
 * What survives via this redirect:
 *
 *   1. **Ambassador referral links.** Existing /signup?ref=cooper-1
 *      URLs are baked into X posts, ambassador Slack threads, email
 *      campaigns, and printed materials. We can't hard-404 those
 *      without breaking the contract. This 307 preserves ?ref= so the
 *      downstream /signin can pre-fill its referral input (Move 2 in
 *      the auth-consolidation plan).
 *
 *   2. **Partner cookie (instaclaw_partner).** Cookies travel with
 *      redirects via the browser's standard request handling. The
 *      OAuth signIn callback at lib/auth.ts reads
 *      cookieJar.get("instaclaw_partner") server-side regardless of
 *      which entry page the user came from. So Edge / Consensus /
 *      future-partner cookies set elsewhere (e.g. /go/[code], /edge
 *      flow) survive across the redirect untouched.
 *
 *   3. **localStorage `instaclaw_ref` (deferred to Move 2).** The
 *      previous /signup read localStorage on mount to pre-fill the
 *      referral field from a prior visit's stored code. Until Move 2
 *      ships the /signin referral expand (which will mirror that
 *      read-on-mount), the localStorage hand-off is silently broken
 *      for users who don't carry ?ref= in this visit's URL. Few-hour
 *      gap during the auth-consolidation session; acceptable.
 *
 * Implementation: Next 15 server component. `searchParams` arrives as
 * a Promise — see signin/page.tsx for the same pattern. We pick the
 * first value if the param is an array (defensive — ?ref=a&ref=b
 * shouldn't happen in practice).
 *
 * Don't read this file and infer that "/signup" is a permanent
 * second-class citizen — the route exists ONLY to preserve external
 * link contracts. If/when ambassador campaigns finish migrating to
 * /signin?ref=, the file can be deleted outright in a future cleanup.
 */

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawRef = Array.isArray(params.ref) ? params.ref[0] : params.ref;
  const ref = rawRef?.trim();
  redirect(ref ? `/signin?ref=${encodeURIComponent(ref)}` : "/signin");
}
