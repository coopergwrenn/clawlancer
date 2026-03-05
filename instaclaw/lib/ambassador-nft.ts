import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// V2 contract — per-token image URIs (deployed 2026-03-05)
const CONTRACT = "0xe4F698f777ec115Ce1fA2E3476dB51Df21B9997E" as const;

const ABI = parseAbi([
  "function mintBadge(address to, string calldata name, uint32 number) external returns (uint256)",
  "function burnBadge(uint256 tokenId) external",
  "function getAmbassador(uint256 tokenId) external view returns (string name, uint32 number, uint64 dateIssued, address holder)",
  "function totalMinted() external view returns (uint256)",
]);

function getAccount() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  return privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : `0x${pk}`);
}

/**
 * Mint a soulbound ambassador NFT on Base mainnet.
 * Returns the token ID and transaction hash.
 */
export async function mintAmbassadorNFT(
  walletAddress: string,
  name: string,
  ambassadorNumber: number,
): Promise<{ tokenId: number; txHash: string }> {
  if (!walletAddress || !walletAddress.startsWith("0x")) {
    throw new Error("Invalid wallet address");
  }
  if (ambassadorNumber < 1) {
    throw new Error("Ambassador number must be >= 1");
  }

  const account = getAccount();
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  // Get total minted before so we can derive token ID after
  const totalBefore = await publicClient.readContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "totalMinted",
  });

  const hash = await walletClient.writeContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "mintBadge",
    args: [walletAddress as `0x${string}`, name, ambassadorNumber],
  });

  // Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Mint transaction reverted: ${hash}`);
  }

  // Token ID = totalBefore + 1 (contract uses _nextTokenId starting at 1)
  const tokenId = Number(totalBefore) + 1;

  return { tokenId, txHash: hash };
}

/**
 * Burn (revoke) an ambassador NFT.
 */
export async function burnAmbassadorNFT(tokenId: number): Promise<string> {
  const account = getAccount();
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  const hash = await walletClient.writeContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "burnBadge",
    args: [BigInt(tokenId)],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Burn transaction reverted: ${hash}`);
  }

  return hash;
}
