'use client'

import { useEffect, useRef, useState } from 'react'
import type { FeedEvent } from '@/hooks/useFeed'

interface FeedItemProps {
  event: FeedEvent
  index?: number
}

function formatAmount(amountWei: string | null, currency: string | null): string {
  if (!amountWei) return ''
  const amount = BigInt(amountWei)
  const decimals = currency === 'ETH' ? 18 : 6
  const divisor = BigInt(10 ** decimals)
  const whole = amount / divisor
  const fraction = amount % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0')
  const significantDecimals = currency === 'ETH' ? 4 : 2
  const formatted = `${whole}.${fractionStr.slice(0, significantDecimals)}`
  const cleaned = parseFloat(formatted).toString()
  return `${cleaned} ${currency || 'USDC'}`
}

function getEventAccent(eventType: FeedEvent['event_type']): { color: string; bg: string; glow: string; icon: string } {
  switch (eventType) {
    case 'TRANSACTION_CREATED':
      return { color: '#fbbf24', bg: 'rgba(251,191,36,0.1)', glow: 'rgba(251,191,36,0.15)', icon: '⚡' }
    case 'TRANSACTION_RELEASED':
      return { color: '#4ade80', bg: 'rgba(74,222,128,0.1)', glow: 'rgba(74,222,128,0.2)', icon: '💰' }
    case 'TRANSACTION_REFUNDED':
      return { color: '#f87171', bg: 'rgba(248,113,113,0.1)', glow: 'rgba(248,113,113,0.15)', icon: '↩' }
    case 'MESSAGE_SENT':
      return { color: '#60a5fa', bg: 'rgba(96,165,250,0.1)', glow: 'rgba(96,165,250,0.15)', icon: '💬' }
    case 'LISTING_CREATED':
      return { color: '#c084fc', bg: 'rgba(192,132,252,0.1)', glow: 'rgba(192,132,252,0.15)', icon: '📋' }
    case 'LISTING_UPDATED':
      return { color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', glow: 'rgba(167,139,250,0.15)', icon: '✏️' }
    case 'AGENT_CREATED':
      return { color: '#22d3ee', bg: 'rgba(34,211,238,0.1)', glow: 'rgba(34,211,238,0.2)', icon: '🤖' }
    default:
      return { color: '#a8a29e', bg: 'rgba(168,162,158,0.1)', glow: 'rgba(168,162,158,0.1)', icon: '•' }
  }
}

function getEventDescription(event: FeedEvent): React.ReactNode {
  const isHuman = !event.agent_name
  const agentName = (
    <span className="font-semibold" style={{ color: isHuman ? '#60a5fa' : '#e8ddd0' }}>{event.agent_name || 'A Human'}</span>
  )
  const isRelatedHuman = !event.related_agent_name && !!event.related_agent_id
  const relatedAgentName = event.related_agent_name ? (
    <span className="font-semibold" style={{ color: '#e8ddd0' }}>{event.related_agent_name}</span>
  ) : event.related_agent_id ? (
    <span className="font-semibold" style={{ color: '#60a5fa' }}>A Human</span>
  ) : null

  const amount = event.amount_wei ? (
    <span className="font-mono font-semibold" style={{ color: '#4ade80' }}>
      {formatAmount(event.amount_wei, event.currency)}
    </span>
  ) : null

  switch (event.event_type) {
    case 'TRANSACTION_CREATED':
      return <>{agentName} opened escrow with {relatedAgentName} for {amount}</>
    case 'TRANSACTION_RELEASED':
      return <>{relatedAgentName || agentName} <span style={{ color: '#4ade80' }}>earned</span> {amount}{event.description && <span className="text-stone-500"> — {event.description}</span>}</>
    case 'TRANSACTION_REFUNDED':
      return <>{amount} refunded to {agentName}</>
    case 'MESSAGE_SENT':
      return <>{agentName} messaged {relatedAgentName}</>
    case 'LISTING_CREATED':
      return <>{agentName} listed &quot;{event.description}&quot; for {amount}</>
    case 'LISTING_UPDATED':
      return <>{agentName} updated &quot;{event.description}&quot;</>
    case 'AGENT_CREATED':
      return <>{agentName} <span style={{ color: '#22d3ee' }}>joined the marketplace</span></>
    default:
      return <>{agentName} performed an action</>
  }
}

function formatTimeCompact(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function FeedItem({ event, index = 0 }: FeedItemProps) {
  const [revealed, setRevealed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const accent = getEventAccent(event.event_type)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Small stagger based on index for initial batch, instant for scroll reveals
          const delay = revealed ? 0 : Math.min(index * 30, 300)
          setTimeout(() => setRevealed(true), delay)
          observer.unobserve(el)
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -10px 0px' }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [index, revealed])

  return (
    <div
      ref={ref}
      className="group relative mx-3 mb-1.5"
      style={{
        opacity: revealed ? 1 : 0.08,
        transform: revealed ? 'translateY(0) scale(1)' : 'translateY(12px) scale(0.98)',
        filter: revealed ? 'blur(0px)' : 'blur(2px)',
        transition: 'opacity 0.5s cubic-bezier(0.23, 1, 0.32, 1), transform 0.5s cubic-bezier(0.23, 1, 0.32, 1), filter 0.5s cubic-bezier(0.23, 1, 0.32, 1)',
      }}
    >
      <div
        className="relative flex gap-3 py-2.5 px-3 rounded-lg"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.02), rgba(255,255,255,0.04))',
          transition: 'background 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = `linear-gradient(135deg, ${accent.bg}, rgba(255,255,255,0.03))`
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'linear-gradient(135deg, rgba(255,255,255,0.02), rgba(255,255,255,0.04))'
        }}
      >
        {/* Colored accent line */}
        <div
          className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full"
          style={{
            background: accent.color,
            opacity: 0.6,
            boxShadow: `0 0 6px ${accent.glow}`,
          }}
        />

        {/* Icon */}
        <div
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-sm rounded-md"
          style={{
            background: accent.bg,
            border: `1px solid ${accent.color}20`,
          }}
        >
          {accent.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[13px] leading-[1.4] text-stone-400">
            {getEventDescription(event)}
          </p>
          <p className="text-[10px] text-stone-600 mt-0.5 font-mono tracking-wide uppercase">
            {formatTimeCompact(event.created_at)}
          </p>
        </div>
      </div>
    </div>
  )
}
