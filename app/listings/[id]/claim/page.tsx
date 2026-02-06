'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Logo } from '@/components/ui/logo'

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
  created_at: string
  is_active: boolean
  agents: {
    id: string
    name: string
    wallet_address: string
  }
}

interface Agent {
  id: string
  name: string
  wallet_address: string
}

function formatPrice(priceWei: string, priceUsdc: string | null): string {
  if (priceUsdc) {
    return `$${parseFloat(priceUsdc).toFixed(2)}`
  }
  const usdc = parseFloat(priceWei) / 1e6
  return `$${usdc.toFixed(2)}`
}

export default function ClaimBountyPage() {
  const params = useParams()
  const router = useRouter()
  const { ready, authenticated, login, user } = usePrivySafe()
  const [listing, setListing] = useState<Listing | null>(null)
  const [userAgents, setUserAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [isClaiming, setIsClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const listingId = params.id as string

  // Fetch listing
  useEffect(() => {
    async function fetchListing() {
      try {
        const res = await fetch(`/api/listings/${listingId}`)
        if (!res.ok) {
          setError('Listing not found')
          return
        }
        const data = await res.json()
        if (data.listing_type !== 'BOUNTY') {
          setError('This listing is not a bounty')
          return
        }
        if (!data.is_active) {
          setError('This bounty is no longer available')
          return
        }
        setListing(data)
      } catch (err) {
        console.error('Failed to fetch listing:', err)
        setError('Failed to load listing')
      } finally {
        setIsLoading(false)
      }
    }

    if (listingId) {
      fetchListing()
    }
  }, [listingId])

  // Fetch user's agents
  useEffect(() => {
    async function fetchUserAgents() {
      if (!user?.wallet?.address) return

      try {
        const res = await fetch(`/api/agents?owner=${user.wallet.address}`)
        if (res.ok) {
          const data = await res.json()
          setUserAgents(data.agents || [])
          if (data.agents?.length === 1) {
            setSelectedAgentId(data.agents[0].id)
          }
        }
      } catch (err) {
        console.error('Failed to fetch user agents:', err)
      }
    }

    if (authenticated && user?.wallet?.address) {
      fetchUserAgents()
    }
  }, [authenticated, user?.wallet?.address])

  async function handleClaim() {
    if (!selectedAgentId || !listing) return

    // Find the selected agent to get its API key
    const selectedAgent = userAgents.find(a => a.id === selectedAgentId)
    if (!selectedAgent) {
      setError('Please select an agent')
      return
    }

    setIsClaiming(true)
    setError(null)

    try {
      // First, get the agent's API key from localStorage or fetch it
      const storedKeys = localStorage.getItem('agent_api_keys')
      let apiKey: string | null = null

      if (storedKeys) {
        const keys = JSON.parse(storedKeys)
        apiKey = keys[selectedAgentId]
      }

      if (!apiKey) {
        setError('No API key found for this agent. Please go to your dashboard to get the API key.')
        setIsClaiming(false)
        return
      }

      const res = await fetch(`/api/listings/${listingId}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to claim bounty')
        return
      }

      // Notify about gas promo if eligible
      if (data.gas_promo_eligible) {
        alert('Bounty claimed! We are sending ~$0.10 ETH to your wallet for gas — enough for 10+ transactions.')
      }

      // Redirect to the transaction page
      router.push(`/transactions/${data.transaction_id}`)
    } catch (err) {
      console.error('Failed to claim bounty:', err)
      setError('Failed to claim bounty')
    } finally {
      setIsClaiming(false)
    }
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
        <header className="border-b border-stone-800 px-3 sm:px-6 py-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <Logo size="md" linkTo="/" />
          </div>
        </header>
        <div className="max-w-2xl mx-auto px-6 py-12">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-stone-800 rounded w-1/2"></div>
            <div className="h-32 bg-stone-800 rounded"></div>
          </div>
        </div>
      </main>
    )
  }

  if (error && !listing) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
        <header className="border-b border-stone-800 px-3 sm:px-6 py-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <Logo size="md" linkTo="/" />
          </div>
        </header>
        <div className="max-w-2xl mx-auto px-6 py-12 text-center">
          <p className="text-xl text-stone-400 mb-4">{error}</p>
          <Link href="/marketplace" className="text-[#c9a882] hover:underline">
            Back to Marketplace
          </Link>
        </div>
      </main>
    )
  }

  if (!listing) return null

  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      <header className="border-b border-stone-800 px-3 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Logo size="md" linkTo="/" />
          <nav className="flex items-center gap-2 sm:gap-6">
            <Link href="/marketplace" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              marketplace
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

      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Breadcrumb */}
        <div className="mb-6">
          <Link href="/marketplace" className="text-sm font-mono text-stone-500 hover:text-[#c9a882]">
            ← Back to Marketplace
          </Link>
        </div>

        <div className="bg-[#141210] border border-stone-800 rounded-lg p-8">
          <div className="flex items-center gap-3 mb-6">
            <span className="px-3 py-1 text-sm font-mono bg-green-900/50 text-green-400 rounded">
              BOUNTY
            </span>
            {listing.category && (
              <span className="px-3 py-1 text-sm font-mono bg-stone-800 text-stone-400 rounded">
                {listing.category}
              </span>
            )}
          </div>

          <h1 className="text-2xl font-mono font-bold mb-4">{listing.title}</h1>

          <p className="text-stone-400 font-mono mb-6">{listing.description}</p>

          <div className="p-4 bg-stone-900/50 rounded-lg mb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-stone-500 font-mono">Bounty Reward</p>
                <p className="text-3xl font-mono font-bold text-green-400">
                  {formatPrice(listing.price_wei, listing.price_usdc)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-stone-500 font-mono">Posted by</p>
                <Link
                  href={`/agents/${listing.agents.id}`}
                  className="text-[#c9a882] hover:underline font-mono"
                >
                  {listing.agents.name}
                </Link>
              </div>
            </div>
          </div>

          {!authenticated ? (
            <div className="text-center py-8 border-t border-stone-800">
              <p className="text-stone-400 font-mono mb-4">Connect your wallet to claim this bounty</p>
              <button
                onClick={login}
                className="px-6 py-3 bg-[#c9a882] text-[#1a1614] font-mono rounded hover:bg-[#d4b896] transition-colors"
              >
                Connect Wallet
              </button>
            </div>
          ) : userAgents.length === 0 ? (
            <div className="text-center py-8 border-t border-stone-800">
              <p className="text-stone-400 font-mono mb-4">You need an agent to claim bounties</p>
              <Link
                href="/agents/create"
                className="px-6 py-3 bg-[#c9a882] text-[#1a1614] font-mono rounded hover:bg-[#d4b896] transition-colors inline-block"
              >
                Create Agent
              </Link>
            </div>
          ) : (
            <div className="border-t border-stone-800 pt-6">
              <h2 className="text-lg font-mono font-bold mb-4">Claim with your agent</h2>

              {userAgents.length > 1 && (
                <div className="mb-4">
                  <label className="block text-sm font-mono text-stone-500 mb-2">
                    Select Agent
                  </label>
                  <select
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    className="w-full px-4 py-3 bg-stone-900 border border-stone-700 rounded font-mono text-white focus:outline-none focus:border-[#c9a882]"
                  >
                    <option value="">Choose an agent...</option>
                    {userAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {userAgents.length === 1 && (
                <p className="text-stone-400 font-mono mb-4">
                  Claiming as <span className="text-[#c9a882]">{userAgents[0].name}</span>
                </p>
              )}

              {error && (
                <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded">
                  <p className="text-red-400 font-mono text-sm">{error}</p>
                </div>
              )}

              <div className="bg-stone-900/50 p-4 rounded-lg mb-6">
                <h3 className="text-sm font-mono font-bold text-stone-300 mb-2">How it works:</h3>
                <ol className="text-sm font-mono text-stone-500 space-y-1">
                  <li>1. You claim the bounty and it gets reserved for you</li>
                  <li>2. The poster&apos;s funds are held in escrow</li>
                  <li>3. Complete the work and deliver your submission</li>
                  <li>4. Once accepted, the bounty is released to you</li>
                </ol>
              </div>

              <button
                onClick={handleClaim}
                disabled={isClaiming || !selectedAgentId}
                className="w-full px-6 py-3 bg-green-700 text-white font-mono rounded hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isClaiming ? 'Claiming...' : 'Claim Bounty'}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
