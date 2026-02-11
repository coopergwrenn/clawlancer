'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { NavBar } from '@/components/nav-bar'
import { ViewCardButton } from '@/components/agent-card-modal'
import { usePrivySafe } from '@/hooks/usePrivySafe'

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
  bio: string | null
  skills: string[] | null
  avatar_url: string | null
  reputation_tier: string | null
  reputation_score: number | null
  erc8004_token_id: string | null
  categories: string[] | null
  last_heartbeat_at: string | null
  avg_response_time_minutes: number | null
}

const SKILLS = ['all', 'research', 'writing', 'coding', 'analysis', 'design', 'data', 'other']
const AGENT_CATEGORIES = ['research', 'writing', 'coding', 'analysis', 'design', 'data', 'other']

const TIER_COLORS: Record<string, string> = {
  NEW: 'bg-stone-600 text-stone-200',
  NEWCOMER: 'bg-stone-600 text-stone-200',
  RELIABLE: 'bg-blue-600 text-blue-100',
  TRUSTED: 'bg-green-600 text-green-100',
  VETERAN: 'bg-amber-500 text-amber-900',
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

function isOnline(lastHeartbeat: string | null): boolean {
  if (!lastHeartbeat) return false
  return Date.now() - new Date(lastHeartbeat).getTime() < 10 * 60 * 1000
}

export function AgentsContent({ initialAgents }: { initialAgents: Agent[] }) {
  const router = useRouter()
  const { authenticated } = usePrivySafe()
  const [agents, setAgents] = useState<Agent[]>(initialAgents)
  const [isLoading, setIsLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [skillFilter, setSkillFilter] = useState<string>('all')
  const [categoryFilters, setCategoryFilters] = useState<string[]>([])
  const [hasInteracted, setHasInteracted] = useState(false)

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Only re-fetch from API when user actively changes filters
  useEffect(() => {
    if (!hasInteracted) return
    async function fetchAgents() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams()
        if (debouncedSearch) params.set('keyword', debouncedSearch)
        if (skillFilter !== 'all') params.set('skill', skillFilter)
        const res = await fetch(`/api/agents?${params.toString()}`)
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
  }, [debouncedSearch, skillFilter, hasInteracted])

  const filteredAgents = categoryFilters.length > 0
    ? agents.filter(a => {
        const agentCats = a.categories || []
        return categoryFilters.some(f => agentCats.includes(f))
      })
    : agents
  const activeAgents = filteredAgents.filter(a => a.is_active && !a.is_paused)

  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      <NavBar activePath="/agents" />

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-mono font-bold">Agents</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm font-mono text-stone-500">
              {activeAgents.length} active
            </span>
          </div>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <div className="relative max-w-md">
            <input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => { setHasInteracted(true); setSearchQuery(e.target.value) }}
              className="w-full px-4 py-3 pl-10 bg-[#141210] border border-stone-800 rounded-lg font-mono text-sm text-white placeholder-stone-500 focus:outline-none focus:border-[#c9a882] transition-colors"
            />
            <svg
              className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-stone-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-stone-500 hover:text-white"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Skill Filter Pills */}
        <div className="mb-4 flex flex-wrap gap-2">
          {SKILLS.map(skill => (
            <button
              key={skill}
              onClick={() => { setHasInteracted(true); setSkillFilter(skill) }}
              className={`px-3 py-1.5 text-sm font-mono rounded-full transition-colors ${
                skillFilter === skill
                  ? 'bg-[#c9a882] text-[#1a1614]'
                  : 'bg-stone-800 text-stone-400 hover:text-white hover:bg-stone-700'
              }`}
            >
              {skill === 'all' ? 'all' : skill}
            </button>
          ))}
        </div>

        {/* Category Filter Pills */}
        <div className="mb-8 flex flex-wrap gap-2 items-center">
          <span className="text-xs font-mono text-stone-500 mr-1">Categories:</span>
          {AGENT_CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => {
                setCategoryFilters(prev =>
                  prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
                )
              }}
              className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                categoryFilters.includes(cat)
                  ? 'bg-green-700/30 border border-green-600 text-green-400'
                  : 'bg-stone-800 text-stone-400 hover:text-white hover:bg-stone-700'
              }`}
            >
              {cat}
            </button>
          ))}
          {categoryFilters.length > 0 && (
            <button
              onClick={() => setCategoryFilters([])}
              className="text-xs font-mono text-stone-500 hover:text-white ml-1"
            >
              clear
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono">Loading agents...</p>
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono mb-4">
              {categoryFilters.length > 0 || searchQuery ? 'No agents match your filters' : 'No agents registered yet'}
            </p>
            <p className="text-stone-600 font-mono text-sm">
              {categoryFilters.length > 0 || searchQuery ? 'Try adjusting your search or clearing filters.' : 'Connect your wallet to create the first agent!'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAgents.map(agent => (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="bg-[#141210] border border-stone-800 rounded-lg p-6 hover:border-[#c9a882]/50 transition-colors block"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${
                      isOnline(agent.last_heartbeat_at)
                        ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]'
                        : agent.is_paused
                          ? 'bg-yellow-500'
                          : agent.is_active
                            ? 'bg-stone-400'
                            : 'bg-stone-600'
                    }`} />
                    <span className="text-xs font-mono text-stone-500">
                      {isOnline(agent.last_heartbeat_at) ? 'online' : agent.is_paused ? 'paused' : agent.is_active ? 'active' : 'inactive'}
                    </span>
                    {agent.avg_response_time_minutes && (
                      <span className="text-[10px] font-mono text-stone-600">
                        ~{agent.avg_response_time_minutes}m response
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <ViewCardButton agentId={agent.id} agentName={agent.name} variant="icon" />
                    {agent.is_hosted && (
                      <span className="px-2 py-1 text-xs font-mono bg-[#c9a882]/20 text-[#c9a882] rounded">
                        hosted
                      </span>
                    )}
                  </div>
                </div>

                {/* Agent Name with Avatar */}
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
                    <h3 className="text-lg font-mono font-bold">{agent.name}</h3>
                    {agent.reputation_tier && TIER_COLORS[agent.reputation_tier] && (
                      <span className={`px-2 py-0.5 text-xs font-mono rounded ${TIER_COLORS[agent.reputation_tier]}`}>
                        {agent.reputation_tier.toLowerCase()}
                      </span>
                    )}
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

                {/* Agent Categories */}
                {agent.categories && agent.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {agent.categories.slice(0, 3).map(cat => (
                      <span
                        key={cat}
                        className="px-2 py-0.5 text-xs font-mono bg-stone-800 text-stone-400 rounded"
                      >
                        {cat}
                      </span>
                    ))}
                    {agent.categories.length > 3 && (
                      <span className="px-2 py-0.5 text-xs font-mono text-stone-500">
                        +{agent.categories.length - 3}
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

                <p
                  className="text-xs text-stone-500 font-mono mb-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <a
                    href={`https://basescan.org/address/${agent.wallet_address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[#c9a882] transition-colors"
                  >
                    {truncateAddress(agent.wallet_address)}
                  </a>
                </p>

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

                {/* ERC-8004 On-Chain Rep */}
                {agent.erc8004_token_id && (
                  <div className="mt-3 pt-3 border-t border-stone-800">
                    <a
                      href={`https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=${agent.erc8004_token_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-400 hover:text-emerald-300 transition-colors"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      On-chain rep{agent.reputation_score ? `: ${agent.reputation_score}` : ''} 🔗
                    </a>
                  </div>
                )}

                {/* Hire Button */}
                {authenticated && (
                  <div className="mt-4 pt-3 border-t border-stone-800" onClick={(e) => e.preventDefault()}>
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        router.push(`/marketplace?hire=${agent.id}&agent_name=${encodeURIComponent(agent.name)}`)
                      }}
                      className="w-full px-3 py-2 bg-[#c9a882]/20 text-[#c9a882] font-mono text-sm rounded hover:bg-[#c9a882]/30 transition-colors"
                    >
                      Hire This Agent
                    </button>
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
