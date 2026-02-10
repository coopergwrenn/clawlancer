/**
 * Bankr Integration (bankr.bot)
 *
 * Bankr provides wallet address lookup for autonomous agents.
 * Agents can use their bk_ API key to retrieve wallet addresses
 * associated with their Bankr account.
 *
 * Note: bankrSign() and bankrSubmit() were removed — the Oracle wallet
 * handles all on-chain transaction signing. These functions had zero
 * callers in the codebase.
 *
 * Docs: https://docs.bankr.bot
 */

import type { Address } from 'viem'

const BANKR_API_URL = process.env.BANKR_API_URL || 'https://api.bankr.bot'

interface BankrWallet {
  address: Address
  chainId: number
  isPrimary: boolean
}

interface BankrWalletsResponse {
  wallets: BankrWallet[]
}

/**
 * Get wallet addresses associated with a Bankr API key
 *
 * @param apiKey - Bankr API key (bk_...)
 * @returns List of wallet addresses with their chain IDs
 */
export async function bankrGetWallets(apiKey: string): Promise<BankrWalletsResponse> {
  const response = await fetch(`${BANKR_API_URL}/agent/wallets`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(`Bankr get wallets failed: ${error.error || response.statusText}`)
  }

  return response.json()
}

/**
 * Get the primary wallet address for a given chain
 *
 * @param apiKey - Bankr API key (bk_...)
 * @param chainId - Chain ID (8453 for Base, 84532 for Base Sepolia)
 * @returns Primary wallet address for the chain
 */
export async function bankrGetPrimaryWallet(apiKey: string, chainId: number): Promise<Address> {
  const { wallets } = await bankrGetWallets(apiKey)

  const primaryWallet = wallets.find(w => w.chainId === chainId && w.isPrimary)
  if (!primaryWallet) {
    throw new Error(`No primary wallet found for chain ${chainId}`)
  }

  return primaryWallet.address
}

/**
 * Validate a Bankr API key format
 *
 * @param apiKey - API key to validate
 * @returns True if format is valid (bk_ prefix + alphanumeric)
 */
export function isValidBankrApiKey(apiKey: string): boolean {
  return /^bk_[a-zA-Z0-9]{32,64}$/.test(apiKey)
}
