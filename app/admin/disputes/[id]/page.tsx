'use client'

import { useState, useEffect, use } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface Agent {
  id: string
  name: string
  wallet_address: string
  reputation_score: number | null
  reputation_tier: string | null
  reputation_transactions: number | null
  total_earned_wei: string
  total_spent_wei: string
  created_at: string
}

interface Transaction {
  id: string
  state: string
  disputed: boolean
  disputed_at: string
  dispute_reason: string
  dispute_resolved_at: string | null
  dispute_resolution: string | null
  dispute_resolution_notes: string | null
  dispute_tx_hash: string | null
  amount_wei: string
  price_wei: string
  currency: string
  listing_title: string
  escrow_id: string
  contract_version: number
  deliverable: string | null
  deliverable_hash: string | null
  delivered_at: string | null
  created_at: string
  buyer: Agent
  seller: Agent
}

interface Message {
  id: string
  from_agent_id: string
  to_agent_id: string
  content: string
  created_at: string
}

interface DisputeData {
  transaction: Transaction
  messages: Message[]
  listing: Record<string, unknown> | null
}

function formatUSDC(wei: string): string {
  const usdc = parseFloat(wei) / 1e6
  return `$${usdc.toFixed(2)}`
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export default function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { user, authenticated } = usePrivy()
  const router = useRouter()
  const [data, setData] = useState<DisputeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolutionNotes, setResolutionNotes] = useState('')

  const walletAddress = user?.wallet?.address?.toLowerCase()

  useEffect(() => {
    if (!authenticated || !walletAddress) return

    async function fetchDispute() {
      setLoading(true)
      try {
        const response = await fetch(`/api/admin/disputes/${id}`, {
          headers: {
            'x-admin-wallet': walletAddress!,
          },
        })

        if (!response.ok) {
          if (response.status === 403) {
            setError('Admin access required')
          } else if (response.status === 404) {
            setError('Dispute not found')
          } else {
            setError('Failed to load dispute')
          }
          return
        }

        const disputeData = await response.json()
        setData(disputeData)
      } catch (err) {
        setError('Failed to load dispute')
      } finally {
        setLoading(false)
      }
    }

    fetchDispute()
  }, [authenticated, walletAddress, id])

  async function handleResolve(releaseToSeller: boolean) {
    if (!walletAddress || resolving) return

    const action = releaseToSeller ? 'release funds to seller' : 'refund funds to buyer'
    if (!confirm(`Are you sure you want to ${action}? This action cannot be undone.`)) {
      return
    }

    setResolving(true)

    try {
      const response = await fetch(`/api/admin/disputes/${id}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-wallet': walletAddress,
        },
        body: JSON.stringify({
          release_to_seller: releaseToSeller,
          resolution_notes: resolutionNotes || null,
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        alert(`Failed to resolve: ${result.error}`)
        return
      }

      alert(`Dispute resolved successfully!\n\nTransaction hash: ${result.tx_hash}`)
      router.push('/admin/disputes')
    } catch (err) {
      alert('Failed to resolve dispute')
    } finally {
      setResolving(false)
    }
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-100 p-8">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-2xl font-bold mb-4">Admin Access Required</h1>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-100 p-8">
        <div className="max-w-4xl mx-auto text-center py-12">
          <div className="animate-spin h-8 w-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto" />
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-100 p-8">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-2xl font-bold mb-4">{error || 'Dispute not found'}</h1>
          <Link href="/admin/disputes" className="text-amber-500 hover:underline">
            Back to disputes
          </Link>
        </div>
      </div>
    )
  }

  const { transaction, messages } = data
  const isResolved = !!transaction.dispute_resolved_at

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Link href="/admin/disputes" className="text-stone-400 hover:text-stone-300 text-sm mb-4 inline-block">
            &larr; Back to disputes
          </Link>
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold">{transaction.listing_title || 'Untitled Transaction'}</h1>
              <p className="text-stone-400 mt-1">
                Disputed on {formatDate(transaction.disputed_at)}
              </p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-amber-500">
                {formatUSDC(transaction.amount_wei || transaction.price_wei)}
              </div>
              <span className={`px-2 py-1 text-sm rounded ${
                isResolved
                  ? 'bg-green-900/50 text-green-400'
                  : 'bg-yellow-900/50 text-yellow-400'
              }`}>
                {isResolved ? transaction.dispute_resolution : 'PENDING'}
              </span>
            </div>
          </div>
        </div>

        {/* Dispute Reason */}
        <div className="bg-stone-900 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold mb-3">Dispute Reason</h2>
          <p className="text-stone-300 whitespace-pre-wrap">{transaction.dispute_reason}</p>
        </div>

        {/* Parties */}
        <div className="grid grid-cols-2 gap-6 mb-6">
          {/* Buyer */}
          <div className="bg-stone-900 rounded-lg p-6">
            <h3 className="text-sm text-stone-400 mb-2">Buyer</h3>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-semibold">{transaction.buyer?.name || 'Unknown'}</span>
              <span className={`px-1.5 py-0.5 text-xs rounded ${getTierBadge(transaction.buyer?.reputation_tier)}`}>
                {transaction.buyer?.reputation_tier || 'NEW'}
              </span>
            </div>
            <div className="text-sm text-stone-400 space-y-1">
              <p>Wallet: {truncateAddress(transaction.buyer?.wallet_address || '')}</p>
              <p>Score: {transaction.buyer?.reputation_score?.toFixed(2) || 'N/A'}</p>
              <p>Transactions: {transaction.buyer?.reputation_transactions || 0}</p>
              <p>Total Spent: {formatUSDC(transaction.buyer?.total_spent_wei || '0')}</p>
            </div>
          </div>

          {/* Seller */}
          <div className="bg-stone-900 rounded-lg p-6">
            <h3 className="text-sm text-stone-400 mb-2">Seller</h3>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-semibold">{transaction.seller?.name || 'Unknown'}</span>
              <span className={`px-1.5 py-0.5 text-xs rounded ${getTierBadge(transaction.seller?.reputation_tier)}`}>
                {transaction.seller?.reputation_tier || 'NEW'}
              </span>
            </div>
            <div className="text-sm text-stone-400 space-y-1">
              <p>Wallet: {truncateAddress(transaction.seller?.wallet_address || '')}</p>
              <p>Score: {transaction.seller?.reputation_score?.toFixed(2) || 'N/A'}</p>
              <p>Transactions: {transaction.seller?.reputation_transactions || 0}</p>
              <p>Total Earned: {formatUSDC(transaction.seller?.total_earned_wei || '0')}</p>
            </div>
          </div>
        </div>

        {/* Deliverable */}
        {transaction.deliverable && (
          <div className="bg-stone-900 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold mb-3">Deliverable</h2>
            <p className="text-stone-300 whitespace-pre-wrap text-sm bg-stone-800 p-4 rounded">
              {transaction.deliverable}
            </p>
            {transaction.deliverable_hash && (
              <p className="text-stone-500 text-xs mt-2">
                Hash: {transaction.deliverable_hash}
              </p>
            )}
            {transaction.delivered_at && (
              <p className="text-stone-500 text-xs mt-1">
                Delivered: {formatDate(transaction.delivered_at)}
              </p>
            )}
          </div>
        )}

        {/* Messages */}
        {messages.length > 0 && (
          <div className="bg-stone-900 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold mb-3">Message History</h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {messages.map((msg) => {
                const isBuyer = msg.from_agent_id === transaction.buyer?.id
                return (
                  <div
                    key={msg.id}
                    className={`p-3 rounded ${isBuyer ? 'bg-blue-900/30' : 'bg-green-900/30'}`}
                  >
                    <div className="flex justify-between text-xs text-stone-400 mb-1">
                      <span>{isBuyer ? 'Buyer' : 'Seller'}</span>
                      <span>{formatDate(msg.created_at)}</span>
                    </div>
                    <p className="text-sm text-stone-300">{msg.content}</p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Transaction Details */}
        <div className="bg-stone-900 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold mb-3">Transaction Details</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-stone-400">Transaction ID:</span>
              <p className="text-stone-300 font-mono text-xs">{transaction.id}</p>
            </div>
            <div>
              <span className="text-stone-400">Escrow ID:</span>
              <p className="text-stone-300 font-mono text-xs">{transaction.escrow_id || 'N/A'}</p>
            </div>
            <div>
              <span className="text-stone-400">Contract Version:</span>
              <p className="text-stone-300">V{transaction.contract_version}</p>
            </div>
            <div>
              <span className="text-stone-400">Current State:</span>
              <p className="text-stone-300">{transaction.state}</p>
            </div>
            <div>
              <span className="text-stone-400">Created:</span>
              <p className="text-stone-300">{formatDate(transaction.created_at)}</p>
            </div>
            <div>
              <span className="text-stone-400">Currency:</span>
              <p className="text-stone-300">{transaction.currency || 'USDC'}</p>
            </div>
          </div>
        </div>

        {/* Resolution Section */}
        {!isResolved ? (
          <div className="bg-stone-900 rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Resolve Dispute</h2>

            <div className="mb-4">
              <label className="block text-sm text-stone-400 mb-2">Resolution Notes (optional)</label>
              <textarea
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                className="w-full bg-stone-800 border border-stone-700 rounded p-3 text-stone-100 text-sm"
                rows={3}
                placeholder="Add notes about your decision..."
              />
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => handleResolve(true)}
                disabled={resolving}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:cursor-not-allowed text-white font-medium py-3 px-6 rounded transition-colors"
              >
                {resolving ? 'Processing...' : 'Release to Seller'}
              </button>
              <button
                onClick={() => handleResolve(false)}
                disabled={resolving}
                className="flex-1 bg-red-600 hover:bg-red-700 disabled:bg-red-800 disabled:cursor-not-allowed text-white font-medium py-3 px-6 rounded transition-colors"
              >
                {resolving ? 'Processing...' : 'Refund to Buyer'}
              </button>
            </div>

            <p className="text-stone-500 text-xs mt-4 text-center">
              This will call resolveDispute() on the V2 contract via the oracle wallet.
            </p>
          </div>
        ) : (
          <div className="bg-stone-900 rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Resolution Details</h2>
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-stone-400">Outcome: </span>
                <span className={transaction.dispute_resolution === 'SELLER_WINS' ? 'text-green-400' : 'text-red-400'}>
                  {transaction.dispute_resolution}
                </span>
              </p>
              <p>
                <span className="text-stone-400">Resolved: </span>
                <span className="text-stone-300">{formatDate(transaction.dispute_resolved_at!)}</span>
              </p>
              {transaction.dispute_resolution_notes && (
                <p>
                  <span className="text-stone-400">Notes: </span>
                  <span className="text-stone-300">{transaction.dispute_resolution_notes}</span>
                </p>
              )}
              {transaction.dispute_tx_hash && (
                <p>
                  <span className="text-stone-400">Transaction: </span>
                  <a
                    href={`https://basescan.org/tx/${transaction.dispute_tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-amber-500 hover:underline font-mono text-xs"
                  >
                    {transaction.dispute_tx_hash.slice(0, 10)}...
                  </a>
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
