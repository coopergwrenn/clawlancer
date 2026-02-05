'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { ViewCardButton } from '@/components/agent-card-modal'
import { Logo } from '@/components/ui/logo'

interface Agent {
  id: string
  name: string
  wallet_address: string
  is_hosted: boolean
  is_active: boolean
  is_paused: boolean
  personality: string | null
  total_earned_wei: string
  total_spent_wei: string
  transaction_count: number
  created_at: string
  erc8004_token_id: string | null
  erc8004_chain: string | null
  // Profile fields (migration 013)
  bio: string | null
  skills: string[] | null
  avatar_url: string | null
}

interface Reputation {
  score: number
  tier: string
  totalTransactions: number
  successRate: number
  disputeRate: number
}

interface OnChainVerification {
  verified: boolean
  discrepancy: {
    scoreMatch: boolean
    tierMatch: boolean
    transactionCountMatch: boolean
  } | null
  message: string
}

interface OnChainData {
  reputation: Reputation
  stats: {
    released_count: number
    disputed_count: number
    refunded_count: number
    total_count: number
  }
  totalVolumeUSDC: string
  transactions: Array<{
    escrowId: string
    amount: string
    outcome: string
    txHash: string
  }>
  contractAddress: string
  chain: string
}

interface VerificationResult {
  verification: OnChainVerification
  onChain: OnChainData
  cached: {
    score: number
    tier: string
    totalTransactions: number
  }
}

interface Specialization {
  category: string
  count: number
}

interface CompletedWork {
  id: string
  title: string
  category: string | null
  completed_at: string
}

interface Endorsement {
  id: string
  endorser: {
    id: string
    name: string
    reputation_tier: string | null
  }
  message: string | null
  created_at: string
}

interface Listing {
  id: string
  title: string
  price_wei: string
  currency: string
  category: string | null
  is_active: boolean
}

interface Transaction {
  id: string
  amount_wei: string
  currency: string
  description: string | null
  state: string
  created_at: string
}

interface Review {
  id: string
  rating: number
  review_text: string | null
  created_at: string
  transaction_id: string
  reviewer: {
    id: string
    name: string
    avatar_url: string | null
    reputation_tier: string | null
  }
}

interface ReviewStats {
  review_count: number
  average_rating: number
  rating_distribution: Record<number, number>
}

const TIER_COLORS: Record<string, string> = {
  NEW: 'bg-stone-600 text-stone-200',
  NEWCOMER: 'bg-stone-600 text-stone-200',
  RELIABLE: 'bg-blue-600 text-blue-100',
  TRUSTED: 'bg-green-600 text-green-100',
  VETERAN: 'bg-amber-500 text-amber-900',
  CAUTION: 'bg-red-600 text-red-100',
}

const TIER_LABELS: Record<string, string> = {
  NEW: 'Newcomer',
  NEWCOMER: 'Newcomer',
  RELIABLE: 'Reliable',
  TRUSTED: 'Trusted',
  VETERAN: 'Veteran',
  CAUTION: 'Caution',
}

function formatUSDC(wei: string): string {
  const usdc = parseFloat(wei) / 1e6
  return `$${usdc.toFixed(2)}`
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) {
    return '0.0%'
  }
  // Value is already a percentage (e.g., 100 for 100%), don't multiply again
  return `${value.toFixed(1)}%`
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          className={`text-sm ${star <= rating ? 'text-amber-400' : 'text-stone-600'}`}
        >
          ★
        </span>
      ))}
    </div>
  )
}

export default function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = use(params)
  const { ready, authenticated } = usePrivySafe()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [reputation, setReputation] = useState<Reputation | null>(null)
  const [specializations, setSpecializations] = useState<Specialization[]>([])
  const [completedWork, setCompletedWork] = useState<CompletedWork[]>([])
  const [endorsements, setEndorsements] = useState<Endorsement[]>([])
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewStats, setReviewStats] = useState<ReviewStats | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([])
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchAgentData() {
      try {
        // Fetch agent basic info
        const agentRes = await fetch(`/api/agents/${agentId}`)
        if (!agentRes.ok) {
          setError('Agent not found')
          return
        }
        const agentData = await agentRes.json()
        // API returns agent fields directly at root level
        setAgent(agentData)
        // Also includes listings and recent_transactions
        setListings(agentData.listings || [])
        setRecentTransactions(agentData.recent_transactions || [])

        // Fetch reputation
        const repRes = await fetch(`/api/agents/${agentId}/reputation`)
        if (repRes.ok) {
          const repData = await repRes.json()
          // API returns reputation nested inside a "reputation" object
          const rep = repData.reputation || repData
          setReputation({
            score: rep.score ?? 0,
            tier: rep.tier || 'NEWCOMER',
            totalTransactions: rep.totalTransactions ?? 0,
            successRate: rep.successRate ?? 0,
            disputeRate: rep.disputeRate ?? 0,
          })
        }

        // Fetch specializations (from completed work categories)
        const specRes = await fetch(`/api/agents/${agentId}/specializations`)
        if (specRes.ok) {
          const specData = await specRes.json()
          setSpecializations(specData.specializations || [])
        }

        // Fetch completed work
        const workRes = await fetch(`/api/agents/${agentId}/completed-work`)
        if (workRes.ok) {
          const workData = await workRes.json()
          setCompletedWork(workData.completedWork || [])
        }

        // Fetch endorsements
        const endRes = await fetch(`/api/agents/${agentId}/endorsements`)
        if (endRes.ok) {
          const endData = await endRes.json()
          setEndorsements(endData.endorsements || [])
        }

        // Fetch reviews
        const reviewsRes = await fetch(`/api/agents/${agentId}/reviews`)
        if (reviewsRes.ok) {
          const reviewsData = await reviewsRes.json()
          setReviews(reviewsData.reviews || [])
          setReviewStats(reviewsData.stats || null)
        }
      } catch (err) {
        console.error('Failed to fetch agent data:', err)
        setError('Failed to load agent')
      } finally {
        setIsLoading(false)
      }
    }

    fetchAgentData()
  }, [agentId])

  async function handleVerifyOnChain() {
    setIsVerifying(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/reputation/verify`)
      if (res.ok) {
        const data = await res.json()
        setVerificationResult(data)
      }
    } catch (err) {
      console.error('Verification failed:', err)
    } finally {
      setIsVerifying(false)
    }
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
        <div className="max-w-4xl mx-auto px-6 py-12">
          <p className="text-stone-500 font-mono">Loading agent...</p>
        </div>
      </main>
    )
  }

  if (error || !agent) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
        <div className="max-w-4xl mx-auto px-6 py-12">
          <p className="text-red-400 font-mono">{error || 'Agent not found'}</p>
          <Link href="/agents" className="text-[#c9a882] font-mono hover:underline mt-4 inline-block">
            ← Back to Agents
          </Link>
        </div>
      </main>
    )
  }

  const tier = reputation?.tier || 'NEW'

  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      {/* Header */}
      <header className="border-b border-stone-800 px-3 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Logo size="md" linkTo="/" />
          <nav className="flex items-center gap-2 sm:gap-6">
            <Link href="/marketplace" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              marketplace
            </Link>
            <Link href="/agents" className="text-sm font-mono text-[#c9a882] transition-colors">
              agents
            </Link>
          </nav>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Agent Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="flex items-center gap-4">
            {/* Avatar */}
            {agent.avatar_url ? (
              <img
                src={agent.avatar_url}
                alt={agent.name}
                className="w-16 h-16 rounded-full object-cover border-2 border-stone-700"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#c9a882] to-[#8b7355] flex items-center justify-center">
                <span className="text-2xl font-mono font-bold text-[#1a1614]">
                  {agent.name.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
            <div className="flex flex-col">
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-mono font-bold">{agent.name}</h1>
                {/* Reputation Tier Badge */}
                <span className={`px-3 py-1 text-xs font-mono font-bold rounded ${TIER_COLORS[tier]}`}>
                  {TIER_LABELS[tier]}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <a
                  href={`https://basescan.org/address/${agent.wallet_address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-stone-500 font-mono hover:text-[#c9a882] transition-colors"
                >
                  {truncateAddress(agent.wallet_address)}
                </a>
                <span className="text-stone-700">•</span>
                <span className="text-sm text-stone-500 font-mono">
                  Joined {new Date(agent.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ViewCardButton agentId={agent.id} agentName={agent.name} variant="default" />
            {agent.erc8004_token_id && (
              <a
                href={`https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=${agent.erc8004_token_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 text-xs font-mono bg-emerald-900/30 text-emerald-400 border border-emerald-800/50 rounded hover:bg-emerald-900/50 transition-colors flex items-center gap-1.5"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                ERC-8004 Registered
              </a>
            )}
          </div>
        </div>

        {/* Bio & Skills */}
        {(agent.bio || (agent.skills && agent.skills.length > 0)) && (
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
            {agent.bio && (
              <p className="font-mono text-sm text-stone-300 leading-relaxed mb-4">{agent.bio}</p>
            )}
            {agent.skills && agent.skills.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {agent.skills.map((skill) => (
                  <Link
                    key={skill}
                    href={`/agents?skill=${encodeURIComponent(skill)}`}
                    className="px-3 py-1 text-xs font-mono bg-[#c9a882]/10 text-[#c9a882] rounded-full hover:bg-[#c9a882]/20 transition-colors"
                  >
                    {skill}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Status</p>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${
                agent.is_paused ? 'bg-yellow-500' : agent.is_active ? 'bg-green-500' : 'bg-stone-500'
              }`} />
              <span className="font-mono text-sm font-bold">
                {agent.is_paused ? 'Paused' : agent.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Earned</p>
            <p className="text-xl font-mono font-bold text-[#c9a882]">{formatUSDC(agent.total_earned_wei)}</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Spent</p>
            <p className="text-xl font-mono font-bold">{formatUSDC(agent.total_spent_wei)}</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Transactions</p>
            <p className="text-xl font-mono font-bold">{agent.transaction_count}</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Success Rate</p>
            <p className="text-xl font-mono font-bold text-green-400">
              {reputation ? formatPercent(reputation.successRate) : '—'}
            </p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Reviews</p>
            <div className="flex items-center gap-1.5">
              <p className="text-xl font-mono font-bold">{reviewStats?.review_count || 0}</p>
              {reviewStats && reviewStats.average_rating > 0 && (
                <span className="text-amber-400 text-sm">★ {reviewStats.average_rating.toFixed(1)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Hire Agent CTA */}
        {agent.is_active && !agent.is_paused && listings.filter(l => l.is_active).length > 0 && (
          <div className="bg-gradient-to-r from-[#c9a882]/10 to-[#c9a882]/5 border border-[#c9a882]/30 rounded-lg p-6 mb-8 flex items-center justify-between">
            <div>
              <h3 className="font-mono font-bold text-lg mb-1">Hire {agent.name}</h3>
              <p className="text-sm font-mono text-stone-400">
                {listings.filter(l => l.is_active).length} active listing{listings.filter(l => l.is_active).length !== 1 ? 's' : ''} starting at {formatUSDC(
                  Math.min(...listings.filter(l => l.is_active).map(l => parseInt(l.price_wei))).toString()
                )}
              </p>
            </div>
            <a
              href="#listings"
              className="px-6 py-3 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded hover:bg-[#d4b896] transition-colors whitespace-nowrap"
            >
              View Listings
            </a>
          </div>
        )}

        {/* Active Listings */}
        {listings.filter(l => l.is_active).length > 0 && (
          <div id="listings" className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
            <h2 className="text-lg font-mono font-bold mb-4">Active Listings</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {listings.filter(l => l.is_active).map((listing) => (
                <Link
                  key={listing.id}
                  href={`/listings/${listing.id}`}
                  className="bg-stone-900/50 border border-stone-700 rounded-lg p-4 hover:border-[#c9a882]/50 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-mono text-sm font-bold mb-1">{listing.title}</h3>
                      {listing.category && (
                        <span className="text-xs font-mono text-stone-500">{listing.category}</span>
                      )}
                    </div>
                    <span className="font-mono font-bold text-[#c9a882]">
                      {formatUSDC(listing.price_wei)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Reputation Details */}
        {reputation && (
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-mono font-bold">Reputation</h2>
                {verificationResult && (
                  <span className={`px-2 py-0.5 text-xs font-mono rounded ${
                    verificationResult.verification.verified
                      ? 'bg-green-900/50 text-green-400 border border-green-700'
                      : 'bg-yellow-900/50 text-yellow-400 border border-yellow-700'
                  }`}>
                    {verificationResult.verification.verified ? 'On-Chain Verified' : 'Discrepancy Detected'}
                  </span>
                )}
              </div>
              <button
                onClick={handleVerifyOnChain}
                disabled={isVerifying}
                className="px-3 py-1.5 text-xs font-mono bg-stone-800 text-stone-300 rounded hover:bg-stone-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {isVerifying ? (
                  <>
                    <span className="inline-block w-3 h-3 border border-stone-400 border-t-transparent rounded-full animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Verify On-Chain'
                )}
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Score</p>
                <p className="font-mono font-bold text-2xl text-[#c9a882]">{reputation.score}</p>
              </div>
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Success Rate</p>
                <p className="font-mono font-bold">{formatPercent(reputation.successRate)}</p>
              </div>
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Dispute Rate</p>
                <p className="font-mono font-bold">{formatPercent(reputation.disputeRate)}</p>
              </div>
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Total Transactions</p>
                <p className="font-mono font-bold">{reputation.totalTransactions}</p>
              </div>
            </div>

            {/* On-Chain Verification Results */}
            {verificationResult && (
              <div className="mt-6 pt-4 border-t border-stone-800">
                <h3 className="text-sm font-mono font-bold text-stone-400 mb-3">On-Chain Verification</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div>
                    <p className="text-xs font-mono text-stone-500 uppercase mb-1">Chain Score</p>
                    <p className="font-mono font-bold text-lg">{verificationResult.onChain.reputation.score}</p>
                  </div>
                  <div>
                    <p className="text-xs font-mono text-stone-500 uppercase mb-1">Released</p>
                    <p className="font-mono font-bold text-green-400">{verificationResult.onChain.stats.released_count}</p>
                  </div>
                  <div>
                    <p className="text-xs font-mono text-stone-500 uppercase mb-1">Disputed</p>
                    <p className="font-mono font-bold text-red-400">{verificationResult.onChain.stats.disputed_count}</p>
                  </div>
                  <div>
                    <p className="text-xs font-mono text-stone-500 uppercase mb-1">On-Chain Volume</p>
                    <p className="font-mono font-bold text-[#c9a882]">${verificationResult.onChain.totalVolumeUSDC}</p>
                  </div>
                </div>

                {/* Discrepancy details */}
                {verificationResult.verification.discrepancy && (
                  <div className="bg-yellow-900/20 border border-yellow-800/50 rounded p-3 mb-4">
                    <p className="text-xs font-mono text-yellow-400 mb-2">Discrepancies found:</p>
                    <div className="flex flex-wrap gap-3">
                      {!verificationResult.verification.discrepancy.scoreMatch && (
                        <span className="text-xs font-mono text-yellow-300">
                          Score: cached {verificationResult.cached.score} vs chain {verificationResult.onChain.reputation.score}
                        </span>
                      )}
                      {!verificationResult.verification.discrepancy.tierMatch && (
                        <span className="text-xs font-mono text-yellow-300">
                          Tier: cached {verificationResult.cached.tier} vs chain {verificationResult.onChain.reputation.tier}
                        </span>
                      )}
                      {!verificationResult.verification.discrepancy.transactionCountMatch && (
                        <span className="text-xs font-mono text-yellow-300">
                          Txns: cached {verificationResult.cached.totalTransactions} vs chain {verificationResult.onChain.stats.total_count}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* On-chain transaction list */}
                {verificationResult.onChain.transactions.length > 0 && (
                  <div>
                    <p className="text-xs font-mono text-stone-500 uppercase mb-2">On-Chain Escrow Events</p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {verificationResult.onChain.transactions.slice(0, 10).map((tx, i) => (
                        <div key={i} className="flex items-center justify-between text-xs font-mono py-1">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded ${
                              tx.outcome === 'released' ? 'bg-green-900/50 text-green-400' :
                              tx.outcome === 'refunded' ? 'bg-orange-900/50 text-orange-400' :
                              tx.outcome === 'disputed' ? 'bg-red-900/50 text-red-400' :
                              'bg-stone-800 text-stone-400'
                            }`}>
                              {tx.outcome}
                            </span>
                            <span className="text-stone-400">${tx.amount} USDC</span>
                          </div>
                          <a
                            href={`https://basescan.org/tx/${tx.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-stone-500 hover:text-[#c9a882] transition-colors"
                          >
                            {tx.txHash.slice(0, 10)}...
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2 text-xs font-mono text-stone-600">
                  <span>Contract:</span>
                  <a
                    href={`https://basescan.org/address/${verificationResult.onChain.contractAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[#c9a882] transition-colors"
                  >
                    {verificationResult.onChain.contractAddress.slice(0, 10)}...{verificationResult.onChain.contractAddress.slice(-4)}
                  </a>
                  <span className="text-stone-700">|</span>
                  <span>{verificationResult.onChain.chain}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Reviews */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-mono font-bold">
                Reviews ({reviewStats?.review_count || 0})
              </h2>
              {reviewStats && reviewStats.review_count > 0 && (
                <div className="flex items-center gap-2 mt-1">
                  <StarRating rating={Math.round(reviewStats.average_rating)} />
                  <span className="text-sm font-mono text-stone-400">
                    {reviewStats.average_rating.toFixed(1)} average
                  </span>
                </div>
              )}
            </div>
            {/* Rating Distribution */}
            {reviewStats && reviewStats.review_count > 0 && (
              <div className="hidden sm:flex items-center gap-1">
                {[5, 4, 3, 2, 1].map((star) => {
                  const count = reviewStats.rating_distribution[star] || 0
                  const percentage = reviewStats.review_count > 0
                    ? (count / reviewStats.review_count) * 100
                    : 0
                  return (
                    <div key={star} className="flex items-center gap-1 text-xs font-mono">
                      <span className="text-stone-500">{star}</span>
                      <div className="w-12 h-2 bg-stone-800 rounded overflow-hidden">
                        <div
                          className="h-full bg-amber-400 rounded"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {reviews.length > 0 ? (
            <div className="space-y-4">
              {reviews.map((review) => (
                <div key={review.id} className="py-4 border-b border-stone-800 last:border-0">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-3">
                      {review.reviewer.avatar_url ? (
                        <img
                          src={review.reviewer.avatar_url}
                          alt={review.reviewer.name}
                          className="w-8 h-8 rounded-full object-cover border border-stone-700"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#c9a882] to-[#8b7355] flex items-center justify-center">
                          <span className="text-xs font-mono font-bold text-[#1a1614]">
                            {review.reviewer.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/agents/${review.reviewer.id}`}
                            className="font-mono text-sm font-bold hover:text-[#c9a882] transition-colors"
                          >
                            {review.reviewer.name}
                          </Link>
                          {review.reviewer.reputation_tier && (
                            <span className={`px-2 py-0.5 text-xs font-mono rounded ${TIER_COLORS[review.reviewer.reputation_tier]}`}>
                              {TIER_LABELS[review.reviewer.reputation_tier]}
                            </span>
                          )}
                        </div>
                        <StarRating rating={review.rating} />
                      </div>
                    </div>
                    <span className="text-xs font-mono text-stone-500">
                      {new Date(review.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {review.review_text && (
                    <p className="text-sm font-mono text-stone-300 mt-2 ml-11">
                      {review.review_text}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm font-mono text-stone-500">No reviews yet</p>
          )}
        </div>

        {/* Completed Work / Portfolio */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-mono font-bold mb-4">Completed Work</h2>
          {completedWork.length > 0 ? (
            <div className="space-y-3">
              {completedWork.slice(0, 10).map((work) => (
                <div key={work.id} className="flex items-center justify-between py-2 border-b border-stone-800 last:border-0">
                  <div>
                    <p className="font-mono text-sm">{work.title}</p>
                    {work.category && (
                      <span className="text-xs font-mono text-stone-500">{work.category}</span>
                    )}
                  </div>
                  <span className="text-xs font-mono text-stone-500">
                    {new Date(work.completed_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm font-mono text-stone-500">No completed work yet</p>
          )}
        </div>

        {/* Specializations */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-mono font-bold mb-4">Specializations</h2>
          {specializations.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {specializations.map((spec) => (
                <span
                  key={spec.category}
                  className="px-3 py-1 text-sm font-mono bg-stone-800 text-stone-300 rounded"
                >
                  {spec.category} ({spec.count})
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm font-mono text-stone-500">No specializations yet</p>
          )}
        </div>

        {/* Endorsements */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-mono font-bold">
              Endorsed by ({endorsements.length})
            </h2>
          </div>
          {endorsements.length > 0 ? (
            <div className="space-y-4">
              {endorsements.map((endorsement) => (
                <div key={endorsement.id} className="flex items-start gap-3 py-3 border-b border-stone-800 last:border-0">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/agents/${endorsement.endorser.id}`}
                        className="font-mono text-sm font-bold hover:text-[#c9a882] transition-colors"
                      >
                        {endorsement.endorser.name}
                      </Link>
                      {endorsement.endorser.reputation_tier && (
                        <span className={`px-2 py-0.5 text-xs font-mono rounded ${TIER_COLORS[endorsement.endorser.reputation_tier]}`}>
                          {TIER_LABELS[endorsement.endorser.reputation_tier]}
                        </span>
                      )}
                    </div>
                    {endorsement.message && (
                      <p className="text-sm font-mono text-stone-400 mt-1">{endorsement.message}</p>
                    )}
                  </div>
                  <span className="text-xs font-mono text-stone-500">
                    {new Date(endorsement.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm font-mono text-stone-500">No endorsements yet</p>
          )}
        </div>

        {/* Recent Transactions */}
        {recentTransactions.length > 0 && (
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6">
            <h2 className="text-lg font-mono font-bold mb-4">Recent Transactions</h2>
            <div className="space-y-3">
              {recentTransactions.slice(0, 10).map((tx) => (
                <Link
                  key={tx.id}
                  href={`/transactions/${tx.id}`}
                  className="flex items-center justify-between py-2 border-b border-stone-800 last:border-0 hover:bg-stone-900/30 -mx-2 px-2 rounded transition-colors"
                >
                  <div>
                    <p className="font-mono text-sm">{tx.description || 'Transaction'}</p>
                    <span className={`text-xs font-mono ${
                      tx.state === 'RELEASED' ? 'text-green-500' :
                      tx.state === 'DISPUTED' ? 'text-red-500' :
                      tx.state === 'REFUNDED' ? 'text-orange-500' :
                      'text-stone-500'
                    }`}>
                      {tx.state}
                    </span>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-bold text-[#c9a882]">{formatUSDC(tx.amount_wei)}</p>
                    <span className="text-xs font-mono text-stone-500">
                      {new Date(tx.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
