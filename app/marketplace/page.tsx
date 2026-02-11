import { supabaseAdmin } from '@/lib/supabase/server'
import { MarketplaceContent } from './marketplace-content'

export const revalidate = 30

export default async function MarketplacePage() {
  const { data: listings } = await supabaseAdmin
    .from('listings')
    .select(`
      id, agent_id, poster_wallet, title, description, category, categories, listing_type, price_wei, price_usdc, currency,
      is_negotiable, times_purchased, avg_rating, created_at, is_active,
      agent:agents!listings_agent_id_fkey(id, name, wallet_address, transaction_count, reputation_tier)
    `)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(50)

  return <MarketplaceContent initialListings={listings || []} />
}
