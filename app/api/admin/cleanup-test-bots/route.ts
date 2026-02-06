import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/admin/cleanup-test-bots - Deactivate E2E test bots
// Test bots match patterns like: e2e-*, test-*, TestBot*, *-test-*, AuditBot-*
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
      authHeader !== `Bearer ${process.env.AGENT_RUNNER_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Known hosted bot IDs to protect
  const HOSTED_BOT_IDS = [
    'a67d7b98-7a5d-42e1-8c15-38e5745bd789', // Dusty Pete
    'bbd8f6e2-96ca-4fe0-b432-8fe60d181ebb', // Sheriff Claude
    '0d458eb0-2325-4130-95cb-e4f5d43def9f', // Tumbleweed
    'c0916187-07c7-4cde-88c4-8de7fdbb59cc', // Cactus Jack
    'cf90cd61-0e0e-42d0-ab06-d333064b2323', // Snake Oil Sally
  ]

  // Test bot name patterns (case-insensitive matching)
  const TEST_PATTERNS = [
    'e2e-', 'test-', 'testbot', 'test_', '-test-',
    'auditbot-', 'audit-bot', 'healthcheck',
    'loadtest', 'load-test', 'bench-',
  ]

  // Also match wallet addresses that are clearly test addresses
  const TEST_WALLETS = [
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000',
  ]

  const { data: allAgents } = await supabaseAdmin
    .from('agents')
    .select('id, name, wallet_address, is_active, transaction_count, total_earned_wei')

  if (!allAgents) {
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 })
  }

  interface Agent {
    id: string
    name: string
    wallet_address: string
    is_active: boolean
    transaction_count: number
    total_earned_wei: string | number
  }

  const testBots: Agent[] = []
  const protected_: Agent[] = []

  for (const agent of allAgents as Agent[]) {
    // Never touch hosted bots
    if (HOSTED_BOT_IDS.includes(agent.id)) {
      protected_.push(agent)
      continue
    }

    const nameLower = agent.name.toLowerCase()
    const isTestName = TEST_PATTERNS.some(p => nameLower.includes(p))
    const isTestWallet = TEST_WALLETS.includes(agent.wallet_address.toLowerCase())

    if (isTestName || isTestWallet) {
      // Only deactivate if they have no real earnings (protect real users with test-like names)
      const earned = parseFloat(String(agent.total_earned_wei || '0'))
      if (earned <= 0 || agent.transaction_count <= 0) {
        testBots.push(agent)
      }
    }
  }

  // Deactivate test bots (set is_active = false, don't delete)
  if (testBots.length > 0) {
    const testBotIds = testBots.map(a => a.id)
    const { error: updateErr } = await supabaseAdmin
      .from('agents')
      .update({ is_active: false })
      .in('id', testBotIds)

    if (updateErr) {
      return NextResponse.json({ error: 'Failed to deactivate test bots' }, { status: 500 })
    }

    // Also clean up their feed events
    const { count: deletedEvents } = await supabaseAdmin
      .from('feed_events')
      .delete({ count: 'exact' })
      .in('agent_id', testBotIds)

    return NextResponse.json({
      success: true,
      deactivated: testBots.length,
      deleted_feed_events: deletedEvents || 0,
      test_bots: testBots.map(a => ({ id: a.id, name: a.name })),
      protected: protected_.length,
      total_agents: allAgents.length,
    })
  }

  return NextResponse.json({
    success: true,
    deactivated: 0,
    message: 'No test bots found to clean up',
    total_agents: allAgents.length,
  })
}
