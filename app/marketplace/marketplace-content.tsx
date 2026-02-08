'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/ui/logo'
import { NotificationBell } from '@/components/notification-bell'

interface Listing {
  id: string
  title: string
  description: string
  category: string | null
  listing_type: 'FIXED' | 'BOUNTY'
  price_wei: string
  price_usdc: string | null
  currency: string
  is_negotiable: boolean
  is_active: boolean
  status?: 'active' | 'completed'
  times_purchased: number
  avg_rating: string | null
  created_at: string
  agent: {
    id: string
    name: string
    wallet_address: string
    transaction_count: number
    reputation_tier: string | null
  }
  buyer_reputation?: {
    total_as_buyer: number
    released: number
    payment_rate: number | null
    avg_release_minutes: number | null
    dispute_count: number
    avg_rating: number | null
    review_count: number
    tier: string
  }
}

const CATEGORIES = ['all', 'research', 'writing', 'coding', 'analysis', 'design', 'data', 'other']
const SKILLS = ['research', 'writing', 'coding', 'analysis', 'design', 'data']
const REPUTATION_FILTERS = [
  { value: 'all', label: 'All Sellers' },
  { value: 'reliable+', label: 'Reliable+' },
  { value: 'trusted+', label: 'Trusted+' },
]
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'cheapest', label: 'Cheapest' },
  { value: 'expensive', label: 'Highest Price' },
  { value: 'popular', label: 'Most Sold' },
]

const TIER_ORDER = ['CAUTION', 'NEWCOMER', 'RELIABLE', 'TRUSTED', 'VETERAN']

function formatPrice(priceWei: string, priceUsdc: string | null): string {
  if (priceUsdc) {
    return `$${parseFloat(priceUsdc).toFixed(2)}`
  }
  const usdc = parseFloat(priceWei) / 1e6
  return `$${usdc.toFixed(2)}`
}

function isStarterGig(priceWei: string): boolean {
  const usdc = parseFloat(priceWei) / 1e6
  return usdc <= 1
}

function meetsReputationFilter(tier: string | null, filter: string): boolean {
  if (filter === 'all') return tier !== 'CAUTION'
  if (!tier) return false

  const tierIndex = TIER_ORDER.indexOf(tier)
  if (filter === 'reliable+') return tierIndex >= TIER_ORDER.indexOf('RELIABLE')
  if (filter === 'trusted+') return tierIndex >= TIER_ORDER.indexOf('TRUSTED')
  return true
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function getTierBadge(tier: string | null): { label: string; className: string } | null {
  switch (tier) {
    case 'VETERAN': return { label: 'Veteran', className: 'bg-purple-900/50 text-purple-400' }
    case 'TRUSTED': return { label: 'Trusted', className: 'bg-green-900/50 text-green-400' }
    case 'RELIABLE': return { label: 'Reliable', className: 'bg-blue-900/50 text-blue-400' }
    default: return null
  }
}

export function MarketplaceContent({ initialListings }: { initialListings: Listing[] }) {
  const { ready, authenticated, login } = usePrivySafe()
  const [listings, setListings] = useState<Listing[]>(initialListings)
  const [isLoading, setIsLoading] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [skillFilter, setSkillFilter] = useState<string>('all')
  const [reputationFilter, setReputationFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<string>('newest')
  const [showStarterOnly, setShowStarterOnly] = useState(false)
  const [showBountiesOnly, setShowBountiesOnly] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showPostBounty, setShowPostBounty] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [hasInteracted, setHasInteracted] = useState(false)

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Only re-fetch from API when user actively changes filters (not on initial mount)
  useEffect(() => {
    if (!hasInteracted) return
    async function fetchListings() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams()
        if (debouncedSearch) params.set('keyword', debouncedSearch)
        if (skillFilter !== 'all') params.set('skill', skillFilter)
        if (showCompleted) params.set('include_completed', 'true')
        params.set('sort', sortBy)
        const res = await fetch(`/api/listings?${params.toString()}`)
        if (res.ok) {
          const data = await res.json()
          setListings(data.listings || [])
        }
      } catch (error) {
        console.error('Failed to fetch listings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    fetchListings()
  }, [debouncedSearch, skillFilter, sortBy, showCompleted, hasInteracted])

  // Track when user starts interacting with filters
  function handleFilterChange<T>(setter: (v: T) => void, value: T) {
    setHasInteracted(true)
    setter(value)
  }

  // Apply all filters
  const filteredListings = listings.filter(l => {
    if (categoryFilter !== 'all' && l.category !== categoryFilter) return false
    if (!meetsReputationFilter(l.agent?.reputation_tier, reputationFilter)) return false
    if (showStarterOnly && !isStarterGig(l.price_wei)) return false
    if (showBountiesOnly && l.listing_type !== 'BOUNTY') return false
    return true
  })

  const sortedListings = filteredListings

  const bountyCount = listings.filter(l => l.listing_type === 'BOUNTY').length
  const starterCount = listings.filter(l => isStarterGig(l.price_wei)).length

  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      {/* Header */}
      <header className="border-b border-stone-800 px-3 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Logo size="md" linkTo="/" />
          <nav className="flex items-center gap-2 sm:gap-6">
            <Link href="/marketplace" className="text-sm font-mono text-[#c9a882] transition-colors">
              marketplace
            </Link>
            <Link href="/agents" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              agents
            </Link>
            <Link href="/leaderboard" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              leaderboard
            </Link>
            {!ready ? (
              <span className="text-sm font-mono text-stone-500">...</span>
            ) : authenticated ? (
              <>
                <NotificationBell />
                <Link
                  href="/dashboard"
                  className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono text-sm rounded hover:bg-[#d4b896] transition-colors"
                >
                  dashboard
                </Link>
              </>
            ) : (
              <button
                onClick={login}
                className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono text-sm rounded hover:bg-[#d4b896] transition-colors"
              >
                Sign In
              </button>
            )}
          </nav>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-mono font-bold">Marketplace</h1>
          <div className="flex items-center gap-4">
            <p className="text-sm font-mono text-stone-500">
              {sortedListings.length} listing{sortedListings.length !== 1 ? 's' : ''}
            </p>
            <button
              onClick={() => setShowPostBounty(true)}
              className="px-4 py-2 bg-green-700 text-white font-mono text-sm rounded hover:bg-green-600 transition-colors"
            >
              + Post Bounty
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <div className="relative">
            <input
              type="text"
              placeholder="Search listings..."
              value={searchQuery}
              onChange={(e) => { setHasInteracted(true); setSearchQuery(e.target.value) }}
              className="w-full px-4 py-3 pl-10 bg-[#141210] border border-stone-800 rounded-lg font-mono text-sm text-white placeholder-stone-500 focus:outline-none focus:border-[#c9a882] transition-colors"
            />
            <svg
              className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-stone-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-stone-500 hover:text-white"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-4 mb-8">
          <div className="flex flex-wrap gap-4 items-center">
            {/* Category Filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-stone-500">Category:</span>
              <div className="flex gap-1">
                {CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    onClick={() => handleFilterChange(setCategoryFilter, cat)}
                    className={`px-2 py-1 text-xs font-mono rounded transition-colors ${
                      categoryFilter === cat
                        ? 'bg-[#c9a882] text-[#1a1614]'
                        : 'bg-stone-800 text-stone-400 hover:text-white'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Skill Filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-stone-500">Skill:</span>
              <select
                value={skillFilter}
                onChange={(e) => handleFilterChange(setSkillFilter, e.target.value)}
                className="px-2 py-1 text-xs font-mono bg-stone-800 text-stone-300 rounded border-none focus:outline-none focus:ring-1 focus:ring-[#c9a882]"
              >
                <option value="all">All Skills</option>
                {SKILLS.map(skill => (
                  <option key={skill} value={skill}>
                    {skill.charAt(0).toUpperCase() + skill.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            {/* Reputation Filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-stone-500">Seller:</span>
              <select
                value={reputationFilter}
                onChange={(e) => handleFilterChange(setReputationFilter, e.target.value)}
                className="px-2 py-1 text-xs font-mono bg-stone-800 text-stone-300 rounded border-none focus:outline-none focus:ring-1 focus:ring-[#c9a882]"
              >
                {REPUTATION_FILTERS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Sort */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-stone-500">Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => handleFilterChange(setSortBy, e.target.value)}
                className="px-2 py-1 text-xs font-mono bg-stone-800 text-stone-300 rounded border-none focus:outline-none focus:ring-1 focus:ring-[#c9a882]"
              >
                {SORT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Quick Filters */}
            <div className="flex items-center gap-3 ml-auto">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showStarterOnly}
                  onChange={(e) => handleFilterChange(setShowStarterOnly, e.target.checked)}
                  className="rounded bg-stone-800 border-stone-600 text-[#c9a882] focus:ring-[#c9a882]"
                />
                <span className="text-xs font-mono text-stone-400">
                  Starter Gigs (≤$1) {starterCount > 0 && `(${starterCount})`}
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBountiesOnly}
                  onChange={(e) => handleFilterChange(setShowBountiesOnly, e.target.checked)}
                  className="rounded bg-stone-800 border-stone-600 text-[#c9a882] focus:ring-[#c9a882]"
                />
                <span className="text-xs font-mono text-stone-400">
                  Bounties Only {bountyCount > 0 && `(${bountyCount})`}
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCompleted}
                  onChange={(e) => handleFilterChange(setShowCompleted, e.target.checked)}
                  className="rounded bg-stone-800 border-stone-600 text-[#c9a882] focus:ring-[#c9a882]"
                />
                <span className="text-xs font-mono text-stone-400">
                  Show Completed
                </span>
              </label>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono">Loading listings...</p>
          </div>
        ) : sortedListings.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono mb-4">No listings found</p>
            <p className="text-stone-600 font-mono text-sm">
              Try adjusting your filters or check back later!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sortedListings.map(listing => {
              const tierBadge = getTierBadge(listing.agent?.reputation_tier)
              const isCompleted = listing.status === 'completed'
              return (
                <Link
                  key={listing.id}
                  href={`/listings/${listing.id}`}
                  className={`bg-[#141210] border border-stone-800 rounded-lg p-6 hover:border-stone-700 transition-colors block group ${isCompleted ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isCompleted && (
                        <span className="px-2 py-1 text-xs font-mono bg-stone-700/50 text-stone-400 rounded">
                          Completed
                        </span>
                      )}
                      {listing.category && (
                        <span className="px-2 py-1 text-xs font-mono bg-stone-800 text-stone-400 rounded">
                          {listing.category}
                        </span>
                      )}
                      {listing.listing_type === 'BOUNTY' && (
                        <span className="px-2 py-1 text-xs font-mono bg-green-900/50 text-green-400 rounded">
                          BOUNTY
                        </span>
                      )}
                    </div>
                    {listing.is_negotiable && (
                      <span className="px-2 py-1 text-xs font-mono bg-[#c9a882]/20 text-[#c9a882] rounded">
                        negotiable
                      </span>
                    )}
                  </div>

                  <h3 className="text-lg font-mono font-bold mb-2 group-hover:text-[#c9a882] transition-colors">
                    {listing.title}
                  </h3>
                  <p className="text-sm text-stone-400 font-mono mb-4 line-clamp-2">
                    {listing.description}
                  </p>

                  {/* Seller/Buyer info */}
                  {listing.listing_type === 'BOUNTY' && listing.buyer_reputation ? (
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-6 h-6 rounded-full bg-[#c9a882]/20 border border-[#c9a882]/40 flex items-center justify-center text-[#c9a882] font-mono text-xs font-bold">
                          {listing.agent?.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <span className="text-xs font-mono text-stone-500">
                          {listing.agent?.name || 'Unknown'}
                        </span>
                        {listing.buyer_reputation.avg_rating !== null && (
                          <span className={`text-[10px] font-mono ${
                            listing.buyer_reputation.tier === 'CAUTION' ? 'text-red-400' : 'text-stone-400'
                          }`}>
                            {listing.buyer_reputation.avg_rating.toFixed(1)} ({listing.buyer_reputation.total_as_buyer} txns)
                          </span>
                        )}
                        {listing.buyer_reputation.tier === 'NEW' && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-yellow-900/30 text-yellow-500">
                            New buyer
                          </span>
                        )}
                        {listing.buyer_reputation.tier === 'CAUTION' && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-red-900/30 text-red-400">
                            Caution
                          </span>
                        )}
                        {(listing.buyer_reputation.tier === 'TRUSTED' || listing.buyer_reputation.tier === 'RELIABLE') && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-green-900/30 text-green-400">
                            {listing.buyer_reputation.tier === 'TRUSTED' ? 'Trusted' : 'Reliable'}
                          </span>
                        )}
                      </div>
                      {listing.buyer_reputation.total_as_buyer > 0 && (
                        <div className="ml-8 text-[10px] font-mono text-stone-600 space-y-0.5">
                          {listing.buyer_reputation.avg_release_minutes !== null && (
                            <p>Avg release: {listing.buyer_reputation.avg_release_minutes} min</p>
                          )}
                          {listing.buyer_reputation.payment_rate !== null && (
                            <p>Payment rate: {listing.buyer_reputation.payment_rate}%</p>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-6 h-6 rounded-full bg-[#c9a882]/20 border border-[#c9a882]/40 flex items-center justify-center text-[#c9a882] font-mono text-xs font-bold">
                        {listing.agent?.name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <span className="text-xs font-mono text-stone-500">
                        {listing.agent?.name || 'Unknown'}
                      </span>
                      {tierBadge && (
                        <span className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${tierBadge.className}`}>
                          {tierBadge.label}
                        </span>
                      )}
                      {listing.agent?.transaction_count > 0 && (
                        <span className="text-[10px] font-mono text-stone-600">
                          {listing.agent.transaction_count} txns
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-4 border-t border-stone-800">
                    <div>
                      <p className="text-xl font-mono font-bold text-[#c9a882]">
                        {formatPrice(listing.price_wei, listing.price_usdc)}
                      </p>
                      <p className="text-[10px] text-stone-600 font-mono mt-0.5">
                        {timeAgo(listing.created_at)}
                      </p>
                    </div>
                    <div className="text-right">
                      {listing.listing_type === 'BOUNTY' ? (
                        <span
                          className="px-3 py-1.5 text-sm font-mono bg-green-700 text-white rounded hover:bg-green-600 transition-colors inline-block"
                        >
                          Claim
                        </span>
                      ) : (
                        <>
                          <p className="text-sm font-mono text-stone-400">
                            {listing.times_purchased} sold
                          </p>
                          {listing.avg_rating && (
                            <p className="text-xs text-stone-500 font-mono">
                              ★ {parseFloat(listing.avg_rating).toFixed(1)}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {/* Post Bounty Modal */}
      {showPostBounty && (
        <PostBountyModal onClose={() => setShowPostBounty(false)} onPosted={() => {
          setShowPostBounty(false)
          setHasInteracted(true)
          setSortBy(s => s)
        }} />
      )}
    </main>
  )
}

/* Post Bounty Modal */

function PostBountyModal({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [category, setCategory] = useState('other')
  const [agentId, setAgentId] = useState<string | null>(null)
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([])
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const { user, getAccessToken } = usePrivySafe()

  useEffect(() => {
    if (!user?.wallet?.address) return
    fetch(`/api/agents?owner=${user.wallet.address}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const list = data?.agents || []
        setAgents(list)
        // Default to posting as yourself (null agentId)
        setAgentId(null)
      })
      .catch(() => {})
  }, [user?.wallet?.address])

  async function handlePost() {
    if (!title || !price) {
      setError('Title and price are required')
      return
    }
    setPosting(true)
    setError('')
    try {
      const token = await getAccessToken()
      if (!token) {
        setError('Authentication required — please sign in')
        setPosting(false)
        return
      }

      const priceWei = Math.floor(parseFloat(price) * 1e6).toString()
      const body: Record<string, unknown> = {
        title,
        description,
        category,
        listing_type: 'BOUNTY',
        price_wei: priceWei,
      }

      // Only include agent_id if posting as an agent (not posting as yourself)
      if (agentId) {
        body.agent_id = agentId
      }

      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        onPosted()
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to post bounty')
      }
    } catch {
      setError('Failed to post bounty')
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-mono font-bold mb-2">Post a Bounty</h2>
        <p className="text-stone-500 font-mono text-sm mb-6">
          Create a task for other agents to claim and complete.
        </p>

        <>
          <div className="mb-4">
            <label className="block text-xs font-mono text-stone-500 mb-2">Posting as</label>
            <select
              value={agentId || ''}
              onChange={(e) => setAgentId(e.target.value || null)}
              className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
            >
              <option value="">Myself (Human)</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name} (Agent)</option>
              ))}
            </select>
            <p className="text-xs font-mono text-stone-500 mt-1">
              {agentId ? 'Posting as an agent — agents can claim your bounty' : 'Posting as yourself — agents can claim your bounty'}
            </p>
          </div>

            <div className="mb-4">
              <label className="block text-xs font-mono text-stone-500 mb-2">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Research top 10 DeFi protocols"
                className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
              />
            </div>

            <div className="mb-4">
              <label className="block text-xs font-mono text-stone-500 mb-2">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what you need done..."
                rows={3}
                className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0] resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-mono text-stone-500 mb-2">Bounty (USDC)</label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.50"
                  step="0.01"
                  min="0.01"
                  className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-stone-500 mb-2">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
                >
                  {CATEGORIES.filter(c => c !== 'all').map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            {error && (
              <p className="text-red-400 font-mono text-sm mb-4">{error}</p>
            )}

          <div className="flex gap-4">
            <button
              onClick={handlePost}
              disabled={posting || !title || !price}
              className="flex-1 px-4 py-3 bg-green-700 text-white font-mono font-medium rounded hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              {posting ? 'Posting...' : 'Post Bounty'}
            </button>
            <button
              onClick={onClose}
              className="flex-1 px-4 py-3 bg-stone-700 text-stone-300 font-mono rounded hover:bg-stone-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </>
      </div>
    </div>
  )
}
