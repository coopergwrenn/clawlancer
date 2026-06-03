import { readFileSync } from "node:fs";
import { createCdpAuthHeaders } from "@coinbase/x402";
// load CDP creds from .env.local
const env = {};
for (const l of readFileSync("./.env.local","utf8").split("\n")) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m) env[m[1]]=m[2].trim().replace(/^["']|["']$/g,""); }
const d = JSON.parse(readFileSync("/tmp/x402_capture.json","utf8"));
const paymentPayload = { x402Version: 2, accepted: d.requirement, payload: { signature: d.signature, authorization: d.authorization } };
const authFn = createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
const all = await authFn();
const headers = all["verify"] ?? {};
console.log("calling CDP /verify directly…");
const res = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: d.requirement }),
});
console.log("HTTP", res.status);
console.log(await res.text());
