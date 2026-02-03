/**
 * Reputation Verification Endpoint
 *
 * Per PRD Section 1 (Trust Model):
 * - Anyone can verify reputation by scanning contract events
 * - Returns on-chain escrow events for an agent's wallet
 * - Compares on-chain data vs cached reputation
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, formatUnits } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { ESCROW_V2_ABI, ESCROW_V2_ADDRESS } from '@/lib/blockchain/escrow-v2'
import { calculateFromStats, ReputationScore } from '@/lib/reputation/calculate'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'sepolia'
const CHAIN = isTestnet ? baseSepolia : base

// GET /api/agents/[id]/reputation/verify - Verify reputation against on-chain data
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Get agent with wallet address
  const { data: agent, error } = await supabaseAdmin
    .from('agents')
    .select(`
      id,
      name,
      wallet_address,
      reputation_score,
      reputation_tier,
      reputation_transactions
    `)
    .eq('id', id)
    .single()

  if (error || !agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  if (!agent.wallet_address) {
    return NextResponse.json({ error: 'Agent has no wallet address' }, { status: 400 })
  }

  const publicClient = createPublicClient({
    chain: CHAIN,
    transport: http(process.env.ALCHEMY_BASE_URL),
  })

  try {
    // Get on-chain events for this seller
    // EscrowCreated has seller as indexed parameter
    const createdLogs = await publicClient.getLogs({
      address: ESCROW_V2_ADDRESS,
      event: {
        type: 'event',
        name: 'EscrowCreated',
        inputs: [
          { name: 'escrowId', type: 'bytes32', indexed: true },
          { name: 'buyer', type: 'address', indexed: true },
          { name: 'seller', type: 'address', indexed: true },
          { name: 'amount', type: 'uint256', indexed: false },
          { name: 'deadline', type: 'uint256', indexed: false },
          { name: 'disputeWindowHours', type: 'uint256', indexed: false },
        ],
      },
      args: {
        seller: agent.wallet_address as `0x${string}`,
      },
      fromBlock: 'earliest',
      toBlock: 'latest',
    })

    // Get release events for escrows created to this seller
    const escrowIds = createdLogs.map((log) => log.args.escrowId)

    let releasedCount = 0
    let refundedCount = 0
    let disputedCount = 0
    let totalVolume = BigInt(0)

    const onChainTransactions: Array<{
      escrowId: string
      amount: string
      outcome: 'released' | 'refunded' | 'disputed' | 'pending'
      blockNumber: bigint
      txHash: string
    }> = []

    // Check status of each escrow
    for (const log of createdLogs) {
      const escrowId = log.args.escrowId!
      const amount = log.args.amount!

      // Check for release
      const releaseLogs = await publicClient.getLogs({
        address: ESCROW_V2_ADDRESS,
        event: {
          type: 'event',
          name: 'EscrowReleased',
          inputs: [
            { name: 'escrowId', type: 'bytes32', indexed: true },
            { name: 'sellerAmount', type: 'uint256', indexed: false },
            { name: 'feeAmount', type: 'uint256', indexed: false },
          ],
        },
        args: { escrowId },
        fromBlock: log.blockNumber,
        toBlock: 'latest',
      })

      if (releaseLogs.length > 0) {
        releasedCount++
        totalVolume += amount
        onChainTransactions.push({
          escrowId: escrowId,
          amount: formatUnits(amount, 6),
          outcome: 'released',
          blockNumber: releaseLogs[0].blockNumber,
          txHash: releaseLogs[0].transactionHash,
        })
        continue
      }

      // Check for refund
      const refundLogs = await publicClient.getLogs({
        address: ESCROW_V2_ADDRESS,
        event: {
          type: 'event',
          name: 'EscrowRefunded',
          inputs: [
            { name: 'escrowId', type: 'bytes32', indexed: true },
            { name: 'amount', type: 'uint256', indexed: false },
          ],
        },
        args: { escrowId },
        fromBlock: log.blockNumber,
        toBlock: 'latest',
      })

      if (refundLogs.length > 0) {
        refundedCount++
        onChainTransactions.push({
          escrowId: escrowId,
          amount: formatUnits(amount, 6),
          outcome: 'refunded',
          blockNumber: refundLogs[0].blockNumber,
          txHash: refundLogs[0].transactionHash,
        })
        continue
      }

      // Check for dispute
      const disputeLogs = await publicClient.getLogs({
        address: ESCROW_V2_ADDRESS,
        event: {
          type: 'event',
          name: 'EscrowDisputed',
          inputs: [
            { name: 'escrowId', type: 'bytes32', indexed: true },
            { name: 'disputedBy', type: 'address', indexed: false },
          ],
        },
        args: { escrowId },
        fromBlock: log.blockNumber,
        toBlock: 'latest',
      })

      if (disputeLogs.length > 0) {
        disputedCount++
        onChainTransactions.push({
          escrowId: escrowId,
          amount: formatUnits(amount, 6),
          outcome: 'disputed',
          blockNumber: disputeLogs[0].blockNumber,
          txHash: disputeLogs[0].transactionHash,
        })
        continue
      }

      // Still pending
      onChainTransactions.push({
        escrowId: escrowId,
        amount: formatUnits(amount, 6),
        outcome: 'pending',
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      })
    }

    // Calculate on-chain reputation
    const onChainStats = {
      released_count: releasedCount,
      disputed_count: disputedCount,
      refunded_count: refundedCount,
      total_count: releasedCount + disputedCount + refundedCount,
      total_volume_wei: totalVolume.toString(),
    }

    const onChainReputation = calculateFromStats(onChainStats)

    // Compare with cached reputation
    const cachedScore = agent.reputation_score || 0
    const cachedTier = agent.reputation_tier || 'NEW'
    const cachedTransactions = agent.reputation_transactions || 0

    const discrepancy = {
      scoreMatch: Math.abs(cachedScore - onChainReputation.score) < 0.1,
      tierMatch: cachedTier === onChainReputation.tier,
      transactionCountMatch: cachedTransactions === onChainReputation.totalTransactions,
    }

    const verified = discrepancy.scoreMatch && discrepancy.tierMatch && discrepancy.transactionCountMatch

    return NextResponse.json({
      agent_id: id,
      agent_name: agent.name,
      wallet_address: agent.wallet_address,
      verification: {
        verified,
        discrepancy: verified ? null : discrepancy,
        message: verified
          ? 'Cached reputation matches on-chain data'
          : 'Discrepancy detected between cached and on-chain reputation',
      },
      onChain: {
        reputation: onChainReputation,
        stats: onChainStats,
        totalVolumeUSDC: formatUnits(totalVolume, 6),
        transactions: onChainTransactions.slice(0, 50), // Limit response size
        contractAddress: ESCROW_V2_ADDRESS,
        chain: isTestnet ? 'base-sepolia' : 'base',
      },
      cached: {
        score: cachedScore,
        tier: cachedTier,
        totalTransactions: cachedTransactions,
      },
    })
  } catch (err) {
    console.error('Verification error:', err)
    return NextResponse.json(
      {
        error: 'Failed to verify on-chain reputation',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
