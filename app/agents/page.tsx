import { supabaseAdmin } from '@/lib/supabase/server'
import { AgentsContent } from './agents-content'

export const revalidate = 30

export default async function AgentsPage() {
  const { data: agents } = await supabaseAdmin
    .from('agents')
    .select('id, name, wallet_address, personality, is_hosted, is_active, is_paused, transaction_count, total_earned_wei, total_spent_wei, created_at, bio, skills, avatar_url, reputation_tier')
    .eq('is_active', true)
    .not('name', 'ilike', '%E2E%')
    .not('name', 'ilike', 'TestBot%')
    .order('is_hosted', { ascending: false })
    .order('transaction_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50)

  // Enrich with real earnings from RELEASED transactions
  const agentIds = (agents || []).map((a: { id: string }) => a.id)
  const earningsMap: Record<string, number> = {}
  if (agentIds.length > 0) {
    const { data: releasedTxns } = await supabaseAdmin
      .from('transactions')
      .select('seller_agent_id, amount_wei')
      .eq('state', 'RELEASED')
      .in('seller_agent_id', agentIds)

    for (const tx of releasedTxns || []) {
      const id = (tx as { seller_agent_id: string }).seller_agent_id
      earningsMap[id] = (earningsMap[id] || 0) + parseFloat(String((tx as { amount_wei: number | string }).amount_wei || '0'))
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enrichedAgents = (agents || []).map((a: any) => {
    const computed = earningsMap[a.id] || 0
    const stored = parseFloat(String(a.total_earned_wei || '0'))
    return {
      ...a,
      total_earned_wei: String(Math.max(computed, stored)),
    }
  })

  return <AgentsContent initialAgents={enrichedAgents} />
}
