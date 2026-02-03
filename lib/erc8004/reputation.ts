/**
 * Reputation Feedback System
 *
 * Per PRD Section 1 (Trust Model):
 * - Reputation is DERIVED from on-chain escrow events
 * - Cached locally for performance
 * - Anyone can verify by scanning contract events
 */

export interface ReputationFeedback {
  agentId: string;
  rating: number; // 1-5
  context: {
    transactionId: string;
    escrowId: string;
    txHash?: string; // On-chain reference for VERIFICATION
    amount: string;
    currency: string;
    completedAt: string;
    outcome: 'released' | 'refunded' | 'disputed_release' | 'disputed_refund';
    durationSeconds: number;
    deliverableHash?: string;
  };
  createdAt: string;
}

/**
 * Create reputation feedback from transaction completion
 * Rating is derived from ON-CHAIN outcome (see Section 1)
 */
export function createReputationFeedback(
  agentId: string,
  transactionId: string,
  escrowId: string,
  amount: string,
  currency: string,
  outcome: ReputationFeedback['context']['outcome'],
  durationSeconds: number,
  txHash?: string,
  deliverableHash?: string
): ReputationFeedback {
  // Rating derived from ON-CHAIN outcome
  let rating: number;
  switch (outcome) {
    case 'released':
      rating = 5; // Successful completion
      break;
    case 'disputed_release':
      rating = 3; // Disputed but seller won
      break;
    case 'disputed_refund':
      rating = 1; // Disputed and buyer won (seller failed)
      break;
    case 'refunded':
      rating = 2; // Deadline passed, no delivery
      break;
    default:
      rating = 3;
  }

  return {
    agentId,
    rating,
    context: {
      transactionId,
      escrowId,
      txHash, // On-chain reference for VERIFICATION
      amount,
      currency,
      completedAt: new Date().toISOString(),
      outcome,
      durationSeconds,
      deliverableHash
    },
    createdAt: new Date().toISOString()
  };
}

/**
 * Calculate aggregate reputation score from feedback
 * Uses weighted average favoring recent transactions
 */
export function calculateReputationScore(
  feedbacks: ReputationFeedback[]
): { score: number; tier: string; totalTransactions: number } {
  if (feedbacks.length === 0) {
    return { score: 0, tier: 'NEW', totalTransactions: 0 };
  }

  // Weight recent transactions more heavily
  const weights = feedbacks.map((_, i, arr) => {
    const recency = (i + 1) / arr.length; // 0 to 1, higher = more recent
    return 0.5 + recency * 0.5; // 0.5 to 1.0 weight
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weightedSum = feedbacks.reduce((sum, fb, i) => sum + fb.rating * weights[i], 0);
  const score = weightedSum / totalWeight;

  // Determine tier based on score and transaction count
  let tier: string;
  const count = feedbacks.length;

  if (count < 3) {
    tier = 'NEW';
  } else if (score >= 4.5 && count >= 10) {
    tier = 'TRUSTED';
  } else if (score >= 4.0 && count >= 5) {
    tier = 'RELIABLE';
  } else if (score >= 3.0) {
    tier = 'STANDARD';
  } else {
    tier = 'CAUTION';
  }

  return {
    score: Math.round(score * 100) / 100,
    tier,
    totalTransactions: count
  };
}

/**
 * Get dispute window hours based on seller reputation
 */
export function getDisputeWindowHours(tier: string): number {
  switch (tier) {
    case 'TRUSTED':
      return 12; // Trusted sellers get shorter window
    case 'RELIABLE':
      return 24;
    case 'STANDARD':
      return 48;
    case 'NEW':
    case 'CAUTION':
    default:
      return 72; // New or cautioned sellers get longer window
  }
}
