/**
 * Notification Creation Helper
 *
 * Creates notifications for agents when important events occur
 */

import { createClient } from '@supabase/supabase-js'

export type NotificationType =
  | 'LISTING_CLAIMED'
  | 'PAYMENT_RECEIVED'
  | 'DISPUTE_FILED'
  | 'DELIVERY_RECEIVED'
  | 'DISPUTE_RESOLVED'
  | 'WITHDRAWAL_COMPLETED'
  | 'REVIEW_RECEIVED'
  | 'SYSTEM'
  | 'NEW_BOUNTY_MATCH'
  | 'LEADERBOARD_CHANGE'
  | 'ACHIEVEMENT_UNLOCKED'
  | 'NEW_AGENT_WELCOME'

interface CreateNotificationParams {
  agentId?: string
  userWallet?: string
  type: NotificationType
  title: string
  message: string
  metadata?: Record<string, unknown>
  relatedTransactionId?: string
  relatedListingId?: string
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Create a notification for an agent or human user
 */
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  const {
    agentId,
    userWallet,
    type,
    title,
    message,
    metadata = {},
    relatedTransactionId,
    relatedListingId,
  } = params

  if (!agentId && !userWallet) {
    console.error('createNotification: Either agentId or userWallet is required')
    return
  }

  try {
    const { error } = await supabase.from('notifications').insert({
      agent_id: agentId || null,
      user_wallet: userWallet ? userWallet.toLowerCase() : null,
      type,
      title,
      message,
      metadata,
      related_transaction_id: relatedTransactionId,
      related_listing_id: relatedListingId,
      read: false,
      created_at: new Date().toISOString(),
    })

    if (error) {
      console.error('Failed to create notification:', error)
    }
  } catch (err) {
    console.error('Notification creation error:', err)
  }
}

/**
 * Notify seller when their listing is claimed (when seller is an agent)
 */
export async function notifyListingClaimed(
  sellerAgentId: string,
  buyerName: string,
  listingTitle: string,
  amount: string,
  transactionId: string,
  listingId: string
): Promise<void> {
  await createNotification({
    agentId: sellerAgentId,
    type: 'LISTING_CLAIMED',
    title: 'Listing Claimed!',
    message: `${buyerName} has claimed "${listingTitle}" for $${(parseFloat(amount) / 1e6).toFixed(2)}. Funds are in escrow.`,
    metadata: { buyer_name: buyerName, listing_title: listingTitle, amount },
    relatedTransactionId: transactionId,
    relatedListingId: listingId,
  })
}

/**
 * Notify human buyer when their bounty is claimed
 */
export async function notifyBountyClaimed(
  buyerWallet: string,
  claimerName: string,
  bountyTitle: string,
  amount: string,
  transactionId: string,
  listingId: string
): Promise<void> {
  await createNotification({
    userWallet: buyerWallet,
    type: 'LISTING_CLAIMED',
    title: 'Bounty Claimed!',
    message: `${claimerName} has claimed your bounty "${bountyTitle}". Funds ($${(parseFloat(amount) / 1e6).toFixed(2)} USDC) are locked in escrow.`,
    metadata: { claimer_name: claimerName, bounty_title: bountyTitle, amount },
    relatedTransactionId: transactionId,
    relatedListingId: listingId,
  })
}

/**
 * Notify seller when payment is released
 */
export async function notifyPaymentReceived(
  sellerAgentId: string,
  buyerName: string,
  listingTitle: string,
  amount: string,
  transactionId: string
): Promise<void> {
  await createNotification({
    agentId: sellerAgentId,
    type: 'PAYMENT_RECEIVED',
    title: 'Payment Received!',
    message: `${buyerName} released payment of $${(parseFloat(amount) / 1e6).toFixed(2)} for "${listingTitle}".`,
    metadata: { buyer_name: buyerName, listing_title: listingTitle, amount },
    relatedTransactionId: transactionId,
  })
}

/**
 * Notify buyer when delivery is submitted
 */
export async function notifyDeliveryReceived(
  buyerAgentId: string,
  sellerName: string,
  listingTitle: string,
  transactionId: string
): Promise<void> {
  await createNotification({
    agentId: buyerAgentId,
    type: 'DELIVERY_RECEIVED',
    title: 'Delivery Submitted',
    message: `${sellerName} has delivered "${listingTitle}". Review and release payment or file a dispute.`,
    metadata: { seller_name: sellerName, listing_title: listingTitle },
    relatedTransactionId: transactionId,
  })
}

/**
 * Notify both parties when dispute is filed
 */
export async function notifyDisputeFiled(
  buyerAgentId: string,
  sellerAgentId: string,
  filerName: string,
  listingTitle: string,
  reason: string,
  transactionId: string
): Promise<void> {
  // Notify seller
  await createNotification({
    agentId: sellerAgentId,
    type: 'DISPUTE_FILED',
    title: 'Dispute Filed',
    message: `${filerName} has filed a dispute for "${listingTitle}". Reason: ${reason.slice(0, 100)}`,
    metadata: { filer_name: filerName, listing_title: listingTitle, reason },
    relatedTransactionId: transactionId,
  })

  // Notify buyer (if they didn't file it)
  await createNotification({
    agentId: buyerAgentId,
    type: 'DISPUTE_FILED',
    title: 'Dispute Filed',
    message: `A dispute has been filed for "${listingTitle}". Admin will review within 48 hours.`,
    metadata: { listing_title: listingTitle, reason },
    relatedTransactionId: transactionId,
  })
}

/**
 * Notify both parties when dispute is resolved
 */
export async function notifyDisputeResolved(
  buyerAgentId: string,
  sellerAgentId: string,
  listingTitle: string,
  resolution: string,
  transactionId: string
): Promise<void> {
  const message = `Dispute for "${listingTitle}" has been resolved: ${resolution}`

  await createNotification({
    agentId: buyerAgentId,
    type: 'DISPUTE_RESOLVED',
    title: 'Dispute Resolved',
    message,
    metadata: { listing_title: listingTitle, resolution },
    relatedTransactionId: transactionId,
  })

  await createNotification({
    agentId: sellerAgentId,
    type: 'DISPUTE_RESOLVED',
    title: 'Dispute Resolved',
    message,
    metadata: { listing_title: listingTitle, resolution },
    relatedTransactionId: transactionId,
  })
}

/**
 * Notify agent when they receive a review
 */
export async function notifyReviewReceived(
  reviewedAgentId: string,
  reviewerName: string,
  rating: number,
  reviewText: string | null,
  transactionId: string
): Promise<void> {
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating)
  await createNotification({
    agentId: reviewedAgentId,
    type: 'REVIEW_RECEIVED',
    title: `New ${rating}-Star Review`,
    message: `${reviewerName} left a ${stars} review${reviewText ? `: "${reviewText.slice(0, 80)}${reviewText.length > 80 ? '...' : ''}"` : '.'}`,
    metadata: { reviewer_name: reviewerName, rating, review_text: reviewText },
    relatedTransactionId: transactionId,
  })
}

/**
 * Notify agent when withdrawal completes
 */
export async function notifyWithdrawalCompleted(
  agentId: string,
  amount: string,
  toWallet: string,
  txHash: string
): Promise<void> {
  await createNotification({
    agentId,
    type: 'WITHDRAWAL_COMPLETED',
    title: 'Withdrawal Complete',
    message: `$${(parseFloat(amount) / 1e6).toFixed(2)} USDC has been sent to ${toWallet.slice(0, 6)}...${toWallet.slice(-4)}`,
    metadata: { amount, to_wallet: toWallet, tx_hash: txHash },
  })
}

/**
 * Notify agents whose skills match a new bounty listing
 */
export async function notifyNewBountyMatch(
  listingId: string,
  listingTitle: string,
  category: string | null,
  priceWei: string,
  excludeAgentId: string
): Promise<void> {
  if (!category) return

  const { data: matchingAgents } = await supabase
    .from('agents')
    .select('id')
    .contains('skills', [category])
    .eq('is_active', true)
    .neq('id', excludeAgentId)
    .limit(20)

  for (const agent of matchingAgents || []) {
    await createNotification({
      agentId: agent.id,
      type: 'NEW_BOUNTY_MATCH',
      title: 'New Bounty Matches Your Skills',
      message: `"${listingTitle}" ($${(parseFloat(priceWei) / 1e6).toFixed(2)}) matches your ${category} skill. Claim it before someone else does!`,
      metadata: { listing_title: listingTitle, category, price_wei: priceWei },
      relatedListingId: listingId,
    })
  }
}

/**
 * Notify agent about leaderboard position change
 */
export async function notifyLeaderboardChange(
  agentId: string,
  position: number,
  previousPosition: number | null
): Promise<void> {
  const direction = previousPosition !== null && position < previousPosition ? 'up' : 'entered'
  const message = direction === 'up'
    ? `You moved up to #${position} on the leaderboard!`
    : `You're now #${position} on the leaderboard!`

  await createNotification({
    agentId,
    type: 'LEADERBOARD_CHANGE',
    title: 'Leaderboard Update',
    message,
    metadata: { position, previous_position: previousPosition },
  })
}

/**
 * Notify top agents when a new agent registers
 */
export async function notifyNewAgentWelcome(
  newAgentName: string,
  newAgentId: string
): Promise<void> {
  const { data: topAgents } = await supabase
    .from('agents')
    .select('id')
    .order('total_earned_wei', { ascending: false })
    .limit(5)

  for (const agent of topAgents || []) {
    if (agent.id === newAgentId) continue
    await createNotification({
      agentId: agent.id,
      type: 'NEW_AGENT_WELCOME',
      title: 'New Agent in Town',
      message: `${newAgentName} just joined the marketplace. A new competitor or collaborator?`,
      metadata: { new_agent_name: newAgentName, new_agent_id: newAgentId },
    })
  }
}
