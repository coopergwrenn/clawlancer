import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getAgentBalance, signAgentTransaction } from '@/lib/privy/server-wallet'
import { ESCROW_ADDRESS, buildCreateUSDCEscrowData, buildReleaseData, uuidToBytes32 } from '@/lib/blockchain/escrow'
import { ESCROW_V2_ADDRESS, buildReleaseV2Data } from '@/lib/blockchain/escrow-v2'
import type { Address } from 'viem'
import { PERSONALITY_PROMPTS } from './personalities'

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// Types for agent context and actions
export interface AgentContext {
  agent: {
    id: string
    name: string
    wallet_address: string
    personality: string
    privy_wallet_id: string | null
    total_earned_wei: string
    total_spent_wei: string
    transaction_count: number
  }
  balance: {
    eth_wei: string
    usdc_wei: string
    eth_formatted: string
    usdc_formatted: string
  }
  listings: Array<{
    id: string
    title: string
    description: string
    category: string
    price_wei: string
    currency: string
    seller_agent_id: string | null
    seller_name: string
    seller_transaction_count: number
  }>
  messages: Array<{
    id: string
    content: string
    from_agent_id: string
    from_agent_name: string
    created_at: string
  }>
  active_escrows: Array<{
    id: string
    amount_wei: string
    description: string
    state: string
    deadline: string
    is_buyer: boolean
    counterparty_name: string
    delivered_at: string | null
    deliverable: string | null
  }>
  my_listings: Array<{
    id: string
    title: string
    price_wei: string
    times_purchased: number
    is_active: boolean
  }>
  direct_assignments: Array<{
    id: string
    title: string
    description: string
    category: string
    categories: string[] | null
    price_wei: string
    currency: string
  }>
}

export type AgentAction =
  | { type: 'do_nothing'; reason: string }
  | { type: 'create_listing'; title: string; description: string; category: string; price_wei: string }
  | { type: 'buy_listing'; listing_id: string; reason: string }
  | { type: 'send_message'; to_agent_id: string; content: string; is_public: boolean }
  | { type: 'deliver'; transaction_id: string; deliverable: string }
  | { type: 'release'; transaction_id: string }
  | { type: 'update_listing'; listing_id: string; price_wei?: string; is_active?: boolean }
  | { type: 'submit_proposal'; listing_id: string; proposal_text: string; proposed_price_wei?: string }

// Known house bot IDs — hardcoded to avoid treasury address mismatch
const HOUSE_BOT_IDS = [
  'a67d7b98-7a5d-42e1-8c15-38e5745bd789', // Dusty Pete
  'bbd8f6e2-96ca-4fe0-b432-8fe60d181ebb', // Sheriff Claude
  '0d458eb0-2325-4130-95cb-e4f5d43def9f', // Tumbleweed
  'c0916187-07c7-4cde-88c4-8de7fdbb59cc', // Cactus Jack
  'cf90cd61-0e0e-42d0-ab06-d333064b2323', // Snake Oil Sally
]

// Check if an agent is a house bot
async function isHouseBot(agentId: string): Promise<boolean> {
  return HOUSE_BOT_IDS.includes(agentId)
}

// Get all house bot IDs for filtering
async function getHouseBotIds(): Promise<string[]> {
  return HOUSE_BOT_IDS
}

// Gather all context an agent needs to make a decision
// Implementation for Known Issue #2
export async function gatherAgentContext(agentId: string): Promise<AgentContext> {
  // 1. Get agent details
  const { data: agent, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single()

  if (agentError || !agent) {
    throw new Error('Agent not found')
  }

  // Check if this agent is a house bot
  const agentIsHouseBot = await isHouseBot(agentId)
  const houseBotIds = agentIsHouseBot ? await getHouseBotIds() : []

  // 2. Fetch real balance from chain (Known Issue #14)
  // House bots get a virtual platform credit of $5 USDC if their on-chain balance is $0
  const HOUSE_BOT_CREDIT_WEI = '5000000' // $5.00 USDC (6 decimals)
  let balance = {
    eth_wei: '0',
    usdc_wei: '0',
    eth_formatted: '0 ETH',
    usdc_formatted: '$0.00',
  }

  try {
    const walletBalance = await getAgentBalance(agent.wallet_address as Address)
    balance = {
      eth_wei: walletBalance.eth.wei.toString(),
      usdc_wei: walletBalance.usdc.wei.toString(),
      eth_formatted: walletBalance.eth.formatted,
      usdc_formatted: walletBalance.usdc.formatted,
    }
  } catch (err) {
    console.error('Failed to fetch balance:', err)
  }

  // House bots: inject virtual platform credit when on-chain balance is $0
  if (agentIsHouseBot && BigInt(balance.usdc_wei) === BigInt(0)) {
    balance.usdc_wei = HOUSE_BOT_CREDIT_WEI
    balance.usdc_formatted = '$5.00'
  }

  // 3. Get available marketplace listings (not this agent's own)
  // IMPORTANT: House bots cannot see other house bot listings (prevents wash trading)
  let listingsQuery = supabaseAdmin
    .from('listings')
    .select(`
      id, title, description, category, price_wei, currency, agent_id,
      agents!listings_agent_id_fkey(name, transaction_count)
    `)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(20)

  const { data: allListings } = await listingsQuery

  // Filter out this agent's own listings and house bot listings (if house bot)
  let listings = (allListings || []).filter((l: { agent_id: string | null }) => l.agent_id !== agentId)
  if (agentIsHouseBot && houseBotIds.length > 0) {
    listings = listings.filter((l: { agent_id: string | null }) => !l.agent_id || !houseBotIds.includes(l.agent_id))
    console.log(`[Agent Runner] House bot ${agent.name}: filtered ${(allListings?.length || 0) - listings.length} own/house bot listings, ${listings.length} external listings visible`)
  }

  // 4. Get recent messages directed at this agent
  // NOTE: Uses `messages` table (public messages) for context gathering
  // See docs/messaging-architecture.md for full explanation of the two message systems
  const { data: messages } = await supabaseAdmin
    .from('messages')
    .select(`
      id, content, created_at, from_agent_id,
      from_agent:agents!from_agent_id(name)
    `)
    .eq('to_agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(10)

  // 5. Get active escrows involving this agent
  const { data: escrows } = await supabaseAdmin
    .from('transactions')
    .select(`
      id, amount_wei, description, state, deadline, delivered_at, deliverable,
      buyer:agents!buyer_agent_id(id, name),
      seller:agents!seller_agent_id(id, name)
    `)
    .eq('state', 'FUNDED')
    .or(`buyer_agent_id.eq.${agentId},seller_agent_id.eq.${agentId}`)

  // 6. Get this agent's own listings
  const { data: myListings } = await supabaseAdmin
    .from('listings')
    .select('id, title, price_wei, times_purchased, is_active')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(10)

  // 7. Check for direct assignments (listings assigned specifically to this agent)
  const { data: directAssignments } = await supabaseAdmin
    .from('listings')
    .select('id, title, description, category, categories, price_wei, currency')
    .eq('assigned_agent_id', agentId)
    .eq('is_active', true)

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      wallet_address: agent.wallet_address,
      personality: agent.personality || 'random',
      privy_wallet_id: agent.privy_wallet_id,
      total_earned_wei: agent.total_earned_wei?.toString() || '0',
      total_spent_wei: agent.total_spent_wei?.toString() || '0',
      transaction_count: agent.transaction_count || 0,
    },
    balance,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listings: (listings || []).map((l: any) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      category: l.category,
      price_wei: l.price_wei?.toString() || '0',
      currency: l.currency,
      seller_agent_id: l.agent_id || null,
      seller_name: l.agents?.name || 'Anonymous User',
      seller_transaction_count: l.agents?.transaction_count || 0,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: (messages || []).map((m: any) => ({
      id: m.id,
      content: m.content,
      from_agent_id: m.from_agent_id,
      from_agent_name: m.from_agent?.name || 'Unknown',
      created_at: m.created_at,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    active_escrows: (escrows || []).map((e: any) => {
      const buyer = e.buyer
      const seller = e.seller
      const isBuyer = buyer?.id === agentId
      return {
        id: e.id,
        amount_wei: e.amount_wei?.toString() || '0',
        description: e.description || '',
        state: e.state,
        deadline: e.deadline,
        is_buyer: isBuyer,
        counterparty_name: isBuyer ? seller?.name : buyer?.name,
        delivered_at: e.delivered_at,
        deliverable: e.deliverable,
      }
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    my_listings: (myListings || []).map((l: any) => ({
      id: l.id,
      title: l.title,
      price_wei: l.price_wei?.toString() || '0',
      times_purchased: l.times_purchased || 0,
      is_active: l.is_active,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    direct_assignments: (directAssignments || []).map((l: any) => ({
      id: l.id,
      title: l.title,
      description: l.description || '',
      category: l.category || '',
      categories: l.categories || null,
      price_wei: l.price_wei?.toString() || '0',
      currency: l.currency || 'USDC',
    })),
  }
}

// Check if agent should skip this heartbeat (Known Issue #7)
// NOTE: We almost never skip for house bots - they should always do SOMETHING for the feed
export function shouldSkipHeartbeat(context: AgentContext, isHouseBot: boolean = false): { skip: boolean; reason: string } {
  // House bots never skip — they run on platform credit, not on-chain balance
  if (isHouseBot) {
    return { skip: false, reason: '' }
  }

  // Regular agents: more selective about when to act
  const hasMessages = context.messages.length > 0
  const hasActiveEscrows = context.active_escrows.length > 0
  const usdcBalance = BigInt(context.balance.usdc_wei)

  // Check if any listings are affordable (can spend up to 30% of balance)
  const maxSpend = usdcBalance / BigInt(3)
  const hasAffordableListings = context.listings.some(
    (l) => BigInt(l.price_wei) <= maxSpend && BigInt(l.price_wei) > BigInt(0)
  )

  // Check if we have pending deliveries to make (as seller)
  const hasPendingDeliveries = context.active_escrows.some(
    (e) => !e.is_buyer && !e.delivered_at
  )

  // Check if we have deliveries to review (as buyer)
  const hasDeliveriesToReview = context.active_escrows.some(
    (e) => e.is_buyer && e.delivered_at
  )

  if (!hasMessages && !hasActiveEscrows && !hasAffordableListings && usdcBalance === BigInt(0)) {
    return { skip: true, reason: 'No balance and nothing actionable' }
  }

  if (!hasMessages && !hasPendingDeliveries && !hasDeliveriesToReview && !hasAffordableListings) {
    if (context.my_listings.filter(l => l.is_active).length >= 5) {
      return { skip: true, reason: 'No urgent actions and already has max listings' }
    }
  }

  return { skip: false, reason: '' }
}

// Build the prompt for Claude
function buildClaudePrompt(context: AgentContext): string {
  const personalityPrompt = PERSONALITY_PROMPTS[context.agent.personality as keyof typeof PERSONALITY_PROMPTS]
    || PERSONALITY_PROMPTS.random

  const contextSummary = `
## YOUR IDENTITY
Name: ${context.agent.name}
Wallet: ${context.agent.wallet_address}
Total Earned: $${(Number(context.agent.total_earned_wei) / 1e6).toFixed(2)} USDC
Total Spent: $${(Number(context.agent.total_spent_wei) / 1e6).toFixed(2)} USDC
Completed Transactions: ${context.agent.transaction_count}

## YOUR CURRENT BALANCE
ETH: ${context.balance.eth_formatted}
USDC: ${context.balance.usdc_formatted}

## MARKETPLACE LISTINGS (Available to Buy)
${context.listings.length === 0 ? 'No listings available.' : context.listings.map((l) => `
- "${l.title}" by ${l.seller_name}${l.seller_agent_id ? ` (agent_id: ${l.seller_agent_id})` : ''} (${l.seller_transaction_count} txns)
  Price: $${(Number(l.price_wei) / 1e6).toFixed(2)} USDC
  Category: ${l.category}
  Listing ID: ${l.id}
  Description: ${l.description.slice(0, 100)}...
`).join('')}

## YOUR LISTINGS
${context.my_listings.length === 0 ? 'You have no listings.' : context.my_listings.map((l) => `
- "${l.title}" - $${(Number(l.price_wei) / 1e6).toFixed(2)} USDC - ${l.times_purchased} sold - ${l.is_active ? 'ACTIVE' : 'INACTIVE'}
  ID: ${l.id}
`).join('')}

## MESSAGES TO YOU
${context.messages.length === 0 ? 'No recent messages.' : context.messages.map((m) => `
- From ${m.from_agent_name} (agent_id: ${m.from_agent_id}): "${m.content.slice(0, 200)}"
`).join('')}

## ACTIVE ESCROWS
${context.active_escrows.length === 0 ? 'No active escrows.' : context.active_escrows.map((e) => `
- ${e.is_buyer ? 'BUYING FROM' : 'SELLING TO'} ${e.counterparty_name}
  Amount: $${(Number(e.amount_wei) / 1e6).toFixed(2)} USDC
  Description: ${e.description}
  Deadline: ${e.deadline}
  ${e.delivered_at ? `DELIVERED: ${e.deliverable?.slice(0, 100)}...` : 'NOT YET DELIVERED'}
  Transaction ID: ${e.id}
`).join('')}

## DIRECT ASSIGNMENTS (Priority - claim these first!)
${context.direct_assignments.length === 0 ? 'No direct assignments.' : context.direct_assignments.map((l) => `
- "${l.title}" - $${(Number(l.price_wei) / 1e6).toFixed(2)} USDC
  Description: ${l.description.slice(0, 150)}
  Category: ${l.categories?.join(', ') || l.category}
  Listing ID: ${l.id}
  NOTE: This bounty was assigned specifically to YOU. Claim it by buying it.
`).join('')}
`

  // Determine guidance based on what's available
  const humanBounties = context.listings.filter(l => !l.seller_agent_id)
  const agentListings = context.listings.filter(l => l.seller_agent_id)

  let houseBotGuidance: string
  if (context.listings.length === 0) {
    houseBotGuidance = `\n\nNOTE: No external listings available right now. Focus on creating interesting content - post a public message, create a new listing, or just observe the scene.`
  } else if (humanBounties.length > 0) {
    houseBotGuidance = `\n\nPRIORITY: There ${humanBounties.length === 1 ? 'is' : 'are'} ${humanBounties.length} HUMAN-POSTED bounty${humanBounties.length === 1 ? '' : 'ies'} waiting for an agent to claim! Real humans are waiting for work to be done. You should strongly consider claiming one using buy_listing with the Listing ID. Human bounties are your TOP PRIORITY — claim them before doing anything else.${agentListings.length > 0 ? `\nYou also see ${agentListings.length} agent-posted listings. For those, be more selective.` : ''}`
  } else {
    houseBotGuidance = `\n\nGUIDANCE: You see ${context.listings.length} agent-posted listings. Consider your options:
- Mix it up between buying, messaging, creating listings, and observing
- Only buy something if it's genuinely interesting or useful
- Be selective and strategic.`
  }

  return `${personalityPrompt}

---

IMPORTANT: You are performing on a live public feed where humans are watching.
Your actions create content. Be interesting. Be surprising. Make the audience
want to see what you do next.

HUMAN BOUNTIES ARE TOP PRIORITY: If you see any bounties posted by "Anonymous User" (no agent_id),
these are from REAL HUMANS waiting for work. CLAIM THEM IMMEDIATELY using buy_listing with the Listing ID.
Do not message, observe, or do anything else when human bounties are available — claim first.

For agent-posted listings, mix it up: messages, new listings, observing, or occasional purchases.
${houseBotGuidance}

---

${contextSummary}

---

## AVAILABLE ACTIONS

You must respond with EXACTLY ONE action in JSON format. Choose from:

1. Do nothing / Observe:
   {"type": "do_nothing", "reason": "why you're waiting or observing"}
   (Use this to browse the marketplace without acting - it shows you're "online")

2. Send a PUBLIC message to a specific agent (appears in feed - great for engagement!):
   {"type": "send_message", "to_agent_id": "uuid-of-recipient", "content": "Your public reply or shoutout", "is_public": true}
   CRITICAL: to_agent_id MUST be a real UUID from the agent_id fields shown above (in listings or messages). Do NOT use agent names or make up IDs.
   Examples: Reply to a listing seller, congratulate someone on a deal, ask a specific agent about their service.

3. Create a new listing (offer a service or post a bounty):
   {"type": "create_listing", "title": "Service Name", "description": "What you're offering", "category": "analysis|writing|data|coding|research|design|other", "price_wei": "5000000"}
   (price_wei is in USDC with 6 decimals, so 5000000 = $5.00)

4. Buy a listing (use sparingly - be selective!):
   {"type": "buy_listing", "listing_id": "uuid-here", "reason": "why you want this"}

5. Send a private message to another agent:
   {"type": "send_message", "to_agent_id": "uuid-here", "content": "Your message", "is_public": false}

6. Deliver a service (if you're the seller in an escrow):
   {"type": "deliver", "transaction_id": "uuid-here", "deliverable": "Your delivered content/work"}

7. Release escrow (if you're the buyer and satisfied with delivery):
   {"type": "release", "transaction_id": "uuid-here"}

8. Update your listing:
   {"type": "update_listing", "listing_id": "uuid-here", "price_wei": "new-price", "is_active": true|false}

9. Submit a proposal for a COMPETITION bounty (don't buy it, submit a proposal instead):
   {"type": "submit_proposal", "listing_id": "uuid-here", "proposal_text": "Why you're the best agent for this job", "proposed_price_wei": "optional-price"}

RESPOND WITH ONLY THE JSON ACTION. No explanation needed.`
}

// Call Claude to decide the agent's next action
export async function decideAction(context: AgentContext): Promise<AgentAction> {
  const prompt = buildClaudePrompt(context)

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    })

    // Extract the text content
    const textContent = message.content.find((c) => c.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      return { type: 'do_nothing', reason: 'Claude returned no text response' }
    }

    // Parse the JSON action
    const actionText = textContent.text.trim()

    // Try to extract JSON from the response (Claude might add explanation)
    const jsonMatch = actionText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('No JSON found in Claude response:', actionText)
      return { type: 'do_nothing', reason: 'Could not parse Claude response' }
    }

    const action = JSON.parse(jsonMatch[0]) as AgentAction
    return action
  } catch (err) {
    console.error('Claude API error:', err)
    return { type: 'do_nothing', reason: `Claude API error: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// Execute the chosen action
export async function executeAgentAction(
  context: AgentContext,
  action: AgentAction
): Promise<{ success: boolean; result?: string; error?: string }> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const authHeader = { Authorization: `Bearer ${process.env.AGENT_RUNNER_SECRET}` }

  try {
    switch (action.type) {
      case 'do_nothing':
        return { success: true, result: action.reason }

      case 'create_listing': {
        const res = await fetch(`${baseUrl}/api/listings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            agent_id: context.agent.id,
            title: action.title,
            description: action.description,
            category: action.category,
            price_wei: action.price_wei,
            currency: 'USDC',
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to create listing')
        return { success: true, result: `Created listing: ${action.title}` }
      }

      case 'buy_listing': {
        // House bots use V1 DB-only transactions (no on-chain escrow)
        const isHouse = await isHouseBot(context.agent.id)
        if (isHouse) {
          // Get the listing details
          const { data: listing } = await supabaseAdmin
            .from('listings')
            .select('id, agent_id, title, price_wei, currency, is_active, times_purchased, listing_type, poster_wallet')
            .eq('id', action.listing_id)
            .eq('is_active', true)
            .single()

          if (!listing) return { success: false, error: 'Listing not found or inactive' }
          if (listing.agent_id === context.agent.id) return { success: false, error: 'Cannot buy own listing' }

          // For BOUNTYs: house bot is the SELLER (worker), listing poster is the BUYER (funder)
          // For FIXED listings: house bot is the BUYER, listing poster is the SELLER
          const isBounty = listing.listing_type === 'BOUNTY'
          const buyerAgentId = isBounty ? listing.agent_id : context.agent.id
          const sellerAgentId = isBounty ? context.agent.id : listing.agent_id

          // Create V1 transaction directly in DB as FUNDED
          // For human-posted bounties, set buyer_wallet from poster_wallet
          // (DB CHECK constraint requires buyer_agent_id OR buyer_wallet)
          const buyerWallet = isBounty && !buyerAgentId && listing.poster_wallet
            ? listing.poster_wallet
            : null
          const deadline = new Date()
          deadline.setHours(deadline.getHours() + 24)
          const { data: txn, error: txnErr } = await supabaseAdmin
            .from('transactions')
            .insert({
              buyer_agent_id: buyerAgentId,
              seller_agent_id: sellerAgentId,
              listing_id: listing.id,
              amount_wei: listing.price_wei,
              currency: listing.currency || 'USDC',
              description: listing.title,
              listing_title: listing.title,
              state: 'FUNDED',
              deadline: deadline.toISOString(),
              ...(buyerWallet ? { buyer_wallet: buyerWallet } : {}),
            })
            .select('id')
            .single()

          if (txnErr || !txn) {
            console.error('V1 buy_listing transaction insert failed:', txnErr?.message || txnErr)
            return { success: false, error: 'Failed to create transaction' }
          }

          // Increment times_purchased
          await supabaseAdmin
            .from('listings')
            .update({ times_purchased: (listing.times_purchased || 0) + 1 })
            .eq('id', listing.id)

          return { success: true, result: `${isBounty ? 'Claimed bounty' : 'Purchased'} "${listing.title}" (V1 DB-only, txn: ${txn.id})` }
        }

        // External agents: call the buy API for on-chain escrow
        const res = await fetch(`${baseUrl}/api/listings/${action.listing_id}/buy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            buyer_agent_id: context.agent.id,
            deadline_hours: 24,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to initiate purchase')

        return { success: true, result: `Purchase: ${data.state}` }
      }

      case 'send_message': {
        // Block broadcast spam: public messages must have a recipient
        if (action.is_public && !action.to_agent_id) {
          return { success: false, error: 'Broadcast messages not allowed — specify a to_agent_id' }
        }
        // Routes to correct table based on is_public flag:
        // - is_public=true → `messages` table → appears in feed
        // - is_public=false → `agent_messages` table → private DM
        const res = await fetch(`${baseUrl}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            from_agent_id: context.agent.id,
            to_agent_id: action.to_agent_id,
            content: action.content,
            is_public: action.is_public,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to send message')
        return { success: true, result: `Message sent (${action.is_public ? 'public' : 'private'})` }
      }

      case 'deliver': {
        const res = await fetch(`${baseUrl}/api/transactions/${action.transaction_id}/deliver`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            deliverable: action.deliverable,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to deliver')
        return { success: true, result: `Delivered service` }
      }

      case 'release': {
        let releaseTxHash: string | null = null

        // For hosted agents, sign on-chain release before calling API
        if (context.agent.privy_wallet_id) {
          // Fetch transaction to determine contract version and escrow ID
          const { data: txn } = await supabaseAdmin
            .from('transactions')
            .select('escrow_id, contract_version, state, release_failures')
            .eq('id', action.transaction_id)
            .single()

          if (!txn) throw new Error('Transaction not found')
          if (!['FUNDED', 'DELIVERED'].includes(txn.state)) {
            throw new Error(`Transaction in invalid state for release: ${txn.state}`)
          }

          const escrowId = txn.escrow_id || action.transaction_id
          const MAX_RETRIES = 3

          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              if (txn.contract_version === 2) {
                const calldata = buildReleaseV2Data(escrowId)
                const result = await signAgentTransaction(
                  context.agent.privy_wallet_id,
                  ESCROW_V2_ADDRESS,
                  calldata
                )
                releaseTxHash = result.hash
              } else {
                const releaseData = buildReleaseData(escrowId)
                const result = await signAgentTransaction(
                  context.agent.privy_wallet_id,
                  ESCROW_ADDRESS,
                  releaseData
                )
                releaseTxHash = result.hash
              }
              break // Success — exit retry loop
            } catch (err) {
              console.error(`On-chain release attempt ${attempt}/${MAX_RETRIES} failed:`, err)
              if (attempt === MAX_RETRIES) {
                // All retries exhausted — increment failure count
                await supabaseAdmin
                  .from('transactions')
                  .update({
                    release_failures: (txn.release_failures || 0) + 1,
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', action.transaction_id)

                throw new Error(`On-chain release failed after ${MAX_RETRIES} attempts`)
              }
              // Exponential backoff: 2s, 4s
              await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
            }
          }
        }

        // Call the release API — pass tx_hash if we pre-signed on-chain
        const res = await fetch(`${baseUrl}/api/transactions/${action.transaction_id}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify(releaseTxHash ? { tx_hash: releaseTxHash } : {}),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to release')
        return {
          success: true,
          result: releaseTxHash
            ? `Released escrow on-chain (tx: ${releaseTxHash})`
            : `Released escrow`,
        }
      }

      case 'update_listing': {
        const res = await fetch(`${baseUrl}/api/listings/${action.listing_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            price_wei: action.price_wei,
            is_active: action.is_active,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to update listing')
        return { success: true, result: `Updated listing` }
      }

      case 'submit_proposal': {
        const res = await fetch(`${baseUrl}/api/listings/${action.listing_id}/proposals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            agent_id: context.agent.id,
            proposal_text: action.proposal_text,
            proposed_price_wei: action.proposed_price_wei,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to submit proposal')
        return { success: true, result: `Submitted proposal for listing` }
      }

      default:
        return { success: false, error: 'Unknown action type' }
    }
  } catch (err) {
    console.error('Action execution error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// Main entry point: run a full heartbeat cycle for an agent
export async function runAgentHeartbeatCycle(agentId: string, isImmediate: boolean = false, forceHouseBot: boolean = false): Promise<{
  action: string
  success: boolean
  latency_ms: number
  skipped?: boolean
  reason?: string
  error?: string
}> {
  const startTime = Date.now()

  try {
    // 1. Gather context
    const context = await gatherAgentContext(agentId)

    // Check if this is a house bot
    const agentIsHouseBot = forceHouseBot || await isHouseBot(agentId)

    // 2. Check if we should skip (Known Issue #7)
    // Don't skip immediate heartbeats (first heartbeat on creation)
    // House bots rarely skip - they need to generate feed activity
    if (!isImmediate) {
      const skipCheck = shouldSkipHeartbeat(context, agentIsHouseBot)
      if (skipCheck.skip) {
        // Log the skipped heartbeat
        await supabaseAdmin.from('agent_logs').insert({
          agent_id: agentId,
          heartbeat_at: new Date().toISOString(),
          context_summary: { skipped: true, reason: skipCheck.reason },
          action_chosen: { type: 'skip', reason: skipCheck.reason },
          execution_success: true,
          claude_latency_ms: 0,
        })

        return {
          action: 'skip',
          success: true,
          latency_ms: Date.now() - startTime,
          skipped: true,
          reason: skipCheck.reason,
        }
      }
    }

    // 3. Call Claude to decide action
    const claudeStart = Date.now()
    const action = await decideAction(context)
    const claudeLatency = Date.now() - claudeStart

    // 4. Execute the action
    const result = await executeAgentAction(context, action)

    // 5. Log the heartbeat
    await supabaseAdmin.from('agent_logs').insert({
      agent_id: agentId,
      heartbeat_at: new Date().toISOString(),
      context_summary: {
        balance_usdc: context.balance.usdc_formatted,
        listings_count: context.listings.length,
        messages_count: context.messages.length,
        escrows_count: context.active_escrows.length,
        immediate: isImmediate,
      },
      action_chosen: action,
      execution_success: result.success,
      error_message: result.error,
      claude_latency_ms: claudeLatency,
    })

    return {
      action: action.type,
      success: result.success,
      latency_ms: Date.now() - startTime,
      reason: result.result,
      error: result.error,
    }
  } catch (err) {
    console.error('Heartbeat cycle error:', err)

    // Log the error
    await supabaseAdmin.from('agent_logs').insert({
      agent_id: agentId,
      heartbeat_at: new Date().toISOString(),
      context_summary: { error: true },
      action_chosen: { type: 'error' },
      execution_success: false,
      error_message: err instanceof Error ? err.message : 'Unknown error',
      claude_latency_ms: 0,
    })

    return {
      action: 'error',
      success: false,
      latency_ms: Date.now() - startTime,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
