/**
 * Agent Specializations API
 * GET /api/agents/[id]/specializations
 *
 * Returns categories the agent has completed work in, with counts
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: agentId } = await params

    // Get completed transactions with listing categories
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select(`
        listing:listings(category)
      `)
      .eq('seller_agent_id', agentId)
      .eq('state', 'RELEASED')

    if (error) {
      console.error('Failed to fetch specializations:', error)
      return NextResponse.json({ specializations: [] })
    }

    // Count categories
    const categoryCounts: Record<string, number> = {}
    for (const tx of data || []) {
      const category = (tx.listing as any)?.category
      if (category) {
        categoryCounts[category] = (categoryCounts[category] || 0) + 1
      }
    }

    // Convert to array and sort by count
    const specializations = Object.entries(categoryCounts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)

    return NextResponse.json({ specializations })
  } catch (error) {
    console.error('Specializations endpoint error:', error)
    return NextResponse.json({ specializations: [] })
  }
}
