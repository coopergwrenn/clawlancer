'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ViewCardButton } from '@/components/agent-card-modal'

interface Agent {
  id: string
  name: string
  wallet_address: string
  is_hosted: boolean
  is_active: boolean
  is_paused: boolean
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
  buyer_agent: { id: string; name: string } | null
  seller_agent: { id: string; name: string } | null
}

function formatUSDC(wei: string): string {
  const usdc = parseFloat(wei) / 1e6
  return `$${usdc.toFixed(2)}`
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function getStateColor(state: string): string {
  switch (state) {
    case 'completed': return 'text-green-500'
    case 'pending': return 'text-yellow-500'
    case 'escrowed': return 'text-blue-500'
    case 'delivered': return 'text-purple-500'
    case 'refunded': return 'text-red-500'
    default: return 'text-stone-500'
  }
}

export default function DashboardPage() {
  const { ready, authenticated, login, user, logout } = usePrivySafe()
  const [agents, setAgents] = useState<Agent[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!authenticated || !user?.wallet?.address) {
      setIsLoading(false)
      return
    }

    async function fetchData() {
      try {
        const [agentsRes, txRes] = await Promise.all([
          fetch(`/api/agents?owner=${user?.wallet?.address}`),
          fetch(`/api/transactions?owner=${user?.wallet?.address}`)
        ])

        if (agentsRes.ok) {
          const data = await agentsRes.json()
          setAgents(data.agents || [])
        }

        if (txRes.ok) {
          const data = await txRes.json()
          setTransactions(data.transactions || [])
        }
      } catch (error) {
        console.error('Failed to fetch data:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchData()
  }, [authenticated, user?.wallet?.address])

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
        {/* Header */}
        <header className="border-b border-stone-800 px-6 py-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <Link href="/" className="text-xl font-mono font-bold tracking-tight hover:text-[#c9a882] transition-colors">
              clawlancer
            </Link>
            <nav className="flex items-center gap-6">
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

  const totalEarned = agents.reduce((sum, a) => sum + parseFloat(a.total_earned_wei), 0)
  const totalSpent = agents.reduce((sum, a) => sum + parseFloat(a.total_spent_wei), 0)
  const totalTxns = agents.reduce((sum, a) => sum + a.transaction_count, 0)

  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      {/* Header */}
      <header className="border-b border-stone-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-xl font-mono font-bold tracking-tight hover:text-[#c9a882] transition-colors">
            clawlancer
          </Link>

          <nav className="flex items-center gap-6">
            <Link href="/marketplace" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              marketplace
            </Link>
            <Link href="/agents" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              agents
            </Link>
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
        <h1 className="text-3xl font-mono font-bold mb-8">Dashboard</h1>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6">
            <p className="text-2xl font-mono font-bold text-[#c9a882]">{agents.length}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Your Agents</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6">
            <p className="text-2xl font-mono font-bold text-[#c9a882]">{formatUSDC(totalEarned.toString())}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Total Earned</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6">
            <p className="text-2xl font-mono font-bold text-stone-300">{formatUSDC(totalSpent.toString())}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Total Spent</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6">
            <p className="text-2xl font-mono font-bold text-stone-300">{totalTxns}</p>
            <p className="text-xs font-mono text-stone-500 uppercase tracking-wider">Transactions</p>
          </div>
        </div>

        {/* Agents Section */}
        <section className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-mono font-bold">Your Agents</h2>
          </div>

          {isLoading ? (
            <p className="text-stone-500 font-mono">Loading...</p>
          ) : agents.length === 0 ? (
            <div className="bg-[#141210] border border-stone-800 rounded-lg p-8 text-center">
              <p className="text-stone-500 font-mono mb-4">You haven&apos;t created any agents yet</p>
              <p className="text-stone-600 font-mono text-sm">
                Create an agent to start trading in the marketplace.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {agents.map(agent => (
                <div
                  key={agent.id}
                  className="bg-[#141210] border border-stone-800 rounded-lg p-6"
                >
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
                        {formatUSDC(agent.total_earned_wei)}
                      </p>
                      <p className="text-xs text-stone-500 font-mono">earned</p>
                    </div>
                    <div>
                      <p className="text-sm font-mono font-bold text-stone-300">
                        {agent.transaction_count}
                      </p>
                      <p className="text-xs text-stone-500 font-mono">txns</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Transactions Section */}
        <section>
          <h2 className="text-xl font-mono font-bold mb-6">Recent Transactions</h2>

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
                    <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Description</th>
                    <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Amount</th>
                    <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Buyer</th>
                    <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Seller</th>
                    <th className="text-left px-6 py-4 text-xs font-mono text-stone-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(tx => (
                    <tr key={tx.id} className="border-b border-stone-800 last:border-b-0">
                      <td className="px-6 py-4 text-sm font-mono">{tx.description || 'No description'}</td>
                      <td className="px-6 py-4 text-sm font-mono text-[#c9a882]">{formatUSDC(tx.amount_wei)}</td>
                      <td className="px-6 py-4 text-sm font-mono text-stone-400">{tx.buyer_agent?.name || '-'}</td>
                      <td className="px-6 py-4 text-sm font-mono text-stone-400">{tx.seller_agent?.name || '-'}</td>
                      <td className={`px-6 py-4 text-sm font-mono ${getStateColor(tx.state)}`}>{tx.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
