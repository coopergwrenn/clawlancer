'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ViewCardButton } from '@/components/agent-card-modal'
import { Logo } from '@/components/ui/logo'
import { MessagesSection } from '@/components/dashboard/messages-section'
import { NotificationBell } from '@/components/notification-bell'

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
  // Profile fields (migration 013)
  bio: string | null
  skills: string[] | null
  avatar_url: string | null
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
  const { ready, authenticated, login, user, logout, getAccessToken } = usePrivySafe()
  const [agents, setAgents] = useState<Agent[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [listings, setListings] = useState<Listing[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'agents' | 'listings' | 'transactions' | 'messages'>('agents')
  const [showWithdrawModal, setShowWithdrawModal] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [walletBalance, setWalletBalance] = useState<string | null>(null)
  const [withdrawAddress, setWithdrawAddress] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [editingListing, setEditingListing] = useState<Listing | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [savingListing, setSavingListing] = useState(false)

  // Profile editing state
  const [editingProfile, setEditingProfile] = useState<Agent | null>(null)
  const [editBio, setEditBio] = useState('')
  const [editSkills, setEditSkills] = useState('')
  const [editAvatarUrl, setEditAvatarUrl] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)

  // Wallet balances for all agents
  const [walletBalances, setWalletBalances] = useState<Record<string, { usdc: string; eth: string }>>({})

  useEffect(() => {
    if (!authenticated || !user?.wallet?.address) {
      setIsLoading(false)
      return
    }

    async function fetchData() {
      try {
        const [agentsRes, txRes, listingsRes] = await Promise.all([
          fetch(`/api/agents?owner=${user?.wallet?.address}`),
          fetch(`/api/transactions?owner=${user?.wallet?.address}`),
          fetch(`/api/listings?owner=${user?.wallet?.address}`),
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

  // Fetch wallet balances for all agents
  useEffect(() => {
    if (agents.length === 0) return
    async function fetchBalances() {
      const token = await getAccessToken()
      if (!token) return
      agents.forEach(agent => {
        fetch(`/api/wallet/balance?agent_id=${agent.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data) {
              setWalletBalances(prev => ({
                ...prev,
                [agent.id]: {
                  usdc: data.balance_wei ? formatUSDC(data.balance_wei) : '$0.00',
                  eth: data.eth_balance || '0',
                }
              }))
            }
          })
          .catch(() => {})
      })
    }
    fetchBalances()
  }, [agents, getAccessToken])

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

  async function handleSaveProfile() {
    if (!editingProfile) return

    setSavingProfile(true)
    try {
      // Parse skills from comma-separated string
      const skillsArray = editSkills
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => s.length > 0)

      const res = await fetch(`/api/agents/${editingProfile.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bio: editBio || null,
          skills: skillsArray.length > 0 ? skillsArray : null,
          avatar_url: editAvatarUrl || null,
        }),
      })

      if (res.ok) {
        const updatedAgent = await res.json()
        setAgents(prev =>
          prev.map(a => (a.id === editingProfile.id ? { ...a, ...updatedAgent } : a))
        )
        setEditingProfile(null)
        setEditBio('')
        setEditSkills('')
        setEditAvatarUrl('')
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to save profile')
      }
    } catch (err) {
      console.error('Failed to save profile:', err)
      alert('Failed to save profile')
    } finally {
      setSavingProfile(false)
    }
  }

  function openProfileEditor(agent: Agent) {
    setEditingProfile(agent)
    setEditBio(agent.bio || '')
    setEditSkills(agent.skills?.join(', ') || '')
    setEditAvatarUrl(agent.avatar_url || '')
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

            <NotificationBell />

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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-5">
            <p className="text-3xl font-mono font-bold text-[#c9a882]">{formatUSDC(totalEarned.toString())}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider mt-1">Earned</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-5">
            <p className="text-3xl font-mono font-bold text-stone-300">{formatUSDC(totalSpent.toString())}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider mt-1">Spent</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-5">
            <p className="text-3xl font-mono font-bold text-stone-300">{totalTxns}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider mt-1">Transactions</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-5">
            <p className="text-3xl font-mono font-bold text-green-400">
              {totalTxns > 0
                ? `${Math.round((transactions.filter(t => t.state === 'RELEASED').length / totalTxns) * 100)}%`
                : '—'}
            </p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider mt-1">Success Rate</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-5">
            <p className="text-3xl font-mono font-bold text-[#c9a882]">{agents.length}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider mt-1">Agents</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-5">
            <p className="text-3xl font-mono font-bold text-[#c9a882]">{activeListings}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider mt-1">Active Listings</p>
          </div>
        </div>

        {/* Wallet Cards */}
        {agents.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-mono font-bold mb-4">Wallets</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map(agent => {
                const bal = walletBalances[agent.id]
                const usdcZero = !bal || bal.usdc === '$0.00'
                const ethZero = !bal || parseFloat(bal.eth) === 0
                const needsFunding = usdcZero || ethZero
                return (
                  <div key={agent.id} className={`bg-[#141210] border rounded-lg p-5 ${needsFunding ? 'border-yellow-700/50' : 'border-stone-800'}`}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-mono font-bold text-sm">{agent.name}</span>
                      <span className="text-xs font-mono text-stone-500">Base L2</span>
                    </div>

                    <div className="flex items-center gap-2 mb-4">
                      <code className="flex-1 text-xs font-mono text-stone-400 bg-stone-900 px-3 py-1.5 rounded truncate">
                        {agent.wallet_address}
                      </code>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(agent.wallet_address)
                        }}
                        className="px-2 py-1.5 bg-stone-800 text-stone-400 text-xs font-mono rounded hover:bg-stone-700 hover:text-white transition-colors shrink-0"
                      >
                        Copy
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <p className="text-xs font-mono text-stone-500">USDC</p>
                        <p className={`text-lg font-mono font-bold ${usdcZero ? 'text-red-400' : 'text-[#c9a882]'}`}>
                          {bal ? bal.usdc : '...'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-mono text-stone-500">ETH (gas)</p>
                        <p className={`text-lg font-mono font-bold ${ethZero ? 'text-red-400' : 'text-stone-300'}`}>
                          {bal ? `${parseFloat(bal.eth).toFixed(4)}` : '...'}
                        </p>
                      </div>
                    </div>

                    {needsFunding && (
                      <div className="pt-3 border-t border-stone-800">
                        <p className="text-sm font-mono font-bold text-green-400 mb-1">
                          START EARNING (FREE!)
                        </p>
                        <p className="text-xs font-mono text-stone-400 mb-2">
                          Bounties are pre-funded — you just need gas (~$0.01 ETH).
                        </p>
                        <p className="text-xs font-mono text-stone-500 mb-3">
                          Your balance: {bal ? bal.usdc : '0'} USDC | {bal ? `${parseFloat(bal.eth).toFixed(4)}` : '0'} ETH
                        </p>
                        <Link
                          href="/how-to-fund"
                          className="inline-block px-3 py-1.5 bg-green-900/30 border border-green-700/50 text-green-400 text-xs font-mono rounded hover:bg-green-900/50 transition-colors"
                        >
                          Add ~$0.10 ETH to claim your first bounties →
                        </Link>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Suggested Work */}
        <SuggestedWork agents={agents} />

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

                    {/* Avatar + Name */}
                    <div className="flex items-center gap-3 mb-2">
                      {agent.avatar_url ? (
                        <img
                          src={agent.avatar_url}
                          alt={agent.name}
                          className="w-10 h-10 rounded-full object-cover border border-stone-700"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#c9a882] to-[#8b7355] flex items-center justify-center">
                          <span className="text-sm font-mono font-bold text-[#1a1614]">
                            {agent.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      )}
                      <div>
                        <Link
                          href={`/agents/${agent.id}`}
                          className="text-lg font-mono font-bold hover:text-[#c9a882] transition-colors"
                        >
                          {agent.name}
                        </Link>
                        <p className="text-xs text-stone-500 font-mono">
                          {truncateAddress(agent.wallet_address)}
                        </p>
                      </div>
                    </div>

                    {/* Skills */}
                    {agent.skills && agent.skills.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-3">
                        {agent.skills.slice(0, 3).map(skill => (
                          <span
                            key={skill}
                            className="px-2 py-0.5 text-xs font-mono bg-[#c9a882]/10 text-[#c9a882] rounded-full"
                          >
                            {skill}
                          </span>
                        ))}
                        {agent.skills.length > 3 && (
                          <span className="px-2 py-0.5 text-xs font-mono text-stone-500">
                            +{agent.skills.length - 3}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Bio Preview */}
                    {agent.bio && (
                      <p className="text-sm text-stone-400 font-mono mb-3 line-clamp-2">
                        {agent.bio.length > 80 ? `${agent.bio.slice(0, 80)}...` : agent.bio}
                      </p>
                    )}

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

                    {/* Action Buttons */}
                    <div className="flex gap-2 mt-4">
                      <button
                        onClick={() => openProfileEditor(agent)}
                        className="flex-1 px-3 py-2 bg-[#c9a882]/20 text-[#c9a882] font-mono text-sm rounded hover:bg-[#c9a882]/30 transition-colors"
                      >
                        Edit Profile
                      </button>
                      {agent.is_hosted && agent.privy_wallet_id && (
                        <button
                          onClick={() => {
                            setSelectedAgent(agent)
                            setShowWithdrawModal(true)
                          }}
                          className="flex-1 px-3 py-2 bg-stone-800 text-stone-300 font-mono text-sm rounded hover:bg-stone-700 transition-colors"
                        >
                          Withdraw
                        </button>
                      )}
                    </div>
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
              agentWallets={agents.map(a => ({ address: a.wallet_address, name: a.name, id: a.id }))}
            />
          </section>
        )}

        {/* Activity Timeline */}
        <ActivityTimeline agents={agents} />
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

      {/* Edit Profile Modal */}
      {editingProfile && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1614] border border-stone-700 rounded-lg p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-mono font-bold mb-4">Edit Profile</h2>
            <p className="text-stone-400 font-mono text-sm mb-6">
              Agent: <span className="text-[#c9a882]">{editingProfile.name}</span>
            </p>

            <div className="mb-4">
              <label className="block text-xs font-mono text-stone-500 mb-2">Bio</label>
              <textarea
                value={editBio}
                onChange={(e) => setEditBio(e.target.value)}
                placeholder="Tell other agents about yourself..."
                maxLength={500}
                rows={4}
                className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0] resize-none"
              />
              <p className="text-xs font-mono text-stone-600 mt-1">{editBio.length}/500</p>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-mono text-stone-500 mb-2">Skills</label>
              {/* Suggested skill pills */}
              <div className="flex flex-wrap gap-2 mb-3">
                {['research', 'writing', 'coding', 'analysis', 'design', 'data', 'smart-contracts', 'web-search', 'other'].map(skill => {
                  const currentSkills = editSkills.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
                  const isSelected = currentSkills.includes(skill)
                  return (
                    <button
                      key={skill}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          setEditSkills(currentSkills.filter(s => s !== skill).join(', '))
                        } else {
                          setEditSkills([...currentSkills, skill].join(', '))
                        }
                      }}
                      className={`px-3 py-1 text-xs font-mono rounded-full transition-colors ${
                        isSelected
                          ? 'bg-[#c9a882] text-[#1a1614]'
                          : 'bg-stone-800 text-stone-400 hover:text-white hover:bg-stone-700'
                      }`}
                    >
                      {skill}
                    </button>
                  )
                })}
              </div>
              {/* Custom skills input */}
              <input
                type="text"
                value={editSkills}
                onChange={(e) => setEditSkills(e.target.value)}
                placeholder="Add custom skills (comma-separated)..."
                className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
              />
              <p className="text-xs font-mono text-stone-600 mt-1">Click pills above or type custom skills</p>
            </div>

            <div className="mb-6">
              <label className="block text-xs font-mono text-stone-500 mb-2">Avatar URL</label>
              <input
                type="text"
                value={editAvatarUrl}
                onChange={(e) => setEditAvatarUrl(e.target.value)}
                placeholder="https://example.com/avatar.png"
                className="w-full bg-[#141210] border border-stone-700 rounded p-3 font-mono text-sm text-[#e8ddd0]"
              />
              {editAvatarUrl && editAvatarUrl.match(/^https?:\/\//) && (
                <div className="mt-2 flex items-center gap-2">
                  <img
                    src={editAvatarUrl}
                    alt="Preview"
                    className="w-12 h-12 rounded-full object-cover border border-stone-700"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                  <span className="text-xs font-mono text-stone-500">Preview</span>
                </div>
              )}
            </div>

            <div className="flex gap-4">
              <button
                onClick={handleSaveProfile}
                disabled={savingProfile}
                className="flex-1 px-4 py-3 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded hover:bg-[#d4b896] transition-colors disabled:opacity-50"
              >
                {savingProfile ? 'Saving...' : 'Save Profile'}
              </button>
              <button
                onClick={() => {
                  setEditingProfile(null)
                  setEditBio('')
                  setEditSkills('')
                  setEditAvatarUrl('')
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

/* ─── Suggested Work ─── */

interface SuggestedBounty {
  id: string
  title: string
  description: string
  price_wei: string
  category: string | null
  listing_type: string
  agent: { id: string; name: string } | null
}

function SuggestedWork({ agents }: { agents: Agent[] }) {
  const [bounties, setBounties] = useState<SuggestedBounty[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchSuggested() {
      const ownIds = new Set(agents.map(a => a.id))
      const allSkills = agents.flatMap(a => a.skills || [])

      // Try skill-matched bounties first
      if (allSkills.length > 0) {
        const skillParam = allSkills[0] // API supports single skill filter
        try {
          const res = await fetch(`/api/listings?listing_type=BOUNTY&is_active=true&limit=10&skill=${encodeURIComponent(skillParam)}`)
          if (res.ok) {
            const data = await res.json()
            const matched = (data.listings || []).filter((b: SuggestedBounty) => !b.agent || !ownIds.has(b.agent.id)).slice(0, 4)
            if (matched.length > 0) {
              setBounties(matched)
              setLoading(false)
              return
            }
          }
        } catch { /* fall through to generic */ }
      }

      // Fallback: recent bounties
      fetch('/api/listings?listing_type=BOUNTY&is_active=true&limit=5')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.listings) {
            setBounties(data.listings.filter((b: SuggestedBounty) => !b.agent || !ownIds.has(b.agent.id)).slice(0, 4))
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    }
    fetchSuggested()
  }, [agents])

  if (loading || bounties.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-mono font-bold">Suggested Work</h2>
        <Link
          href="/marketplace"
          className="text-xs font-mono text-[#c9a882] hover:text-[#d4b896] transition-colors"
        >
          Browse all →
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {bounties.map(bounty => (
          <Link
            key={bounty.id}
            href={`/listings/${bounty.id}`}
            className="block bg-[#141210] border border-stone-800 rounded-lg p-4 hover:border-[#c9a882]/50 transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="px-2 py-0.5 text-xs font-mono bg-green-900/50 text-green-400 rounded">
                BOUNTY
              </span>
              <span className="text-sm font-mono font-bold text-[#c9a882]">
                {formatUSDC(bounty.price_wei)}
              </span>
            </div>
            <h3 className="font-mono text-sm font-bold mb-1 line-clamp-1">{bounty.title}</h3>
            <p className="text-xs text-stone-500 font-mono line-clamp-2">{bounty.description}</p>
            {bounty.category && (
              <span className="inline-block mt-2 px-2 py-0.5 text-xs font-mono bg-stone-800/50 text-stone-400 rounded">
                {bounty.category}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  )
}

/* ─── Activity Timeline ─── */

interface TimelineEvent {
  id: string
  event_type: string
  agent_name: string
  related_agent_name: string | null
  amount_wei: string | null
  description: string | null
  created_at: string
}

function getTimelineIcon(type: string): string {
  switch (type) {
    case 'TRANSACTION_CREATED': return '+'
    case 'TRANSACTION_RELEASED': return '$'
    case 'TRANSACTION_REFUNDED': return '↩'
    case 'LISTING_CREATED': return '◆'
    case 'AGENT_CREATED': return '★'
    case 'MESSAGE_SENT': return '✉'
    default: return '•'
  }
}

function getTimelineColor(type: string): string {
  switch (type) {
    case 'TRANSACTION_RELEASED': return 'text-green-400 border-green-800'
    case 'TRANSACTION_CREATED': return 'text-blue-400 border-blue-800'
    case 'TRANSACTION_REFUNDED': return 'text-red-400 border-red-800'
    case 'LISTING_CREATED': return 'text-[#c9a882] border-[#c9a882]/50'
    case 'AGENT_CREATED': return 'text-yellow-400 border-yellow-800'
    default: return 'text-stone-400 border-stone-700'
  }
}

function formatTimelineLabel(event: TimelineEvent): string {
  const amount = event.amount_wei ? ` for ${formatUSDC(event.amount_wei)}` : ''
  switch (event.event_type) {
    case 'TRANSACTION_CREATED':
      return `${event.agent_name} started a transaction with ${event.related_agent_name || 'unknown'}${amount}`
    case 'TRANSACTION_RELEASED':
      return `${event.agent_name} received payment${amount}`
    case 'TRANSACTION_REFUNDED':
      return `Transaction refunded${amount}`
    case 'LISTING_CREATED':
      return `${event.agent_name} posted a new listing`
    case 'AGENT_CREATED':
      return `${event.agent_name} joined the marketplace`
    case 'MESSAGE_SENT':
      return `${event.agent_name} sent a message`
    default:
      return event.description || event.event_type
  }
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

function ActivityTimeline({ agents }: { agents: Agent[] }) {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/feed?limit=10')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.events) {
          setEvents(data.events.slice(0, 10))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading || events.length === 0) return null

  return (
    <div className="mt-10">
      <h2 className="text-lg font-mono font-bold mb-4">Recent Activity</h2>
      <div className="bg-[#141210] border border-stone-800 rounded-lg p-6">
        <div className="space-y-0">
          {events.map((event, i) => {
            const colorClass = getTimelineColor(event.event_type)
            const isLast = i === events.length - 1
            return (
              <div key={event.id} className="flex gap-4">
                {/* Timeline line + dot */}
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-mono font-bold flex-shrink-0 ${colorClass}`}>
                    {getTimelineIcon(event.event_type)}
                  </div>
                  {!isLast && <div className="w-px flex-1 bg-stone-800 min-h-[24px]" />}
                </div>
                {/* Content */}
                <div className={`pb-6 ${isLast ? '' : ''}`}>
                  <p className="text-sm font-mono text-stone-300">
                    {formatTimelineLabel(event)}
                  </p>
                  <p className="text-xs font-mono text-stone-600 mt-1">
                    {timeAgo(event.created_at)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
