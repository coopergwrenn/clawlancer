#!/usr/bin/env node
/**
 * DEBUG (canary signature diagnosis) — capture the EXACT signing inputs the spend
 * script produces, WITHOUT authorizing/paying/settling. Probes anchor, builds the
 * EIP-3009 authorization + EIP-712 typed data identically to frontier-spend.mjs,
 * asks Bankr to sign it, and dumps {from, requirement, authorization, typedData,
 * bankrRaw, signature} as JSON so we can ecrecover it locally. No money moves.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { selectPaymentRequirement, buildAuthorization, buildTransferTypedData } from "./frontier-spend-core.mjs";

const URL = "https://api.anchor-x402.com/v1/price/token?symbol=ETH";

function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(`${homedir()}/.openclaw/.env`, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* */ }
  return out;
}

const env = loadEnv();
const wallet = env.BANKR_WALLET_ADDRESS;
const bankrKey = env.BANKR_API_KEY;

const probe = await fetch(URL, { method: "GET" });
const offer = await probe.json();
const sel = selectPaymentRequirement(offer.accepts, { maxAmountUsd: 1 });
if (!("selected" in sel)) { console.log(JSON.stringify({ error: "select failed", sel })); process.exit(1); }
const { amountAtomic, payTo, asset, requirement } = sel.selected;

const authorization = buildAuthorization({
  from: wallet, to: payTo, amountAtomic,
  nonceHex: "0x" + randomBytes(32).toString("hex"),
  nowSec: Math.floor(Date.now() / 1000), maxTimeoutSeconds: requirement.maxTimeoutSeconds,
});
const typedData = buildTransferTypedData(authorization, { asset, name: requirement.extra?.name, version: requirement.extra?.version });

// Bankr sign — capture the RAW response shape too.
const res = await fetch("https://api.bankr.bot/wallet/sign", {
  method: "POST",
  headers: { "X-API-Key": bankrKey, "Content-Type": "application/json" },
  body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData }),
});
const bankrRaw = await res.json().catch(() => ({ parse_error: true }));
const signature = bankrRaw?.signature || bankrRaw?.data?.signature || bankrRaw?.result?.signature || null;

console.log(JSON.stringify({
  from: wallet,
  payTo,
  asset,
  requirement,
  authorization,
  typedData,
  bankr_http_status: res.status,
  bankrRaw,
  signature,
  signature_len: signature ? signature.length : null,
  signature_v_byte: signature && signature.length >= 132 ? signature.slice(-2) : null,
}, null, 2));
