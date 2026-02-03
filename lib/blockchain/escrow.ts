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
} from 'viem';
import { base, baseSepolia } from 'viem/chains';

// Contract ABI - minimal interface for escrow operations
export const ESCROW_ABI = [
  {
    name: 'create',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'seller', type: 'address' },
      { name: 'deadlineHours', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'createWithToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'seller', type: 'address' },
      { name: 'deadlineHours', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'release',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'refund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'getEscrow',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'state', type: 'uint8' },
      { name: 'token', type: 'address' },
    ],
  },
  {
    name: 'fee',
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
  // Events
  {
    name: 'Created',
    type: 'event',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'token', type: 'address', indexed: false },
    ],
  },
  {
    name: 'Released',
    type: 'event',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'sellerAmount', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'Refunded',
    type: 'event',
    inputs: [{ name: 'id', type: 'bytes32', indexed: true }],
  },
] as const;

// ERC20 ABI for USDC operations
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
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// Contract addresses
export const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS as Address;

// USDC addresses
export const USDC_ADDRESS = {
  mainnet: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  sepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
};

// Determine which chain to use
const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia';
export const CHAIN = isTestnet ? baseSepolia : base;
export const USDC = isTestnet ? USDC_ADDRESS.sepolia : USDC_ADDRESS.mainnet;

// Create public client for reading
export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(process.env.ALCHEMY_BASE_URL),
});

// Escrow state enum (matches contract)
export enum EscrowState {
  FUNDED = 0,
  RELEASED = 1,
  REFUNDED = 2,
}

// Convert UUID to bytes32 for on-chain
export function uuidToBytes32(uuid: string): Hex {
  // Remove hyphens and pad to 32 bytes
  const cleanUuid = uuid.replace(/-/g, '');
  return keccak256(toHex(cleanUuid));
}

// Get escrow details from chain
export async function getOnChainEscrow(escrowId: string) {
  const bytes32Id = uuidToBytes32(escrowId);

  const result = await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'getEscrow',
    args: [bytes32Id],
  });

  const [buyer, seller, amount, deadline, state, token] = result;

  return {
    buyer,
    seller,
    amount,
    deadline: Number(deadline),
    state: state as EscrowState,
    token,
    isActive: state === EscrowState.FUNDED,
    isETH: token === '0x0000000000000000000000000000000000000000',
  };
}

// Get wallet ETH balance
export async function getETHBalance(address: Address): Promise<bigint> {
  return publicClient.getBalance({ address });
}

// Get wallet USDC balance
export async function getUSDCBalance(address: Address): Promise<bigint> {
  return publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

// Format USDC amount (6 decimals)
export function formatUSDC(amount: bigint): string {
  return formatUnits(amount, 6);
}

// Parse USDC amount to wei
export function parseUSDC(amount: string): bigint {
  return parseUnits(amount, 6);
}

// Format ETH amount
export function formatETH(amount: bigint): string {
  return formatUnits(amount, 18);
}

// Build transaction data for creating USDC escrow
export function buildCreateUSDCEscrowData(
  escrowId: string,
  seller: Address,
  deadlineHours: number,
  amount: bigint
): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: 'createWithToken',
    args: [bytes32Id, seller, BigInt(deadlineHours), USDC, amount],
  });
}

// Build transaction data for creating ETH escrow
export function buildCreateETHEscrowData(
  escrowId: string,
  seller: Address,
  deadlineHours: number
): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: 'create',
    args: [bytes32Id, seller, BigInt(deadlineHours)],
  });
}

// Build transaction data for releasing escrow
export function buildReleaseData(escrowId: string): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: 'release',
    args: [bytes32Id],
  });
}

// Build transaction data for refunding escrow
export function buildRefundData(escrowId: string): Hex {
  const bytes32Id = uuidToBytes32(escrowId);

  return encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: 'refund',
    args: [bytes32Id],
  });
}

// Build USDC approve transaction data
export function buildApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

// Get contract fee (in basis points)
export async function getContractFee(): Promise<number> {
  const fee = await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'fee',
  });
  return Number(fee);
}

// Calculate amounts after fee
export function calculateAmounts(amount: bigint, feeBps: number = 100) {
  const feeAmount = (amount * BigInt(feeBps)) / BigInt(10000);
  const sellerAmount = amount - feeAmount;
  return { feeAmount, sellerAmount };
}
