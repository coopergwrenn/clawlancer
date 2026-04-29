/**
 * Tweet template registry — mini-app port.
 *
 * CANONICAL SOURCE: instaclaw/lib/bankr-tweet-templates.ts
 * Keep these two files in sync. The two are byte-identical except for
 * this header comment. They diverge ONLY if the mini-app needs a
 * different rendering surface (e.g., shorter copy for in-app webview
 * X intent — not currently the case).
 *
 * Single source of truth for the 5 randomized templates the mini-app
 * BankrTokenizeCard celebration uses. Pick a template, render with
 * agentName + ticker + address, length-clamp, return.
 */

export interface TweetArgs {
  tokenSymbol: string;
  agentName?: string | null;
  address?: string | null;
}

const HASHTAGS = "@instaclaws + @bankrbot";
const URL_BASE = "https://bankr.bot/launches/";
const TWEET_LIMIT = 280;
const TRUNCATE_AT = 275;

function cleanAgentName(raw?: string | null): string | null {
  if (!raw) return null;
  let name = raw.trim();
  if (name.startsWith("@")) name = name.slice(1);
  name = name.replace(/[_-]?bot$/i, "");
  name = name.replace(/[_-]+/g, " ").trim();
  if (name.length < 2) return null;
  return name;
}

type Builder = (args: { sym: string; name: string | null; url: string }) => string;

const BUILDERS: Builder[] = [
  ({ sym, name, url }) =>
    name
      ? `my agent ${name} just deployed $${sym} on Base. it runs the wallet, earns trading fees, funds its own compute. self-funding from day one. ${HASHTAGS}.\n\n${url}`
      : `my AI agent just deployed $${sym} on Base. it runs the wallet, owns the token, earns the trading fees. self-funding from day one. ${HASHTAGS}.\n\n${url}`,

  ({ sym, name, url }) =>
    name
      ? `$${sym} is live on Base. my AI agent ${name} owns the wallet, owns the token, earns the fees. agents that pay rent. ${HASHTAGS}.\n\n${url}`
      : `$${sym} is live on Base. my AI agent owns the wallet, owns the token, earns the fees. agents that pay rent. ${HASHTAGS}.\n\n${url}`,

  ({ sym, name, url }) =>
    name
      ? `watching ${name} launch its own token in chat was strange and beautiful. $${sym} on Base. trading fees → its compute → it gets smarter. ${HASHTAGS}.\n\n${url}`
      : `watching my AI agent launch its own token in chat was strange and beautiful. $${sym} on Base. trading fees → its compute → it gets smarter. ${HASHTAGS}.\n\n${url}`,

  ({ sym, name, url }) =>
    name
      ? `${name} just shipped $${sym} on Base — first autonomous deploy. fees flow back to its wallet, fund its compute. running its own economy now. ${HASHTAGS}.\n\n${url}`
      : `my AI agent just shipped $${sym} on Base — first autonomous deploy. fees flow back to its wallet, fund its compute. running its own economy now. ${HASHTAGS}.\n\n${url}`,

  ({ sym, name, url }) =>
    name
      ? `deployed by an AI: $${sym} on Base. fees flow back to its wallet, fund its compute. ${name} pays its own rent now. ${HASHTAGS}.\n\n${url}`
      : `deployed by an AI: $${sym} on Base. fees flow back to its wallet, fund its compute. it pays its own rent now. ${HASHTAGS}.\n\n${url}`,
];

function clamp(text: string): string {
  if (text.length <= TWEET_LIMIT) return text;
  const splitIdx = text.lastIndexOf("\n\n");
  if (splitIdx > 0 && splitIdx < text.length - 10) {
    const body = text.slice(0, splitIdx);
    const tail = text.slice(splitIdx);
    const room = TRUNCATE_AT - tail.length - 1;
    if (room > 20) {
      return body.slice(0, room).trimEnd() + "…" + tail;
    }
  }
  return text.slice(0, TRUNCATE_AT - 1).trimEnd() + "…";
}

export function pickTweetTemplate(args: TweetArgs): string {
  const sym = (args.tokenSymbol ?? "").toUpperCase();
  const name = cleanAgentName(args.agentName);
  const url = args.address ? `${URL_BASE}${args.address}` : "";
  const builder = BUILDERS[Math.floor(Math.random() * BUILDERS.length)];
  return clamp(builder({ sym, name, url }));
}

export function pickTweetTemplateNoUrl(args: Omit<TweetArgs, "address">): string {
  const sym = (args.tokenSymbol ?? "").toUpperCase();
  const name = cleanAgentName(args.agentName);
  const builder = BUILDERS[Math.floor(Math.random() * BUILDERS.length)];
  return clamp(builder({ sym, name, url: "" }).replace(/\n\n$/, ""));
}
