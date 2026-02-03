/**
 * Oracle Retry Logic with Exponential Backoff
 *
 * Per PRD Section 5:
 * - Exponential backoff: 1s → 2s → 4s → 8s → 16s (max 30s)
 * - Retryable errors: nonce, underpriced, timeout, rate limit, network
 * - Non-retryable errors: revert, insufficient balance, invalid state
 * - All operations are idempotent — check state before executing
 */

import { sendAlert } from '@/lib/monitoring/alerts';
import { ESCROW_V2_ABI, EscrowStateV2 } from '@/lib/blockchain/escrow-v2';

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2
};

interface RetryResult<T> {
  success: boolean;
  result?: T;
  attempts: number;
  lastError?: string;
}

/**
 * Execute an on-chain oracle operation with exponential backoff
 * Handles gas estimation failures, nonce issues, and RPC errors
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: Partial<RetryConfig> = {}
): Promise<RetryResult<T>> {
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config
  };

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      return { success: true, result, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      const errorMsg = lastError.message.toLowerCase();
      const isRetryable =
        errorMsg.includes('nonce') ||
        errorMsg.includes('underpriced') ||
        errorMsg.includes('timeout') ||
        errorMsg.includes('rate limit') ||
        errorMsg.includes('502') ||
        errorMsg.includes('503') ||
        errorMsg.includes('network') ||
        errorMsg.includes('econnreset') ||
        errorMsg.includes('socket hang up');

      if (!isRetryable || attempt === maxAttempts) {
        await sendAlert('error', `Oracle operation failed after ${attempt} attempts: ${operationName}`, {
          error: lastError.message,
          attempts: attempt,
          retryable: isRetryable
        });
        return { success: false, attempts: attempt, lastError: lastError.message };
      }

      // Log retry attempt
      console.log(`[Oracle] ${operationName} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`);

      // Wait with exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  return { success: false, attempts: maxAttempts, lastError: lastError?.message };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PublicClientLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WalletClientLike = any;

/**
 * Idempotent oracle release — safe to retry
 * Checks on-chain state before executing to avoid double-release
 */
export async function safeOracleRelease(
  escrowIdBytes32: `0x${string}`,
  publicClient: PublicClientLike,
  walletClient: WalletClientLike,
  contractAddress: `0x${string}`
): Promise<{ success: boolean; txHash?: string; alreadyReleased?: boolean; error?: string }> {
  // First check if already released (idempotency)
  try {
    const escrow = await publicClient.readContract({
      address: contractAddress,
      abi: ESCROW_V2_ABI,
      functionName: 'getEscrow',
      args: [escrowIdBytes32]
    }) as { state: number };

    if (escrow.state === EscrowStateV2.RELEASED) {
      return { success: true, alreadyReleased: true };
    }

    if (escrow.state === EscrowStateV2.REFUNDED) {
      return { success: false, alreadyReleased: true, error: 'Already refunded' };
    }

    if (escrow.state !== EscrowStateV2.DELIVERED) {
      return { success: false, error: `Invalid state for release: ${escrow.state}` };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to check escrow state: ${error instanceof Error ? error.message : 'Unknown'}`
    };
  }

  // Execute with retry
  const result = await executeWithRetry(
    async () => {
      const hash = await walletClient.writeContract({
        address: contractAddress,
        abi: ESCROW_V2_ABI,
        functionName: 'release',
        args: [escrowIdBytes32]
      });
      return hash;
    },
    `release(${escrowIdBytes32.slice(0, 10)}...)`
  );

  return {
    success: result.success,
    txHash: result.result,
    alreadyReleased: false,
    error: result.lastError
  };
}

/**
 * Idempotent oracle refund — safe to retry
 * Checks on-chain state before executing to avoid double-refund
 */
export async function safeOracleRefund(
  escrowIdBytes32: `0x${string}`,
  publicClient: PublicClientLike,
  walletClient: WalletClientLike,
  contractAddress: `0x${string}`
): Promise<{ success: boolean; txHash?: string; alreadyRefunded?: boolean; error?: string }> {
  // First check if already refunded (idempotency)
  try {
    const escrow = await publicClient.readContract({
      address: contractAddress,
      abi: ESCROW_V2_ABI,
      functionName: 'getEscrow',
      args: [escrowIdBytes32]
    }) as { state: number };

    if (escrow.state === EscrowStateV2.REFUNDED) {
      return { success: true, alreadyRefunded: true };
    }

    if (escrow.state === EscrowStateV2.RELEASED) {
      return { success: false, alreadyRefunded: true, error: 'Already released' };
    }

    if (escrow.state !== EscrowStateV2.FUNDED) {
      return { success: false, error: `Invalid state for refund: ${escrow.state}` };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to check escrow state: ${error instanceof Error ? error.message : 'Unknown'}`
    };
  }

  // Execute with retry
  const result = await executeWithRetry(
    async () => {
      const hash = await walletClient.writeContract({
        address: contractAddress,
        abi: ESCROW_V2_ABI,
        functionName: 'refund',
        args: [escrowIdBytes32]
      });
      return hash;
    },
    `refund(${escrowIdBytes32.slice(0, 10)}...)`
  );

  return {
    success: result.success,
    txHash: result.result,
    alreadyRefunded: false,
    error: result.lastError
  };
}
