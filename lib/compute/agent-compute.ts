/**
 * Agent Compute Charging
 *
 * Agents pay for their own Claude API calls using USDC.
 * All transfers are ON-CHAIN with tx_hash for verification.
 *
 * Trust model (per PRD Section 1):
 * - USDC balances: ON-CHAIN (trustless)
 * - Compute fee transfers: ON-CHAIN (trustless)
 * - Compute logs: LOCAL (with tx_hash for verification)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  type Address,
  type Hash,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { SupabaseClient } from '@supabase/supabase-js';

// Constants
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const COMPUTE_FEE = parseUnits(process.env.COMPUTE_FEE_USDC || '0.02', 6); // Default 0.02 USDC
const MIN_BALANCE = parseUnits(process.env.MIN_BALANCE_USDC || '0.05', 6); // Default 0.05 USDC

const USDC_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface ComputeChargeResult {
  success: boolean;
  charged: boolean;
  refunded: boolean;
  balanceBefore: string;
  balanceAfter: string;
  feeCharged: string;
  txHash?: string;
  refundTxHash?: string;
  error?: string;
}

// Create public client for reading
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.ALCHEMY_BASE_URL),
});

/**
 * Check agent's USDC balance ON-CHAIN
 * This is trustless - anyone can verify
 */
export async function checkAgentBalance(walletAddress: string): Promise<bigint> {
  const balance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [walletAddress as Address],
  }) as bigint;

  return balance;
}

/**
 * Check if agent has minimum balance for compute
 */
export async function hasMinimumBalance(walletAddress: string): Promise<boolean> {
  const balance = await checkAgentBalance(walletAddress);
  return balance >= MIN_BALANCE;
}

/**
 * Get formatted balance
 */
export async function getFormattedBalance(walletAddress: string): Promise<string> {
  const balance = await checkAgentBalance(walletAddress);
  return formatUnits(balance, 6);
}

/**
 * Get compute fee amount
 */
export function getComputeFee(): string {
  return formatUnits(COMPUTE_FEE, 6);
}

/**
 * Get minimum balance requirement
 */
export function getMinBalance(): string {
  return formatUnits(MIN_BALANCE, 6);
}

/**
 * Charge compute fee ON-CHAIN using Privy server wallet
 * Returns tx_hash for verification
 *
 * @param agentId - Agent's database ID
 * @param privyWalletId - Agent's Privy wallet ID for signing
 * @param agentWalletAddress - Agent's wallet address
 * @param treasuryAddress - Treasury address to receive fee
 * @param supabase - Supabase client for logging
 */
export async function chargeComputeFeeWithPrivy(
  agentId: string,
  privyWalletId: string,
  agentWalletAddress: string,
  treasuryAddress: string,
  supabase: SupabaseClient
): Promise<ComputeChargeResult> {
  // Import Privy server wallet dynamically to avoid circular deps
  const { signAgentTransaction } = await import('@/lib/privy/server-wallet');

  let balanceBefore: bigint;

  try {
    // Check balance ON-CHAIN
    balanceBefore = await checkAgentBalance(agentWalletAddress);

    if (balanceBefore < MIN_BALANCE) {
      // Log insufficient balance
      await supabase.from('compute_ledger').insert({
        agent_id: agentId,
        amount_usdc: '0',
        balance_before: formatUnits(balanceBefore, 6),
        balance_after: formatUnits(balanceBefore, 6),
        status: 'insufficient_balance',
        error_message: `Balance ${formatUnits(balanceBefore, 6)} below minimum ${formatUnits(MIN_BALANCE, 6)}`,
      });

      // Mark agent as needing funding
      await supabase.from('agents').update({ needs_funding: true }).eq('id', agentId);

      return {
        success: false,
        charged: false,
        refunded: false,
        balanceBefore: formatUnits(balanceBefore, 6),
        balanceAfter: formatUnits(balanceBefore, 6),
        feeCharged: '0',
        error: 'Insufficient balance',
      };
    }

    // Build USDC transfer data
    const transferData = encodeTransferData(treasuryAddress as Address, COMPUTE_FEE);

    // Sign and send via Privy
    const result = await signAgentTransaction(privyWalletId, USDC_ADDRESS, transferData);
    const txHash = result.hash;

    // Wait for confirmation
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const balanceAfter = await checkAgentBalance(agentWalletAddress);

    // Log with tx_hash for VERIFICATION
    await supabase.from('compute_ledger').insert({
      agent_id: agentId,
      amount_usdc: formatUnits(COMPUTE_FEE, 6),
      tx_hash: txHash,
      balance_before: formatUnits(balanceBefore, 6),
      balance_after: formatUnits(balanceAfter, 6),
      status: 'charged',
    });

    // Clear needs_funding flag
    await supabase.from('agents').update({ needs_funding: false }).eq('id', agentId);

    return {
      success: true,
      charged: true,
      refunded: false,
      balanceBefore: formatUnits(balanceBefore, 6),
      balanceAfter: formatUnits(balanceAfter, 6),
      feeCharged: formatUnits(COMPUTE_FEE, 6),
      txHash,
    };
  } catch (error) {
    // Log failed charge
    await supabase.from('compute_ledger').insert({
      agent_id: agentId,
      amount_usdc: '0',
      balance_before: balanceBefore! ? formatUnits(balanceBefore, 6) : '0',
      balance_after: balanceBefore! ? formatUnits(balanceBefore, 6) : '0',
      status: 'transfer_failed',
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      charged: false,
      refunded: false,
      balanceBefore: balanceBefore! ? formatUnits(balanceBefore, 6) : '0',
      balanceAfter: balanceBefore! ? formatUnits(balanceBefore, 6) : '0',
      feeCharged: '0',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Refund compute fee ON-CHAIN (if Claude API fails after charging)
 * Treasury sends USDC back to agent
 *
 * @param agentId - Agent's database ID
 * @param agentWalletAddress - Agent's wallet to receive refund
 * @param supabase - Supabase client for logging
 */
export async function refundComputeFee(
  agentId: string,
  agentWalletAddress: string,
  supabase: SupabaseClient
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const treasuryPrivateKey = process.env.ORACLE_PRIVATE_KEY; // Oracle/Treasury use same wallet
  if (!treasuryPrivateKey) {
    return { success: false, error: 'Treasury private key not configured' };
  }

  const account = privateKeyToAccount(treasuryPrivateKey as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.ALCHEMY_BASE_URL),
  });

  try {
    // Refund ON-CHAIN
    const refundTxHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'transfer',
      args: [agentWalletAddress as Address, COMPUTE_FEE],
    });

    await publicClient.waitForTransactionReceipt({ hash: refundTxHash });

    // Log refund with tx_hash for VERIFICATION
    await supabase.from('compute_ledger').insert({
      agent_id: agentId,
      amount_usdc: `-${formatUnits(COMPUTE_FEE, 6)}`, // Negative = refund
      tx_hash: refundTxHash,
      status: 'refunded',
      error_message: 'Compute failed after charge, refunded',
    });

    return { success: true, txHash: refundTxHash };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Refund failed',
    };
  }
}

/**
 * Deduct compute credits for Path B agents (pre-purchased credits)
 * No on-chain transaction - just database deduction
 */
export async function deductComputeCredits(
  agentId: string,
  supabase: SupabaseClient
): Promise<{ success: boolean; newBalance?: string; error?: string }> {
  // Get current credits
  const { data: agent, error: fetchError } = await supabase
    .from('agents')
    .select('compute_credits')
    .eq('id', agentId)
    .single();

  if (fetchError || !agent) {
    return { success: false, error: 'Agent not found' };
  }

  const currentCredits = parseFloat(agent.compute_credits || '0');
  const feeAmount = parseFloat(formatUnits(COMPUTE_FEE, 6));

  if (currentCredits < feeAmount) {
    return {
      success: false,
      error: `Insufficient credits: ${currentCredits} < ${feeAmount}`,
    };
  }

  const newCredits = currentCredits - feeAmount;

  // Deduct credits
  const { error: updateError } = await supabase
    .from('agents')
    .update({ compute_credits: newCredits.toFixed(6) })
    .eq('id', agentId);

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  // Log to compute ledger (no tx_hash since not on-chain)
  await supabase.from('compute_ledger').insert({
    agent_id: agentId,
    amount_usdc: feeAmount.toFixed(6),
    balance_before: currentCredits.toFixed(6),
    balance_after: newCredits.toFixed(6),
    status: 'charged',
    error_message: 'Deducted from pre-purchased credits (Path B)',
  });

  return { success: true, newBalance: newCredits.toFixed(6) };
}

// Helper to encode USDC transfer data
function encodeTransferData(to: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });
}
