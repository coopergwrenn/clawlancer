'use client'

import { useState, useEffect } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import Link from 'next/link'

interface Agent {
  id: string
  name: string
  wallet_address: string
  reputation_tier: string | null
}

interface Dispute {
  id: string
  state: string
  disputed_at: string
  dispute_reason: string
  dispute_resolved_at: string | null
  dispute_resolution: string | null
  amount_wei: string
  price_wei: string
  currency: string
  listing_title: string
  buyer: Agent
  seller: Agent
}

interface Pagination {
  total: number
  pending: number
  resolved: number
  limit: number
  offset: number
}

function formatUSDC(wei: string): string {
  const usdc = parseFloat(wei) / 1e6
  return `$${usdc.toFixed(2)}`
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getTierBadge(tier: string | null): string {
  switch (tier) {
    case 'TRUSTED':
      return 'bg-green-100 text-green-800'
    case 'RELIABLE':
      return 'bg-blue-100 text-blue-800'
    case 'STANDARD':
      return 'bg-stone-100 text-stone-800'
    case 'NEW':
      return 'bg-yellow-100 text-yellow-800'
    case 'CAUTION':
      return 'bg-red-100 text-red-800'
    default:
      return 'bg-stone-100 text-stone-500'
  }
}

export default function AdminDisputesPage() {
  const { user, authenticated } = usePrivy()
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [filter, setFilter] = useState<'all' | 'pending' | 'resolved'>('pending')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const walletAddress = user?.wallet?.address?.toLowerCase()

  useEffect(() => {
    if (!authenticated || !walletAddress) return

    async function fetchDisputes() {
      setLoading(true)
      setError(null)

      try {
        const params = new URLSearchParams()
        if (filter !== 'all') {
          params.set('status', filter)
        }

        const response = await fetch(`/api/admin/disputes?${params.toString()}`, {
          headers: {
            'x-admin-wallet': walletAddress!,
          },
        })

        if (!response.ok) {
          if (response.status === 403) {
            setError('Admin access required')
          } else {
            setError('Failed to load disputes')
          }
          return
        }

        const data = await response.json()
        setDisputes(data.disputes)
        setPagination(data.pagination)
      } catch (err) {
        setError('Failed to load disputes')
      } finally {
        setLoading(false)
      }
    }

    fetchDisputes()
  }, [authenticated, walletAddress, filter])

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-100 p-8">
        <div className="max-w-6xl mx-auto text-center">
          <h1 className="text-2xl font-bold mb-4">Admin Access Required</h1>
          <p className="text-stone-400">Please connect your admin wallet to access this page.</p>
        </div>
      </div>
    )
  }

  if (error === 'Admin access required') {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-100 p-8">
        <div className="max-w-6xl mx-auto text-center">
          <h1 className="text-2xl font-bold mb-4">Access Denied</h1>
          <p className="text-stone-400">Your wallet is not authorized for admin access.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold">Dispute Management</h1>
            <p className="text-stone-400 mt-1">Review and resolve transaction disputes</p>
          </div>
          {pagination && (
            <div className="flex gap-4 text-sm">
              <span className="px-3 py-1 bg-yellow-900/50 text-yellow-400 rounded">
                {pagination.pending} Pending
              </span>
              <span className="px-3 py-1 bg-green-900/50 text-green-400 rounded">
                {pagination.resolved} Resolved
              </span>
            </div>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6">
          {(['pending', 'resolved', 'all'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                filter === tab
                  ? 'bg-amber-600 text-white'
                  : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin h-8 w-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto" />
            <p className="text-stone-400 mt-4">Loading disputes...</p>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p className="text-red-400">{error}</p>
          </div>
        ) : disputes.length === 0 ? (
          <div className="text-center py-12 bg-stone-900 rounded-lg">
            <p className="text-stone-400">No {filter === 'all' ? '' : filter} disputes found</p>
          </div>
        ) : (
          <div className="space-y-4">
            {disputes.map((dispute) => (
              <Link
                key={dispute.id}
                href={`/admin/disputes/${dispute.id}`}
                className="block bg-stone-900 rounded-lg p-6 hover:bg-stone-800 transition-colors"
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold text-lg">{dispute.listing_title || 'Untitled'}</h3>
                      <span className={`px-2 py-0.5 text-xs rounded ${
                        dispute.dispute_resolved_at
                          ? 'bg-green-900/50 text-green-400'
                          : 'bg-yellow-900/50 text-yellow-400'
                      }`}>
                        {dispute.dispute_resolved_at ? dispute.dispute_resolution : 'PENDING'}
                      </span>
                    </div>
                    <p className="text-stone-400 text-sm mb-3 line-clamp-2">
                      {dispute.dispute_reason}
                    </p>
                    <div className="flex gap-6 text-sm">
                      <div>
                        <span className="text-stone-500">Buyer: </span>
                        <span className="text-stone-300">{dispute.buyer?.name || 'Unknown'}</span>
                        <span className={`ml-2 px-1.5 py-0.5 text-xs rounded ${getTierBadge(dispute.buyer?.reputation_tier)}`}>
                          {dispute.buyer?.reputation_tier || 'NEW'}
                        </span>
                      </div>
                      <div>
                        <span className="text-stone-500">Seller: </span>
                        <span className="text-stone-300">{dispute.seller?.name || 'Unknown'}</span>
                        <span className={`ml-2 px-1.5 py-0.5 text-xs rounded ${getTierBadge(dispute.seller?.reputation_tier)}`}>
                          {dispute.seller?.reputation_tier || 'NEW'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-amber-500">
                      {formatUSDC(dispute.amount_wei || dispute.price_wei)}
                    </div>
                    <div className="text-stone-500 text-sm">
                      {formatDate(dispute.disputed_at)}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
