/**
 * Coinbase Developer Platform (CDP) Smart Wallet Client
 *
 * Provides programmatic wallet creation and management via CDP API.
 * Reference: https://docs.cdp.coinbase.com
 */

const CDP_API_URL = 'https://api.developer.coinbase.com';

interface CdpWalletResponse {
  id: string;
  default_address: {
    address_id: string;
    wallet_id: string;
    network_id: string;
  };
}

interface CdpBalanceResponse {
  data: Array<{
    amount: string;
    asset: {
      asset_id: string;
      network_id: string;
      decimals: number;
    };
  }>;
}

/**
 * Create a new CDP wallet on Base mainnet
 */
export async function createCdpWallet(): Promise<{ walletId: string; address: string }> {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!apiKeyId || !apiKeySecret) {
    throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set');
  }

  // Use the Coinbase SDK or direct REST API
  // For now, use REST API directly
  const response = await fetch(`${CDP_API_URL}/platform/v1/wallets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKeySecret}`,
      'X-Api-Key-Id': apiKeyId,
    },
    body: JSON.stringify({
      network_id: 'base-mainnet',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`CDP wallet creation failed: ${response.status} ${error}`);
  }

  const wallet: CdpWalletResponse = await response.json();

  return {
    walletId: wallet.id,
    address: wallet.default_address.address_id,
  };
}

/**
 * Get the address for a CDP wallet
 */
export async function getCdpWalletAddress(walletId: string): Promise<string> {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!apiKeyId || !apiKeySecret) {
    throw new Error('CDP credentials not configured');
  }

  const response = await fetch(`${CDP_API_URL}/platform/v1/wallets/${walletId}`, {
    headers: {
      'Authorization': `Bearer ${apiKeySecret}`,
      'X-Api-Key-Id': apiKeyId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch CDP wallet: ${response.status}`);
  }

  const wallet: CdpWalletResponse = await response.json();
  return wallet.default_address.address_id;
}

/**
 * Get USDC balance for a CDP wallet
 */
export async function getCdpBalance(walletId: string): Promise<string> {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!apiKeyId || !apiKeySecret) {
    throw new Error('CDP credentials not configured');
  }

  const response = await fetch(
    `${CDP_API_URL}/platform/v1/wallets/${walletId}/balances`,
    {
      headers: {
        'Authorization': `Bearer ${apiKeySecret}`,
        'X-Api-Key-Id': apiKeyId,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch CDP balance: ${response.status}`);
  }

  const data: CdpBalanceResponse = await response.json();
  const usdcBalance = data.data.find(b => b.asset.asset_id === 'usdc');
  return usdcBalance?.amount || '0';
}

/**
 * Check if CDP credentials are configured
 */
export function isCdpConfigured(): boolean {
  return !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
}

/**
 * Validate a CDP wallet ID format
 */
export function isValidCdpWalletId(walletId: string): boolean {
  return /^[a-f0-9-]{36}$/.test(walletId);
}
