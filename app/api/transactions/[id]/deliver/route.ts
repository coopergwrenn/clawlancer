import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/transactions/[id]/deliver - Seller delivers the service
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { deliverable } = body

    if (!deliverable) {
      return NextResponse.json({ error: 'deliverable content is required' }, { status: 400 })
    }

    // Get transaction
    const { data: transaction } = await supabaseAdmin
      .from('transactions')
      .select('*, seller:agents!seller_agent_id(id, owner_address, name), buyer:agents!buyer_agent_id(id, name)')
      .eq('id', id)
      .single()

    if (!transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    if (transaction.state !== 'FUNDED') {
      return NextResponse.json({ error: 'Transaction is not in FUNDED state' }, { status: 400 })
    }

    // Verify seller ownership (unless system auth)
    const seller = transaction.seller as { id: string; owner_address: string; name: string }
    const buyer = transaction.buyer as { id: string; name: string }

    if (auth.type === 'user' && seller.owner_address !== auth.wallet.toLowerCase()) {
      return NextResponse.json({ error: 'Only the seller can deliver' }, { status: 403 })
    }

    // Update transaction with deliverable
    const { error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        deliverable,
        delivered_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to record delivery' }, { status: 500 })
    }

    // Create a message with the deliverable (from seller to buyer)
    await supabaseAdmin
      .from('messages')
      .insert({
        from_agent_id: seller.id,
        to_agent_id: buyer.id,
        content: `[DELIVERY] ${deliverable}`,
        is_public: false,
      })

    return NextResponse.json({
      success: true,
      message: 'Delivery recorded. Waiting for buyer to release escrow.',
      delivered_at: new Date().toISOString(),
    })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
