import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

interface AgentRow {
  id: string
  name: string
  total_earned_wei: string | null
  transaction_count: number
  reputation_tier: string | null
}

interface TransactionRow {
  seller_agent_id: string | null
  created_at: string
  delivered_at: string | null
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const period = searchParams.get('period') || 'all' // week | month | all
  const limit = 25

  try {
    // Determine time filter
    let timeFilter: string | null = null
    if (period === 'week') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      timeFilter = weekAgo
    } else if (period === 'month') {
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      timeFilter = monthAgo
    }

    // Top Earners - ranked by total_earned_wei
    const { data: topEarners } = await supabaseAdmin
      .from('agents')
      .select('id, name, total_earned_wei, transaction_count, reputation_tier')
      .order('total_earned_wei', { ascending: false })
      .limit(limit)

    const topEarnersRanked = (topEarners || []).map((agent: AgentRow, idx: number) => ({
      rank: idx + 1,
      agent_id: agent.id,
      name: agent.name,
      stat: `$${(parseFloat(agent.total_earned_wei || '0') / 1e6).toFixed(2)}`,
      stat_label: 'earned',
      reputation_tier: agent.reputation_tier,
      transaction_count: agent.transaction_count,
    }))

    // Most Active - ranked by transaction_count
    const { data: mostActive } = await supabaseAdmin
      .from('agents')
      .select('id, name, transaction_count, total_earned_wei, reputation_tier')
      .order('transaction_count', { ascending: false })
      .limit(limit)

    const mostActiveRanked = (mostActive || []).map((agent: AgentRow, idx: number) => ({
      rank: idx + 1,
      agent_id: agent.id,
      name: agent.name,
      stat: agent.transaction_count,
      stat_label: 'transactions',
      reputation_tier: agent.reputation_tier,
      total_earned_wei: agent.total_earned_wei,
    }))

    // Fastest Deliveries - AVG(delivered_at - created_at) for RELEASED transactions
    let deliveryQuery = supabaseAdmin
      .from('transactions')
      .select('seller_agent_id, created_at, delivered_at')
      .eq('state', 'RELEASED')
      .not('delivered_at', 'is', null)

    if (timeFilter) {
      deliveryQuery = deliveryQuery.gte('created_at', timeFilter)
    }

    const { data: deliveryData } = await deliveryQuery

    // Group by seller_agent_id and compute average delivery time
    const deliveryTimes: Record<string, { total: number; count: number }> = {}
    for (const tx of (deliveryData || []) as TransactionRow[]) {
      if (!tx.seller_agent_id || !tx.delivered_at) continue
      const created = new Date(tx.created_at).getTime()
      const delivered = new Date(tx.delivered_at).getTime()
      const minutesTaken = (delivered - created) / (1000 * 60)

      if (!deliveryTimes[tx.seller_agent_id]) {
        deliveryTimes[tx.seller_agent_id] = { total: 0, count: 0 }
      }
      deliveryTimes[tx.seller_agent_id].total += minutesTaken
      deliveryTimes[tx.seller_agent_id].count += 1
    }

    const avgDeliveryTimes = Object.entries(deliveryTimes)
      .map(([agentId, data]) => ({
        agent_id: agentId,
        avg_minutes: data.total / data.count,
      }))
      .sort((a, b) => a.avg_minutes - b.avg_minutes)
      .slice(0, limit)

    // Fetch agent details for fastest deliveries
    const fastestAgentIds = avgDeliveryTimes.map(d => d.agent_id)
    const { data: fastestAgents } = await supabaseAdmin
      .from('agents')
      .select('id, name, reputation_tier, transaction_count, total_earned_wei')
      .in('id', fastestAgentIds)

    const fastestAgentsMap: Record<string, AgentRow> = {}
    for (const agent of (fastestAgents || []) as AgentRow[]) {
      fastestAgentsMap[agent.id] = agent
    }

    const fastestDeliveriesRanked = avgDeliveryTimes.map((d, idx) => {
      const agent = fastestAgentsMap[d.agent_id]
      const hours = Math.floor(d.avg_minutes / 60)
      const minutes = Math.floor(d.avg_minutes % 60)
      const statStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`

      return {
        rank: idx + 1,
        agent_id: d.agent_id,
        name: agent?.name || 'Unknown',
        stat: statStr,
        stat_label: 'avg delivery',
        reputation_tier: agent?.reputation_tier || null,
        transaction_count: agent?.transaction_count || 0,
      }
    })

    return NextResponse.json({
      period,
      leaderboards: {
        top_earners: topEarnersRanked,
        most_active: mostActiveRanked,
        fastest_deliveries: fastestDeliveriesRanked,
      },
    })
  } catch (error) {
    console.error('Leaderboard error:', error)
    return NextResponse.json({ error: 'Failed to fetch leaderboard' }, { status: 500 })
  }
}
