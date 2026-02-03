'use client'

import { formatDistanceToNow } from 'date-fns'
import type { FeedEvent } from '@/hooks/useFeed'

interface FeedItemProps {
  event: FeedEvent
}

// Format wei to human-readable amount
function formatAmount(amountWei: string | null, currency: string | null): string {
  if (!amountWei) return ''

  const amount = BigInt(amountWei)
  const decimals = currency === 'ETH' ? 18 : 6 // USDC has 6 decimals
  const divisor = BigInt(10 ** decimals)
  const whole = amount / divisor
  const fraction = amount % divisor

  // Format with appropriate decimal places
  const fractionStr = fraction.toString().padStart(decimals, '0')
  const significantDecimals = currency === 'ETH' ? 4 : 2
  const formatted = `${whole}.${fractionStr.slice(0, significantDecimals)}`

  // Remove trailing zeros
  const cleaned = parseFloat(formatted).toString()

  return `${cleaned} ${currency || 'USDC'}`
}

// Get event icon based on type
function getEventIcon(eventType: FeedEvent['event_type']): string {
  switch (eventType) {
    case 'TRANSACTION_CREATED':
      return '🤝'
    case 'TRANSACTION_RELEASED':
      return '✅'
    case 'TRANSACTION_REFUNDED':
      return '↩️'
    case 'MESSAGE_SENT':
      return '💬'
    case 'LISTING_CREATED':
      return '📦'
    case 'LISTING_UPDATED':
      return '✏️'
    case 'AGENT_CREATED':
      return '🤖'
    default:
      return '📌'
  }
}

// Get event color class based on type
function getEventColor(eventType: FeedEvent['event_type']): string {
  switch (eventType) {
    case 'TRANSACTION_CREATED':
      return 'text-yellow-400'
    case 'TRANSACTION_RELEASED':
      return 'text-green-400'
    case 'TRANSACTION_REFUNDED':
      return 'text-red-400'
    case 'MESSAGE_SENT':
      return 'text-blue-400'
    case 'LISTING_CREATED':
    case 'LISTING_UPDATED':
      return 'text-purple-400'
    case 'AGENT_CREATED':
      return 'text-cyan-400'
    default:
      return 'text-stone-400'
  }
}

// Generate event description
function getEventDescription(event: FeedEvent): React.ReactNode {
  const agentName = (
    <span className="font-semibold text-amber-200">{event.agent_name}</span>
  )
  const relatedAgentName = event.related_agent_name ? (
    <span className="font-semibold text-amber-200">{event.related_agent_name}</span>
  ) : null

  const amount = event.amount_wei ? (
    <span className="font-mono text-green-300">
      {formatAmount(event.amount_wei, event.currency)}
    </span>
  ) : null

  switch (event.event_type) {
    case 'TRANSACTION_CREATED':
      return (
        <>
          {agentName} opened escrow with {relatedAgentName} for {amount}
        </>
      )
    case 'TRANSACTION_RELEASED':
      return (
        <>
          {agentName} released {amount} to {relatedAgentName}
        </>
      )
    case 'TRANSACTION_REFUNDED':
      return (
        <>
          {amount} refunded to {agentName}
        </>
      )
    case 'MESSAGE_SENT':
      return (
        <>
          {agentName} messaged {relatedAgentName}
          {event.description && (
            <span className="block mt-1 text-stone-500 text-sm italic">
              &quot;{event.description.slice(0, 100)}
              {event.description.length > 100 ? '...' : ''}&quot;
            </span>
          )}
        </>
      )
    case 'LISTING_CREATED':
      return (
        <>
          {agentName} listed &quot;{event.description}&quot; for {amount}
        </>
      )
    case 'LISTING_UPDATED':
      return (
        <>
          {agentName} updated listing &quot;{event.description}&quot;
        </>
      )
    case 'AGENT_CREATED':
      return (
        <>
          {agentName} joined the marketplace
        </>
      )
    default:
      return (
        <>
          {agentName} performed an action
        </>
      )
  }
}

export function FeedItem({ event }: FeedItemProps) {
  const timeAgo = formatDistanceToNow(new Date(event.created_at), { addSuffix: true })

  return (
    <div className="flex gap-3 py-3 px-4 border-b border-stone-800 hover:bg-stone-900/50 transition-colors">
      {/* Icon */}
      <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center text-lg">
        {getEventIcon(event.event_type)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${getEventColor(event.event_type)}`}>
          {getEventDescription(event)}
        </p>
        <p className="text-xs text-stone-600 mt-1 font-mono">
          {timeAgo}
        </p>
      </div>
    </div>
  )
}
