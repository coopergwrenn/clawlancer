/**
 * Reputation Score Calculation
 *
 * Per PRD Section 6 (Reputation System):
 * - Reputation is DERIVED from on-chain escrow events
 * - Configurable weights via environment variables
 * - Anyone can verify by scanning contract events
 */

import { ReputationFeedback } from '@/lib/erc8004/reputation'

// Configurable weights (env vars or defaults)
const WEIGHTS = {
  RELEASED: parseFloat(process.env.REP_WEIGHT_RELEASED || '5'),
  DISPUTED_RELEASE: parseFloat(process.env.REP_WEIGHT_DISPUTED_RELEASE || '3'),
  DISPUTED_REFUND: parseFloat(process.env.REP_WEIGHT_DISPUTED_REFUND || '1'),
  REFUNDED: parseFloat(process.env.REP_WEIGHT_REFUNDED || '2'),
  RECENCY_MIN: parseFloat(process.env.REP_RECENCY_MIN || '0.5'),
  RECENCY_MAX: parseFloat(process.env.REP_RECENCY_MAX || '1.0'),
}

// Tier thresholds (configurable)
const TIER_THRESHOLDS = {
  TRUSTED_SCORE: parseFloat(process.env.REP_TIER_TRUSTED_SCORE || '4.5'),
  TRUSTED_COUNT: parseInt(process.env.REP_TIER_TRUSTED_COUNT || '10'),
  RELIABLE_SCORE: parseFloat(process.env.REP_TIER_RELIABLE_SCORE || '4.0'),
  RELIABLE_COUNT: parseInt(process.env.REP_TIER_RELIABLE_COUNT || '5'),
  STANDARD_SCORE: parseFloat(process.env.REP_TIER_STANDARD_SCORE || '3.0'),
  NEW_COUNT: parseInt(process.env.REP_TIER_NEW_COUNT || '3'),
}

export interface ReputationScore {
  score: number
  tier: 'TRUSTED' | 'RELIABLE' | 'STANDARD' | 'NEW' | 'CAUTION'
  totalTransactions: number
  breakdown: {
    released: number
    disputed: number
    refunded: number
    successRate: number
  }
  lastUpdated: string
}

export interface TransactionStats {
  released_count: number
  disputed_count: number
  refunded_count: number
  total_count: number
  total_volume_wei: string
}

/**
 * Calculate reputation score from feedback entries
 * Uses weighted average favoring recent transactions
 */
export function calculateFromFeedback(feedbacks: ReputationFeedback[]): ReputationScore {
  if (feedbacks.length === 0) {
    return {
      score: 0,
      tier: 'NEW',
      totalTransactions: 0,
      breakdown: {
        released: 0,
        disputed: 0,
        refunded: 0,
        successRate: 0,
      },
      lastUpdated: new Date().toISOString(),
    }
  }

  // Sort by date (oldest first for weighting)
  const sorted = [...feedbacks].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )

  // Calculate recency weights
  const weights = sorted.map((_, i, arr) => {
    const recency = (i + 1) / arr.length
    return WEIGHTS.RECENCY_MIN + recency * (WEIGHTS.RECENCY_MAX - WEIGHTS.RECENCY_MIN)
  })

  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const weightedSum = sorted.reduce((sum, fb, i) => sum + fb.rating * weights[i], 0)
  const score = weightedSum / totalWeight

  // Count outcomes
  const released = feedbacks.filter((f) => f.context.outcome === 'released').length
  const disputed = feedbacks.filter(
    (f) => f.context.outcome === 'disputed_release' || f.context.outcome === 'disputed_refund'
  ).length
  const refunded = feedbacks.filter((f) => f.context.outcome === 'refunded').length

  // Calculate tier
  const count = feedbacks.length
  let tier: ReputationScore['tier']

  if (count < TIER_THRESHOLDS.NEW_COUNT) {
    tier = 'NEW'
  } else if (score >= TIER_THRESHOLDS.TRUSTED_SCORE && count >= TIER_THRESHOLDS.TRUSTED_COUNT) {
    tier = 'TRUSTED'
  } else if (score >= TIER_THRESHOLDS.RELIABLE_SCORE && count >= TIER_THRESHOLDS.RELIABLE_COUNT) {
    tier = 'RELIABLE'
  } else if (score >= TIER_THRESHOLDS.STANDARD_SCORE) {
    tier = 'STANDARD'
  } else {
    tier = 'CAUTION'
  }

  return {
    score: Math.round(score * 100) / 100,
    tier,
    totalTransactions: count,
    breakdown: {
      released,
      disputed,
      refunded,
      successRate: count > 0 ? Math.round((released / count) * 100) : 0,
    },
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Calculate reputation from transaction stats (used by cron)
 * This is faster than loading all feedback when we just need counts
 */
export function calculateFromStats(stats: TransactionStats): ReputationScore {
  const { released_count, disputed_count, refunded_count, total_count } = stats

  if (total_count === 0) {
    return {
      score: 0,
      tier: 'NEW',
      totalTransactions: 0,
      breakdown: {
        released: 0,
        disputed: 0,
        refunded: 0,
        successRate: 0,
      },
      lastUpdated: new Date().toISOString(),
    }
  }

  // Calculate weighted score from counts
  const weightedSum =
    released_count * WEIGHTS.RELEASED +
    disputed_count * WEIGHTS.DISPUTED_RELEASE + // Assume split of disputed outcomes
    refunded_count * WEIGHTS.REFUNDED

  const score = weightedSum / total_count

  // Calculate tier
  let tier: ReputationScore['tier']

  if (total_count < TIER_THRESHOLDS.NEW_COUNT) {
    tier = 'NEW'
  } else if (score >= TIER_THRESHOLDS.TRUSTED_SCORE && total_count >= TIER_THRESHOLDS.TRUSTED_COUNT) {
    tier = 'TRUSTED'
  } else if (score >= TIER_THRESHOLDS.RELIABLE_SCORE && total_count >= TIER_THRESHOLDS.RELIABLE_COUNT) {
    tier = 'RELIABLE'
  } else if (score >= TIER_THRESHOLDS.STANDARD_SCORE) {
    tier = 'STANDARD'
  } else {
    tier = 'CAUTION'
  }

  return {
    score: Math.round(score * 100) / 100,
    tier,
    totalTransactions: total_count,
    breakdown: {
      released: released_count,
      disputed: disputed_count,
      refunded: refunded_count,
      successRate: total_count > 0 ? Math.round((released_count / total_count) * 100) : 0,
    },
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Get dispute window hours based on seller reputation tier
 * Per PRD Section 6: Higher reputation = shorter dispute window
 */
export function getDisputeWindowHours(tier: ReputationScore['tier']): number {
  switch (tier) {
    case 'TRUSTED':
      return 12 // Trusted sellers get shorter window
    case 'RELIABLE':
      return 24
    case 'STANDARD':
      return 48
    case 'NEW':
    case 'CAUTION':
    default:
      return 72 // New or cautioned sellers get longer window
  }
}

/**
 * Get tier display info for UI
 */
export function getTierInfo(tier: ReputationScore['tier']): {
  label: string
  color: string
  description: string
} {
  switch (tier) {
    case 'TRUSTED':
      return {
        label: 'Trusted',
        color: 'green',
        description: 'Highly reliable with 10+ successful transactions',
      }
    case 'RELIABLE':
      return {
        label: 'Reliable',
        color: 'blue',
        description: 'Good track record with 5+ successful transactions',
      }
    case 'STANDARD':
      return {
        label: 'Standard',
        color: 'gray',
        description: 'Average reputation',
      }
    case 'NEW':
      return {
        label: 'New',
        color: 'yellow',
        description: 'Fewer than 3 completed transactions',
      }
    case 'CAUTION':
      return {
        label: 'Caution',
        color: 'red',
        description: 'Below average reputation - proceed with care',
      }
  }
}
