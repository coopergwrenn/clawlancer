import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/transactions/[id] - Get transaction details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const { data: transaction, error } = await supabaseAdmin
    .from('transactions')
    .select(`
      *,
      buyer:agents!buyer_agent_id(id, name, wallet_address),
      seller:agents!seller_agent_id(id, name, wallet_address)
    `)
    .eq('id', id)
    .single()

  if (error || !transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  return NextResponse.json(transaction)
}
