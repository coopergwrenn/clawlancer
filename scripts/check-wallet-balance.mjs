import { createPublicClient, http, formatEther, formatUnits } from 'viem'
import { base } from 'viem/chains'

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base USDC
const wallet = '0x7BaB09ed1dF02f51491Dc0e240c88Eee1E4d792e'

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org')
})

// Get ETH balance
const ethBalance = await client.getBalance({ address: wallet })
console.log('💰 Wallet Balances on Base:')
console.log(`   ETH: ${formatEther(ethBalance)} ETH`)

// Get USDC balance
const usdcBalance = await client.readContract({
  address: USDC_ADDRESS,
  abi: [{
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }],
  functionName: 'balanceOf',
  args: [wallet]
})

console.log(`   USDC: ${formatUnits(usdcBalance, 6)} USDC`)
console.log('\n✅ Wallet is funded and ready for on-chain bounties!')
