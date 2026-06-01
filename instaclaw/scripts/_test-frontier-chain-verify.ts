#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-chain-verify.ts — the on-chain settlement verifier.
 *
 * Run: npx tsx scripts/_test-frontier-chain-verify.ts
 * Exits 0 if all pass, 1 on any failure. No live chain — a mock ChainReader and
 * faithfully-encoded USDC Transfer logs drive every path.
 *
 * This is the forgery-defense surface: it must REJECT wrong recipient/amount,
 * RETRY (pending/rpc_error) on uncertainty, and only VERIFY a real matching
 * transfer with enough confirmations.
 */
import { pad, toHex } from "viem";
import {
  USDC_BASE,
  usdcToBaseUnits,
  decodeUsdcTransfers,
  matchSettlementTransfer,
  verifyUsdcSettlement,
  type ChainReader,
} from "../lib/frontier-chain-verify";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const WALLET = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const PAYER = "0x1111111111111111111111111111111111111111";

// keccak256("Transfer(address,address,uint256)") — well-known ERC-20 constant.
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Build a Transfer log exactly as it appears on-chain: indexed addresses are the
// 20-byte address left-padded to 32 bytes in topics; the non-indexed value is a
// 32-byte word in data. (viem's encodeEventLog isn't exported in this version, so
// we construct the canonical shape with pad/toHex.)
function transferLog(from: string, to: string, value: bigint, address = USDC_BASE) {
  return {
    address,
    topics: [
      TRANSFER_TOPIC0,
      pad(from as `0x${string}`, { size: 32 }),
      pad(to as `0x${string}`, { size: 32 }),
    ] as string[],
    data: pad(toHex(value), { size: 32 }) as string,
  };
}

// ── usdcToBaseUnits (6-decimal exactness) ──
check("usdc 5 → 5_000_000", usdcToBaseUnits(5) === 5_000_000n);
check("usdc 0.0001 → 100", usdcToBaseUnits(0.0001) === 100n);
check("usdc 0.000001 → 1", usdcToBaseUnits(0.000001) === 1n);
check("usdc 5.005 → 5_005_000", usdcToBaseUnits(5.005) === 5_005_000n);
check("usdc 0.1 float-safe → 100_000", usdcToBaseUnits(0.1) === 100_000n);

// ── decodeUsdcTransfers ──
{
  const logs = [
    transferLog(PAYER, WALLET, 5_000_000n),                    // good USDC transfer
    transferLog(PAYER, WALLET, 1n, OTHER),                     // non-USDC address → skip
    { address: USDC_BASE, topics: ["0xdeadbeef"], data: "0x" }, // wrong topic0 → skip
  ];
  const decoded = decodeUsdcTransfers(logs, USDC_BASE);
  check("decode: only the real USDC transfer", decoded.length === 1);
  check("decode: to/value parsed", decoded[0]?.value === 5_000_000n && decoded[0]?.to.toLowerCase() === WALLET);
}
check("decode: empty logs → []", decodeUsdcTransfers([], USDC_BASE).length === 0);

// ── matchSettlementTransfer (pure) ──
const T = (from: string, to: string, value: bigint) => ({ from, to, value });
check("match earn to wallet, amount ok",
  matchSettlementTransfer([T(PAYER, WALLET, 5_000_000n)], "earn", [WALLET], 5_000_000n) !== null);
check("match earn wrong recipient → null",
  matchSettlementTransfer([T(PAYER, OTHER, 5_000_000n)], "earn", [WALLET], 5_000_000n) === null);
check("match earn wrong amount → null",
  matchSettlementTransfer([T(PAYER, WALLET, 9_999_999n)], "earn", [WALLET], 5_000_000n) === null);
check("match spend from wallet → ok",
  matchSettlementTransfer([T(WALLET, OTHER, 2_000_000n)], "spend", [WALLET], 2_000_000n) !== null);
check("match spend but it's an inbound → null",
  matchSettlementTransfer([T(PAYER, WALLET, 2_000_000n)], "spend", [WALLET], 2_000_000n) === null);
check("match case-insensitive wallet",
  matchSettlementTransfer([T(PAYER, WALLET.toUpperCase().replace("0X", "0x"), 5_000_000n)], "earn", [WALLET], 5_000_000n) !== null);
check("match empty wallets → null",
  matchSettlementTransfer([T(PAYER, WALLET, 5_000_000n)], "earn", [], 5_000_000n) === null);
check("match picks the right one among many",
  matchSettlementTransfer(
    [T(PAYER, OTHER, 5_000_000n), T(PAYER, WALLET, 5_000_000n), T(PAYER, WALLET, 1n)],
    "earn", [WALLET], 5_000_000n,
  ) !== null);

// ── verifyUsdcSettlement (mock reader) ──
function reader(over: Partial<{ receipt: unknown; receiptThrow: unknown; block: bigint; blockThrow: unknown }>): ChainReader {
  return {
    async getTransactionReceipt() {
      if (over.receiptThrow) throw over.receiptThrow;
      return over.receipt as Awaited<ReturnType<ChainReader["getTransactionReceipt"]>>;
    },
    async getBlockNumber() {
      if (over.blockThrow) throw over.blockThrow;
      return over.block ?? 1040n;
    },
  };
}
const goodReceipt = (logs: ReturnType<typeof transferLog>[], blockNumber = 1000n) => ({
  status: "success" as const, blockNumber, logs,
});
const base = { direction: "earn" as const, vmWallets: [WALLET], expectedAmountUsdc: 5, minConfirmations: 30 };

async function run() {
  let r;

  r = await verifyUsdcSettlement({ reader: reader({}), txHash: "0xnothex", ...base });
  check("malformed hash → rejected", r.status === "rejected");

  r = await verifyUsdcSettlement({ reader: reader({}), txHash: "0x" + "a".repeat(64), ...base, vmWallets: [] });
  check("no wallets → pending", r.status === "pending");

  r = await verifyUsdcSettlement({
    reader: reader({ receiptThrow: { name: "TransactionReceiptNotFoundError", message: "not found" } }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("receipt not found → pending", r.status === "pending");

  r = await verifyUsdcSettlement({
    reader: reader({ receiptThrow: { name: "HttpRequestError", message: "fetch failed" } }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("rpc fault → rpc_error", r.status === "rpc_error");

  r = await verifyUsdcSettlement({
    reader: reader({ receipt: { status: "reverted", blockNumber: 1000n, logs: [] } }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("reverted → rejected", r.status === "rejected");

  r = await verifyUsdcSettlement({
    reader: reader({ receipt: goodReceipt([transferLog(PAYER, WALLET, 5_000_000n)]), block: 1005n }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("insufficient confirmations → pending", r.status === "pending");

  r = await verifyUsdcSettlement({
    reader: reader({ receipt: goodReceipt([transferLog(PAYER, WALLET, 5_000_000n)]), block: 1040n }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("happy path → verified", r.status === "verified");

  r = await verifyUsdcSettlement({
    reader: reader({ receipt: goodReceipt([transferLog(PAYER, OTHER, 5_000_000n)]), block: 1040n }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("confirmed but wrong recipient → rejected", r.status === "rejected");

  r = await verifyUsdcSettlement({
    reader: reader({ receipt: goodReceipt([transferLog(PAYER, WALLET, 9_999_999n)]), block: 1040n }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("confirmed but wrong amount → rejected", r.status === "rejected");

  r = await verifyUsdcSettlement({
    reader: reader({ receipt: goodReceipt([transferLog(PAYER, WALLET, 5_000_000n)]), blockThrow: { message: "rpc down" } }),
    txHash: "0x" + "a".repeat(64), ...base,
  });
  check("block-number rpc fault → rpc_error", r.status === "rpc_error");

  // spend direction end-to-end
  r = await verifyUsdcSettlement({
    reader: reader({ receipt: goodReceipt([transferLog(WALLET, OTHER, 2_000_000n)]), block: 1040n }),
    txHash: "0x" + "a".repeat(64), direction: "spend", vmWallets: [WALLET], expectedAmountUsdc: 2, minConfirmations: 30,
  });
  check("spend happy path → verified", r.status === "verified");

  console.log(`\nfrontier-chain-verify: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
