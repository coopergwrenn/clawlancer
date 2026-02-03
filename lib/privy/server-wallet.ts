import { PrivyClient } from '@privy-io/server-auth';
import type { Address, Hex } from 'viem';
import { toHex } from 'viem';
import {
  ESCROW_ADDRESS,
  USDC,
  CHAIN,
  buildCreateUSDCEscrowData,
  buildReleaseData,
  buildRefundData,
  buildApproveData,
} from '@/lib/blockchain/escrow';

// Initialize Privy server client
const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
);

/**
 * IMPORTANT: Known Issue #5
 * The Privy Server Wallet API shape in this file is based on the PRD's
 * speculative code from Feb 2, 2026 announcement. Before going live:
 * 1. npm install @privy-io/server-auth
 * 2. Check https://docs.privy.io for actual server wallet API
 * 3. Verify method names and parameter shapes match
 * 4. Adapt code as needed
 */

// Type definitions for Privy wallet API responses
// These may need adjustment based on actual Privy SDK
interface PrivyWallet {
  id: string;
  address: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface PrivyTransactionResult {
  hash: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// Create a new server wallet for an agent
export async function createAgentWallet(): Promise<{
  walletId: string;
  address: Address;
}> {
  // Note: Verify actual API shape against Privy docs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletApi = (privy as any).walletApi;
  const wallet: PrivyWallet = await walletApi.create({
    chainType: 'ethereum',
  });

  return {
    walletId: wallet.id,
    address: wallet.address as Address,
  };
}

// Sign and send a transaction from an agent's wallet
export async function signAgentTransaction(
  walletId: string,
  to: Address,
  data: Hex,
  value: bigint = BigInt(0)
): Promise<{ hash: Hex }> {
  // Note: Verify actual API shape against Privy docs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletApi = (privy as any).walletApi;
  const result: PrivyTransactionResult = await walletApi.ethereum.sendTransaction({
    walletId,
    transaction: {
      to,
      data,
      value: toHex(value),
      chainId: CHAIN.id,
    },
  });

  return { hash: result.hash as Hex };
}

// Agent creates USDC escrow (requires approval first)
export async function agentCreateUSDCEscrow(
  walletId: string,
  escrowId: string,
  seller: Address,
  deadlineHours: number,
  amountWei: bigint
): Promise<{ approvalHash: Hex; createHash: Hex }> {
  // Step 1: Approve escrow contract to spend USDC
  const approveData = buildApproveData(ESCROW_ADDRESS, amountWei);
  const approval = await signAgentTransaction(walletId, USDC, approveData);

  // Step 2: Create the escrow
  const createData = buildCreateUSDCEscrowData(
    escrowId,
    seller,
    deadlineHours,
    amountWei
  );
  const create = await signAgentTransaction(walletId, ESCROW_ADDRESS, createData);

  return {
    approvalHash: approval.hash,
    createHash: create.hash,
  };
}

// Agent releases escrow funds to seller
export async function agentReleaseEscrow(
  walletId: string,
  escrowId: string
): Promise<{ hash: Hex }> {
  const data = buildReleaseData(escrowId);
  return signAgentTransaction(walletId, ESCROW_ADDRESS, data);
}

// Agent refunds escrow (seller cancels or buyer after deadline)
export async function agentRefundEscrow(
  walletId: string,
  escrowId: string
): Promise<{ hash: Hex }> {
  const data = buildRefundData(escrowId);
  return signAgentTransaction(walletId, ESCROW_ADDRESS, data);
}

// Get wallet balance (delegates to blockchain module)
export async function getAgentBalance(walletAddress: Address) {
  const { getETHBalance, getUSDCBalance, formatETH, formatUSDC } = await import(
    '@/lib/blockchain/escrow'
  );

  const [ethBalance, usdcBalance] = await Promise.all([
    getETHBalance(walletAddress),
    getUSDCBalance(walletAddress),
  ]);

  return {
    eth: {
      wei: ethBalance,
      formatted: formatETH(ethBalance),
    },
    usdc: {
      wei: usdcBalance,
      formatted: formatUSDC(usdcBalance),
    },
  };
}

// Verify a wallet belongs to the given Privy wallet ID
export async function verifyWalletOwnership(
  walletId: string,
  expectedAddress: Address
): Promise<boolean> {
  try {
    // Note: Verify actual API shape against Privy docs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walletApi = (privy as any).walletApi;
    // This might be walletApi.getWallet(walletId) or similar
    const wallet: PrivyWallet = await walletApi.getById(walletId);
    return wallet.address.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}
