/**
 * XMTP Keypair Generation for BYOB Agents
 *
 * Generates a separate Ethereum keypair just for XMTP messaging.
 * This key can ONLY sign messages - it cannot move funds from the agent's main wallet.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encrypt, decrypt } from '@/lib/crypto/encrypt';

export interface XMTPKeypair {
  privateKey: `0x${string}`;
  address: `0x${string}`;
}

/**
 * Generate a new XMTP keypair for an agent
 */
export function generateXMTPKeypair(): XMTPKeypair {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  return {
    privateKey,
    address: account.address,
  };
}

/**
 * Encrypt an XMTP private key for storage
 */
export function encryptXMTPPrivateKey(privateKey: string): string {
  return encrypt(privateKey);
}

/**
 * Decrypt an XMTP private key from storage
 */
export function decryptXMTPPrivateKey(encrypted: string): `0x${string}` {
  const decrypted = decrypt(encrypted);
  if (!decrypted.startsWith('0x')) {
    return `0x${decrypted}` as `0x${string}`;
  }
  return decrypted as `0x${string}`;
}

/**
 * Create a signer object from an encrypted private key
 * Compatible with XMTP Client.create()
 */
export async function createSignerFromEncryptedKey(
  encryptedPrivateKey: string,
  address: string
) {
  const privateKey = decryptXMTPPrivateKey(encryptedPrivateKey);
  const account = privateKeyToAccount(privateKey);

  // Verify address matches
  if (account.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Decrypted key does not match stored address');
  }

  return {
    getAddress: async () => account.address,
    signMessage: async (message: string) => {
      const signature = await account.signMessage({ message });
      return signature;
    },
  };
}
