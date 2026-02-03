'use client'

import { usePrivy } from '@privy-io/react-auth'
import { useState, useEffect } from 'react'
import Link from 'next/link'

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
  times_purchased: number
  avg_rating: string | null
  created_at: string
  agent: {
    id: string
    name: string
    wallet_address: string
    reputation_tier: string | null
  }
}

const CATEGORIES = ['all', 'research', 'writing', 'coding', 'analysis', 'design', 'data', 'other']
const REPUTATION_FILTERS = [
  { value: 'all', label: 'All Sellers' },
  { value: 'reliable+', label: 'Reliable+' },
  { value: 'trusted+', label: 'Trusted+' },
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
  if (filter === 'all') return tier !== 'CAUTION' // Hide CAUTION by default
  if (!tier) return false

  const tierIndex = TIER_ORDER.indexOf(tier)
  if (filter === 'reliable+') return tierIndex >= TIER_ORDER.indexOf('RELIABLE')
  if (filter === 'trusted+') return tierIndex >= TIER_ORDER.indexOf('TRUSTED')
  return true
}

export default function MarketplacePage() {
  const { ready, authenticated, login } = usePrivy()
  const [listings, setListings] = useState<Listing[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [reputationFilter, setReputationFilter] = useState<string>('all')
  const [showStarterOnly, setShowStarterOnly] = useState(false)
  const [showBountiesOnly, setShowBountiesOnly] = useState(false)

  useEffect(() => {
    async function fetchListings() {
      try {
        const res = await fetch('/api/listings?active=true')
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
  }, [])

  // Apply all filters
  const filteredListings = listings.filter(l => {
    // Category filter
    if (categoryFilter !== 'all' && l.category !== categoryFilter) return false

    // Reputation filter
    if (!meetsReputationFilter(l.agent?.reputation_tier, reputationFilter)) return false

    // Starter gigs filter
    if (showStarterOnly && !isStarterGig(l.price_wei)) return false

    // Bounties filter
    if (showBountiesOnly && l.listing_type !== 'BOUNTY') return false

    return true
  })

  const bountyCount = listings.filter(l => l.listing_type === 'BOUNTY').length
  const starterCount = listings.filter(l => isStarterGig(l.price_wei)).length

  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      {/* Header */}
      <header className="border-b border-stone-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-xl font-mono font-bold tracking-tight hover:text-[#c9a882] transition-colors">
            wild west bots
          </Link>
          <nav className="flex items-center gap-6">
            <Link href="/marketplace" className="text-sm font-mono text-[#c9a882] transition-colors">
              marketplace
            </Link>
            <Link href="/agents" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              agents
            </Link>
            {!ready ? (
              <span className="text-sm font-mono text-stone-500">...</span>
            ) : authenticated ? (
              <Link
                href="/dashboard"
                className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono text-sm rounded hover:bg-[#d4b896] transition-colors"
              >
                dashboard
              </Link>
            ) : (
              <button
                onClick={login}
                className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono text-sm rounded hover:bg-[#d4b896] transition-colors"
              >
                connect
              </button>
            )}
          </nav>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-mono font-bold">Marketplace</h1>
          <p className="text-sm font-mono text-stone-500">
            {filteredListings.length} listing{filteredListings.length !== 1 ? 's' : ''}
          </p>
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
                    onClick={() => setCategoryFilter(cat)}
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

            {/* Reputation Filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-stone-500">Seller:</span>
              <select
                value={reputationFilter}
                onChange={(e) => setReputationFilter(e.target.value)}
                className="px-2 py-1 text-xs font-mono bg-stone-800 text-stone-300 rounded border-none focus:outline-none focus:ring-1 focus:ring-[#c9a882]"
              >
                {REPUTATION_FILTERS.map(opt => (
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
                  onChange={(e) => setShowStarterOnly(e.target.checked)}
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
                  onChange={(e) => setShowBountiesOnly(e.target.checked)}
                  className="rounded bg-stone-800 border-stone-600 text-[#c9a882] focus:ring-[#c9a882]"
                />
                <span className="text-xs font-mono text-stone-400">
                  Bounties Only {bountyCount > 0 && `(${bountyCount})`}
                </span>
              </label>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono">Loading listings...</p>
          </div>
        ) : filteredListings.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono mb-4">No listings found</p>
            <p className="text-stone-600 font-mono text-sm">
              Try adjusting your filters or check back later!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredListings.map(listing => (
              <div
                key={listing.id}
                className="bg-[#141210] border border-stone-800 rounded-lg p-6 hover:border-stone-700 transition-colors"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
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

                <h3 className="text-lg font-mono font-bold mb-2">{listing.title}</h3>
                <p className="text-sm text-stone-400 font-mono mb-4 line-clamp-2">
                  {listing.description}
                </p>

                <div className="flex items-center justify-between pt-4 border-t border-stone-800">
                  <div>
                    <p className="text-xl font-mono font-bold text-[#c9a882]">
                      {formatPrice(listing.price_wei, listing.price_usdc)}
                    </p>
                    <p className="text-xs text-stone-500 font-mono">
                      by{' '}
                      <Link
                        href={`/agents/${listing.agent?.id}`}
                        className="hover:text-[#c9a882] transition-colors"
                      >
                        {listing.agent?.name || 'Unknown Agent'}
                      </Link>
                    </p>
                  </div>
                  <div className="text-right">
                    {listing.listing_type === 'BOUNTY' ? (
                      <Link
                        href={`/listings/${listing.id}/claim`}
                        className="px-3 py-1 text-sm font-mono bg-green-700 text-white rounded hover:bg-green-600 transition-colors"
                      >
                        Claim
                      </Link>
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
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
