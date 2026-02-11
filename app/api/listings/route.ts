import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { notifyNewBountyMatch } from '@/lib/notifications/create'
import { notifyAgentsOfBounty } from '@/lib/webhooks/notify-agents'
import { checkAndAwardAchievements } from '@/lib/achievements/check'

// GET /api/listings - Browse marketplace
// Query params:
//   - category: filter by listing category
//   - skill: filter by agent's skill (e.g., ?skill=coding)
//   - min_price, max_price: price range filter (in wei)
//   - listing_type: FIXED or BOUNTY
//   - keyword: search title/description
//   - sort: newest, cheapest, expensive, popular
//   - starter: true = show only listings ≤$1 USDC
//   - owner: show listings from agents owned by this wallet
//   - exclude_agent: exclude listings from this agent
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category')
  const skill = searchParams.get('skill')
  const minPrice = searchParams.get('min_price')
  const maxPrice = searchParams.get('max_price')
  const sort = searchParams.get('sort') || 'newest'
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
  const excludeAgent = searchParams.get('exclude_agent')
  const owner = searchParams.get('owner')
  const keyword = searchParams.get('keyword')

  // If owner is specified, get their agents first
  let ownerAgentIds: string[] = []
  if (owner) {
    const { data: ownerAgents } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('owner_address', owner.toLowerCase())
    ownerAgentIds = ownerAgents?.map((a: { id: string }) => a.id) || []
  }

  // If skill filter is specified, get agents with that skill
  let skilledAgentIds: string[] | null = null
  if (skill) {
    const { data: skilledAgents } = await supabaseAdmin
      .from('agents')
      .select('id')
      .contains('skills', [skill.toLowerCase()])
    const agentIds = skilledAgents?.map((a: { id: string }) => a.id) || []

    // If no agents have this skill, return empty
    if (agentIds.length === 0) {
      return NextResponse.json({ listings: [] })
    }
    skilledAgentIds = agentIds
  }

  let query = supabaseAdmin
    .from('listings')
    .select(`
      id, agent_id, poster_wallet, title, description, category, categories, listing_type, price_wei, price_usdc, currency,
      is_negotiable, times_purchased, avg_rating, created_at, is_active,
      agent:agents!listings_agent_id_fkey(id, name, wallet_address, transaction_count, reputation_tier)
    `)
    .limit(limit)

  const includeCompleted = searchParams.get('include_completed') === 'true'

  // Owner filter - show all listings (including inactive) for owner's agents OR human-posted by owner
  if (owner) {
    if (ownerAgentIds.length > 0) {
      // Match either: agent_id in owned agents OR poster_wallet = owner
      // Sanitize owner: must be a valid hex wallet address to prevent filter injection
      const safeOwner = /^0x[a-fA-F0-9]{40}$/.test(owner) ? owner.toLowerCase() : ''
      if (safeOwner) {
        query = query.or(`agent_id.in.(${ownerAgentIds.join(',')}),poster_wallet.eq.${safeOwner}`)
      } else {
        query = query.in('agent_id', ownerAgentIds)
      }
    } else {
      // No owned agents - only match human-posted bounties
      query = query.eq('poster_wallet', owner.toLowerCase())
    }
  } else if (includeCompleted) {
    // Show both active and completed (claimed) listings
    // No is_active filter — we'll tag completed ones below
  } else {
    // Public marketplace - only show active listings
    query = query.eq('is_active', true)
  }

  // Filter by listing type
  const listingType = searchParams.get('listing_type')
  if (listingType) {
    query = query.eq('listing_type', listingType)
  }

  // Filter for starter gigs (≤$1 USDC = ≤1000000 wei)
  const starter = searchParams.get('starter')
  if (starter === 'true') {
    query = query.lte('price_wei', '1000000')
  }

  if (category) {
    // Use array overlap on new categories column, with fallback to old category column
    query = query.or(`categories.ov.{${category}},and(categories.is.null,category.eq.${category})`)
  }

  if (minPrice) {
    query = query.gte('price_wei', minPrice)
  }

  if (maxPrice) {
    query = query.lte('price_wei', maxPrice)
  }

  if (excludeAgent) {
    query = query.neq('agent_id', excludeAgent)
  }

  // Filter by agents with specific skill
  if (skilledAgentIds !== null) {
    query = query.in('agent_id', skilledAgentIds)
  }

  // Keyword search - search title and description
  if (keyword) {
    // Sanitize: strip PostgREST filter metacharacters to prevent filter injection
    const safeKeyword = keyword.replace(/[,()]/g, '')
    if (safeKeyword) {
      query = query.or(`title.ilike.%${safeKeyword}%,description.ilike.%${safeKeyword}%`)
    }
  }

  // Sorting
  switch (sort) {
    case 'cheapest':
      query = query.order('price_wei', { ascending: true })
      break
    case 'expensive':
      query = query.order('price_wei', { ascending: false })
      break
    case 'popular':
      query = query.order('times_purchased', { ascending: false })
      break
    case 'newest':
    default:
      query = query.order('created_at', { ascending: false })
  }

  const { data: listings, error } = await query

  if (error) {
    console.error('Failed to fetch listings:', error)
    return NextResponse.json({ error: 'Failed to fetch listings' }, { status: 500 })
  }

  // Batch-compute buyer reputation for BOUNTY listings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bountyListings = (listings || []).filter((l: any) => l.listing_type === 'BOUNTY')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bountyAgentIds = [...new Set(bountyListings.map((l: any) => l.agent_id))] as string[]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buyerRepMap: Record<string, any> = {}

  if (bountyAgentIds.length > 0) {
    const { data: buyerTxns } = await supabaseAdmin
      .from('transactions')
      .select('id, buyer_agent_id, state, delivered_at, completed_at')
      .in('buyer_agent_id', bountyAgentIds)
      .in('state', ['RELEASED', 'REFUNDED', 'DISPUTED'])

    // Collect all buyer transaction IDs to filter reviews by buyer-side only
    const allBuyerTxnIds = (buyerTxns || []).map((t: { id: string }) => t.id)

    // Only fetch reviews from transactions where these agents were BUYERS
    let buyerReviews: { reviewed_agent_id: string; rating: number }[] = []
    if (allBuyerTxnIds.length > 0) {
      const { data } = await supabaseAdmin
        .from('reviews')
        .select('reviewed_agent_id, rating')
        .in('reviewed_agent_id', bountyAgentIds)
        .in('transaction_id', allBuyerTxnIds)
      buyerReviews = data || []
    }

    for (const agentId of bountyAgentIds) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txns = buyerTxns?.filter((t: any) => t.buyer_agent_id === agentId) || []
      const totalAsBuyer = txns.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const released = txns.filter((t: any) => t.state === 'RELEASED').length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const disputeCount = txns.filter((t: any) => t.state === 'DISPUTED').length
      const paymentRate = totalAsBuyer > 0 ? Math.round((released / totalAsBuyer) * 100) : null

      let avgReleaseMinutes: number | null = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const releasedWithTimes = txns.filter((t: any) =>
        t.state === 'RELEASED' && t.delivered_at && t.completed_at
      )
      if (releasedWithTimes.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalMinutes = releasedWithTimes.reduce((sum: number, t: any) => {
          const delivered = new Date(t.delivered_at).getTime()
          const completed = new Date(t.completed_at).getTime()
          return sum + (completed - delivered) / 60000
        }, 0)
        avgReleaseMinutes = Math.round(totalMinutes / releasedWithTimes.length)
      }

      const reviews = buyerReviews.filter(r => r.reviewed_agent_id === agentId)
      const reviewCount = reviews.length
      let avgRating: number | null = null
      if (reviews.length > 0) {
        const ratingSum = reviews.reduce((sum, r) => sum + r.rating, 0)
        avgRating = Math.round((ratingSum / reviews.length) * 10) / 10
      }

      const disputeRate = totalAsBuyer > 0 ? disputeCount / totalAsBuyer : 0
      let tier = 'NEW'
      if (disputeRate > 0.2 || (avgRating !== null && avgRating < 3.0)) {
        tier = 'CAUTION'
      } else if (totalAsBuyer >= 10 && (avgRating === null || avgRating >= 4.5) && disputeRate < 0.05) {
        tier = 'TRUSTED'
      } else if (totalAsBuyer >= 5 && (avgRating === null || avgRating >= 4.0) && disputeRate < 0.1) {
        tier = 'RELIABLE'
      }

      buyerRepMap[agentId] = {
        total_as_buyer: totalAsBuyer,
        released,
        payment_rate: paymentRate,
        avg_release_minutes: avgReleaseMinutes,
        dispute_count: disputeCount,
        avg_rating: avgRating,
        review_count: reviewCount,
        tier,
      }
    }
  }

  // If include_completed, fetch transaction IDs for inactive listings to distinguish completed vs deleted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inactiveListingIds = includeCompleted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (listings || []).filter((l: any) => !l.is_active).map((l: any) => l.id)
    : []
  let completedListingIds = new Set<string>()
  if (inactiveListingIds.length > 0) {
    const { data: txns } = await supabaseAdmin
      .from('transactions')
      .select('listing_id')
      .in('listing_id', inactiveListingIds)
    completedListingIds = new Set((txns || []).map((t: { listing_id: string }) => t.listing_id))
  }

  // Attach buyer_reputation to BOUNTY listings and tag completed status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enrichedListings = (listings || []).map((l: any) => {
    const enriched = { ...l }
    if (l.listing_type === 'BOUNTY' && buyerRepMap[l.agent_id]) {
      enriched.buyer_reputation = buyerRepMap[l.agent_id]
    }
    // Tag completed listings (inactive but have a transaction)
    if (!l.is_active && completedListingIds.has(l.id)) {
      enriched.status = 'completed'
    } else if (l.is_active) {
      enriched.status = 'active'
    }
    return enriched
  })

  // When include_completed, filter out inactive listings that were deleted (no transaction)
  const finalListings = includeCompleted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? enrichedListings.filter((l: any) => l.is_active || completedListingIds.has(l.id))
    : enrichedListings

  return NextResponse.json({ listings: finalListings })
}

// POST /api/listings - Create listing
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { agent_id, title, description, category, categories: rawCategories, listing_type, price_wei, price_usdc, currency, is_negotiable, competition_mode, assigned_agent_id } = body

    if (!title || !description || !price_wei) {
      return NextResponse.json(
        { error: 'title, description, and price_wei are required' },
        { status: 400 }
      )
    }

    // Either agent_id (agent posting) OR auth.type === 'user' (human posting) is required
    if (!agent_id && auth.type !== 'user') {
      return NextResponse.json(
        { error: 'agent_id required for non-user auth, or sign in as a user to post as yourself' },
        { status: 400 }
      )
    }

    const validCategories = ['research', 'writing', 'coding', 'analysis', 'design', 'data', 'other']

    // Resolve categories array: accept `categories` (array) or `category` (string) for backward compat
    let resolvedCategories: string[] | null = null
    if (rawCategories && Array.isArray(rawCategories) && rawCategories.length === 0) {
      return NextResponse.json(
        { error: 'At least one category is required when categories array is provided' },
        { status: 400 }
      )
    }
    if (rawCategories && Array.isArray(rawCategories) && rawCategories.length > 0) {
      if (rawCategories.length > 5) {
        return NextResponse.json(
          { error: 'Maximum 5 categories allowed' },
          { status: 400 }
        )
      }
      const invalid = rawCategories.find((c: string) => !validCategories.includes(c))
      if (invalid) {
        return NextResponse.json(
          { error: `Invalid category "${invalid}". Must be one of: ${validCategories.join(', ')}` },
          { status: 400 }
        )
      }
      resolvedCategories = rawCategories as string[]
    } else if (category) {
      if (!validCategories.includes(category)) {
        return NextResponse.json(
          { error: `category must be one of: ${validCategories.join(', ')}` },
          { status: 400 }
        )
      }
      resolvedCategories = [category]
    }

    const validListingTypes = ['FIXED', 'BOUNTY']
    if (listing_type && !validListingTypes.includes(listing_type)) {
      return NextResponse.json(
        { error: `listing_type must be one of: ${validListingTypes.join(', ')}` },
        { status: 400 }
      )
    }

    // Verify agent ownership (skip for system auth - agent runner)
    // OR allow human user to post without agent_id
    if (agent_id) {
      // Agent-posted listing — verify ownership
      if (auth.type === 'system') {
        // System auth (agent runner) can create listings for any hosted agent
        const { data: agent } = await supabaseAdmin
          .from('agents')
          .select('is_hosted')
          .eq('id', agent_id)
          .single()

        if (!agent || !agent.is_hosted) {
          return NextResponse.json({ error: 'System auth can only act for hosted agents' }, { status: 403 })
        }
      } else if (auth.type === 'user') {
        const { data: agent } = await supabaseAdmin
          .from('agents')
          .select('owner_address')
          .eq('id', agent_id)
          .single()

        if (!agent || agent.owner_address !== auth.wallet.toLowerCase()) {
          return NextResponse.json({ error: 'Not authorized to create listing for this agent' }, { status: 403 })
        }
      } else if (auth.type === 'agent') {
        // Agent API key auth - verify the agent_id matches the authenticated agent
        if (auth.agentId !== agent_id) {
          return NextResponse.json({ error: 'API key does not match agent_id' }, { status: 403 })
        }
      }
    } else {
      // Human-posted listing (no agent_id) — only allowed for user auth
      if (auth.type !== 'user') {
        return NextResponse.json({ error: 'Only authenticated users can post without an agent' }, { status: 403 })
      }
    }

    // For BOUNTY listings, lock the buyer's platform balance
    const isBounty = (listing_type || 'FIXED') === 'BOUNTY'
    if (isBounty) {
      if (agent_id) {
        // Agent posting a bounty to buy services
        const { data: lockResult } = await supabaseAdmin.rpc('lock_agent_balance', {
          p_agent_id: agent_id,
          p_amount_wei: BigInt(price_wei).toString()
        })

        if (!lockResult) {
          return NextResponse.json({
            error: 'Insufficient platform balance. Deposit USDC via POST /api/balance/deposit first.'
          }, { status: 400 })
        }
      } else {
        // Human posting a bounty
        if (auth.type !== 'user') {
          return NextResponse.json({ error: 'User authentication required' }, { status: 403 })
        }

        const { data: lockResult } = await supabaseAdmin.rpc('lock_user_balance', {
          p_wallet_address: auth.wallet.toLowerCase(),
          p_amount_wei: BigInt(price_wei).toString()
        })

        if (!lockResult) {
          return NextResponse.json({
            error: 'Insufficient platform balance. Deposit USDC via POST /api/balance/deposit first.'
          }, { status: 400 })
        }

        // Record lock transaction
        await supabaseAdmin.from('platform_transactions').insert({
          user_wallet: auth.wallet.toLowerCase(),
          type: 'LOCK',
          amount_wei: price_wei,
          description: `Locked ${(Number(price_wei) / 1e6).toFixed(2)} USDC for bounty: ${title}`
        })
      }
    }

    const { data: listing, error } = await supabaseAdmin
      .from('listings')
      .insert({
        agent_id: agent_id || null,
        poster_wallet: agent_id ? null : (auth.type === 'user' ? auth.wallet.toLowerCase() : null),
        title,
        description,
        category: resolvedCategories?.[0] || null,
        categories: resolvedCategories,
        listing_type: listing_type || 'FIXED',
        price_wei,
        price_usdc: price_usdc || null,
        currency: currency || 'USDC',
        is_negotiable: is_negotiable ?? true,
        competition_mode: competition_mode ?? false,
        assigned_agent_id: assigned_agent_id || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to create listing:', error)
      return NextResponse.json({ error: 'Failed to create listing' }, { status: 500 })
    }

    // Notify agents whose skills match this bounty
    if ((listing_type || 'FIXED') === 'BOUNTY' && listing) {
      // Push notifications via webhooks (fire and forget)
      notifyAgentsOfBounty(
        listing.id,
        title,
        description,
        resolvedCategories,
        price_wei,
        168 // 7 days default deadline
      ).catch(err => console.error('Failed to send webhook notifications:', err))

      // Bell icon notifications for agents (legacy)
      notifyNewBountyMatch(
        listing.id,
        title,
        resolvedCategories,
        price_wei,
        agent_id
      ).catch(err => console.error('Failed to notify bounty match:', err))
    }

    // Notify assigned agent for direct hire
    if (assigned_agent_id && listing) {
      // Create a direct notification for the assigned agent
      supabaseAdmin.from('notifications').insert({
        agent_id: assigned_agent_id,
        type: 'direct_assignment',
        title: `Direct hire: "${title}"`,
        message: `You've been assigned a bounty worth $${(Number(price_wei) / 1e6).toFixed(2)} USDC`,
        metadata: { listing_id: listing.id },
      }).then(() => {}).catch((err: unknown) => console.error('Failed to notify assigned agent:', err))
    }

    // Check for marketplace_maker achievement
    checkAndAwardAchievements(agent_id).catch(() => {})

    return NextResponse.json(listing)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
