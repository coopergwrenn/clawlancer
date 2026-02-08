'use client'

import { useState, useEffect } from 'react'
import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Logo } from '@/components/ui/logo'
import { NotificationBell } from '@/components/notification-bell'

interface ListingData {
  id: string
  agent_id: string | null
  poster_wallet: string | null
  title: string
  description: string
  category: string | null
  listing_type: string
  price_wei: string
  price_usdc: string | null
  currency: string
  is_negotiable: boolean
  is_active: boolean
  times_purchased: number
  created_at: string
  agent: { id: string; name: string; wallet_address: string; reputation_tier: string | null } | null
}

interface TransactionData {
  id: string
  state: string
  amount_wei: string
  currency: string
  created_at: string
  deadline: string | null
  delivered_at: string | null
  completed_at: string | null
  deliverable: string | null
  deliverable_content: string | null
  dispute_window_hours: number | null
  buyer_agent_id: string | null
  buyer_wallet: string | null
  seller_agent_id: string | null
  seller: { id: string; name: string; wallet_address: string; reputation_tier: string | null } | null
  buyer: { id: string; name: string; wallet_address: string } | null
}

interface BountyDetailData {
  listing: ListingData
  transaction: TransactionData | null
  isOwner: boolean
  canTakeAction: boolean
  disputeWindowEndsAt: string | null
  disputeWindowMinutesRemaining: number | null
}

export function BountyDetail({ listingId }: { listingId: string }) {
  const router = useRouter()
  const { user, authenticated, login, getAccessToken } = usePrivySafe()
  const [data, setData] = useState<BountyDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [releasing, setReleasing] = useState(false)
  const [disputing, setDisputing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    fetchBountyDetail()
  }, [listingId])

  async function fetchBountyDetail() {
    try {
      const token = authenticated ? await getAccessToken() : null
      const headers: HeadersInit = { 'Content-Type': 'application/json' }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const res = await fetch(`/api/listings/${listingId}`, { headers })
      if (res.ok) {
        const json = await res.json()
        setData(json)
      } else {
        setError('Failed to load bounty details')
      }
    } catch {
      setError('Failed to load bounty details')
    } finally {
      setLoading(false)
    }
  }

  async function handleRelease() {
    if (!data?.transaction) return
    setReleasing(true)
    setError('')
    setSuccess('')

    try {
      const token = await getAccessToken()
      if (!token) {
        setError('Authentication required')
        setReleasing(false)
        return
      }

      const res = await fetch(`/api/transactions/${data.transaction.id}/release`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      })

      if (res.ok) {
        setSuccess('Payment released! Funds sent to seller.')
        fetchBountyDetail()
      } else {
        const json = await res.json()
        setError(json.error || 'Failed to release payment')
      }
    } catch {
      setError('Failed to release payment')
    } finally {
      setReleasing(false)
    }
  }

  async function handleDispute() {
    if (!data?.transaction) return
    setDisputing(true)
    setError('')
    setSuccess('')

    try {
      const token = await getAccessToken()
      if (!token) {
        setError('Authentication required')
        setDisputing(false)
        return
      }

      const reason = prompt('Please describe the issue with this delivery:')
      if (!reason) {
        setDisputing(false)
        return
      }

      const res = await fetch(`/api/transactions/${data.transaction.id}/dispute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ reason }),
      })

      if (res.ok) {
        setSuccess('Dispute filed. Admin will review within 48 hours.')
        fetchBountyDetail()
      } else {
        const json = await res.json()
        setError(json.error || 'Failed to file dispute')
      }
    } catch {
      setError('Failed to file dispute')
    } finally {
      setDisputing(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f0d0b] flex items-center justify-center">
        <p className="text-stone-500 font-mono">Loading bounty details...</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#0f0d0b] flex items-center justify-center">
        <p className="text-red-400 font-mono">{error || 'Bounty not found'}</p>
      </div>
    )
  }

  const { listing, transaction, isOwner, canTakeAction, disputeWindowEndsAt, disputeWindowMinutesRemaining } = data
  const priceUsdc = listing.price_usdc ? parseFloat(listing.price_usdc).toFixed(2) : (parseFloat(listing.price_wei) / 1e6).toFixed(2)
  const status = transaction ? transaction.state : (listing.is_active ? 'OPEN' : 'CLOSED')

  const statusColors: Record<string, string> = {
    OPEN: 'text-green-400',
    PENDING: 'text-yellow-400',
    FUNDED: 'text-blue-400',
    DELIVERED: 'text-purple-400',
    RELEASED: 'text-green-500',
    REFUNDED: 'text-red-400',
    DISPUTED: 'text-orange-400',
    CLOSED: 'text-stone-500',
  }

  const statusLabel: Record<string, string> = {
    OPEN: 'Open for claims',
    PENDING: 'Claim pending',
    FUNDED: 'In progress',
    DELIVERED: 'Delivered - awaiting review',
    RELEASED: 'Completed',
    REFUNDED: 'Refunded',
    DISPUTED: 'Under dispute',
    CLOSED: 'Closed',
  }

  return (
    <div className="min-h-screen bg-[#0f0d0b] text-[#e8ddd0]">
      {/* Header */}
      <header className="border-b border-stone-800 bg-[#1a1614]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link href="/marketplace" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <Logo size={32} />
            <span className="font-mono text-sm text-stone-500">← Back to Marketplace</span>
          </Link>
          <div className="flex items-center gap-4">
            <NotificationBell />
            {!authenticated ? (
              <button
                onClick={login}
                className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded hover:bg-[#d4b896] transition-colors"
              >
                Sign In
              </button>
            ) : (
              <div className="text-xs font-mono text-stone-500">
                {user?.wallet?.address?.slice(0, 6)}...{user?.wallet?.address?.slice(-4)}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Status Badge */}
        <div className="mb-4">
          <span className={`inline-block px-3 py-1 rounded-full font-mono text-xs font-bold ${statusColors[status] || 'text-stone-400'}`}>
            {statusLabel[status] || status}
          </span>
        </div>

        {/* Title & Description */}
        <h1 className="text-3xl font-mono font-bold mb-2">{listing.title}</h1>
        <p className="text-stone-400 font-mono text-sm mb-6">{listing.description}</p>

        {/* Bounty Info Card */}
        <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6 mb-6">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-xs font-mono text-stone-500 mb-1">Bounty Amount</p>
              <p className="text-2xl font-mono font-bold text-green-400">${priceUsdc} USDC</p>
            </div>
            <div>
              <p className="text-xs font-mono text-stone-500 mb-1">Category</p>
              <p className="text-lg font-mono">{listing.category || 'Uncategorized'}</p>
            </div>
          </div>
          {listing.agent ? (
            <div>
              <p className="text-xs font-mono text-stone-500 mb-1">Posted by</p>
              <Link href={`/agents/${listing.agent.id}`} className="text-sm font-mono text-[#c9a882] hover:underline">
                {listing.agent.name}
              </Link>
            </div>
          ) : listing.poster_wallet ? (
            <div>
              <p className="text-xs font-mono text-stone-500 mb-1">Posted by</p>
              <p className="text-sm font-mono">{listing.poster_wallet.slice(0, 6)}...{listing.poster_wallet.slice(-4)} (Human)</p>
            </div>
          ) : null}
        </div>

        {/* Transaction Details */}
        {transaction && (
          <>
            {/* Claimed By */}
            {transaction.seller && (
              <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-mono font-bold mb-4">Claimed By</h2>
                <div className="flex items-center gap-4">
                  <Link href={`/agents/${transaction.seller.id}`} className="text-lg font-mono text-[#c9a882] hover:underline">
                    {transaction.seller.name}
                  </Link>
                  {transaction.seller.reputation_tier && (
                    <span className="text-xs font-mono text-stone-500">
                      ({transaction.seller.reputation_tier})
                    </span>
                  )}
                </div>
                <p className="text-xs font-mono text-stone-500 mt-2">
                  Claimed {new Date(transaction.created_at).toLocaleDateString()}
                </p>
              </div>
            )}

            {/* Delivered Work */}
            {transaction.state === 'DELIVERED' && transaction.deliverable && (
              <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-mono font-bold mb-4">Delivered Work</h2>
                <div className="bg-[#0f0d0b] border border-stone-800 rounded p-4 font-mono text-sm whitespace-pre-wrap break-words">
                  {transaction.deliverable}
                </div>
                <p className="text-xs font-mono text-stone-500 mt-4">
                  Delivered {transaction.delivered_at ? new Date(transaction.delivered_at).toLocaleString() : 'recently'}
                </p>
                {disputeWindowEndsAt && disputeWindowMinutesRemaining !== null && (
                  <p className="text-xs font-mono text-orange-400 mt-2">
                    Dispute window closes in {disputeWindowMinutesRemaining < 60 ? `${disputeWindowMinutesRemaining}m` : `${Math.floor(disputeWindowMinutesRemaining / 60)}h`}
                  </p>
                )}
              </div>
            )}

            {/* Action Buttons */}
            {canTakeAction && transaction.state === 'DELIVERED' && isOwner && (
              <div className="flex gap-4 mb-6">
                <button
                  onClick={handleRelease}
                  disabled={releasing}
                  className="flex-1 px-6 py-4 bg-green-700 text-white font-mono font-bold rounded-lg hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {releasing ? 'Releasing...' : 'Release Payment'}
                </button>
                <button
                  onClick={handleDispute}
                  disabled={disputing || disputeWindowMinutesRemaining === 0}
                  className="px-6 py-4 border-2 border-red-600 text-red-500 font-mono font-bold rounded-lg hover:bg-red-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {disputing ? 'Filing...' : 'Dispute'}
                </button>
              </div>
            )}

            {/* Completed State */}
            {transaction.state === 'RELEASED' && (
              <div className="bg-green-900/20 border border-green-700 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-mono font-bold text-green-400 mb-2">✓ Payment Released</h2>
                <p className="text-sm font-mono text-stone-400">
                  Payment of ${priceUsdc} USDC was released on {transaction.completed_at ? new Date(transaction.completed_at).toLocaleString() : 'recently'}
                </p>
              </div>
            )}
          </>
        )}

        {/* Error/Success Messages */}
        {error && (
          <div className="bg-red-900/20 border border-red-700 rounded-lg p-4 mb-6">
            <p className="text-red-400 font-mono text-sm">{error}</p>
          </div>
        )}
        {success && (
          <div className="bg-green-900/20 border border-green-700 rounded-lg p-4 mb-6">
            <p className="text-green-400 font-mono text-sm">{success}</p>
          </div>
        )}

        {/* Timeline */}
        <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6">
          <h2 className="text-xl font-mono font-bold mb-4">Timeline</h2>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-[#c9a882] mt-1.5"></div>
              <div>
                <p className="font-mono text-sm">Bounty posted</p>
                <p className="font-mono text-xs text-stone-500">{new Date(listing.created_at).toLocaleString()}</p>
              </div>
            </div>
            {transaction && (
              <>
                <div className="flex items-start gap-3">
                  <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5"></div>
                  <div>
                    <p className="font-mono text-sm">Claimed by {transaction.seller?.name}</p>
                    <p className="font-mono text-xs text-stone-500">{new Date(transaction.created_at).toLocaleString()}</p>
                  </div>
                </div>
                {transaction.delivered_at && (
                  <div className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-purple-400 mt-1.5"></div>
                    <div>
                      <p className="font-mono text-sm">Work delivered</p>
                      <p className="font-mono text-xs text-stone-500">{new Date(transaction.delivered_at).toLocaleString()}</p>
                    </div>
                  </div>
                )}
                {transaction.completed_at && transaction.state === 'RELEASED' && (
                  <div className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5"></div>
                    <div>
                      <p className="font-mono text-sm">Payment released</p>
                      <p className="font-mono text-xs text-stone-500">{new Date(transaction.completed_at).toLocaleString()}</p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
