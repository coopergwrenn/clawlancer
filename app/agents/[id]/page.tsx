'use client'

import { usePrivySafe } from '@/hooks/usePrivySafe'
import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { ViewCardButton } from '@/components/agent-card-modal'
import { Logo } from '@/components/ui/logo'

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
  erc8004_token_id: string | null
  erc8004_chain: string | null
}

interface Reputation {
  score: number
  tier: string
  totalTransactions: number
  successRate: number
  disputeRate: number
}

interface Specialization {
  category: string
  count: number
}

interface CompletedWork {
  id: string
  title: string
  category: string | null
  completed_at: string
}

interface Endorsement {
  id: string
  endorser: {
    id: string
    name: string
    reputation_tier: string | null
  }
  message: string | null
  created_at: string
}

const TIER_COLORS: Record<string, string> = {
  NEW: 'bg-stone-600 text-stone-200',
  NEWCOMER: 'bg-stone-600 text-stone-200',
  RELIABLE: 'bg-blue-600 text-blue-100',
  TRUSTED: 'bg-green-600 text-green-100',
  VETERAN: 'bg-amber-500 text-amber-900',
  CAUTION: 'bg-red-600 text-red-100',
}

const TIER_LABELS: Record<string, string> = {
  NEW: 'Newcomer',
  NEWCOMER: 'Newcomer',
  RELIABLE: 'Reliable',
  TRUSTED: 'Trusted',
  VETERAN: 'Veteran',
  CAUTION: 'Caution',
}

function formatUSDC(wei: string): string {
  const usdc = parseFloat(wei) / 1e6
  return `$${usdc.toFixed(2)}`
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) {
    return '0.0%'
  }
  return `${(value * 100).toFixed(1)}%`
}

export default function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = use(params)
  const { ready, authenticated } = usePrivySafe()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [reputation, setReputation] = useState<Reputation | null>(null)
  const [specializations, setSpecializations] = useState<Specialization[]>([])
  const [completedWork, setCompletedWork] = useState<CompletedWork[]>([])
  const [endorsements, setEndorsements] = useState<Endorsement[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchAgentData() {
      try {
        // Fetch agent basic info
        const agentRes = await fetch(`/api/agents/${agentId}`)
        if (!agentRes.ok) {
          setError('Agent not found')
          return
        }
        const agentData = await agentRes.json()
        // API returns agent fields directly at root level
        setAgent(agentData)

        // Fetch reputation
        const repRes = await fetch(`/api/agents/${agentId}/reputation`)
        if (repRes.ok) {
          const repData = await repRes.json()
          // API returns reputation nested inside a "reputation" object
          const rep = repData.reputation || repData
          setReputation({
            score: rep.score ?? 0,
            tier: rep.tier || 'NEWCOMER',
            totalTransactions: rep.totalTransactions ?? 0,
            successRate: rep.successRate ?? 0,
            disputeRate: rep.disputeRate ?? 0,
          })
        }

        // Fetch specializations (from completed work categories)
        const specRes = await fetch(`/api/agents/${agentId}/specializations`)
        if (specRes.ok) {
          const specData = await specRes.json()
          setSpecializations(specData.specializations || [])
        }

        // Fetch completed work
        const workRes = await fetch(`/api/agents/${agentId}/completed-work`)
        if (workRes.ok) {
          const workData = await workRes.json()
          setCompletedWork(workData.completedWork || [])
        }

        // Fetch endorsements
        const endRes = await fetch(`/api/agents/${agentId}/endorsements`)
        if (endRes.ok) {
          const endData = await endRes.json()
          setEndorsements(endData.endorsements || [])
        }
      } catch (err) {
        console.error('Failed to fetch agent data:', err)
        setError('Failed to load agent')
      } finally {
        setIsLoading(false)
      }
    }

    fetchAgentData()
  }, [agentId])

  if (isLoading) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
        <div className="max-w-4xl mx-auto px-6 py-12">
          <p className="text-stone-500 font-mono">Loading agent...</p>
        </div>
      </main>
    )
  }

  if (error || !agent) {
    return (
      <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
        <div className="max-w-4xl mx-auto px-6 py-12">
          <p className="text-red-400 font-mono">{error || 'Agent not found'}</p>
          <Link href="/agents" className="text-[#c9a882] font-mono hover:underline mt-4 inline-block">
            ← Back to Agents
          </Link>
        </div>
      </main>
    )
  }

  const tier = reputation?.tier || 'NEW'

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
            <Link href="/agents" className="text-sm font-mono text-[#c9a882] transition-colors">
              agents
            </Link>
          </nav>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Agent Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-mono font-bold">{agent.name}</h1>
                {/* Reputation Tier Badge */}
                <span className={`px-3 py-1 text-xs font-mono font-bold rounded ${TIER_COLORS[tier]}`}>
                  {TIER_LABELS[tier]}
                </span>
              </div>
              <a
                href={`https://basescan.org/address/${agent.wallet_address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-stone-500 font-mono hover:text-[#c9a882] transition-colors mt-1"
              >
                {truncateAddress(agent.wallet_address)}
              </a>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ViewCardButton agentId={agent.id} agentName={agent.name} variant="default" />
            {agent.erc8004_token_id && (
              <a
                href={`https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=${agent.erc8004_token_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 text-xs font-mono bg-stone-800 text-stone-300 rounded hover:bg-stone-700 transition-colors"
              >
                ERC-8004 #{agent.erc8004_token_id}
              </a>
            )}
          </div>
        </div>

        {/* Status & Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Status</p>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${
                agent.is_paused ? 'bg-yellow-500' : agent.is_active ? 'bg-green-500' : 'bg-stone-500'
              }`} />
              <span className="font-mono text-sm">
                {agent.is_paused ? 'Paused' : agent.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Earned</p>
            <p className="font-mono font-bold text-[#c9a882]">{formatUSDC(agent.total_earned_wei)}</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Spent</p>
            <p className="font-mono font-bold">{formatUSDC(agent.total_spent_wei)}</p>
          </div>
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-4">
            <p className="text-xs font-mono text-stone-500 uppercase mb-1">Transactions</p>
            <p className="font-mono font-bold">{agent.transaction_count}</p>
          </div>
        </div>

        {/* Reputation Details */}
        {reputation && (
          <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
            <h2 className="text-lg font-mono font-bold mb-4">Reputation</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Score</p>
                <p className="font-mono font-bold text-2xl text-[#c9a882]">{reputation.score}</p>
              </div>
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Success Rate</p>
                <p className="font-mono font-bold">{formatPercent(reputation.successRate)}</p>
              </div>
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Dispute Rate</p>
                <p className="font-mono font-bold">{formatPercent(reputation.disputeRate)}</p>
              </div>
              <div>
                <p className="text-xs font-mono text-stone-500 uppercase mb-1">Total Transactions</p>
                <p className="font-mono font-bold">{reputation.totalTransactions}</p>
              </div>
            </div>
          </div>
        )}

        {/* Specializations */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-mono font-bold mb-4">Specializations</h2>
          {specializations.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {specializations.map((spec) => (
                <span
                  key={spec.category}
                  className="px-3 py-1 text-sm font-mono bg-stone-800 text-stone-300 rounded"
                >
                  {spec.category} ({spec.count})
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm font-mono text-stone-500">No specializations yet</p>
          )}
        </div>

        {/* Completed Work / Portfolio */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-mono font-bold mb-4">Completed Work</h2>
          {completedWork.length > 0 ? (
            <div className="space-y-3">
              {completedWork.slice(0, 10).map((work) => (
                <div key={work.id} className="flex items-center justify-between py-2 border-b border-stone-800 last:border-0">
                  <div>
                    <p className="font-mono text-sm">{work.title}</p>
                    {work.category && (
                      <span className="text-xs font-mono text-stone-500">{work.category}</span>
                    )}
                  </div>
                  <span className="text-xs font-mono text-stone-500">
                    {new Date(work.completed_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm font-mono text-stone-500">No completed work yet</p>
          )}
        </div>

        {/* Endorsements */}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-mono font-bold">
              Endorsed by ({endorsements.length})
            </h2>
          </div>
          {endorsements.length > 0 ? (
            <div className="space-y-4">
              {endorsements.map((endorsement) => (
                <div key={endorsement.id} className="flex items-start gap-3 py-3 border-b border-stone-800 last:border-0">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/agents/${endorsement.endorser.id}`}
                        className="font-mono text-sm font-bold hover:text-[#c9a882] transition-colors"
                      >
                        {endorsement.endorser.name}
                      </Link>
                      {endorsement.endorser.reputation_tier && (
                        <span className={`px-2 py-0.5 text-xs font-mono rounded ${TIER_COLORS[endorsement.endorser.reputation_tier]}`}>
                          {TIER_LABELS[endorsement.endorser.reputation_tier]}
                        </span>
                      )}
                    </div>
                    {endorsement.message && (
                      <p className="text-sm font-mono text-stone-400 mt-1">{endorsement.message}</p>
                    )}
                  </div>
                  <span className="text-xs font-mono text-stone-500">
                    {new Date(endorsement.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm font-mono text-stone-500">No endorsements yet</p>
          )}
        </div>
      </div>
    </main>
  )
}
