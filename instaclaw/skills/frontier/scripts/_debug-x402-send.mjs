#!/usr/bin/env node
/**
 * DEBUG — instrumented live send. Tests the hypothesis that anchor's resource
 * server requires the v2 payload's top-level `resource` field (which the official
 * @x402 client includes and we omitted). Probe → sign → build X-PAYMENT WITH
 * resource → send to anchor → dump FULL response (status + every header + body).
 * If anchor accepts, money moves (that's the goal). If 402, we learn maximally.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { selectPaymentRequirement, buildAuthorization, buildTransferTypedData } from "./frontier-spend-core.mjs";

const URL = "https://api.anchor-x402.com/v1/price/token?symbol=ETH";
const env = {};
for (const l of readFileSync(`${homedir()}/.openclaw/.env`, "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }

const offer = await (await fetch(URL)).json();
const sel = selectPaymentRequirement(offer.accepts, { maxAmountUsd: 1 });
const { amountAtomic, payTo, asset, requirement } = sel.selected;
const authorization = buildAuthorization({ from: env.BANKR_WALLET_ADDRESS, to: payTo, amountAtomic, nonceHex: "0x" + randomBytes(32).toString("hex"), nowSec: Math.floor(Date.now() / 1000), maxTimeoutSeconds: requirement.maxTimeoutSeconds });
const typedData = buildTransferTypedData(authorization, { asset, name: requirement.extra?.name, version: requirement.extra?.version });
const sig = (await (await fetch("https://api.bankr.bot/wallet/sign", { method: "POST", headers: { "X-API-Key": env.BANKR_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ signatureType: "eth_signTypedData_v4", typedData }) })).json()).signature;

// v2 envelope WITH top-level `resource` (matching the official @x402 client).
const envelope = { x402Version: 2, resource: offer.resource, accepted: requirement, payload: { signature: sig, authorization } };
const xPayment = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");

const res = await fetch(URL, { method: "GET", headers: { "PAYMENT-SIGNATURE": xPayment, "X-PAYMENT": xPayment } });
const headers = {};
for (const [k, v] of res.headers.entries()) headers[k] = v;
const body = await res.text();
console.log(JSON.stringify({
  http_status: res.status,
  ok: res.ok,
  response_headers: headers,
  x_payment_response: headers["x-payment-response"] ? JSON.parse(Buffer.from(headers["x-payment-response"], "base64").toString("utf8")) : null,
  body: body.slice(0, 700),
}, null, 2));
