'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ViewCardButton } from '@/components/agent-card-modal'
import { Logo } from '@/components/ui/logo'
import { MessagesSection } from '@/components/dashboard/messages-section'

interface Agent {
  id: string
  name: string
  wallet_address: string
  is_hosted: boolean
  is_active: boolean
  is_paused: boolean
  privy_wallet_id: string | null
  total_earned_wei: string
  total_spent_wei: string
  transaction_count: number
  created_at: string
}

interface Transaction {
  id: string
  amount_wei: string
  description: string | null
  state: string
  created_at: string
  buyer: { id: string; name: string } | null
  seller: { id: string; name: string } | null
  listing: { id: string; title: string } | null
}

interface Listing {
  id: string
  title: string
  description: string
  price_wei: string
  price_usdc: string | null
  category: string | null
  listing_type: 'FIXED' | 'BOUNTY'
  is_active: boolean
  is_negotiable: boolean
  times_purchased: number
  created_at: string
  agent_id: string
}

interface Notification {
  id: string
  type: string
  title: string
  message: string
  read: boolean
  created_at: string
  related_transaction_id: string | null
}

function formatUSDC(wei: string): string {
  const usdc = parseFloat(wei) / 1e6
  return `$${usdc.toFixed(2)}`
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function getStateColor(state: string): string {
  switch (state.toUpperCase()) {
    case 'RELEASED':
    case 'COMPLETED':
      return 'text-green-500'
    case 'PENDING':
      return 'text-yellow-500'
    case 'ESCROWED':
    case 'FUNDED':
      return 'text-blue-500'
    case 'DELIVERED':
      return 'text-purple-500'
    case 'REFUNDED':
      return 'text-red-500'
    case 'DISPUTED':
      return 'text-orange-500'
    default:
      return 'text-stone-500'
  }
}

export default function DashboardPage() {
  const { ready, authenticated, login, user, logout } = usePrivySafe()
  const [agents, setAgents] = useState<Agent[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [listings, setListings] = useState<Listing[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'agents' | 'listings' | 'transactions' | 'messages'>('agents')
  const [showNotifications, setShowNotifications] = useState(false)
  const [showWithdrawModal, setShowWithdrawModal] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [walletBalance, setWalletBalance] = useState<string | null>(null)
  const [withdrawAddress, setWithdrawAddress] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [editingListing, setEditingListing] = useState<Listing | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [savingListing, setSavingListing] = useState(false)

  useEffect(() => {
    if (!authenticated || !user?.wallet?.address) {
      setIsLoading(false)
      return
    }

    async function fetchData() {
      try {
        const [agentsRes, txRes, listingsRes, notifRes] = await Promise.all([
          fetch(`/api/agents?owner=${user?.wallet?.address}`),
          fetch(`/api/transactions?owner=${user?.wallet?.address}`),
          fetch(`/api/listings?owner=${user?.wallet?.address}`),
          fetch('/api/notifications').catch(() => null),
        ])

        if (agentsRes.ok) {
          const data = await agentsRes.json()
          setAgents(data.agents || [])
        }

        if (txRes.ok) {
          const data = await txRes.json()
          setTransactions(data.transactions || [])
        }

        if (listingsRes.ok) {
          const data = await listingsRes.json()
          setListings(data.listings || [])
        }

        if (notifRes?.ok) {
          const data = await notifRes.json()
          setNotifications(data.notifications || [])
          setUnreadCount(data.unread_count || 0)
        }
      } catch (error) {
        console.error('Failed to fetch data:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchData()
  }, [authenticated, user?.wallet?.address])

  // Fetch wallet balance when withdraw modal opens
  useEffect(() => {
    if (showWithdrawModal && selectedAgent) {
      fetch(`/api/wallet/balance?agent_id=${selectedAgent.id}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data) setWalletBalance(data.balance_wei)
        })
        .catch(() => setWalletBalance(null))
    }
  }, [showWithdrawModal, selectedAgent])

  async function handleWithdraw() {
    if (!selectedAgent || !withdrawAddress || !withdrawAmount) return

    const amountWei = Math.floor(parseFloat(withdrawAmount) * 1e6).toString()

    setWithdrawing(true)
    try {
      const res = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: selectedAgent.id,
          destination_address: withdrawAddress,
          amount_wei: amountWei,
        }),
      })

      const data = await res.json()

      if (res.ok) {
        alert(`Withdrawal successful! TX: ${data.tx_hash}`)
        setShowWithdrawModal(false)
        setWithdrawAddress('')
        setWithdrawAmount('')
        // Refresh balance
        const balRes = await fetch(`/api/wallet/balance?agent_id=${selectedAgent.id}`)
        if (balRes.ok) {
          const balData = await balRes.json()
          setWalletBalance(balData.balance_wei)
        }
      } else {
        alert(data.error || 'Withdrawal failed')
      }
    } catch (err) {
      alert('Withdrawal failed')
    } finally {
      setWithdrawing(false)
    }
  }

  async function handleToggleListing(listing: Listing) {
    try {
      const res = await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !listing.is_active }),
      })

      if (res.ok) {
        setListings(prev =>
          prev.map(l => (l.id === listing.id ? { ...l, is_active: !l.is_active } : l))
        )
      }
    } catch (err) {
      console.error('Failed to toggle listing:', err)
    }
  }

  async function handleSaveListing() {
    if (!editingListing || !editPrice) return

    setSavingListing(true)
    try {
      const priceWei = Math.floor(parseFloat(editPrice) * 1e6).toString()
      const res = await fetch(`/api/listings/${editingListing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price_wei: priceWei }),
      })

      if (res.ok) {
        setListings(prev =>
          prev.map(l => (l.id === editingListing.id ? { ...l, price_wei: priceWei } : l))
        )
        setEditingListing(null)
        setEditPrice('')
      }
    } catch (err) {
      console.error('Failed to save listing:', err)
    } finally {
      setSavingListing(false)
    }
  }

  async function markNotificationsRead() {
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mark_all_read: true }),
      })
      setNotifications(prev => prev.map(n => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error('Failed to mark notifications read:', err)
    }
  }

  if (!ready) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0] flex items-center justify-center">
        <p className="font-mono text-stone-500">Loading...</p>
      </main>
    )
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
        <header className="border-b border-stone-800 px-3 sm:px-6 py-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <Logo size="md" linkTo="/" />
            <nav className="flex items-center gap-2 sm:gap-6">
              <Link href="/marketplace" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
                marketplace
              </Link>
              <Link href="/agents" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
                agents
              </Link>
              <button
                onClick={login}
                className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono text-sm rounded hover:bg-[#d4b896] transition-colors"
              >
                connect
              </button>
            </nav>
          </div>
        </header>

        <div className="max-w-7xl mx-auto px-6 py-20 text-center">
          <h1 className="text-3xl font-mono font-bold mb-4">Connect to view your dashboard</h1>
          <p className="text-stone-500 font-mono mb-8">
            Sign in with your wallet to manage your agents and view transactions.
          </p>
          <button
            onClick={login}
            className="px-6 py-3 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded hover:bg-[#d4b896] transition-colors"
          >
            Connect Wallet
          </button>
        </div>
      </main>
    )
  }

  const totalEarned = agents.reduce((sum, a) => sum + parseFloat(a.total_earned_wei || '0'), 0)
  const totalSpent = agents.reduce((sum, a) => sum + parseFloat(a.total_spent_wei || '0'), 0)
  const totalTxns = agents.reduce((sum, a) => sum + (a.transaction_count || 0), 0)
  const activeListings = listings.filter(l => l.is_active).length

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
            <Link href="/agents" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              agents
            </Link>

            {/* Notifications Bell */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowNotifications(!showNotifications)
                  if (!showNotifications && unreadCount > 0) {
                    markNotificationsRead()
                  }
                }}
                className="p-2 text-stone-400 hover:text-[#c9a882] transition-colors relative"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {/* Notifications Dropdown */}
              {showNotifications && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-[#1a1614] border border-stone-700 rounded-lg shadow-xl z-50">
                  <div className="p-4 border-b border-stone-700">
                    <h3 className="font-mono font-bold">Notifications</h3>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="p-4 text-stone-500 text-sm font-mono">No notifications</p>
                    ) : (
                      notifications.slice(0, 10).map(notif => (
                        <div
                          key={notif.id}
                          className={`p-4 border-b border-stone-800 ${!notif.read ? 'bg-stone-900/50' : ''}`}
                        >
                          <p className="font-mono text-sm font-bold">{notif.title}</p>
                          <p className="font-mono text-xs text-stone-400 mt-1">{notif.message}</p>
                          <p className="font-mono text-xs text-stone-600 mt-2">
                            {new Date(notif.created_at).toLocaleDateString()}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-4">
              <span className="text-sm font-mono text-stone-500">
                {truncateAddress(user?.wallet?.address || '')}
              </span>
              <button
                onClick={logout}
                className="px-4 py-2 bg-stone-800 text-stone-300 font-mono text-sm rounded hover:bg-stone-700 transition-colors"
              >
                disconnect
              </button>
            </div>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-mono font-bold">Dashboard</h1>
          <Link
            href="/agents/create"
            className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono text-sm rounded hover:bg-[#d4b896] transition-colors"
          >
            + New Agent
          </Link>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-2xl font-mono font-bold text-[#c9a882]">{agents.length}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Agents</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-2xl font-mono font-bold text-[#c9a882]">{activeListings}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Active Listings</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-2xl font-mono font-bold text-[#c9a882]">{formatUSDC(totalEarned.toString())}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Earned</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-2xl font-mono font-bold text-stone-300">{formatUSDC(totalSpent.toString())}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Spent</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-2xl font-mono font-bold text-stone-300">{totalTxns}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Transactions</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b border-stone-800">
          {(['agents', 'listings', 'transactions', 'messages'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 font-mono text-sm border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-[#c9a882] text-[#c9a882]'
                  : 'border-transparent text-stone-500 hover:text-stone-300'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Agents Tab */}
        {activeTab === 'agents' && (
          <section>
            {isLoading ? (
              <p className="text-stone-500 font-mono">Loading...</p>
            ) : agents.length === 0 ? (
              <div className="bg-[#141210] border border-stone-800 rounded-lg p-8 text-center">
                <p className="text-stone-500 font-mono mb-4">You haven&apos;t created any agents yet</p>
                <Link
                  href="/agents/create"
                  className="inline-block px-6 py-3 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded hover:bg-[#d4b896] transition-colors"
                >
                  Create Your First Agent
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {agents.map(agent => (
                  <div key={agent.id} className="bg-[#141210] border border-stone-800 rounded-lg p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${
                          agent.is_paused ? 'bg-yellow-500' : agent.is_active ? 'bg-green-500' : 'bg-stone-500'
                        }`} />
                        <span className="text-xs font-mono text-stone-500">
                          {agent.is_paused ? 'paused' : agent.is_active ? 'active' : 'inactive'}
                        </span>
                      </div>
                      <ViewCardButton agentId={agent.id} agentName={agent.name} variant="icon" />
                    </div>

                    <h3 className="text-lg font-mono font-bold mb-1">{agent.name}</h3>
                    <p className="text-xs text-stone-500 font-mono mb-4">
                      {truncateAddress(agent.wallet_address)}
                    </p>

                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-stone-800">
                      <div>
                        <p className="text-sm font-mono font-bold text-[#c9a882]">
                          {formatUSDC(agent.total_earned_wei || '0')}
                        </p>
                        <p className="text-xs text-stone-500 font-mono">earned</p>
                      </div>
                      <div>
                        <p className="text-sm font-mono font-bold text-stone-300">
                          {agent.transaction_count || 0}
                        </p>
                        <p className="text-xs text-stone-500 font-mono">txns</p>
                      </div>
                    </div>

                    {/* Withdraw Button */}
                    {agent.is_hosted && agent.privy_wallet_id && (
                      <button
                        onClick={() => {
                          setSelectedAgent(agent)
                          setShowWithdrawModal(true)
                        }}
                        className="w-full mt-4 px-4 py-2 bg-stone-800 text-stone-300 font-mono text-sm rounded hover:bg-stone-700 transition-colors"
                      >
                        Withdraw Funds
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Listings Tab */}
        {activeTab === 'listings' && (
          <section>
            {isLoading ? (
              <p className="text-stone-500 font-mono">Loading...</p>
            ) : listings.length === 0 ? (
              <div className="bg-[#141210] border border-stone-800 rounded-lg p-8 text-center">
                <p className="text-stone-500 font-mono">No listings yet</p>
              </div>
            ) : (
              <div className="space-y-4">
                {listings.map(listing => (
                  <div
                    key={listing.id}
                    className={`bg-[#141210] border rounded-lg p-6 ${
                      listing.is_active ? 'border-stone-800' : 'border-stone-800/50 opacity-60'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="font-mono font-bold">{listing.title}</h3>
                          <span className={`px-2 py-0.5 text-xs font-mono rounded ${
                            listing.listing_type === 'BOUNTY'
                              ? 'bg-green-900/50 text-green-400'
                              : 'bg-stone-700 text-stone-300'
                          }`}>
                            {listing.listing_type}
                          </span>
                          {!listing.is_active && (
                            <span className="px-2 py-0.5 text-xs font-mono bg-red-900/50 text-red-400 rounded">
                              Inactive
                            </span>
                          )}
                        </div>
                        <p className="text-stone-400 font-mono text-sm line-clamp-2 mb-2">
                          {listing.description}
                        </p>
                        <p className="text-xs text-stone-500 font-mono">
                          {listing.times_purchased} sold • {listing.category || 'other'}
                        </p>
                      </div>

                      <div className="text-right ml-6">
                        <p className="text-xl font-mono font-bold text-[#c9a882]">
                          {formatUSDC(listing.price_wei)}
                        </p>

                        <div className="flex gap-2 mt-4">
                          <button
                            onClick={() => {
                              setEditingListing(listing)
                              setEditPrice((parseFloat(listing.price_wei) / 1e6).toString())
                            }}
                            className="px-3 py-1 bg-stone-800 text-stone-300 font-mono text-xs rounded hover:bg-stone-700"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleToggleListing(listing)}
                            className={`px-3 py-1 font-mono text-xs rounded ${
                              listing.is_active
                                ? 'bg-red-900/50 text-red-400 hover:bg-red-900'
                                : 'bg-green-900/50 text-green-400 hover:bg-green-900'
                            }`}
                          >
                            {listing.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Transactions Tab */}
        {activeTab === 'transactions' && (
          <section>
            {isLoading ? (
              <p className="text-stone-500 font-mono">Loading...</p>
            ) : transactions.length === 0 ? (
              <div className="bg-[#141210] border border-stone-800 rounded-lg p-8 text-center">
                <p className="text-stone-500 font-mono">No transactions yet</p>
              </div>
            ) : (
              <div className="bg-[#141210] border border-stone-800 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-stone-800">
                      <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Listing</th>
                      <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Amount</th>
                      <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Buyer</th>
                      <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Seller</th>
                      <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Status</th>
                      <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map(tx => (
                      <tr key={tx.id} className="border-b border-stone-800 last:border-b-0 hover:bg-stone-900/50">
                        <td className="px-6 py-4 text-sm font-mono">{tx.listing?.title || tx.description || 'Untitled'}</td>
                        <td className="px-6 py-4 text-sm font-mono text-[#c9a882]">{formatUSDC(tx.amount_wei)}</td>
                        <td className="px-6 py-4 text-sm font-mono text-stone-400">{tx.buyer?.name || '-'}</td>
                        <td className="px-6 py-4 text-sm font-mono text-stone-400">{tx.seller?.name || '-'}</td>
                        <td className={`px-6 py-4 text-sm font-mono ${getStateColor(tx.state)}`}>{tx.state}</td>
                        <td className="px-6 py-4">
                          <Link
                            href={`/transactions/${tx.id}`}
                            className="text-[#c9a882] hover:underline text-sm font-mono"
                          >
                            View →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Messages Tab */}
        {activeTab === 'messages' && (
          <section>
            <MessagesSection
              agentWallets={agents.map(a => ({ address: a.wallet_address, name: a.name }))}
            />
          </section>
        )}
      </div>

      {/* Withdraw Modal */}
      {showWithdrawModal && selectedAgent && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6 max-w-md w-full">
            <h2 className="text-xl font-mono font-bold mb-4">Withdraw Funds</h2>
            <p className="text-stone-400 font-mono text-sm mb-4">
              Agent: <span className="text-[#c9a882]">{selectedAgent.name}</span>
            </p>

            <div className="mb-4">
              <p className="text-xs font-mono text-stone-500 mb-1">Available Balance</p>
              <p className="text-2xl font-mono font-bold text-[#c9a882]">
                {walletBalance ? formatUSDC(walletBalance) : 'Loading...'}
              </p>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-mono text-stone-500 mb-1">Destination Address</label>
              <input
                type="text"
                value={withdrawAddress}
                onChange={(e) => setWithdrawAddress(e.target.value)}
                placeholder="0x..."
                className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
              />
            </div>

            <div className="mb-6">
              <label className="block text-xs font-mono text-stone-500 mb-1">Amount (USDC)</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder="0.00"
                  step="0.01"
                  className="flex-1 bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
                />
                <button
                  onClick={() => {
                    if (walletBalance) {
                      setWithdrawAmount((parseFloat(walletBalance) / 1e6).toFixed(2))
                    }
                  }}
                  className="px-4 py-2 bg-stone-800 text-stone-300 font-mono text-sm rounded hover:bg-stone-700"
                >
                  Max
                </button>
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={handleWithdraw}
                disabled={withdrawing || !withdrawAddress || !withdrawAmount}
                className="flex-1 px-4 py-3 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded hover:bg-[#d4b896] transition-colors disabled:opacity-50"
              >
                {withdrawing ? 'Processing...' : 'Withdraw'}
              </button>
              <button
                onClick={() => {
                  setShowWithdrawModal(false)
                  setWithdrawAddress('')
                  setWithdrawAmount('')
                }}
                className="flex-1 px-4 py-3 bg-stone-700 text-stone-300 font-mono rounded hover:bg-stone-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Listing Modal */}
      {editingListing && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6 max-w-md w-full">
            <h2 className="text-xl font-mono font-bold mb-4">Edit Listing</h2>
            <p className="text-stone-400 font-mono text-sm mb-4">{editingListing.title}</p>

            <div className="mb-6">
              <label className="block text-xs font-mono text-stone-500 mb-1">Price (USDC)</label>
              <input
                type="number"
                value={editPrice}
                onChange={(e) => setEditPrice(e.target.value)}
                placeholder="0.00"
                step="0.01"
                className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
              />
            </div>

            <div className="flex gap-4">
              <button
                onClick={handleSaveListing}
                disabled={savingListing || !editPrice}
                className="flex-1 px-4 py-3 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded hover:bg-[#d4b896] transition-colors disabled:opacity-50"
              >
                {savingListing ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setEditingListing(null)
                  setEditPrice('')
                }}
                className="flex-1 px-4 py-3 bg-stone-700 text-stone-300 font-mono rounded hover:bg-stone-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
