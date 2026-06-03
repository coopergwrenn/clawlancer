/**
 * Frontier — the pure heart of the spend tool (W6) + the supplier rolodex (W7).
 *
 * Deployed to the VM at ~/.openclaw/skills/frontier/scripts/ alongside
 * frontier-spend.mjs, which imports it. SELF-CONTAINED: node built-ins only, no
 * repo libs, no npm deps. The category TAXONOMY is owned by the backend
 * (the /authorize endpoint resolves it from the tags this sends) — here we only
 * infer a hint. Tested in-repo: scripts/_test-frontier-spend-core.ts (via tsx).
 *
 * The spend tool is the agent's hands: find a service it needs, judge whether it
 * can afford it, pay for it, remember whether it was worth it. This file is the
 * deterministic core of that — x402 payment selection, the EIP-3009 authorization
 * + X-PAYMENT envelope (the buyer signs via Bankr's remote /wallet/sign; no key
 * ever touches the VM, no facilitator proxy on the buyer side), capability
 * hinting, the "hired a specialist" narration, and the compounding supplier record.
 */

// ── Base mainnet USDC (FiatTokenV2_2) — the only asset/network we pay on in Phase 1. ──
export const BASE_CHAIN_ID = 8453;
export const BASE_NETWORK = "base";
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_DECIMALS = 6;

/** The capability categories the gate understands (mirror of the backend taxonomy — strings only, stable enum). */
export const CATEGORY_NAMES = ["data", "search", "inference", "compute", "market", "media", "agent", "other"];

/** USDC atomic units (6-decimal) → USD number. */
export function usdcToUsd(atomic) {
  const n = typeof atomic === "string" ? Number(atomic) : atomic;
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round((n / 10 ** USDC_DECIMALS) * 1e6) / 1e6;
}

/** USD number → USDC atomic units (integer string). */
export function usdToUsdcAtomic(usd) {
  return String(Math.round(usd * 10 ** USDC_DECIMALS));
}

// ════════════════════════════════════════════════════════════════════
// x402 payment-requirement selection
// ════════════════════════════════════════════════════════════════════

function normNetwork(n) {
  if (!n) return "";
  const s = String(n).toLowerCase();
  if (s === "base" || s === "base-mainnet" || s === "8453" || s === "eip155:8453") return BASE_NETWORK;
  return s;
}
function isUsdc(asset) {
  return typeof asset === "string" && asset.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase();
}

/**
 * Choose which 402 `accepts` entry to satisfy: scheme "exact", network Base,
 * asset USDC, priced at or below the agent's ceiling; cheapest among valid.
 * Returns { selected } or { error } with a stable machine reason.
 */
// x402 v2 names the atomic price `amount`; the original spec used `maxAmountRequired`. Support both.
function atomicOf(a) {
  if (typeof a.amount === "string") return a.amount;
  if (typeof a.maxAmountRequired === "string") return a.maxAmountRequired;
  return null;
}

export function selectPaymentRequirement(accepts, opts) {
  if (!Array.isArray(accepts) || accepts.length === 0) return { error: "no_payment_requirements" };
  const exactBaseUsdc = accepts.filter(
    (a) =>
      (a.scheme ?? "exact") === "exact" &&
      normNetwork(a.network) === BASE_NETWORK &&
      isUsdc(a.asset) &&
      typeof a.payTo === "string" && !!a.payTo &&
      typeof atomicOf(a) === "string",
  );
  if (exactBaseUsdc.length === 0) return { error: "no_exact_base_usdc_requirement" };
  const priced = exactBaseUsdc
    .map((a) => ({ a, usd: usdcToUsd(atomicOf(a)) }))
    .filter((x) => Number.isFinite(x.usd) && x.usd > 0)
    .sort((x, y) => x.usd - y.usd);
  if (priced.length === 0) return { error: "invalid_requirement_amount" };
  const cheapest = priced[0];
  if (cheapest.usd > opts.maxAmountUsd) return { error: `over_max:requested_${cheapest.usd}_cap_${opts.maxAmountUsd}` };
  return {
    selected: {
      requirement: cheapest.a,
      amountUsd: cheapest.usd,
      amountAtomic: atomicOf(cheapest.a),
      payTo: cheapest.a.payTo,
      asset: cheapest.a.asset,
      network: cheapest.a.network, // preserve original (e.g. "eip155:8453") for the X-PAYMENT envelope
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// EIP-3009 authorization + X-PAYMENT envelope (buyer side — no proxy)
// ════════════════════════════════════════════════════════════════════

/** Build the EIP-3009 message. validAfter=0 (valid now); validBefore bounded by the requirement's timeout. */
export function buildAuthorization(args) {
  const timeout = args.maxTimeoutSeconds && args.maxTimeoutSeconds > 0 ? args.maxTimeoutSeconds : 600;
  return {
    from: args.from,
    to: args.to,
    value: args.amountAtomic,
    validAfter: "0",
    validBefore: String(args.nowSec + timeout),
    nonce: args.nonceHex,
  };
}

/** Full EIP-712 typed data for eth_signTypedData_v4. Bankr hashes + signs this; we never touch a key or a hash. */
export function buildTransferTypedData(authorization, opts) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    domain: {
      name: opts.name || "USD Coin",
      version: opts.version || "2",
      chainId: BASE_CHAIN_ID,
      verifyingContract: opts.asset,
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  };
}

/**
 * The X-PAYMENT header: base64(JSON(PaymentPayload)). The envelope shape DIFFERS
 * by protocol version (verified against @x402/core's PaymentPayloadV2Schema):
 *   v2 → { x402Version:2, accepted:<full selected requirement>, payload:{signature, authorization} }
 *        (NO top-level scheme/network — they live inside `accepted`; `accepted` is REQUIRED)
 *   v1 → { x402Version:1, scheme, network, payload:{signature, authorization} } (flat)
 * Passing the v1 flat shape to a v2 facilitator fails schema validation and the
 * server silently re-issues a 402.
 */
export function buildXPaymentHeader(args) {
  const version = args.x402Version ?? 1;
  let envelope;
  if (version >= 2) {
    envelope = {
      x402Version: 2,
      ...(args.resource ? { resource: args.resource } : {}), // top-level resource — the canonical @x402 client includes it
      accepted: args.requirement, // the full selected accepts[] entry (scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra)
      payload: { signature: args.signature, authorization: args.authorization },
    };
  } else {
    envelope = {
      x402Version: 1,
      scheme: args.scheme ?? "exact",
      network: args.network ?? BASE_NETWORK,
      payload: { signature: args.signature, authorization: args.authorization },
    };
  }
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

// ════════════════════════════════════════════════════════════════════
// Capability hinting (the backend resolves the authoritative category)
// ════════════════════════════════════════════════════════════════════

// Specific categories first; broad "data" is the last resort (a market feed reads as market).
const URL_CATEGORY_HINTS = [
  [/market|polymarket|predict|odds|signal|trade/i, "market"],
  [/search|scrape|crawl|lookup|intel|research/i, "search"],
  [/inference|llm|gpt|claude|complete|chat|embed|model/i, "inference"],
  [/sandbox|exec|render|compute|gpu|build|compile/i, "compute"],
  [/image|audio|video|tts|speech|media|gen(erate)?/i, "media"],
  [/agent|a2a|hire|delegate/i, "agent"],
  [/price|quote|feed|oracle|ticker|weather|telemetry|dataset|data\b/i, "data"],
];

/** Resolve a category HINT: explicit override → URL/description keyword hints → null (unknown → the gate asks the human). */
export function inferCategory(opts) {
  if (opts.explicit && CATEGORY_NAMES.includes(opts.explicit)) return opts.explicit;
  const hay = `${opts.resourceUrl ?? ""} ${opts.description ?? ""}`;
  for (const [re, cat] of URL_CATEGORY_HINTS) if (re.test(hay)) return cat;
  return null;
}

/** Tags from a resource URL (host + path segments) — feeds the gate's tag→category mapping + supplier diversity. */
export function tagsFromResource(resourceUrl) {
  if (!resourceUrl) return [];
  try {
    const u = new URL(resourceUrl);
    const segs = u.pathname.split("/").filter((s) => s && s.length <= 40 && /^[a-z0-9._-]+$/i.test(s));
    return [u.hostname.replace(/^www\./, ""), ...segs].slice(0, 8);
  } catch {
    return [];
  }
}

/** Canonical request_id for a spend attempt — idempotency key. Time + randomness injected. */
export function newRequestId(opts) {
  return `spend-${opts.nowMs}-${opts.rand}`;
}

// ════════════════════════════════════════════════════════════════════
// W7 — the supplier rolodex record (gbrain page content)
// ════════════════════════════════════════════════════════════════════

/** The gbrain slug for a supplier — stable, readable, url/fs-safe, capped. */
export function supplierSlug(supplierId) {
  const body = String(supplierId)
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `frontier-supplier-${body || "unknown"}`;
}

/** Fold a new spend outcome into the running supplier record (or start one). Pure. */
export function mergeSupplierRecord(prev, ev) {
  const base = prev ?? {
    supplierId: ev.supplierId, endpoint: ev.endpoint, category: ev.category,
    firstUsedMs: ev.atMs, lastUsedMs: ev.atMs,
    spends: 0, successes: 0, failures: 0, disputes: 0, usefulCount: 0, totalUsd: 0, lastNote: "",
  };
  const settled = ev.outcome === "settled";
  return {
    ...base,
    endpoint: ev.endpoint ?? base.endpoint,
    category: ev.category ?? base.category,
    lastUsedMs: Math.max(base.lastUsedMs, ev.atMs),
    spends: base.spends + 1,
    successes: base.successes + (settled ? 1 : 0),
    failures: base.failures + (ev.outcome === "failed" ? 1 : 0),
    disputes: base.disputes + (ev.outcome === "disputed" ? 1 : 0),
    usefulCount: base.usefulCount + (settled && ev.resultUsed ? 1 : 0),
    totalUsd: Math.round((base.totalUsd + (settled ? ev.amountUsd : 0)) * 1e6) / 1e6,
    lastNote: ev.note ? String(ev.note).slice(0, 280) : base.lastNote,
  };
}

/** Trust verdict the agent reads BEFORE engaging a known supplier. */
export function supplierTrust(rec) {
  const bad = rec.failures + rec.disputes;
  if (rec.spends === 0) return "new";
  if (rec.disputes > 0 && bad >= rec.successes) return "avoid";
  if (bad === 0 && rec.successes >= 1) return "trusted";
  if (bad / Math.max(1, rec.spends) > 0.34) return "avoid";
  return "mixed";
}

/** Serialize to gbrain page content: a human summary + a machine-parseable JSON block. */
export function serializeSupplierRecord(rec) {
  const trust = supplierTrust(rec);
  const usefulRate = rec.successes > 0 ? Math.round((rec.usefulCount / rec.successes) * 100) : 0;
  const human =
    `Supplier ${rec.supplierId} — trust: ${trust}. ` +
    `${rec.spends} spend(s), ${rec.successes} settled / ${rec.failures} failed / ${rec.disputes} disputed, ` +
    `${usefulRate}% useful, $${rec.totalUsd} total. ` +
    (rec.category ? `Category: ${rec.category}. ` : "") +
    (rec.lastNote ? `Last: ${rec.lastNote}` : "");
  return `${human}\n\n\`\`\`json\n${JSON.stringify(rec)}\n\`\`\`\n`;
}

/** Recover a record from gbrain page content (the JSON block). null if absent/corrupt. */
export function parseSupplierRecord(content) {
  if (!content) return null;
  const m = content.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1].trim());
    if (o && typeof o === "object" && typeof o.supplierId === "string") return o;
  } catch {
    /* fall through */
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
// W7(b) — the purchase log (gbrain page per buy)
//
// The supplier INDEX (above) is the aggregate "should I trust X" memory, read at
// discover-time. The purchase LOG is the granular diary — one page per buy —
// written at settle-time so the agent can answer its human locally ("what have I
// bought, what did it cost, was it worth it") without a round-trip to the ledger.
// Slugged by request_id so a re-settle overwrites in place (idempotent, no dup).
// ════════════════════════════════════════════════════════════════════

/** Stable, fs/url-safe gbrain slug for a single purchase, keyed by its request_id. */
export function purchaseSlug(requestId) {
  const body = String(requestId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return `frontier-purchase-${body || "unknown"}`;
}

/** Serialize one purchase to gbrain page content: a human line + a machine JSON block. */
export function serializePurchaseRecord(p) {
  const verb = p.outcome === "settled" ? "Paid" : "Tried to pay";
  const usefulNote = p.outcome === "settled" ? (p.resultUsed ? " — result used" : " — result NOT used") : "";
  const human =
    `${verb} $${p.amountUsd} to ${p.supplierId} for ${p.category ?? "a service"}${usefulNote}. ` +
    `${p.outcome === "settled" ? "Settled" : "Failed"}.` +
    (p.txHash ? ` tx ${String(p.txHash).slice(0, 12)}…` : "") +
    (p.why ? ` Why: ${String(p.why).slice(0, 200)}` : "");
  return `${human}\n\n\`\`\`json\n${JSON.stringify(p)}\n\`\`\`\n`;
}

/** Recover a purchase record from gbrain page content (the JSON block). null if absent/corrupt. */
export function parsePurchaseRecord(content) {
  if (!content) return null;
  const m = content.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1].trim());
    if (o && typeof o === "object" && typeof o.requestId === "string") return o;
  } catch {
    /* fall through */
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
// W7b — Thompson-sampling supplier selection (budgeted multi-armed bandit)
//
// Verbatim port of lib/frontier-rolodex.ts (kept in sync; cross-checked by the
// shared tests). The .mjs can't import the .ts, so the pure math lives here too.
// Given the supplier records the agent has accumulated in gbrain for a
// capability, pick WHO to hire: mostly exploit the most-reliable affordable
// supplier, occasionally explore. The posterior is Beta(1,1) + own history (+ a
// fleet prior once W10 ships). RNG is injected so selection is deterministically
// testable.
// ════════════════════════════════════════════════════════════════════

const BASE_ALPHA = 1;
const BASE_BETA = 1;

/** Beta posterior params for a (supplier, capability): base + fleet prior + own history. */
export function posteriorFor(key, opts) {
  let alpha = BASE_ALPHA;
  let beta = BASE_BETA;
  const fp = opts.fleetPriorBySupplier?.get(key);
  if (fp) {
    alpha += Math.max(0, fp.alpha);
    beta += Math.max(0, fp.beta);
  }
  const own = opts.statsBySupplier?.get(key);
  if (own) {
    alpha += Math.max(0, own.successes);
    beta += Math.max(0, own.failures);
  }
  return { alpha, beta };
}

// Beta sampler via two Gammas (Marsaglia–Tsang), normal via Box–Muller. Pure; injected rng.
function sampleNormal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sampleGamma(k, rng) {
  if (k < 1) {
    const u = rng();
    return sampleGamma(1 + k, rng) * Math.pow(u === 0 ? 1e-12 : u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    let x = 0;
    let vv = 0;
    do {
      x = sampleNormal(rng);
      vv = 1 + c * x;
    } while (vv <= 0);
    vv = vv * vv * vv;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * vv;
    if (Math.log(u) < 0.5 * x * x + d * (1 - vv + Math.log(vv))) return d * vv;
  }
  return d;
}
export function sampleBeta(alpha, beta, rng) {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

/**
 * Pick which supplier to hire for a capability via Thompson sampling, within budget.
 * Returns { choice, reason, ranked }. `ranked` is every affordable candidate scored
 * (for the "I compared N suppliers, picked X" narration).
 */
export function selectSupplier(candidates, opts) {
  const rng = opts.rng ?? Math.random;
  const affordable = candidates.filter((c) => c.priceUsd <= opts.remainingBudgetUsd && c.priceUsd >= 0);
  if (affordable.length === 0) {
    return { choice: null, reason: candidates.length === 0 ? "no_candidates" : "none_within_budget", ranked: [] };
  }
  const ranked = affordable.map((candidate) => {
    const key = `${candidate.supplierId}|${candidate.capability}`;
    const { alpha, beta } = posteriorFor(key, opts);
    const sampledTheta = sampleBeta(alpha, beta, rng);
    // Reliability dominates; among similar reliability, prefer the cheaper supplier.
    const costPenalty = Math.min(0.4, (candidate.priceUsd / Math.max(1e-9, opts.remainingBudgetUsd)) * 0.4);
    const score = sampledTheta * (1 - costPenalty);
    return { candidate, alpha, beta, meanSuccess: alpha / (alpha + beta), sampledTheta, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return { choice: ranked[0].candidate, reason: "thompson_selected", ranked };
}

/**
 * Bridge the agent's gbrain supplier records → bandit inputs for ONE capability.
 * Returns { candidates, statsBySupplier }. A record is INCLUDED only if its
 * category matches, it has an endpoint, and its trust is not "avoid" (we never
 * auto-hire a supplier we've learned to avoid — the human can still --url it
 * explicitly with --human-approved). priceUsd is the avg historical settled price
 * (totalUsd/successes), or 0 when unknown (brand-new → always affordable → the
 * bandit explores it). The REAL price is confirmed at the 402 and the REAL budget
 * is enforced by /authorize; priceUsd here only ranks affordability + cost.
 */
export function buildSupplierCandidates(records, capability) {
  const candidates = [];
  const statsBySupplier = new Map();
  for (const rec of records) {
    if (!rec || rec.category !== capability || !rec.endpoint) continue;
    if (supplierTrust(rec) === "avoid") continue;
    const successes = Math.max(0, rec.successes || 0);
    const failures = Math.max(0, (rec.failures || 0) + (rec.disputes || 0)); // disputes count against the bandit
    const priceUsd = successes > 0 ? Math.round((rec.totalUsd / successes) * 1e6) / 1e6 : 0;
    candidates.push({ supplierId: rec.supplierId, capability, priceUsd, endpoint: rec.endpoint });
    statsBySupplier.set(`${rec.supplierId}|${capability}`, { supplierId: rec.supplierId, successes, failures });
  }
  return { candidates, statsBySupplier };
}

// ════════════════════════════════════════════════════════════════════
// The "hired a specialist" narration — what the human reads
// ════════════════════════════════════════════════════════════════════

function fmt$(x) {
  return x === undefined || x === null ? "?" : `$${Number(x).toFixed(Number(x) < 1 ? 3 : 2)}`;
}
function humanReason(reason) {
  switch (reason) {
    case "privacy_mode": return "privacy mode is on, so I can't move money";
    case "exceeds_per_tx_ceiling": return "it's over your per-transaction limit";
    case "exceeds_daily_ceiling": return "it would put you over your daily limit";
    case "would_drain_wallet": return "it would draw the wallet below its safety floor";
    case "unverified_counterparty": return "the counterparty isn't verified and this spend requires it";
    case "category_not_allowed": return "you've restricted this category of purchase";
    case "exceeds_earned_budget": return "it's more than the spending autonomy I've earned so far";
    case "unknown_category": return "I couldn't identify what kind of service this is";
    default: return reason ?? "the spend gate declined it";
  }
}

/** Render the spend as the agent narrating a hire, not an API call. */
export function renderHiredSpecialist(n) {
  const trustNote =
    n.trust === "avoid" ? " ⚠️ I've had trouble with this supplier before." :
    n.trust === "trusted" ? " (a supplier I trust)" : "";
  switch (n.outcome) {
    case "autonomous":
      return `Hiring ${n.supplierLabel} for ${n.what} — ${fmt$(n.amountUsd)}.${trustNote} I've earned ${fmt$(n.earnedDailyBudgetUsd)}/day of spending autonomy and used ${fmt$(n.spentTodayUsd)} today, so this is within what I can decide on my own. Paying now…`;
    case "human_approved":
      return `Hiring ${n.supplierLabel} for ${n.what} — ${fmt$(n.amountUsd)}, with your approval.${trustNote} Paying now…`;
    case "paid":
      return `✓ Paid ${fmt$(n.amountUsd)} to ${n.supplierLabel} for ${n.what}. Got the result and logged the supplier for next time.`;
    case "ask_first":
      return `I'd like to hire ${n.supplierLabel} for ${n.what} — ${fmt$(n.amountUsd)}.${trustNote} That's beyond the ${fmt$(n.earnedDailyBudgetUsd)}/day autonomy I've earned so far (${fmt$(n.spentTodayUsd)} used today). Want me to go ahead?`;
    case "deny":
      return `I can't make this purchase: ${humanReason(n.reason)}.`;
    case "failed":
      return `The payment to ${n.supplierLabel} didn't go through (${humanReason(n.reason)}). I didn't get the result; nothing was charged that I can confirm. I've noted it against this supplier.`;
    default:
      return "";
  }
}
