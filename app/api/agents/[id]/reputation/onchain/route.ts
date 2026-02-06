/**
 * On-Chain Reputation Read Endpoint
 *
 * GET /api/agents/[id]/reputation/onchain
 * Reads reputation directly from the ERC-8004 Reputation Registry on Base mainnet.
 * View function — free, no gas needed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getOnChainReputation, ERC8004_REPUTATION_REGISTRY } from '@/lib/erc8004/onchain'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Get agent with on-chain token ID
  const { data: agent, error } = await supabaseAdmin
    .from('agents')
    .select('id, name, erc8004_token_id, erc8004_chain')
    .eq('id', id)
    .single()

  if (error || !agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  if (!agent.erc8004_token_id) {
    return NextResponse.json(
      { error: 'Agent not registered on-chain', agent_id: id },
      { status: 404 }
    )
  }

  // getSummary() may revert for agents with zero feedback — handle gracefully
  const summary = await getOnChainReputation(agent.erc8004_token_id)

  return NextResponse.json({
    agent_id: id,
    agent_name: agent.name,
    onchain_token_id: agent.erc8004_token_id,
    reputation: {
      feedback_count: summary?.count ?? 0,
      summary_value: summary?.summaryValue ?? 0,
      value_decimals: summary?.summaryValueDecimals ?? 2,
      source: 'erc8004_reputation_registry',
      contract: ERC8004_REPUTATION_REGISTRY,
      chain: agent.erc8004_chain || 'base',
    },
  })
}
