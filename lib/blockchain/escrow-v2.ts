/**
 * WildWestEscrowV2 Contract Helpers
 *
 * V2 adds: oracle permissions, delivery tracking, disputes, pausable
 * See: contracts/src/WildWestEscrowV2.sol
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type Hex,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  keccak256,
  toHex,
  toBytes,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// V2 Contract ABI
export const ESCROW_V2_ABI = [
  // State variables
  {
    name: 'FEE_BASIS_POINTS',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'treasury',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'oracle',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  // Escrow functions
  {
    name: 'createEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'seller', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadlineHours', type: 'uint256' },
      { name: 'disputeWindowHours', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'markDelivered',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'deliverableHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'dispute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'release',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'refund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'resolveDispute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'releaseToSeller', type: 'bool' },
    ],
    outputs: [],
  },
  // View functions
  {
    name: 'getEscrow',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'buyer', type: 'address' },
          { name: 'seller', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'deliveredAt', type: 'uint256' },
          { name: 'disputeWindowHours', type: 'uint256' },
          { name: 'deliverableHash', type: 'bytes32' },
          { name: 'state', type: 'uint8' },
          { name: 'disputed', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'isAutoReleaseReady',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'isRefundReady',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  // Events
  {
    name: 'EscrowCreated',
    type: 'event',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false },
      { name: 'disputeWindowHours', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'EscrowDelivered',
    type: 'event',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'deliveredAt', type: 'uint256', indexed: false },
      { name: 'deliverableHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    name: 'EscrowDisputed',
    type: 'event',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'disputedBy', type: 'address', indexed: false },
    ],
  },
  {
    name: 'EscrowReleased',
    type: 'event',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'sellerAmount', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'EscrowRefunded',
    type: 'event',
    inputs: [
      { name: 'escrowId', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ERC20 ABI for USDC
export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// Contract addresses
export const ESCROW_V2_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS as Address;

// USDC addresses
export const USDC_ADDRESS = {
  mainnet: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  sepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
};

// Chain config
const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia';
export const CHAIN = isTestnet ? baseSepolia : base;
export const USDC = isTestnet ? USDC_ADDRESS.sepolia : USDC_ADDRESS.mainnet;

// Public client for reading
export const publicClientV2 = createPublicClient({
  chain: CHAIN,
  transport: http(process.env.ALCHEMY_BASE_URL),
});

// Escrow state enum (matches V2 contract)
export enum EscrowStateV2 {
  NONE = 0,
  FUNDED = 1,
  DELIVERED = 2,
  DISPUTED = 3,
  RELEASED = 4,
  REFUNDED = 5,
}

// Convert UUID to bytes32 for on-chain
export function uuidToBytes32(uuid: string): Hex {
  const cleanUuid = uuid.replace(/-/g, '');
  return keccak256(toHex(cleanUuid));
}

// Hash deliverable content for on-chain proof
export function hashDeliverable(content: string): Hex {
  return keccak256(toBytes(content));
}

// Get escrow details from V2 contract
export async function getEscrowV2(escrowId: string) {
  const bytes32Id = uuidToBytes32(escrowId);

  const result = await publicClientV2.readContract({
    address: ESCROW_V2_ADDRESS,
    abi: ESCROW_V2_ABI,
    functionName: 'getEscrow',
    args: [bytes32Id],
  });

  return {
    buyer: result.buyer,
    seller: result.seller,
    amount: result.amount,
    createdAt: Number(result.createdAt),
    deadline: Number(result.deadline),
    deliveredAt: Number(result.deliveredAt),
    disputeWindowHours: Number(result.disputeWindowHours),
    deliverableHash: result.deliverableHash,
    state: result.state as EscrowStateV2,
    disputed: result.disputed,
  };
}

// Check if auto-release is ready
export async function isAutoReleaseReady(escrowId: string): Promise<boolean> {
  const bytes32Id = uuidToBytes32(escrowId);

  return publicClientV2.readContract({
    address: ESCROW_V2_ADDRESS,
    abi: ESCROW_V2_ABI,
    functionName: 'isAutoReleaseReady',
    args: [bytes32Id],
  });
}

// Check if refund is ready
export async function isRefundReady(escrowId: string): Promise<boolean> {
  const bytes32Id = uuidToBytes32(escrowId);

  return publicClientV2.readContract({
    address: ESCROW_V2_ADDRESS,
    abi: ESCROW_V2_ABI,
    functionName: 'isRefundReady',
    args: [bytes32Id],
  });
}

// Build transaction data for creating V2 escrow
export function buildCreateEscrowV2Data(
  escrowId: string,
  seller: Address,
  amount: bigint,
  deadlineHours: number,
  disputeWindowHours: number = 24
): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_V2_ABI,
    functionName: 'createEscrow',
    args: [bytes32Id, seller, amount, BigInt(deadlineHours), BigInt(disputeWindowHours)],
  });
}

// Build transaction data for marking delivered
export function buildMarkDeliveredData(escrowId: string, deliverableContent: string): Hex {
  const bytes32Id = uuidToBytes32(escrowId);
  const deliverableHash = hashDeliverable(deliverableContent);

  return encodeFunctionData({
    abi: ESCROW_V2_ABI,
    functionName: 'markDelivered',
    args: [bytes32Id, deliverableHash],
  });
}

// Build transaction data for disputing
export function buildDisputeData(escrowId: string): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_V2_ABI,
    functionName: 'dispute',
    args: [bytes32Id],
  });
}

// Build transaction data for releasing
export function buildReleaseV2Data(escrowId: string): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_V2_ABI,
    functionName: 'release',
    args: [bytes32Id],
  });
}

// Build transaction data for refunding
export function buildRefundV2Data(escrowId: string): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_V2_ABI,
    functionName: 'refund',
    args: [bytes32Id],
  });
}

// Build transaction data for resolving dispute
export function buildResolveDisputeData(escrowId: string, releaseToSeller: boolean): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_V2_ABI,
    functionName: 'resolveDispute',
    args: [bytes32Id, releaseToSeller],
  });
}

// Build USDC approve data
export function buildApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

// Oracle wallet client for signing transactions
export function createOracleWalletClient() {
  const privateKey = process.env.ORACLE_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('ORACLE_PRIVATE_KEY not set');
  }

  const account = privateKeyToAccount(privateKey as Hex);

  return createWalletClient({
    account,
    chain: CHAIN,
    transport: http(process.env.ALCHEMY_BASE_URL),
  });
}

// Execute oracle release (auto-release after dispute window)
export async function oracleRelease(escrowId: string): Promise<Hash> {
  const walletClient = createOracleWalletClient();
  const bytes32Id = uuidToBytes32(escrowId);

  const hash = await walletClient.writeContract({
    address: ESCROW_V2_ADDRESS,
    abi: ESCROW_V2_ABI,
    functionName: 'release',
    args: [bytes32Id],
  });

  // Wait for confirmation
  await publicClientV2.waitForTransactionReceipt({ hash });

  return hash;
}

// Execute oracle refund (auto-refund after deadline)
export async function oracleRefund(escrowId: string): Promise<Hash> {
  const walletClient = createOracleWalletClient();
  const bytes32Id = uuidToBytes32(escrowId);

  const hash = await walletClient.writeContract({
    address: ESCROW_V2_ADDRESS,
    abi: ESCROW_V2_ABI,
    functionName: 'refund',
    args: [bytes32Id],
  });

  await publicClientV2.waitForTransactionReceipt({ hash });

  return hash;
}

// Execute oracle dispute resolution
export async function oracleResolveDispute(escrowId: string, releaseToSeller: boolean): Promise<Hash> {
  const walletClient = createOracleWalletClient();
  const bytes32Id = uuidToBytes32(escrowId);

  const hash = await walletClient.writeContract({
    address: ESCROW_V2_ADDRESS,
    abi: ESCROW_V2_ABI,
    functionName: 'resolveDispute',
    args: [bytes32Id, releaseToSeller],
  });

  await publicClientV2.waitForTransactionReceipt({ hash });

  return hash;
}

// Format USDC amount (6 decimals)
export function formatUSDC(amount: bigint): string {
  return formatUnits(amount, 6);
}

// Parse USDC amount to wei
export function parseUSDC(amount: string): bigint {
  return parseUnits(amount, 6);
}

// Calculate amounts after fee (1%)
export function calculateAmountsV2(amount: bigint) {
  const feeAmount = (amount * BigInt(100)) / BigInt(10000); // 1% fee
  const sellerAmount = amount - feeAmount;
  return { feeAmount, sellerAmount };
}
