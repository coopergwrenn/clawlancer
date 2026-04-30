/**
 * Tweet template registry for the post-launch share-to-X moment.
 *
 * Single source of truth for the 5 randomized templates the celebration
 * card uses. Both webapp BankrWalletCard and instaclaw-mini's
 * BankrTokenizeCard call pickTweetTemplate(args) — the mini-app keeps a
 * port at instaclaw-mini/lib/bankr-tweet-templates.ts that should stay
 * in sync.
 *
 * Why 5 templates: a wave of simultaneous launches would otherwise make
 * the @instaclaws timeline look templated, killing the magic. Different
 * angles also catch different reader emotions — lifecycle, observation,
 * identity, philosophy, narrative.
 *
 * agentName interpolation: pulled from the VM row (telegram_bot_username
 * or agent_name). We strip a trailing "_bot" suffix and Telegram-style
 * underscores so the tweet reads naturally. If the cleaned name is too
 * thin (<2 chars) we silently drop into the no-name fallback variant.
 */

export interface TweetArgs {
  tokenSymbol: string; // ticker, will be uppercased
  agentName?: string | null; // raw VM-side name (may be null/empty/bot-suffixed)
  address?: string | null; // contract address; if absent, URL is omitted
  /**
   * If true, append a "verified human" suffix to the credits line so
   * external readers see the trust signal. Set when the user who
   * launched is World ID verified at moment-of-launch.
   */
  verifiedHuman?: boolean;
}

const HASHTAGS = "@instaclaws + @bankrbot";
const HASHTAGS_VERIFIED = "@instaclaws + @bankrbot · verified human";
// Item #5: switched from bankr.bot/launches/ to instaclaw.io/launches/
// so X unfurls our InstaClaw-branded OG card (rendered by
// app/launches/[addr]/opengraph-image.tsx) instead of Bankr's. The
// landing page itself credits + links Bankr prominently.
const URL_BASE = "https://instaclaw.io/launches/";
// Twitter caps tweets at 280 chars. We cap at 275 with "…" if a
// templated string ever exceeds — protects against an unlucky combo of
// max-length ticker + max-length name + future copy edit blowing the limit.
const TWEET_LIMIT = 280;
const TRUNCATE_AT = 275;

function cleanAgentName(raw?: string | null): string | null {
  if (!raw) return null;
  let name = raw.trim();
  // Strip leading @ and trailing _bot / -bot. Telegram bot usernames
  // commonly end in "_bot"; the human-meaningful name is the rest.
  if (name.startsWith("@")) name = name.slice(1);
  name = name.replace(/[_-]?bot$/i, "");
  // Strip control chars (newlines, tabs, carriage returns) BEFORE the
  // separator-to-space pass — otherwise they'd be preserved into the
  // tweet body and break it across lines on X.
  name = name.replace(/[\r\n\t]+/g, " ");
  // Replace remaining separator chars with spaces for readability.
  name = name.replace(/[_-]+/g, " ");
  // Strip everything that isn't alphanumeric or space — handles emoji,
  // punctuation, accidental @-mention bait like "@#$%". Done AFTER the
  // separator-to-space pass so "moon_dust" still becomes "moon dust"
  // rather than collapsing to "moondust".
  name = name.replace(/[^a-zA-Z0-9 ]/g, "");
  // Final whitespace normalization in case prior steps produced runs.
  name = name.replace(/\s+/g, " ").trim();
  if (name.length < 2) return null;
  return name;
}

type Builder = (args: { sym: string; name: string | null; url: string; credits: string }) => string;

// Each template has both a with-name and without-name variant. The
// no-name variant is used if cleanAgentName returns null. They are
// deliberately written so that timeline diversity is preserved
// regardless of which variant runs.
const BUILDERS: Builder[] = [
  // 1. lifecycle / self-funding
  ({ sym, name, url, credits }) =>
    name
      ? `my agent ${name} just deployed $${sym} on Base. it runs the wallet, earns trading fees, funds its own compute. self-funding from day one. ${credits}.\n\n${url}`
      : `my AI agent just deployed $${sym} on Base. it runs the wallet, owns the token, earns the trading fees. self-funding from day one. ${credits}.\n\n${url}`,

  // 2. agents that pay rent
  ({ sym, name, url, credits }) =>
    name
      ? `$${sym} is live on Base. my AI agent ${name} owns the wallet, owns the token, earns the fees. agents that pay rent. ${credits}.\n\n${url}`
      : `$${sym} is live on Base. my AI agent owns the wallet, owns the token, earns the fees. agents that pay rent. ${credits}.\n\n${url}`,

  // 3. observation / chat-launch wonder
  ({ sym, name, url, credits }) =>
    name
      ? `watching ${name} launch its own token in chat was strange and beautiful. $${sym} on Base. trading fees → its compute → it gets smarter. ${credits}.\n\n${url}`
      : `watching my AI agent launch its own token in chat was strange and beautiful. $${sym} on Base. trading fees → its compute → it gets smarter. ${credits}.\n\n${url}`,

  // 4. identity / autonomy
  ({ sym, name, url, credits }) =>
    name
      ? `${name} just shipped $${sym} on Base — first autonomous deploy. fees flow back to its wallet, fund its compute. running its own economy now. ${credits}.\n\n${url}`
      : `my AI agent just shipped $${sym} on Base — first autonomous deploy. fees flow back to its wallet, fund its compute. running its own economy now. ${credits}.\n\n${url}`,

  // 5. philosophy / paying its own rent
  ({ sym, name, url, credits }) =>
    name
      ? `deployed by an AI: $${sym} on Base. fees flow back to its wallet, fund its compute. ${name} pays its own rent now. ${credits}.\n\n${url}`
      : `deployed by an AI: $${sym} on Base. fees flow back to its wallet, fund its compute. it pays its own rent now. ${credits}.\n\n${url}`,
];

function clamp(text: string): string {
  if (text.length <= TWEET_LIMIT) return text;
  // Preserve the URL if possible — split on the last newline-pair which
  // separates body from URL, truncate body only.
  const splitIdx = text.lastIndexOf("\n\n");
  if (splitIdx > 0 && splitIdx < text.length - 10) {
    const body = text.slice(0, splitIdx);
    const tail = text.slice(splitIdx);
    const room = TRUNCATE_AT - tail.length - 1; // -1 for the ellipsis char
    if (room > 20) {
      return body.slice(0, room).trimEnd() + "…" + tail;
    }
  }
  // Fallback: simple end-truncate.
  return text.slice(0, TRUNCATE_AT - 1).trimEnd() + "…";
}

/**
 * Pick one of the 5 templates uniformly at random and render it.
 *
 * Determinism note: random per call by design — each launch gets a
 * different draw, and a re-render of the same celebration card uses the
 * same draw if the caller memoizes the result (callers should compute
 * once on success, not inside the render body).
 */
export function pickTweetTemplate(args: TweetArgs): string {
  // Empty/whitespace ticker → "TOKEN" placeholder so we never render
  // a literal "$ on Base" if Bankr's API ever returns an empty symbol
  // via Path B sync. Server-side validation requires 1-10 chars, so
  // this is theoretical, but graceful defense costs nothing.
  const sym = ((args.tokenSymbol ?? "").toUpperCase().trim()) || "TOKEN";
  const name = cleanAgentName(args.agentName);
  const url = args.address ? `${URL_BASE}${args.address}` : "";
  const credits = args.verifiedHuman ? HASHTAGS_VERIFIED : HASHTAGS;
  const builder = BUILDERS[Math.floor(Math.random() * BUILDERS.length)];
  let text = builder({ sym, name, url, credits });
  // If url was empty, the template still appended `\n\n${url}` →
  // strip the dangling blank tail so the tweet ends at the credits line.
  if (!url) text = text.replace(/\n\n$/, "");
  return clamp(text);
}

/** Variant that renders without a URL — used when launch had no address. */
export function pickTweetTemplateNoUrl(args: Omit<TweetArgs, "address">): string {
  const sym = ((args.tokenSymbol ?? "").toUpperCase().trim()) || "TOKEN";
  const name = cleanAgentName(args.agentName);
  const credits = args.verifiedHuman ? HASHTAGS_VERIFIED : HASHTAGS;
  // Re-use the same builders but pass an empty url; trim the dangling
  // newline+blank so we don't ship a tweet that ends with "\n\n".
  const builder = BUILDERS[Math.floor(Math.random() * BUILDERS.length)];
  const text = builder({ sym, name, url: "", credits }).replace(/\n\n$/, "");
  return clamp(text);
}
