import { readFileSync } from "node:fs";
import { recoverTypedDataAddress, hashTypedData } from "viem";
const d = JSON.parse(readFileSync("/tmp/x402_capture.json", "utf8"));
const sig = d.signature;
console.log("=== STEP 5: signature format ===");
console.log("len:", sig?.length, "(132 expected: 0x+64r+64s+2v)");
console.log("v byte:", sig?.slice(-2), "→", ({"1b":"27 OK","1c":"28 OK","00":"0 NEEDS +27","01":"1 NEEDS +27"})[sig?.slice(-2)?.toLowerCase()] ?? "?");
console.log("bankr_http:", d.bankr_http_status, "| bankrRaw keys:", Object.keys(d.bankrRaw||{}));
const types = { ...d.typedData.types }; delete types.EIP712Domain;
console.log("\n=== STEP 3: local ecrecover ===");
try {
  const args = { domain: d.typedData.domain, types, primaryType: d.typedData.primaryType, message: d.typedData.message ?? d.authorization };
  console.log("EIP-712 hash :", hashTypedData(args));
  const recovered = await recoverTypedDataAddress({ ...args, signature: sig });
  const match = recovered.toLowerCase() === d.from.toLowerCase();
  console.log("recovered    :", recovered);
  console.log("expected from:", d.from);
  console.log("MATCH:", match);
  console.log(match
    ? ">> typed data correct + Bankr signed exactly it. Mismatch is MY typed-data vs ANCHOR's (STEP 2/4)."
    : ">> Bankr signed a DIFFERENT hash than I sent. Investigate Bankr's signing path (STEP 5).");
} catch (e) {
  console.log("ecrecover ERROR:", String(e?.shortMessage ?? e?.message ?? e).slice(0,160), "→ signature encoding (STEP 5)");
}
