/**
 * Oracle Wallet Health Monitoring
 *
 * Monitors the oracle wallet's ETH balance to ensure it can pay gas for:
 * - Auto-release transactions
 * - Auto-refund transactions
 * - Dispute resolutions
 */

import { createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { base, baseSepolia } from 'viem/chains';

const MIN_BALANCE_WARNING = parseUnits('0.1', 18); // 0.1 ETH
const MIN_BALANCE_CRITICAL = parseUnits('0.05', 18); // 0.05 ETH

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia';
const CHAIN = isTestnet ? baseSepolia : base;

export interface WalletHealth {
  healthy: boolean;
  balanceEth: string;
  balanceUsd: number;
  warningLevel: 'ok' | 'low' | 'critical';
}

/**
 * Check the oracle wallet's ETH balance and health status
 */
export async function checkOracleWalletHealth(): Promise<WalletHealth> {
  const oracleAddress = process.env.ORACLE_ADDRESS;

  if (!oracleAddress) {
    return {
      healthy: false,
      balanceEth: '0',
      balanceUsd: 0,
      warningLevel: 'critical'
    };
  }

  const publicClient = createPublicClient({
    chain: CHAIN,
    transport: http(process.env.ALCHEMY_BASE_URL)
  });

  try {
    const balance = await publicClient.getBalance({
      address: oracleAddress as `0x${string}`
    });

    const balanceEth = formatUnits(balance, 18);
    // Rough ETH price estimate - in production, fetch from price oracle
    const balanceUsd = parseFloat(balanceEth) * 2500;

    let warningLevel: 'ok' | 'low' | 'critical';
    if (balance < MIN_BALANCE_CRITICAL) {
      warningLevel = 'critical';
    } else if (balance < MIN_BALANCE_WARNING) {
      warningLevel = 'low';
    } else {
      warningLevel = 'ok';
    }

    return {
      healthy: warningLevel !== 'critical',
      balanceEth,
      balanceUsd,
      warningLevel
    };
  } catch (error) {
    console.error('Failed to check oracle wallet health:', error);
    return {
      healthy: false,
      balanceEth: '0',
      balanceUsd: 0,
      warningLevel: 'critical'
    };
  }
}

/**
 * Get the oracle wallet address
 */
export function getOracleAddress(): string | undefined {
  return process.env.ORACLE_ADDRESS;
}
