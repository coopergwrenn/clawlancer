import { supabaseAdmin } from '@/lib/supabase/server'

export interface Achievement {
  key: string
  name: string
  description: string
  check: (agentStats: AgentStats) => boolean
}

export interface AgentStats {
  agentId: string
  totalEarned: number
  transactionCount: number
  successfulTxns: number
  messagesSent: number
  listingsCreated: number
  avgDeliveryMinutes: number | null
  joinedAt: Date
}

const ACHIEVEMENTS: Achievement[] = [
  {
    key: 'first_dollar',
    name: 'First Dollar',
    description: 'Earned your first payment',
    check: (stats) => stats.totalEarned >= 1,
  },
  {
    key: 'speed_demon',
    name: 'Speed Demon',
    description: 'Delivered work in under 30 minutes',
    check: (stats) => stats.avgDeliveryMinutes !== null && stats.avgDeliveryMinutes < 30,
  },
  {
    key: 'perfect_ten',
    name: 'Perfect Ten',
    description: 'Completed 10 transactions with 100% success rate',
    check: (stats) => stats.transactionCount >= 10 && stats.successfulTxns === stats.transactionCount,
  },
  {
    key: 'rising_star',
    name: 'Rising Star',
    description: 'Earned $100+ in total',
    check: (stats) => stats.totalEarned >= 100,
  },
  {
    key: 'top_earner',
    name: 'Top Earner',
    description: 'Earned $1,000+ in total',
    check: (stats) => stats.totalEarned >= 1000,
  },
  {
    key: 'social_butterfly',
    name: 'Social Butterfly',
    description: 'Sent 50+ messages',
    check: (stats) => stats.messagesSent >= 50,
  },
  {
    key: 'bounty_hunter',
    name: 'Bounty Hunter',
    description: 'Completed 25+ transactions',
    check: (stats) => stats.successfulTxns >= 25,
  },
  {
    key: 'marketplace_maker',
    name: 'Marketplace Maker',
    description: 'Created 10+ listings',
    check: (stats) => stats.listingsCreated >= 10,
  },
  {
    key: 'early_adopter',
    name: 'Early Adopter',
    description: 'Joined in the first month of launch',
    check: (stats) => {
      // Platform launched roughly Feb 2026, first month = before Mar 1, 2026
      const launchCutoff = new Date('2026-03-01')
      return stats.joinedAt < launchCutoff
    },
  },
  {
    key: 'reliable',
    name: 'Reliable',
    description: 'Maintained 95%+ success rate over 20+ transactions',
    check: (stats) =>
      stats.transactionCount >= 20 && stats.successfulTxns / stats.transactionCount >= 0.95,
  },
]

async function fetchAgentStats(agentId: string): Promise<AgentStats | null> {
  // Get agent basic data
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('total_earned_wei, transaction_count, created_at')
    .eq('id', agentId)
    .single()

  if (!agent) return null

  // Get successful transactions (RELEASED)
  const { count: successfulCount } = await supabaseAdmin
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('seller_agent_id', agentId)
    .eq('state', 'RELEASED')

  // Get messages sent
  const { count: messagesCount } = await supabaseAdmin
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('sender_agent_id', agentId)

  // Get listings created
  const { count: listingsCount } = await supabaseAdmin
    .from('listings')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', agentId)

  // Compute average delivery time
  const { data: deliveredTxns } = await supabaseAdmin
    .from('transactions')
    .select('created_at, delivered_at')
    .eq('seller_agent_id', agentId)
    .eq('state', 'RELEASED')
    .not('delivered_at', 'is', null)

  let avgDeliveryMinutes: number | null = null
  if (deliveredTxns && deliveredTxns.length > 0) {
    const totalMinutes = deliveredTxns.reduce((sum: number, tx: { created_at: string; delivered_at: string }) => {
      const created = new Date(tx.created_at).getTime()
      const delivered = new Date(tx.delivered_at!).getTime()
      return sum + (delivered - created) / (1000 * 60)
    }, 0)
    avgDeliveryMinutes = totalMinutes / deliveredTxns.length
  }

  return {
    agentId,
    totalEarned: parseFloat(agent.total_earned_wei || '0') / 1e6,
    transactionCount: agent.transaction_count || 0,
    successfulTxns: successfulCount || 0,
    messagesSent: messagesCount || 0,
    listingsCreated: listingsCount || 0,
    avgDeliveryMinutes,
    joinedAt: new Date(agent.created_at),
  }
}

export async function checkAndAwardAchievements(agentId: string): Promise<string[]> {
  try {
    const stats = await fetchAgentStats(agentId)
    if (!stats) return []

    // Get already unlocked achievements
    const { data: existing } = await supabaseAdmin
      .from('achievements')
      .select('achievement_key')
      .eq('agent_id', agentId)

    const unlockedKeys = new Set((existing || []).map((a: { achievement_key: string }) => a.achievement_key))

    // Check each achievement
    const newlyUnlocked: string[] = []
    for (const achievement of ACHIEVEMENTS) {
      if (unlockedKeys.has(achievement.key)) continue
      if (achievement.check(stats)) {
        // Award achievement
        const { error } = await supabaseAdmin.from('achievements').insert({
          agent_id: agentId,
          achievement_key: achievement.key,
          metadata: { stats_at_unlock: stats },
        })

        if (!error) {
          newlyUnlocked.push(achievement.key)
        }
      }
    }

    return newlyUnlocked
  } catch (error) {
    console.error('checkAndAwardAchievements error:', error)
    return []
  }
}

export function getAchievementMetadata(key: string): Achievement | null {
  return ACHIEVEMENTS.find((a) => a.key === key) || null
}

export function getAllAchievements(): Achievement[] {
  return ACHIEVEMENTS
}
