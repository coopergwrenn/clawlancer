import { PrivyClient } from '@privy-io/node';
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

// Initialize Privy Node client (updated from deprecated @privy-io/server-auth)
// Docs: https://docs.privy.io/guide/server-wallets/create
// Note: Privy SDK may look for PRIVY_APP_ID internally, so we set it
const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;

if (!appId || !appSecret) {
  console.error('Privy credentials missing:', { hasAppId: !!appId, hasAppSecret: !!appSecret });
}

const privy = new PrivyClient({
  appId: appId!,
  appSecret: appSecret!,
});

// CAIP-2 chain ID for Base mainnet
const BASE_CAIP2 = `eip155:${CHAIN.id}`;

// Create a new server wallet for an agent
// Returns walletId (for signing) and address (for display/funding)
export async function createAgentWallet(): Promise<{
  walletId: string;
  address: Address;
}> {
  // Create server wallet - no user owner needed for agent wallets
  // Docs: https://docs.privy.io/wallets/wallets/create/create-a-wallet
  const wallet = await privy.wallets().create({
    chain_type: 'ethereum',
  });

  // Extract wallet ID - must exist for signing
  const walletId = String(wallet.id || '');
  if (!walletId) {
    console.error('CRITICAL: No wallet ID from Privy:', JSON.stringify(wallet));
    throw new Error('Privy wallet created without ID - cannot sign transactions');
  }

  // Extract the address - handle potential CAIP-10 format
  let address = String(wallet.address || '');
  if (address.includes(':')) {
    const parts = address.split(':');
    address = parts[parts.length - 1];
  }

  // Validate address format
  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    throw new Error(`Invalid wallet address format: ${address}`);
  }

  console.log('Privy wallet created successfully:', { walletId, address });

  return {
    walletId,
    address: address as Address,
  };
}

// Sign and send a transaction from an agent's wallet
// Docs: https://docs.privy.io/guide/server-wallets/usage/ethereum
export async function signAgentTransaction(
  walletId: string,
  to: Address,
  data: Hex,
  value: bigint = BigInt(0)
): Promise<{ hash: Hex }> {
  const result = await privy.wallets().ethereum().sendTransaction(walletId, {
    caip2: BASE_CAIP2,
    params: {
      transaction: {
        to,
        data,
        value: toHex(value),
        chain_id: CHAIN.id,
      },
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
    const wallet = await privy.wallets().get(walletId);
    return wallet.address.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

// Sign an arbitrary message with an agent's wallet (for XMTP, etc.)
// Uses personal_sign under the hood
export async function signMessageForAgent(
  walletId: string,
  message: string
): Promise<string> {
  const result = await privy.wallets().ethereum().signMessage(walletId, {
    message,
  });
  return result.signature;
}
