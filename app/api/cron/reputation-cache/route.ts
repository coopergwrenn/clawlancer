/**
 * Reputation Cache Cron
 *
 * Per PRD Section 6 (Reputation System):
 * - Runs hourly to recalculate all agent reputation scores
 * - Updates cached scores in agents table
 * - Derives from on-chain transaction outcomes
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { calculateFromStats, ReputationScore } from '@/lib/reputation/calculate'
import { sendAlert } from '@/lib/monitoring/alerts'

const MAX_AGENTS_PER_RUN = 100 // Batch size for Vercel timeout safety

export async function POST(request: NextRequest) {
  const startTime = Date.now()

  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  try {
    // Get agents that need reputation updates
    // Prioritize agents with recent transactions or stale cache
    const { data: agents, error: agentsError } = await supabase
      .from('agents')
      .select('id, name, reputation_score, reputation_tier, reputation_updated_at')
      .order('reputation_updated_at', { ascending: true, nullsFirst: true })
      .limit(MAX_AGENTS_PER_RUN)

    if (agentsError) {
      await sendAlert('error', 'Reputation cache: failed to fetch agents', { error: agentsError })
      return NextResponse.json({ error: 'Database error' }, { status: 500 })
    }

    if (!agents || agents.length === 0) {
      return NextResponse.json({ message: 'No agents to process', processed: 0 })
    }

    const results: Array<{ agentId: string; status: string; score?: number; tier?: string }> = []

    for (const agent of agents) {
      try {
        // Get transaction stats for this agent (as seller)
        const { data: stats, error: statsError } = await supabase.rpc(
          'get_agent_transaction_stats',
          { agent_uuid: agent.id }
        )

        if (statsError) {
          // If the function doesn't exist, fall back to direct query
          const { data: txData } = await supabase
            .from('transactions')
            .select('state')
            .eq('seller_agent_id', agent.id)
            .in('state', ['RELEASED', 'REFUNDED', 'DISPUTED'])

          const fallbackStats = {
            released_count: txData?.filter((t) => t.state === 'RELEASED').length || 0,
            disputed_count: txData?.filter((t) => t.state === 'DISPUTED').length || 0,
            refunded_count: txData?.filter((t) => t.state === 'REFUNDED').length || 0,
            total_count: txData?.length || 0,
            total_volume_wei: '0',
          }

          const score = calculateFromStats(fallbackStats)
          await updateAgentReputation(supabase, agent.id, score)
          results.push({ agentId: agent.id, status: 'updated', score: score.score, tier: score.tier })
          continue
        }

        // Calculate new reputation from stats
        const score = calculateFromStats(stats || {
          released_count: 0,
          disputed_count: 0,
          refunded_count: 0,
          total_count: 0,
          total_volume_wei: '0',
        })

        // Update agent's cached reputation
        await updateAgentReputation(supabase, agent.id, score)

        results.push({ agentId: agent.id, status: 'updated', score: score.score, tier: score.tier })
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        results.push({ agentId: agent.id, status: 'error' })
        console.error(`Failed to update reputation for ${agent.id}:`, errorMsg)
      }
    }

    const successful = results.filter((r) => r.status === 'updated').length
    const failed = results.filter((r) => r.status === 'error').length

    if (failed > 0) {
      await sendAlert('warning', `Reputation cache: ${failed} failures out of ${results.length}`, {
        results,
      })
    }

    return NextResponse.json({
      processed: results.length,
      successful,
      failed,
      duration_ms: Date.now() - startTime,
      results,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    await sendAlert('error', 'Reputation cache cron failed', { error: errorMsg })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateAgentReputation(
  supabase: any,
  agentId: string,
  score: ReputationScore
) {
  await supabase
    .from('agents')
    .update({
      reputation_score: score.score,
      reputation_tier: score.tier,
      reputation_transactions: score.totalTransactions,
      reputation_success_rate: score.breakdown.successRate,
      reputation_updated_at: new Date().toISOString(),
    })
    .eq('id', agentId)
}

// Support GET for Vercel cron
export async function GET(request: NextRequest) {
  return POST(request)
}

export const runtime = 'nodejs'
export const maxDuration = 60
