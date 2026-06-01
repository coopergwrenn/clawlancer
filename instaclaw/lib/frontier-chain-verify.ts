/**
 * Frontier — on-chain settlement verification (the value-moving half).
 *
 * Frontier transactions are recorded by the VM as *claims* (verified_on_chain_at
 * NULL). Before any value effect (fee burn, future crediting) keys off a row, the
 * settlement must be proven on-chain. This module is that proof: given a reported
 * tx_hash, it reads the Base transaction receipt and confirms a real USDC
 * Transfer of the claimed amount to/from the VM's own wallet.
 *
 * Trust model: x402's `exact` scheme settles via EIP-3009 transferWithAuthorization
 * on USDC, which emits the standard ERC-20 Transfer(from,to,value). We parse that
 * log directly from the receipt — trustless, independent of any facilitator's say-so.
 *
 * Outcome is four-way and the distinction is load-bearing:
 *   verified  — proven good. Caller may stamp + apply effects.
 *   rejected  — proven BAD (reverted / wrong recipient / wrong amount / forged
 *               hash / replay). Caller marks disputed. NEVER credits.
 *   pending   — not yet provable (unmined / too few confirmations). Retry later.
 *   rpc_error — couldn't check (RPC down/flaky). Retry later. CRUCIALLY distinct
 *               from `rejected` so a bad RPC never flags a real settlement as fraud.
 *
 * The matching + amount logic is split into pure functions so the security-
 * critical decisions are unit-tested without a live chain (see
 * scripts/_test-frontier-chain-verify.ts).
 */
import { createPublicClient, http, fallback, decodeEventLog } from "viem";
import { base } from "viem/chains";

/** Native USDC on Base mainnet (Circle-issued). The ONLY native USDC on Base. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer topic0. */
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ERC20_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// Same Base RPC fallback set as lib/agentbook.ts.
const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base.drpc.org",
];

const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;

export interface UsdcTransfer {
  from: string;
  to: string;
  value: bigint;
}

export type VerifyOutcome =
  | { status: "verified"; confirmations: number; transfer: UsdcTransfer }
  | { status: "rejected"; reason: string }
  | { status: "pending"; reason: string }
  | { status: "rpc_error"; reason: string };

/** Minimal structural interface for the chain reader — lets tests inject a mock. */
export interface ChainReader {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: ReadonlyArray<{ address: string; topics: string[]; data: string }>;
  }>;
  getBlockNumber(): Promise<bigint>;
}

/** Production Base client (fallback RPCs). Tests inject their own ChainReader. */
export function getBaseChainReader(): ChainReader {
  return createPublicClient({
    chain: base,
    transport: fallback(BASE_RPC_URLS.map((url) => http(url, { timeout: 10_000 }))),
  }) as unknown as ChainReader;
}

/** USDC has 6 decimals. Convert a USD amount to integer base units (exact). */
export function usdcToBaseUnits(amountUsdc: number): bigint {
  return BigInt(Math.round(amountUsdc * 1_000_000));
}

/** Decode USDC Transfer events out of a receipt's logs. Non-USDC / non-Transfer
 *  / undecodable logs are skipped. Pure given the logs. */
export function decodeUsdcTransfers(
  logs: ReadonlyArray<{ address: string; topics: string[]; data: string }>,
  usdcAddress: string,
): UsdcTransfer[] {
  const usdc = usdcAddress.toLowerCase();
  const out: UsdcTransfer[] = [];
  for (const log of logs) {
    if (log.address?.toLowerCase() !== usdc) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC0) continue;
    try {
      const dec = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      });
      if (dec.eventName === "Transfer") {
        const args = dec.args as unknown as { from: string; to: string; value: bigint };
        out.push({ from: args.from, to: args.to, value: args.value });
      }
    } catch {
      // Malformed/foreign log shaped like a Transfer — ignore it.
    }
  }
  return out;
}

/**
 * Pure settlement matcher. Returns the matching transfer or null.
 *   earn  → USDC must have arrived AT one of the VM's wallets (to ∈ wallets)
 *   spend → USDC must have LEFT one of the VM's wallets (from ∈ wallets)
 * Amount must match exactly (no tolerance — payTo receives the full amount; gas
 * is the facilitator's, paid separately).
 */
export function matchSettlementTransfer(
  transfers: ReadonlyArray<UsdcTransfer>,
  direction: "earn" | "spend",
  vmWallets: ReadonlyArray<string>,
  expectedBaseUnits: bigint,
): UsdcTransfer | null {
  const wallets = new Set(vmWallets.filter(Boolean).map((w) => w.toLowerCase()));
  if (wallets.size === 0) return null;
  for (const t of transfers) {
    if (t.value !== expectedBaseUnits) continue;
    const side = direction === "earn" ? t.to : t.from;
    if (side && wallets.has(side.toLowerCase())) return t;
  }
  return null;
}

export interface VerifyParams {
  reader: ChainReader;
  txHash: string;
  direction: "earn" | "spend";
  /** The VM's own wallet address(es): bankr_evm_address + cdp_wallet_address. */
  vmWallets: ReadonlyArray<string>;
  expectedAmountUsdc: number;
  minConfirmations: number;
  usdcAddress?: string;
}

/** Verify a reported settlement against the Base chain. See VerifyOutcome. */
export async function verifyUsdcSettlement(p: VerifyParams): Promise<VerifyOutcome> {
  // Reject forged/garbage hashes before spending an RPC call on them.
  if (!TX_HASH_RE.test(p.txHash)) {
    return { status: "rejected", reason: "malformed tx_hash" };
  }
  if (p.vmWallets.filter(Boolean).length === 0) {
    // No wallet to verify against — can't prove it; treat as pending so a
    // transiently-missing wallet doesn't get marked fraud.
    return { status: "pending", reason: "no VM wallet to verify against" };
  }

  let receipt: Awaited<ReturnType<ChainReader["getTransactionReceipt"]>>;
  try {
    receipt = await p.reader.getTransactionReceipt({ hash: p.txHash as `0x${string}` });
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    const msg = (err as { message?: string })?.message ?? String(err);
    // Not-found = not mined yet (or dropped). Distinguish from a real RPC fault.
    if (name.includes("TransactionReceiptNotFound") || /could not be found|not found/i.test(msg)) {
      return { status: "pending", reason: "receipt not found (unmined or dropped)" };
    }
    return { status: "rpc_error", reason: `receipt lookup failed: ${msg.slice(0, 200)}` };
  }

  if (!receipt) {
    return { status: "pending", reason: "receipt not found (unmined or dropped)" };
  }
  if (receipt.status !== "success") {
    return { status: "rejected", reason: "transaction reverted on-chain" };
  }

  let currentBlock: bigint;
  try {
    currentBlock = await p.reader.getBlockNumber();
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? String(err);
    return { status: "rpc_error", reason: `block number lookup failed: ${msg.slice(0, 200)}` };
  }

  const confirmations = Number(currentBlock - receipt.blockNumber) + 1;
  if (confirmations < p.minConfirmations) {
    return { status: "pending", reason: `only ${confirmations}/${p.minConfirmations} confirmations` };
  }

  const transfers = decodeUsdcTransfers(receipt.logs, p.usdcAddress ?? USDC_BASE);
  const match = matchSettlementTransfer(
    transfers,
    p.direction,
    p.vmWallets,
    usdcToBaseUnits(p.expectedAmountUsdc),
  );
  if (!match) {
    return {
      status: "rejected",
      reason: `no USDC Transfer matching direction=${p.direction} amount=${p.expectedAmountUsdc} to/from the VM wallet`,
    };
  }

  return { status: "verified", confirmations, transfer: match };
}
