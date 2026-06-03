#!/usr/bin/env node
/**
 * frontier.spend — the agent's hands. (Frontier W6.)
 *
 * For the first time, when an agent needs a service it doesn't have, the answer
 * isn't "ask the human" or "give up." It's: find it, judge whether you can
 * afford it, pay for it, remember whether it was worth it. This script is that
 * sequence, end to end:
 *
 *   1. PROBE     hit the x402 endpoint; read its 402 payment requirements
 *   2. JUDGE     /api/agent-economy/authorize — your earned standing + your
 *                human's policy decide autonomous / ask-first / deny, and (on go)
 *                reserve the spend as a pending hold
 *   3. PAY       sign the EIP-3009 USDC authorization via Bankr (no key leaves the
 *                VM; the buyer needs no facilitator proxy), send X-PAYMENT, get the result
 *   4. SETTLE    /api/agent-economy/settle — flip the hold, record the outcome.
 *                This is what teaches the NEXT decision.
 *   5. REMEMBER  fold the outcome into the gbrain supplier record so the rolodex
 *                compounds — every spend makes the next judgment better.
 *
 * Self-contained: node built-ins + the sibling frontier-spend-core.mjs. No npm.
 *
 * Usage:
 *   node frontier-spend.mjs --url <x402-endpoint> [options]
 *   node frontier-spend.mjs --capability <category> [options]   (rolodex picks the supplier)
 *     --capability <cat>     no --url: Thompson-pick a supplier from your gbrain
 *                            rolodex for this category (data|search|inference|compute|
 *                            market|media|agent|other). Cold-start → asks for a --url.
 *     --max-usd <n>          most you'll pay (default: the 402's asking price)
 *     --why "<text>"         the rationale (logged + sent as the spend's summary)
 *     --method GET|POST      request method (default GET)
 *     --body '<json>'        request body for the resource call
 *     --category <cat>       capability hint (else inferred)
 *     --wallet-balance-usd <n>  your spendable USDC (else read from chain; else ask-first)
 *     --human-approved       the human acked this spend (pushes past the earned-budget gate)
 *     --result-used true|false  did the result turn out useful? (default: delivered & non-empty)
 *     --dispute              you paid but the delivery was bad/garbage (W27): records a
 *                            dispute + drops the supplier to "avoid" so it's never auto-picked again
 *     --dry-run              preview the plan + supplier trust; never reserves, signs, or pays
 *     --json                 machine-readable output
 *
 * NOTE: the on-chain leg (Bankr /wallet/sign request shape, the X-PAYMENT resend,
 * the X-PAYMENT-RESPONSE tx hash, the gbrain MCP result envelope) is proven live
 * on the canary (Frontier W11). Each is isolated, commented, and fails loud.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  selectPaymentRequirement, buildAuthorization, buildTransferTypedData, buildXPaymentHeader,
  inferCategory, tagsFromResource, newRequestId, supplierSlug, mergeSupplierRecord,
  supplierTrust, serializeSupplierRecord, parseSupplierRecord, renderHiredSpecialist,
  usdcToUsd, USDC_BASE_ADDRESS, CATEGORY_NAMES, selectSupplier, buildSupplierCandidates,
  purchaseSlug, serializePurchaseRecord,
} from "./frontier-spend-core.mjs";

const API_BASE = process.env.INSTACLAW_API_BASE || "https://instaclaw.io";
const GBRAIN_URL = "http://127.0.0.1:3131/mcp";
const BANKR_SIGN_URL = "https://api.bankr.bot/wallet/sign";
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// ── tiny arg parser (built-in; no deps) ──
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const key = t.slice(2);
    const flagOnly = ["human-approved", "dry-run", "json", "debug", "dispute"];
    if (flagOnly.includes(key)) { a[key] = true; continue; }
    a[key] = argv[++i];
  }
  return a;
}

function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(`${homedir()}/.openclaw/.env`, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* env file optional in some contexts */ }
  return out;
}

function fail(msg, extra) {
  console.error(JSON.stringify({ ok: false, error: msg, ...extra }));
  process.exit(1);
}

// canonical supplier id matching lib/frontier-ledger.supplierIdOf (url > addr).
function canonicalSupplierId(url, payTo) {
  if (url) {
    try {
      const u = new URL(url);
      return `url:${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
    } catch { /* fall through */ }
  }
  return payTo ? `addr:${payTo.toLowerCase()}` : "addr:unknown";
}

// ── gbrain (best-effort; never fails the spend) ──
async function gbrainCall(bearer, name, args) {
  if (!bearer) return null;
  try {
    const res = await fetch(GBRAIN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${bearer}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    // gbrain may answer as JSON or SSE; extract the JSON-RPC result either way.
    const jsonLine = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text;
    const parsed = JSON.parse(jsonLine);
    return parsed?.result ?? null;
  } catch {
    return null; // gbrain optional — the rolodex degrades gracefully
  }
}
// MCP tool results carry their payload as content[].text — pull the first text block.
function mcpText(result) {
  const c = result?.content;
  if (Array.isArray(c)) {
    const t = c.find((x) => x?.type === "text" && typeof x.text === "string");
    if (t) return t.text;
  }
  return typeof result === "string" ? result : null;
}

// get_page returns the MCP text block as a JSON ENVELOPE ({id,slug,compiled_truth,
// frontmatter,tags,…}); the markdown body we wrote (human summary + ```json record)
// lives in `compiled_truth`. Extract it before parsing — feeding the stringified
// envelope to parseSupplierRecord never matches (its embedded fence is JSON-escaped),
// which is why the supplier trust lookup silently always read "new" before this fix.
function pageBody(getPageResult) {
  const txt = mcpText(getPageResult);
  if (!txt) return null;
  try {
    const env = JSON.parse(txt);
    if (env && typeof env === "object" && !Array.isArray(env)) {
      return env.compiled_truth ?? env.content ?? env.body ?? txt;
    }
  } catch { /* not an envelope (some gbrain builds return raw markdown) — use as-is */ }
  return txt;
}

async function readSupplier(bearer, slug) {
  const r = await gbrainCall(bearer, "get_page", { slug });
  return parseSupplierRecord(pageBody(r));
}
async function writeSupplier(bearer, slug, rec) {
  // Frontmatter type makes the page enumerable via list_pages({type:"frontier_supplier"})
  // so `--capability` can find every supplier the agent has used. The authoritative
  // record (category, stats, endpoint) stays in the JSON block serializeSupplierRecord writes.
  const frontmatter = `---\ntype: frontier_supplier\ntags:\n  - frontier-supplier\n---\n`;
  await gbrainCall(bearer, "put_page", { slug, content: frontmatter + serializeSupplierRecord(rec) });
}

// W7(b) — the per-purchase diary entry (one gbrain page per buy, keyed by request_id).
// Best-effort like writeSupplier: gbrainCall swallows failures so the rolodex/log
// degrade gracefully and never fail the spend.
async function writePurchase(bearer, p) {
  const frontmatter = `---\ntype: frontier_purchase\ntags:\n  - frontier-purchase\n---\n`;
  await gbrainCall(bearer, "put_page", { slug: purchaseSlug(p.requestId), content: frontmatter + serializePurchaseRecord(p) });
}

// Enumerate the agent's supplier rolodex for `--capability`. Best-effort: gbrain is
// optional, so any failure degrades to an empty list (→ cold-start, ask for a --url).
// Only pages written with the frontmatter above are returned; suppliers last touched
// before that change reappear here after their next spend re-writes the record.
async function listSupplierRecords(bearer) {
  if (!bearer) return [];
  const r = await gbrainCall(bearer, "list_pages", { type: "frontier_supplier", limit: 200 });
  let metas;
  try {
    metas = JSON.parse(mcpText(r) || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(metas)) return [];
  const recs = [];
  for (const m of metas) {
    if (!m?.slug) continue;
    const rec = await readSupplier(bearer, m.slug);
    if (rec) recs.push(rec);
  }
  return recs;
}

// ── chain balance (best-effort; null → the gate forces ask-first) ──
async function readUsdcBalanceUsd(wallet) {
  if (!wallet) return null;
  try {
    // balanceOf(address) selector 0x70a08231 + 32-byte padded address
    const data = "0x70a08231" + wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const res = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE_ADDRESS, data }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (!j?.result || j.result === "0x") return null;
    return usdcToUsd(BigInt(j.result).toString());
  } catch {
    return null;
  }
}

async function authorize(gatewayToken, body) {
  const res = await fetch(`${API_BASE}/api/agent-economy/authorize`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function settle(gatewayToken, body) {
  const res = await fetch(`${API_BASE}/api/agent-economy/settle`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ── Bankr remote signing (the buyer signs; no key on the VM). Live-verified at W11. ──
async function bankrSign(apiKey, typedData) {
  const res = await fetch(BANKR_SIGN_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`bankr_sign_http_${res.status}`);
  const j = await res.json();
  const sig = j?.signature || j?.data?.signature || j?.result?.signature;
  if (!sig) throw new Error("bankr_sign_no_signature");
  return sig;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const json = !!args.json;
  const out = (obj) => { if (json) console.log(JSON.stringify(obj)); else if (obj.narration) console.log(obj.narration); if (obj.result !== undefined && !json) console.log("\n--- result ---\n" + (typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result, null, 2))); };

  let url = args.url;
  const capability = args.capability;
  if (!url && !capability) fail("provide --url <endpoint> or --capability <category>");
  const method = (args.method || "GET").toUpperCase();
  const why = args.why || "a service I needed";
  const reqBody = args.body;
  const maxUsd = args["max-usd"] !== undefined ? Number(args["max-usd"]) : Infinity;

  const env = loadEnv();
  const gatewayToken = env.GATEWAY_TOKEN;
  const bankrKey = env.BANKR_API_KEY;
  const wallet = env.BANKR_WALLET_ADDRESS;
  const gbrainBearer = (() => { try { return readFileSync(`${homedir()}/.gbrain/openclaw-bearer-token.txt`, "utf8").trim(); } catch { return null; } })();
  if (!gatewayToken) fail("frontier not configured: GATEWAY_TOKEN missing in ~/.openclaw/.env");

  // 0 ── ROLODEX SELECT: no --url given → pick WHO to hire for --capability ──
  // Thompson sampling over the agent's own supplier history (W7). The chosen
  // endpoint then runs the SAME probe→authorize→pay→settle→remember flow below —
  // selection picks the supplier; /authorize remains the sole budget authority.
  if (!url) {
    if (!CATEGORY_NAMES.includes(capability)) fail(`--capability must be one of ${CATEGORY_NAMES.join(", ")}`);
    const records = await listSupplierRecords(gbrainBearer);
    const { candidates, statsBySupplier } = buildSupplierCandidates(records, capability);
    if (candidates.length === 0) {
      // Cold-start: nothing known for this capability. Not an error — a real state.
      return out({ ok: true, paid: false, no_supplier: true, capability,
        narration: `I don't have a known supplier for "${capability}" yet. Give me a --url to try one and I'll remember whether it's worth hiring again.` });
    }
    const selection = selectSupplier(candidates, { statsBySupplier, remainingBudgetUsd: maxUsd });
    if (!selection.choice) {
      return out({ ok: true, paid: false, no_supplier: true, capability, reason: selection.reason,
        narration: `I know ${candidates.length} supplier(s) for "${capability}", but none fit within $${maxUsd === Infinity ? "∞" : maxUsd}. Raise --max-usd or give me a --url.` });
    }
    url = selection.choice.endpoint;
    const picked = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    if (!json) console.log(`Compared ${selection.ranked.length} supplier(s) for "${capability}" and picked ${picked}.`);
  }

  // 1 ── PROBE: get the 402 ──
  let probe;
  try {
    probe = await fetch(url, { method, body: reqBody, headers: reqBody ? { "Content-Type": "application/json" } : undefined, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    fail("endpoint_unreachable", { detail: String(e?.message ?? e) });
  }
  if (probe.status === 200) {
    const body = await probe.text();
    return out({ ok: true, paid: false, free: true, narration: `${url} served the result without a payment — nothing to pay.`, result: body });
  }
  if (probe.status !== 402) fail(`unexpected_status_${probe.status}`, { detail: (await probe.text()).slice(0, 500) });

  const offer = await probe.json().catch(() => ({}));
  const accepts = offer?.accepts;
  // x402 v2 carries description + tags on a top-level `resource` object; v1 put them per-accept.
  const description = offer?.resource?.description ?? offer?.accepts?.[0]?.description ?? offer?.error ?? null;
  const resourceTags = Array.isArray(offer?.resource?.tags) ? offer.resource.tags.filter((t) => typeof t === "string") : [];
  const x402Version = typeof offer?.x402Version === "number" ? offer.x402Version : 1;

  // ── SELECT which requirement to satisfy (maxUsd hoisted to the top of main) ──
  const sel = selectPaymentRequirement(accepts, { maxAmountUsd: maxUsd });
  if ("error" in sel) {
    const supplierLabel = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    return out({ ok: false, paid: false, reason: sel.error, narration: renderHiredSpecialist({ amountUsd: 0, supplierLabel, what: why, outcome: "deny", reason: sel.error }) });
  }
  const { amountUsd, amountAtomic, payTo, asset, requirement } = sel.selected;
  const supplierId = canonicalSupplierId(url, payTo);
  const supplierLabel = (() => { try { return new URL(url).hostname; } catch { return supplierId; } })();
  const slug = supplierSlug(supplierId);
  const category = inferCategory({ explicit: args.category, resourceUrl: url, description });
  const tags = [...new Set([...tagsFromResource(url), ...resourceTags])].slice(0, 12);

  // 5(read) ── REMEMBER: consult the rolodex before engaging ──
  const prevRec = await readSupplier(gbrainBearer, slug);
  const trust = prevRec ? supplierTrust(prevRec) : "new";

  // gbrain memory actively gates: never auto-spend on a supplier we've learned to avoid.
  if (trust === "avoid" && !args["human-approved"]) {
    return out({ ok: false, paid: false, reason: "supplier_avoid", supplier_trust: trust,
      narration: `I'd be hiring ${supplierLabel} for ${why} (${`$${amountUsd}`}), but ⚠️ I've had trouble with this supplier before (${prevRec.failures} failed / ${prevRec.disputes} disputed). I'd rather you approve this one. Re-run with approval if you want me to proceed.` });
  }

  const walletBalanceUsd = args["wallet-balance-usd"] !== undefined ? Number(args["wallet-balance-usd"]) : await readUsdcBalanceUsd(wallet);

  if (args["dry-run"]) {
    return out({ ok: true, dry_run: true, would_pay_usd: amountUsd, supplier: supplierId, supplier_trust: trust, category, wallet_balance_usd: walletBalanceUsd,
      narration: `Dry run: ${supplierLabel} would charge ${`$${amountUsd}`} for ${why} (category: ${category ?? "unknown"}, trust: ${trust}). I haven't reserved, signed, or paid anything.` });
  }

  // 2 ── JUDGE: authorize (gate + reserve) ──
  const requestId = newRequestId({ nowMs: Date.now(), rand: randomBytes(6).toString("hex") });
  const az = await authorize(gatewayToken, {
    request_id: requestId,
    amount_usd: amountUsd,
    endpoint: url,
    counterparty_address: payTo,
    category: category ?? undefined,
    tags,
    // wallet balance is now read server-side by /authorize (P1-3); no longer sent.
    human_approved: !!args["human-approved"],
    rail: "x402",
  });
  if (az.status !== 201 && az.status !== 200) fail("authorize_failed", { status: az.status, detail: az.json });
  const d = az.json;
  if (!d.authorized) {
    return out({ ok: true, paid: false, authorized: false, outcome: d.outcome, reason: d.reason, supplier_trust: trust,
      standing: d.standing, spent_today_usd: d.spent_today_usd,
      narration: renderHiredSpecialist({ amountUsd, supplierLabel, what: why, outcome: d.outcome, reason: d.reason, earnedDailyBudgetUsd: d.earned_daily_budget_usd, spentTodayUsd: d.spent_today_usd, trust }) });
  }
  const holdId = d.hold_id;
  const mode = d.mode === "human_approved" ? "human_approved" : "autonomous";
  if (!json) console.log(renderHiredSpecialist({ amountUsd, supplierLabel, what: why, outcome: mode, earnedDailyBudgetUsd: d.earned_daily_budget_usd, spentTodayUsd: d.spent_today_usd, trust }));

  // 3 ── PAY: sign EIP-3009 via Bankr, send X-PAYMENT, get the result ──
  let paid = false, txHash = null, resultBody = null, payErr = null, payErrBody = null, xPaymentDebug = null;
  try {
    if (!bankrKey || !wallet) throw new Error("bankr_not_configured");
    const authorizationMsg = buildAuthorization({
      from: wallet, to: payTo, amountAtomic, nonceHex: "0x" + randomBytes(32).toString("hex"),
      nowSec: Math.floor(Date.now() / 1000), maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    });
    const typedData = buildTransferTypedData(authorizationMsg, { asset, name: requirement.extra?.name, version: requirement.extra?.version });
    const signature = await bankrSign(bankrKey, typedData);
    const xPayment = buildXPaymentHeader({ signature, authorization: authorizationMsg, requirement, resource: offer?.resource, network: requirement.network, scheme: requirement.scheme, x402Version });
    if (args.debug) { try { xPaymentDebug = JSON.parse(Buffer.from(xPayment, "base64").toString("utf8")); xPaymentDebug.payload.signature = String(signature).slice(0, 20) + "…"; } catch { /* ignore */ } }

    // x402 v2 resource servers read the payment from PAYMENT-SIGNATURE (extractPayment in @x402/core);
    // X-PAYMENT is the v1 name. Send BOTH for v1+v2 compatibility (matching the canonical @x402 client).
    const payRes = await fetch(url, { method, body: reqBody, headers: { "PAYMENT-SIGNATURE": xPayment, "X-PAYMENT": xPayment, ...(reqBody ? { "Content-Type": "application/json" } : {}) }, signal: AbortSignal.timeout(60000) });
    if (payRes.ok) {
      paid = true;
      resultBody = await payRes.text();
      // v2 servers return the settlement in the `payment-response` header; v1 used `x-payment-response`.
      const xpr = payRes.headers.get("payment-response") || payRes.headers.get("x-payment-response");
      if (xpr) { try { txHash = JSON.parse(Buffer.from(xpr, "base64").toString("utf8"))?.transaction ?? null; } catch { /* tx hash best-effort */ } }
    } else {
      payErr = `pay_http_${payRes.status}`;
      payErrBody = (await payRes.text().catch(() => "")).slice(0, 800);
    }
  } catch (e) {
    payErr = String(e?.message ?? e);
  }

  // result_used: the agent's judgment; default to "delivered & non-empty" unless told otherwise.
  // W27 — the agent can flag a bad delivery (x402 settles-then-serves: you paid, then
  // got garbage). --dispute only applies to a spend that actually PAID; it tanks the
  // supplier to "avoid" so the rolodex never auto-picks it again. A disputed result is
  // never "used".
  const disputed = !!args.dispute && paid;
  const settleResult = !paid ? "failed" : disputed ? "disputed" : "success"; // settle-endpoint vocab
  const recordOutcome = !paid ? "failed" : disputed ? "disputed" : "settled"; // supplier/purchase vocab
  const resultUsed = disputed
    ? false
    : args["result-used"] !== undefined
      ? args["result-used"] === "true"
      : (paid && !!resultBody && resultBody.trim().length > 0);

  // 4 ── SETTLE: flip the hold, record the outcome (teaches the next decision) ──
  await settle(gatewayToken, {
    hold_id: holdId,
    request_id: requestId,
    result: settleResult,
    tx_hash: txHash ?? undefined,
    result_used: resultUsed,
    response_summary: why.slice(0, 1000),
  });

  // 5(write) ── REMEMBER: compound the supplier record ──
  const merged = mergeSupplierRecord(prevRec, {
    supplierId, endpoint: url, category,
    outcome: recordOutcome, amountUsd, resultUsed, atMs: Date.now(),
    note: `${why}${txHash ? ` (tx ${txHash.slice(0, 12)}…)` : ""}${payErr ? ` [${payErr}]` : ""}`,
  });
  await writeSupplier(gbrainBearer, slug, merged);
  // W7(b) — also log this individual purchase to the agent's local diary.
  await writePurchase(gbrainBearer, {
    requestId, supplierId, endpoint: url, category,
    amountUsd, outcome: recordOutcome, resultUsed,
    txHash: txHash ?? null, atMs: Date.now(), why: why.slice(0, 200),
  });

  if (paid) {
    return out({ ok: true, paid: true, mode, hold_id: holdId, tx_hash: txHash, amount_usd: amountUsd, supplier: supplierId, supplier_trust: supplierTrust(merged), result_used: resultUsed,
      narration: renderHiredSpecialist({ amountUsd, supplierLabel, what: why, outcome: "paid" }), result: resultBody });
  }
  return out({ ok: false, paid: false, mode, hold_id: holdId, reason: payErr, supplier: supplierId,
    pay_error_body: payErrBody, x_payment_sent: xPaymentDebug,
    narration: renderHiredSpecialist({ amountUsd, supplierLabel, what: why, outcome: "failed", reason: payErr }) });
}

main().catch((e) => fail("unexpected_error", { detail: String(e?.stack ?? e) }));
