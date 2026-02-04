import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, formatEther, formatUnits } from 'viem'
import { base } from 'viem/chains'

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS?.toLowerCase()

// ERC20 ABI for balanceOf
const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// GET /api/admin/house-bot-balances - Check all house bot wallet balances
export async function GET(request: NextRequest) {
  // Verify admin/system auth
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
      authHeader !== `Bearer ${process.env.AGENT_RUNNER_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Get house bots (owned by treasury)
    const { data: houseBots, error } = await supabaseAdmin
      .from('agents')
      .select('id, name, wallet_address, is_hosted, privy_wallet_id')
      .eq('owner_address', TREASURY_ADDRESS || '')

    if (error) {
      console.error('Failed to fetch house bots:', error)
      return NextResponse.json({ error: 'Failed to fetch house bots' }, { status: 500 })
    }

    if (!houseBots || houseBots.length === 0) {
      return NextResponse.json({
        message: 'No house bots found',
        treasury_address: TREASURY_ADDRESS,
        bots: [],
      })
    }

    // Create public client for Base
    const client = createPublicClient({
      chain: base,
      transport: http(),
    })

    interface HouseBot {
      id: string
      name: string
      wallet_address: string
      is_hosted: boolean
      privy_wallet_id: string | null
    }

    // Check balances for each bot
    const balances = await Promise.all(
      (houseBots as HouseBot[]).map(async (bot) => {
        try {
          const walletAddress = bot.wallet_address as `0x${string}`

          // Get ETH balance
          const ethBalance = await client.getBalance({ address: walletAddress })

          // Get USDC balance
          const usdcBalance = await client.readContract({
            address: USDC_ADDRESS,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [walletAddress],
          })

          return {
            id: bot.id,
            name: bot.name,
            wallet_address: bot.wallet_address,
            is_hosted: bot.is_hosted,
            has_privy_wallet: !!bot.privy_wallet_id,
            eth_wei: ethBalance.toString(),
            eth_formatted: formatEther(ethBalance),
            usdc_wei: usdcBalance.toString(),
            usdc_formatted: formatUnits(usdcBalance, 6),
            needs_funding: usdcBalance === BigInt(0),
          }
        } catch (err) {
          console.error(`Failed to get balance for ${bot.name}:`, err)
          return {
            id: bot.id,
            name: bot.name,
            wallet_address: bot.wallet_address,
            is_hosted: bot.is_hosted,
            has_privy_wallet: !!bot.privy_wallet_id,
            error: 'Failed to fetch balance',
          }
        }
      })
    )

    const needsFunding = balances.filter(b => b.needs_funding)

    return NextResponse.json({
      treasury_address: TREASURY_ADDRESS,
      total_house_bots: houseBots.length,
      bots_needing_funding: needsFunding.length,
      balances,
    })
  } catch (err) {
    console.error('Balance check error:', err)
    return NextResponse.json({ error: 'Balance check failed' }, { status: 500 })
  }
}
