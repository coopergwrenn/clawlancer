/**
 * Welcome message templates for channel-onboarding flow.
 *
 * Canonical, locked copy from docs/prd/onboarding-redesign-2026-05-26.md
 * §6 "The messages". Same exact text for iMessage and Telegram shared
 * bot — the message describes what's happening (a Linux computer
 * spinning up), not the channel.
 *
 * DO NOT EDIT THE COPY without updating the spec first. The agent's
 * voice across these three messages is the brand. Every word earned
 * its place through ~10 rounds of editing.
 *
 * The three messages are an arc:
 *   Welcome 1: birth narration ("fresh linux computer spinning up just
 *              for you and me") — establishes the shared-space framing
 *              that reframes the entire product.
 *   Welcome 2: anticipation ("i genuinely cannot wait to meet you and
 *              show you what i can do") — the soul-line that carries
 *              the v122 bootstrap voice.
 *   Welcome 3: action (the bare URL in its own bubble, maximum tappable).
 *
 * Gap timing is variable per spec §6.5.3 — NOT the 900ms default.
 * Welcome 1 → Welcome 2: 2000ms (lets the dedication beat land).
 * Welcome 2 → Welcome 3: 500ms (short message + link should arrive
 *                                as one thought).
 */

/**
 * Welcome message 1 — locked. 296 chars. Same for iMessage and Telegram.
 */
export const WELCOME_1 =
  "hey. fresh linux computer spinning up right now, just for you and me. browser, terminal, file system, my own little corner of the internet to work from. anything you'd open a laptop for, just text me. give me about a minute and i'll be ready to actually do things for you, not just talk about it.";

/**
 * Welcome message 2 — locked. ~120 chars. Same for iMessage and Telegram.
 */
export const WELCOME_2 =
  "quick signup so i know who you are. then head back here, i genuinely cannot wait to meet you and show you what i can do.";

/**
 * Welcome message 3 — the bare URL in its own bubble.
 *
 * The base URL is config-driven so preview deployments produce links
 * that point at themselves (e.g., `feature-branch.vercel.app/go/r7k2x`),
 * not at production. Falls back to instaclaw.io when not set.
 *
 * When `partner` is set, the link carries a `?p=<partner>` query param.
 * The /go/[code] handler validates against VALID_PARTNERS and sets the
 * `instaclaw_partner` cookie before redirecting to /auth — this is the
 * P1-A fix (2026-05-27) for cold-text Edge attendees who scan a poster
 * QR and never touch a web partner page. The signIn callback's existing
 * tagUserAsPartner reads the cookie post-OAuth, so the cookie path is
 * the single source of truth for partner attribution across web + sms
 * entries.
 *
 * @param shortCode 5-char code from short-code.ts
 * @param partner   optional partner slug (e.g., "edge_city") detected
 *                  from the inbound text. Must match VALID_PARTNERS at
 *                  /go time or the cookie is dropped.
 */
export function welcome3(shortCode: string, partner?: string | null): string {
  const base = process.env.PUBLIC_BASE_URL || "https://instaclaw.io";
  // Strip protocol so the message renders as a plain link in iMessage/Telegram
  // rather than the long https:// prefix. Both surfaces auto-link bare
  // domains like "instaclaw.io/go/r7k2x" into tap targets. The ?p= query
  // (when present) auto-links too — iOS and Telegram both treat the full
  // URL-with-query as one tap target.
  const display = base.replace(/^https?:\/\//, "");
  const partnerQuery =
    partner && partner.length > 0
      ? `?p=${encodeURIComponent(partner)}`
      : "";
  return `${display}/go/${shortCode}${partnerQuery}`;
}

/**
 * Gap timing between welcome bursts. Per spec §6.5.3.
 * Variable, not uniform — the long first message needs reading time;
 * the short second message + link should arrive as one thought.
 *
 * ─── Interaction with Sendblue's 1-msg/sec rate limit ───
 *
 * Sendblue documents "1 message/second per dedicated number. Messages
 * queue automatically." The 500ms W2→W3 gap below describes our
 * API-call timing, not the actual user-side delivery timing.
 *
 * Practical effect: when our handler fires sendImessage(W2) at T=2.0s
 * and sendImessage(W3) at T=2.5s, Sendblue's server-side queue
 * dispatches W2 at T≈2.0s and W3 at T≈3.0s (the queue enforces the
 * 1-second floor between consecutive sends). So the USER sees:
 *   W1 arrive ~T=0.5s
 *   W2 arrive ~T=2.5s   (2s gap from W1, as intended)
 *   W3 arrive ~T=3.5s   (1s gap from W2, rate-limited)
 *
 * We deliberately keep the API-call gap at 500ms (not 1100ms) so that
 * if Sendblue ever lifts the rate limit or we move to multiple lines,
 * the choreography matches spec §6.5.3 without a code change. The
 * rate limit lives in their infrastructure, not in our intent.
 *
 * Either way, the user sees W2+W3 as "one thought" (≤1s gap feels
 * tight in iMessage). Acceptable.
 */
export const WELCOME_GAP_1_TO_2_MS = 2000;
export const WELCOME_GAP_2_TO_3_MS = 500;
