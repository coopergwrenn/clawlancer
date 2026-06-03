/**
 * Server-side Base-mainnet USDC balance reader.
 *
 * Mirrors the drain-guard read in app/api/agent-economy/authorize/route.ts
 * (`readUsdcBalanceUsd`) — extracted here so dashboard surfaces can show the
 * agent's *real* on-chain wallet balance without duplicating the eth_call
 * plumbing or touching the load-bearing authorize gate. Returns null on ANY
 * failure (bad address, RPC error, timeout, empty result) — callers treat null
 * as "unknown", never as zero.
 */

const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

export async function readUsdcBalanceUsd(
  address: string | null | undefined,
): Promise<number | null> {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  try {
    // balanceOf(address) selector + 32-byte left-padded address.
    const data =
      "0x70a08231" +
      address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const res = await fetch(BASE_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: USDC_BASE_ADDRESS, data }, "latest"],
      }),
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json();
    if (!j?.result || j.result === "0x") return null;
    // USDC has 6 decimals.
    return Math.round((Number(BigInt(j.result)) / 1e6) * 1e6) / 1e6;
  } catch {
    return null;
  }
}
