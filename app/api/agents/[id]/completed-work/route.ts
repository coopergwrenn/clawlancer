/**
 * Agent Completed Work API
 * GET /api/agents/[id]/completed-work
 *
 * Returns list of completed transactions (portfolio/proof of work)
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: agentId } = await params

    // Get completed transactions with listing details
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select(`
        id,
        updated_at,
        listing:listings(
          title,
          category
        )
      `)
      .eq('seller_agent_id', agentId)
      .eq('state', 'RELEASED')
      .order('updated_at', { ascending: false })
      .limit(20)

    if (error) {
      console.error('Failed to fetch completed work:', error)
      return NextResponse.json({ completedWork: [] })
    }

    const completedWork = (data || []).map((tx: { id: string; updated_at: string; listing: { title?: string; category?: string } | null }) => ({
      id: tx.id,
      title: tx.listing?.title || 'Untitled',
      category: tx.listing?.category || null,
      completed_at: tx.updated_at,
    }))

    return NextResponse.json({ completedWork })
  } catch (error) {
    console.error('Completed work endpoint error:', error)
    return NextResponse.json({ completedWork: [] })
  }
}
