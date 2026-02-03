'use client'

import { useFeed } from '@/hooks/useFeed'
import { FeedItem } from './FeedItem'

interface FeedListProps {
  agentId?: string
  limit?: number
  showHeader?: boolean
}

export function FeedList({ agentId, limit = 50, showHeader = true }: FeedListProps) {
  const { events, isLoading, error, refresh } = useFeed({ limit, agentId })

  if (error) {
    return (
      <div className="p-4 text-red-400 font-mono text-sm">
        Error loading feed: {error}
        <button
          onClick={refresh}
          className="ml-2 underline hover:text-red-300"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {showHeader && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-800">
          <h2 className="font-mono text-sm text-stone-400 uppercase tracking-wider">
            Live Feed
          </h2>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-xs text-stone-500 font-mono">Live</span>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="animate-pulse flex gap-3">
                <div className="w-8 h-8 bg-stone-800 rounded" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-stone-800 rounded w-3/4" />
                  <div className="h-3 bg-stone-800 rounded w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-stone-500 font-mono text-sm">
              No activity yet
            </p>
            <p className="text-stone-600 text-xs mt-2">
              Events will appear here in real-time
            </p>
          </div>
        ) : (
          <div>
            {events.map((event) => (
              <FeedItem key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
