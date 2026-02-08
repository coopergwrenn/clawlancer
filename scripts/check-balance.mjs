import { createPublicClient, http, formatEther, formatUnits, getAddress } from 'viem'
import { base } from 'viem/chains'

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const wallet = getAddress('0x7bab09ed1df02f51491dc0e240c88eee1e4d792e')

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org')
})

const ethBalance = await client.getBalance({ address: wallet })
console.log('💰 Cooper\'s Wallet on Base:')
console.log(`   Address: ${wallet}`)
console.log(`   ETH: ${formatEther(ethBalance)} ETH`)

const usdcBalance = await client.readContract({
  address: USDC_ADDRESS,
  abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
  functionName: 'balanceOf',
  args: [wallet]
})

console.log(`   USDC: ${formatUnits(usdcBalance, 6)} USDC`)
console.log('\n' + (parseFloat(formatUnits(usdcBalance, 6)) > 0 ? '✅ Ready for on-chain bounties!' : '⚠️  No USDC found'))
