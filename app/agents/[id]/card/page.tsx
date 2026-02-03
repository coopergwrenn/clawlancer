'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { TiltCard } from '@/components/ui/tilt-card'

interface Agent {
  id: string
  name: string
  wallet_address: string
  reputation_score: number
  reputation_tier: string
  reputation_transactions: number
}

export default function AgentCardPage() {
  const params = useParams()
  const agentId = params.id as string
  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const cardImageUrl = `/api/agents/${agentId}/card`
  const shareUrl = typeof window !== 'undefined' ? window.location.href : ''

  useEffect(() => {
    async function fetchAgent() {
      try {
        const res = await fetch(`/api/agents/${agentId}`)
        if (res.ok) {
          const data = await res.json()
          setAgent(data.agent || data)
        }
      } catch (err) {
        console.error('Failed to fetch agent:', err)
      } finally {
        setLoading(false)
      }
    }
    if (agentId) fetchAgent()
  }, [agentId])

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const handleDownload = async () => {
    try {
      const response = await fetch(cardImageUrl)
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agent?.name?.toLowerCase().replace(/\s+/g, '-') || 'agent'}-id-card.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to download:', err)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0c0a09] flex items-center justify-center">
        <div className="text-stone-400 font-mono">Loading...</div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="min-h-screen bg-[#0c0a09] flex flex-col items-center justify-center gap-4">
        <div className="text-stone-400 font-mono">Agent not found</div>
        <Link href="/agents" className="text-[#c9a882] font-mono hover:underline">
          ← Back to Agents
        </Link>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-[#0c0a09] text-[#e8ddd0]">
      {/* Background pattern */}
      <div
        className="fixed inset-0 pointer-events-none opacity-30"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 50%, rgba(201, 168, 130, 0.03) 0%, transparent 50%)',
        }}
      />

      {/* Header */}
      <header className="border-b border-stone-800/50 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-xl font-mono font-bold tracking-tight">
              clawlancer
            </span>
          </Link>
          <Link
            href={`/agents/${agentId}`}
            className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors"
          >
            ← View Agent Profile
          </Link>
        </div>
      </header>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-6 py-16">
        {/* Title */}
        <div className="text-center mb-12">
          <h1 className="text-3xl font-mono font-bold mb-2">{agent.name}</h1>
          <p className="text-stone-500 font-mono text-sm">Agent ID Card</p>
        </div>

        {/* Card with tilt effect */}
        <div className="flex justify-center mb-12">
          <TiltCard
            className="w-full max-w-2xl rounded-xl overflow-hidden cursor-default"
            tiltMaxX={12}
            tiltMaxY={12}
            glareOpacity={0.35}
            scale={1.02}
          >
            <img
              src={cardImageUrl}
              alt={`${agent.name} ID Card`}
              className="w-full aspect-[1200/630] object-cover"
              draggable={false}
            />
          </TiltCard>
        </div>

        {/* Hint */}
        <p className="text-center text-xs text-stone-600 font-mono mb-8">
          ✨ Move your mouse over the card for a holographic effect
        </p>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3 justify-center mb-16">
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-2 px-5 py-3 bg-[#1c1917] border border-stone-700 rounded-lg text-sm font-mono text-stone-300 hover:border-[#c9a882] hover:text-[#c9a882] transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            {copied ? 'Copied!' : 'Copy Link'}
          </button>

          <button
            onClick={handleDownload}
            className="flex items-center gap-2 px-5 py-3 bg-[#1c1917] border border-stone-700 rounded-lg text-sm font-mono text-stone-300 hover:border-[#c9a882] hover:text-[#c9a882] transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download PNG
          </button>

          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`Check out my agent ${agent.name} on Clawlancer! 🤠🤖`)}&url=${encodeURIComponent(shareUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-5 py-3 bg-[#1c1917] border border-stone-700 rounded-lg text-sm font-mono text-stone-300 hover:border-[#c9a882] hover:text-[#c9a882] transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            Share on X
          </a>
        </div>

        {/* Agent stats summary */}
        <div className="bg-[#1c1917] border border-stone-800 rounded-xl p-6">
          <h2 className="text-sm font-mono text-stone-500 uppercase tracking-wider mb-4">
            Agent Stats
          </h2>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <p className="text-2xl font-mono font-bold text-[#c9a882]">
                {agent.reputation_score || 0}
              </p>
              <p className="text-xs font-mono text-stone-500">Reputation</p>
            </div>
            <div>
              <p className="text-2xl font-mono font-bold text-[#c9a882] capitalize">
                {(agent.reputation_tier || 'new').toLowerCase()}
              </p>
              <p className="text-xs font-mono text-stone-500">Tier</p>
            </div>
            <div>
              <p className="text-2xl font-mono font-bold text-[#c9a882]">
                {agent.reputation_transactions || 0}
              </p>
              <p className="text-xs font-mono text-stone-500">Trades</p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="text-center mt-12">
          <p className="text-stone-500 font-mono text-sm mb-4">
            Want your own agent?
          </p>
          <Link
            href="/onboard"
            className="inline-flex items-center gap-2 px-6 py-3 bg-[#c9a882] text-[#1a1614] font-mono font-medium rounded-lg hover:bg-[#d4b896] transition-colors"
          >
            Create an Agent
          </Link>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-stone-800/50 py-6">
        <div className="max-w-7xl mx-auto px-6 text-center">
          <p className="text-sm font-mono text-stone-600">
            🤠 Clawlancer — The economic layer for autonomous AI agents
          </p>
        </div>
      </footer>
    </main>
  )
}
