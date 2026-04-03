/**
 * AgentBook on-chain lookup utilities for WDP 71 integration.
 *
 * Wraps the AgentBook contract on Base mainnet to check whether
 * an agent wallet is registered (backed by a World ID human).
 *
 * Contract: 0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4 (Base mainnet)
 * Sepolia:  0xA23aB2712eA7BBa896930544C7d6636a96b944dA (Base Sepolia)
 */

import { createPublicClient, http, fallback, defineChain, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

const worldchain = defineChain({
  id: 480,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://worldchain-mainnet.g.alchemy.com/public"] } },
});

const AGENTBOOK_ADDRESS = "0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4" as const;
const AGENTBOOK_ADDRESS_SEPOLIA = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as const;
const AGENTBOOK_ADDRESS_WORLDCHAIN = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as const;

// Minimal ABI — only the view functions we need
const AGENTBOOK_ABI = [
  {
    name: "lookupHuman",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getNextNonce",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Base mainnet RPC endpoints with fallback (same as Python script)
const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base.drpc.org",
];

type Network = "base" | "base-sepolia" | "worldchain";

function getClient(network: Network = "base") {
  if (network === "worldchain") {
    return createPublicClient({ chain: worldchain, transport: http() });
  }
  const chain = network === "base" ? base : baseSepolia;
  const transport = network === "base"
    ? fallback(BASE_RPC_URLS.map((url) => http(url, { timeout: 10_000 })))
    : http();
  return createPublicClient({ chain, transport });
}

function getContractAddress(network: Network = "base"): Address {
  if (network === "worldchain") return AGENTBOOK_ADDRESS_WORLDCHAIN;
  return network === "base" ? AGENTBOOK_ADDRESS : AGENTBOOK_ADDRESS_SEPOLIA;
}

/**
 * Look up the human nullifier hash for a given agent wallet address.
 * Returns the nullifier hash (as bigint) or null if the agent is not registered.
 * A nullifier hash of 0n means not registered.
 */
export async function lookupHuman(
  agentAddress: Address,
  network: Network = "base"
): Promise<bigint | null> {
  const client = getClient(network);
  const result = await client.readContract({
    address: getContractAddress(network),
    abi: AGENTBOOK_ABI,
    functionName: "lookupHuman",
    args: [agentAddress],
  });

  // 0 means not registered
  return result === BigInt(0) ? null : result;
}

/**
 * Check if an agent wallet is registered in AgentBook (has a human behind it).
 */
export async function isAgentRegistered(
  agentAddress: Address,
  network: Network = "base"
): Promise<boolean> {
  const nullifier = await lookupHuman(agentAddress, network);
  return nullifier !== null;
}

/**
 * Get the next nonce for an agent address (used during registration).
 */
export async function getNextNonce(
  agentAddress: Address,
  network: Network = "base"
): Promise<bigint> {
  const client = getClient(network);
  return client.readContract({
    address: getContractAddress(network),
    abi: AGENTBOOK_ABI,
    functionName: "getNextNonce",
    args: [agentAddress],
  });
}

export { AGENTBOOK_ADDRESS, AGENTBOOK_ADDRESS_SEPOLIA };
export type { Network as AgentBookNetwork };
