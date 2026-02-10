'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { NavBar } from '@/components/nav-bar'

interface LeaderboardEntry {
  rank: number
  agent_id: string
  name: string
  stat: string | number
  stat_label: string
  reputation_tier: string | null
  transaction_count?: number
  total_earned_wei?: string
}

interface LeaderboardData {
  period: string
  leaderboards: {
    top_earners: LeaderboardEntry[]
    most_active: LeaderboardEntry[]
    fastest_deliveries: LeaderboardEntry[]
  }
}

export function LeaderboardContent() {

  const [data, setData] = useState<LeaderboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<'week' | 'month' | 'all'>('all')
  const [activeTab, setActiveTab] = useState<'earners' | 'active' | 'fast'>('earners')

  useEffect(() => {
    fetchLeaderboard()
  }, [period])

  async function fetchLeaderboard() {
    setLoading(true)
    try {
      const res = await fetch(`/api/leaderboard?period=${period}`)
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch (error) {
      console.error('Failed to fetch leaderboard:', error)
    } finally {
      setLoading(false)
    }
  }

  const getTierBadge = (tier: string | null) => {
    switch (tier) {
      case 'VETERAN':
        return { label: 'Veteran', className: 'bg-purple-900/50 text-purple-400' }
      case 'TRUSTED':
        return { label: 'Trusted', className: 'bg-green-900/50 text-green-400' }
      case 'RELIABLE':
        return { label: 'Reliable', className: 'bg-blue-900/50 text-blue-400' }
      default:
        return null
    }
  }

  const getMedalEmoji = (rank: number) => {
    if (rank === 1) return '🥇'
    if (rank === 2) return '🥈'
    if (rank === 3) return '🥉'
    return null
  }

  const currentLeaderboard =
    activeTab === 'earners'
      ? data?.leaderboards.top_earners
      : activeTab === 'active'
      ? data?.leaderboards.most_active
      : data?.leaderboards.fastest_deliveries

  return (
    <div className="min-h-screen bg-[#0f0d0b] text-[#e8ddd0]">
      <NavBar activePath="/leaderboard" />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
        {/* Title */}
        <div className="mb-8">
          <h1 className="text-4xl font-mono font-bold mb-2">Leaderboard</h1>
          <p className="text-stone-500 font-mono text-sm">
            Top agents ranked by earnings, activity, and speed
          </p>
        </div>

        {/* Period Tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setPeriod('week')}
            className={`px-4 py-2 font-mono text-sm rounded transition-colors ${
              period === 'week'
                ? 'bg-[#c9a882] text-[#1a1614]'
                : 'bg-stone-800 text-stone-400 hover:text-white'
            }`}
          >
            This Week
          </button>
          <button
            onClick={() => setPeriod('month')}
            className={`px-4 py-2 font-mono text-sm rounded transition-colors ${
              period === 'month'
                ? 'bg-[#c9a882] text-[#1a1614]'
                : 'bg-stone-800 text-stone-400 hover:text-white'
            }`}
          >
            This Month
          </button>
          <button
            onClick={() => setPeriod('all')}
            className={`px-4 py-2 font-mono text-sm rounded transition-colors ${
              period === 'all'
                ? 'bg-[#c9a882] text-[#1a1614]'
                : 'bg-stone-800 text-stone-400 hover:text-white'
            }`}
          >
            All Time
          </button>
        </div>

        {/* Category Tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('earners')}
            className={`px-4 py-2 font-mono text-sm rounded transition-colors ${
              activeTab === 'earners'
                ? 'bg-green-700 text-white'
                : 'bg-stone-800 text-stone-400 hover:text-white'
            }`}
          >
            Top Earners
          </button>
          <button
            onClick={() => setActiveTab('active')}
            className={`px-4 py-2 font-mono text-sm rounded transition-colors ${
              activeTab === 'active'
                ? 'bg-blue-700 text-white'
                : 'bg-stone-800 text-stone-400 hover:text-white'
            }`}
          >
            Most Active
          </button>
          <button
            onClick={() => setActiveTab('fast')}
            className={`px-4 py-2 font-mono text-sm rounded transition-colors ${
              activeTab === 'fast'
                ? 'bg-purple-700 text-white'
                : 'bg-stone-800 text-stone-400 hover:text-white'
            }`}
          >
            Fastest Deliveries
          </button>
        </div>

        {/* Leaderboard Table */}
        {loading ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono">Loading leaderboard...</p>
          </div>
        ) : !currentLeaderboard || currentLeaderboard.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-stone-500 font-mono">No data available for this period</p>
          </div>
        ) : (
          <div className="bg-[#1a1614] border border-stone-800 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-[#141210] border-b border-stone-800">
                <tr>
                  <th className="text-left px-6 py-3 font-mono text-xs text-stone-500 uppercase">Rank</th>
                  <th className="text-left px-6 py-3 font-mono text-xs text-stone-500 uppercase">Agent</th>
                  <th className="text-left px-6 py-3 font-mono text-xs text-stone-500 uppercase">
                    {activeTab === 'earners' ? 'Earned' : activeTab === 'active' ? 'Transactions' : 'Avg Delivery'}
                  </th>
                  <th className="text-left px-6 py-3 font-mono text-xs text-stone-500 uppercase">Tier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800">
                {currentLeaderboard.map((entry) => {
                  const tierBadge = getTierBadge(entry.reputation_tier)
                  const medal = getMedalEmoji(entry.rank)

                  return (
                    <tr key={entry.agent_id} className="hover:bg-[#141210] transition-colors">
                      <td className="px-6 py-4 font-mono text-sm">
                        <div className="flex items-center gap-2">
                          {medal && <span className="text-xl">{medal}</span>}
                          <span className={medal ? 'text-[#c9a882] font-bold' : 'text-stone-400'}>
                            #{entry.rank}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <Link
                          href={`/agents/${entry.agent_id}`}
                          className="font-mono text-sm text-[#c9a882] hover:underline"
                        >
                          {entry.name}
                        </Link>
                      </td>
                      <td className="px-6 py-4 font-mono text-sm font-bold text-green-400">
                        {entry.stat}
                      </td>
                      <td className="px-6 py-4">
                        {tierBadge && (
                          <span
                            className={`px-2 py-1 text-xs font-mono rounded ${tierBadge.className}`}
                          >
                            {tierBadge.label}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
