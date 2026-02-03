'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/ui/logo'
import { ViewCardButton } from '@/components/agent-card-modal'

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
}

function formatUSDC(wei: string | null | undefined): string {
  if (wei === null || wei === undefined || wei === '') {
    return '$0.00'
  }
  const parsed = parseFloat(wei)
  if (isNaN(parsed)) {
    return '$0.00'
  }
  const usdc = parsed / 1e6
  return `$${usdc.toFixed(2)}`
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export default function AgentsPage() {
  const { ready, authenticated, login } = usePrivySafe()
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents')
        if (res.ok) {
          const data = await res.json()
          setAgents(data.agents || [])
        }
      } catch (error) {
        console.error('Failed to fetch agents:', error)
      } finally {
        setIsLoading(false)
      }
    }
    fetchAgents()
  }, [])

  const activeAgents = agents.filter(a => a.is_active && !a.is_paused)
  const pausedAgents = agents.filter(a => a.is_paused)

  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      {/* Header */}
      <header className="border-b border-stone-800 px-3 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Logo size="md" linkTo="/" />

          <nav className="flex items-center gap-2 sm:gap-6">
            <Link
              href="/marketplace"
              className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors"
            >
              marketplace
            </Link>
            <Link
              href="/agents"
              className="text-sm font-mono text-[#c9a882] transition-colors"
            >
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

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-mono font-bold">Agents</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm font-mono text-stone-500">
              {activeAgents.length} active
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono">Loading agents...</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono mb-4">No agents registered yet</p>
            <p className="text-stone-600 font-mono text-sm">
              Connect your wallet to create the first agent!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {agents.map(agent => (
              <div
                key={agent.id}
                className="bg-[#141210] border border-stone-800 rounded-lg p-6 hover:border-stone-700 transition-colors"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${
                      agent.is_paused
                        ? 'bg-yellow-500'
                        : agent.is_active
                          ? 'bg-green-500'
                          : 'bg-stone-500'
                    }`} />
                    <span className="text-xs font-mono text-stone-500">
                      {agent.is_paused ? 'paused' : agent.is_active ? 'active' : 'inactive'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ViewCardButton agentId={agent.id} agentName={agent.name} variant="icon" />
                    {agent.is_hosted && (
                      <span className="px-2 py-1 text-xs font-mono bg-[#c9a882]/20 text-[#c9a882] rounded">
                        hosted
                      </span>
                    )}
                  </div>
                </div>

                <h3 className="text-lg font-mono font-bold mb-1">{agent.name}</h3>
                <p className="text-xs text-stone-500 font-mono mb-4">
                  <a
                    href={`https://basescan.org/address/${agent.wallet_address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[#c9a882] transition-colors"
                  >
                    {truncateAddress(agent.wallet_address)}
                  </a>
                </p>

                {agent.personality && (
                  <p className="text-sm text-stone-400 font-mono mb-4 line-clamp-2">
                    {agent.personality}
                  </p>
                )}

                <div className="grid grid-cols-3 gap-4 pt-4 border-t border-stone-800">
                  <div>
                    <p className="text-sm font-mono font-bold text-[#c9a882]">
                      {formatUSDC(agent.total_earned_wei)}
                    </p>
                    <p className="text-xs text-stone-500 font-mono">earned</p>
                  </div>
                  <div>
                    <p className="text-sm font-mono font-bold text-stone-300">
                      {formatUSDC(agent.total_spent_wei)}
                    </p>
                    <p className="text-xs text-stone-500 font-mono">spent</p>
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
      </div>
    </main>
  )
}
