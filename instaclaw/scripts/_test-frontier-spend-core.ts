#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-spend-core.ts — the pure heart of the spend tool (W6)
 * and the supplier rolodex (W7). x402 selection, EIP-3009 envelope, category
 * inference, supplier-record compounding + trust, and the narration.
 * Run: npx tsx scripts/_test-frontier-spend-core.ts  (exit 0 = all pass)
 */
import {
  usdcToUsd, usdToUsdcAtomic, selectPaymentRequirement, buildAuthorization, buildTransferTypedData,
  buildXPaymentHeader, inferCategory, tagsFromResource, supplierSlug, mergeSupplierRecord,
  supplierTrust, serializeSupplierRecord, parseSupplierRecord, renderHiredSpecialist,
  USDC_BASE_ADDRESS, BASE_CHAIN_ID,
} from "../skills/frontier/scripts/frontier-spend-core.mjs";

let passed = 0, failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

// ── USDC <-> USD ──
check("usdcToUsd 1_000_000 → 1", usdcToUsd("1000000") === 1);
check("usdcToUsd 1000 → 0.001", usdcToUsd("1000") === 0.001);
check("usdToUsdcAtomic 0.001 → 1000", usdToUsdcAtomic(0.001) === "1000");
check("round-trip $2.5", usdcToUsd(usdToUsdcAtomic(2.5)) === 2.5);

// ── selectPaymentRequirement ──
const req = (p) => ({
  scheme: "exact", network: "base", asset: USDC_BASE_ADDRESS, payTo: "0xSeller", maxAmountRequired: "1000", ...p,
});
{
  const r = selectPaymentRequirement([req({ maxAmountRequired: "1000" })], { maxAmountUsd: 1 });
  check("picks valid exact/base/usdc", "selected" in r && r.selected.amountUsd === 0.001);
}
{
  const r = selectPaymentRequirement([req({ maxAmountRequired: "5000" }), req({ maxAmountRequired: "2000" })], { maxAmountUsd: 1 });
  check("picks the cheapest", "selected" in r && r.selected.amountAtomic === "2000");
}
check("empty accepts → error", "error" in selectPaymentRequirement([], { maxAmountUsd: 1 }));
check("over budget → over_max error", (() => { const r = selectPaymentRequirement([req({ maxAmountRequired: "5000000" })], { maxAmountUsd: 1 }); return "error" in r && r.error.startsWith("over_max"); })());
check("wrong chain → no_exact_base_usdc", (() => { const r = selectPaymentRequirement([req({ network: "ethereum" })], { maxAmountUsd: 1 }); return "error" in r && r.error === "no_exact_base_usdc_requirement"; })());
check("wrong asset → no_exact_base_usdc", (() => { const r = selectPaymentRequirement([req({ asset: "0xDEAD" })], { maxAmountUsd: 1 }); return "error" in r && r.error === "no_exact_base_usdc_requirement"; })());
check("non-exact scheme → no_exact_base_usdc", (() => { const r = selectPaymentRequirement([req({ scheme: "upto" })], { maxAmountUsd: 1 }); return "error" in r; })());
check("network 8453 normalizes to base", "selected" in selectPaymentRequirement([req({ network: "8453" })], { maxAmountUsd: 1 }));
check("network eip155:8453 normalizes", "selected" in selectPaymentRequirement([req({ network: "eip155:8453" })], { maxAmountUsd: 1 }));
check("asset case-insensitive", "selected" in selectPaymentRequirement([req({ asset: USDC_BASE_ADDRESS.toLowerCase() })], { maxAmountUsd: 1 }));
check("missing payTo rejected", "error" in selectPaymentRequirement([req({ payTo: undefined })], { maxAmountUsd: 1 }));

// ── EIP-3009 authorization ──
{
  const auth = buildAuthorization({ from: "0xA", to: "0xB", amountAtomic: "1000", nonceHex: "0xNONCE", nowSec: 1000, maxTimeoutSeconds: 300 });
  check("validAfter is 0", auth.validAfter === "0");
  check("validBefore = now + timeout", auth.validBefore === "1300");
  check("value passthrough", auth.value === "1000");
  check("nonce passthrough", auth.nonce === "0xNONCE");
  const authDefault = buildAuthorization({ from: "0xA", to: "0xB", amountAtomic: "1", nonceHex: "0x0", nowSec: 0 });
  check("default timeout 600", authDefault.validBefore === "600");
}

// ── typed data ──
{
  const auth = buildAuthorization({ from: "0xA", to: "0xB", amountAtomic: "1000", nonceHex: "0xN", nowSec: 0 });
  const td = buildTransferTypedData(auth, { asset: USDC_BASE_ADDRESS, name: "USD Coin", version: "2" });
  check("typed data chainId 8453", td.domain.chainId === BASE_CHAIN_ID);
  check("typed data verifyingContract = asset", td.domain.verifyingContract === USDC_BASE_ADDRESS);
  check("typed data primaryType", td.primaryType === "TransferWithAuthorization");
  check("typed data message = authorization", td.message.value === "1000" && td.message.from === "0xA");
  const tdDefault = buildTransferTypedData(auth, { asset: USDC_BASE_ADDRESS });
  check("domain name defaults to USD Coin", tdDefault.domain.name === "USD Coin" && tdDefault.domain.version === "2");
}

// ── X-PAYMENT header ──
{
  const auth = buildAuthorization({ from: "0xA", to: "0xB", amountAtomic: "1000", nonceHex: "0xN", nowSec: 0 });
  const hdr = buildXPaymentHeader({ signature: "0xSIG", authorization: auth });
  const decoded = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
  check("X-PAYMENT decodes to envelope", decoded.x402Version === 1 && decoded.scheme === "exact" && decoded.network === "base");
  check("X-PAYMENT carries signature + authorization", decoded.payload.signature === "0xSIG" && decoded.payload.authorization.value === "1000");
}

// ── category inference ──
check("explicit category wins", inferCategory({ explicit: "inference", resourceUrl: "https://x.com/price" }) === "inference");
check("invalid explicit ignored, falls to hint", inferCategory({ explicit: "banana", resourceUrl: "https://x.com/price" }) === "data");
check("url hint: price → data", inferCategory({ resourceUrl: "https://api.anchor.com/v1/price/token" }) === "data");
check("url hint: llm → inference", inferCategory({ resourceUrl: "https://api.x.com/llm/complete" }) === "inference");
check("description hint: polymarket → market", inferCategory({ description: "polymarket odds feed" }) === "market");
check("unknown → null", inferCategory({ resourceUrl: "https://x.com/zzz", description: "thing" }) === null);

// ── tagsFromResource ──
check("tags = host + path segs", JSON.stringify(tagsFromResource("https://www.api.com/v1/price?x=1")) === JSON.stringify(["api.com", "v1", "price"]));
check("bad url → []", tagsFromResource("not a url").length === 0);

// ── supplier slug ──
check("slug stable + safe", supplierSlug("url:https://API.Anchor.com/v1/price") === "frontier-supplier-url-api-anchor-com-v1-price");
check("slug vm", supplierSlug("vm:abc-123") === "frontier-supplier-vm-abc-123");
check("slug capped", supplierSlug("addr:" + "z".repeat(200)).length <= "frontier-supplier-".length + 80);

// ── supplier record compounding (W7) ──
const ev = (p) => ({
  supplierId: "url:https://a.com/p", endpoint: "https://a.com/p", category: "data",
  outcome: "settled", amountUsd: 0.5, resultUsed: true, atMs: 1000, ...p,
});
{
  const r1 = mergeSupplierRecord(null, ev({ atMs: 1000 }));
  check("new record: 1 spend, 1 success, 1 useful", r1.spends === 1 && r1.successes === 1 && r1.usefulCount === 1);
  check("new record: firstUsed set", r1.firstUsedMs === 1000);
  check("new record: totalUsd from settled", r1.totalUsd === 0.5);

  const r2 = mergeSupplierRecord(r1, ev({ outcome: "settled", resultUsed: false, amountUsd: 0.5, atMs: 2000 }));
  check("settled+unused: success++ but useful flat", r2.successes === 2 && r2.usefulCount === 1);
  check("lastUsed advances", r2.lastUsedMs === 2000);
  check("totalUsd accumulates settled", r2.totalUsd === 1);

  const r3 = mergeSupplierRecord(r2, ev({ outcome: "failed", amountUsd: 0.5, atMs: 3000 }));
  check("failed: failures++ no totalUsd", r3.failures === 1 && r3.totalUsd === 1);

  const r4 = mergeSupplierRecord(r3, ev({ outcome: "disputed", amountUsd: 0.5, atMs: 4000 }));
  check("disputed: disputes++", r4.disputes === 1 && r4.spends === 4);
}

// ── supplier trust ──
check("trust new", supplierTrust(mk({ spends: 0 })) === "new");
check("trust trusted (clean)", supplierTrust(mk({ spends: 3, successes: 3 })) === "trusted");
check("trust avoid (a dispute and bad>=good)", supplierTrust(mk({ spends: 2, successes: 1, disputes: 1 })) === "avoid");
check("trust avoid (>34% bad)", supplierTrust(mk({ spends: 10, successes: 6, failures: 4 })) === "avoid");
check("trust mixed (some bad, mostly good)", supplierTrust(mk({ spends: 10, successes: 9, failures: 1 })) === "mixed");

// ── serialize / parse round-trip ──
{
  const rec = mergeSupplierRecord(null, ev({}));
  const content = serializeSupplierRecord(rec);
  check("serialized has human summary", content.includes("Supplier url:https://a.com/p"));
  check("serialized has json block", content.includes("```json"));
  const back = parseSupplierRecord(content);
  check("parse round-trips supplierId", back?.supplierId === rec.supplierId);
  check("parse round-trips counters", back?.spends === 1 && back?.usefulCount === 1);
}
check("parse null content → null", parseSupplierRecord(null) === null);
check("parse corrupt → null", parseSupplierRecord("no json here") === null);
check("parse malformed json → null", parseSupplierRecord("```json\n{bad}\n```") === null);

// ── narration ──
check("autonomous narration mentions autonomy + amount", renderHiredSpecialist({ amountUsd: 0.5, supplierLabel: "anchor.com", what: "a price feed", outcome: "autonomous", earnedDailyBudgetUsd: 5, spentTodayUsd: 1 }).includes("autonomy"));
check("ask_first narration asks for approval", /go ahead\?$/.test(renderHiredSpecialist({ amountUsd: 5, supplierLabel: "x", what: "y", outcome: "ask_first", earnedDailyBudgetUsd: 1, spentTodayUsd: 0 })));
check("deny narration explains earned-budget reason", renderHiredSpecialist({ amountUsd: 5, supplierLabel: "x", what: "y", outcome: "deny", reason: "exceeds_earned_budget" }).includes("autonomy"));
check("paid narration confirms + logging", renderHiredSpecialist({ amountUsd: 0.5, supplierLabel: "anchor.com", what: "a feed", outcome: "paid" }).includes("logged"));
check("avoid trust surfaces a warning", renderHiredSpecialist({ amountUsd: 0.5, supplierLabel: "x", what: "y", outcome: "autonomous", trust: "avoid", earnedDailyBudgetUsd: 5, spentTodayUsd: 0 }).includes("⚠️"));

function mk(p) {
  return { supplierId: "s", endpoint: null, category: null, firstUsedMs: 0, lastUsedMs: 0, spends: 0, successes: 0, failures: 0, disputes: 0, usefulCount: 0, totalUsd: 0, lastNote: "", ...p };
}

console.log(`\nfrontier-spend-core: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
