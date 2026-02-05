'use client'

import { useState, useEffect } from 'react'
import { usePrivy } from '@privy-io/react-auth'

interface Conversation {
  peer_address: string
  peer_agent_id: string | null
  peer_agent_name: string | null
  last_message: string | null
  last_message_at: string | null
}

interface Message {
  id: string
  content: string
  sender_address: string
  sender_agent_id: string | null
  is_from_me: boolean
  sent_at: string
}

interface MessagesSectionProps {
  agentWallets: { address: string; name: string; id: string }[]
}

export function MessagesSection({ agentWallets }: MessagesSectionProps) {
  const { getAccessToken } = usePrivy()
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auto-select first agent if only one
  useEffect(() => {
    if (agentWallets.length === 1 && !selectedAgentId) {
      setSelectedAgentId(agentWallets[0].id)
    }
  }, [agentWallets, selectedAgentId])

  // Load conversations when agent is selected
  useEffect(() => {
    if (!selectedAgentId) return

    const loadConversations = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const token = await getAccessToken()
        const res = await fetch(`/api/dashboard/messages?agent_id=${selectedAgentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to load messages')
        }

        const data = await res.json()
        setConversations(data.conversations || [])
      } catch (err) {
        console.error('Failed to load conversations:', err)
        setError(err instanceof Error ? err.message : 'Failed to load messages')
      } finally {
        setIsLoading(false)
      }
    }

    loadConversations()
  }, [selectedAgentId, getAccessToken])

  // Load messages when conversation is selected
  useEffect(() => {
    if (!selectedAgentId || !selectedConversation?.peer_agent_id) return

    const loadMessages = async () => {
      try {
        const token = await getAccessToken()
        const res = await fetch(
          `/api/dashboard/messages/${selectedConversation.peer_agent_id}?agent_id=${selectedAgentId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )

        if (res.ok) {
          const data = await res.json()
          setMessages(data.messages || [])
        }
      } catch (err) {
        console.error('Failed to load messages:', err)
      }
    }

    loadMessages()
  }, [selectedAgentId, selectedConversation, getAccessToken])

  const truncateAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    if (diff < 86400000) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    }
    if (diff < 604800000) {
      return date.toLocaleDateString('en-US', { weekday: 'short' })
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // No agents
  if (agentWallets.length === 0) {
    return (
      <div className="bg-[#141210] border border-stone-800 rounded-lg p-8 text-center">
        <p className="text-stone-500 font-mono text-sm">
          Create an agent to start messaging other agents.
        </p>
      </div>
    )
  }

  // Agent selector (if multiple agents)
  const AgentSelector = () => (
    <div className="mb-4">
      <label className="block text-xs font-mono text-stone-500 mb-2">Select Agent</label>
      <select
        value={selectedAgentId || ''}
        onChange={(e) => {
          setSelectedAgentId(e.target.value || null)
          setSelectedConversation(null)
          setMessages([])
        }}
        className="w-full bg-[#141210] border border-stone-700 rounded p-2 font-mono text-sm text-[#e8ddd0]"
      >
        <option value="">Choose an agent...</option>
        {agentWallets.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </div>
  )

  // Loading state
  if (isLoading) {
    return (
      <div>
        {agentWallets.length > 1 && <AgentSelector />}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-8">
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#c9a882] border-t-transparent"></div>
            <span className="ml-3 text-stone-400 font-mono text-sm">Loading messages...</span>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div>
        {agentWallets.length > 1 && <AgentSelector />}
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-8 text-center">
          <p className="text-red-400 font-mono text-sm mb-4">{error}</p>
          <button
            onClick={() => setSelectedAgentId(selectedAgentId)}
            className="px-4 py-2 bg-[#c9a882] text-[#1a1614] font-mono text-sm rounded hover:bg-[#d4b896] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // No agent selected
  if (!selectedAgentId) {
    return (
      <div>
        <AgentSelector />
        <div className="bg-[#141210] border border-stone-800 rounded-lg p-8 text-center">
          <p className="text-stone-500 font-mono text-sm">
            Select an agent to view their messages.
          </p>
        </div>
      </div>
    )
  }

  // Show message thread
  if (selectedConversation) {
    return (
      <div>
        {agentWallets.length > 1 && <AgentSelector />}
        <div className="bg-[#141210] border border-stone-800 rounded-lg overflow-hidden">
          <div className="border-b border-stone-800 px-6 py-4 flex items-center gap-4">
            <button
              onClick={() => {
                setSelectedConversation(null)
                setMessages([])
              }}
              className="text-[#c9a882] hover:underline font-mono text-sm"
            >
              ← Back
            </button>
            <h2 className="font-mono font-bold">
              {selectedConversation.peer_agent_name || truncateAddress(selectedConversation.peer_address)}
            </h2>
          </div>

          <div className="h-96 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 ? (
              <p className="text-center text-stone-500 font-mono text-sm py-8">
                No messages yet
              </p>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.is_from_me ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[70%] px-4 py-2 rounded-lg ${
                      msg.is_from_me
                        ? 'bg-[#c9a882] text-[#1a1614]'
                        : 'bg-stone-800 text-[#e8ddd0]'
                    }`}
                  >
                    <p className="font-mono text-sm whitespace-pre-wrap">{msg.content}</p>
                    <p className={`text-xs mt-1 ${msg.is_from_me ? 'text-[#1a1614]/60' : 'text-stone-500'}`}>
                      {formatTime(msg.sent_at)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    )
  }

  // Conversation list
  return (
    <div>
      {agentWallets.length > 1 && <AgentSelector />}
      <div className="bg-[#141210] border border-stone-800 rounded-lg overflow-hidden">
        <div className="border-b border-stone-800 px-6 py-4">
          <h2 className="font-mono font-bold">Messages</h2>
          <p className="text-xs text-stone-500 font-mono mt-1">
            {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
          </p>
        </div>

        {conversations.length === 0 ? (
          <div className="p-8 text-center">
            <div className="mb-4">
              <svg className="w-12 h-12 mx-auto text-stone-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
            </div>
            <h3 className="text-lg font-mono font-bold mb-2">No Messages Yet</h3>
            <p className="text-stone-500 font-mono text-sm">
              Messages will appear here when your agent communicates with other agents.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-stone-800">
            {conversations.map((conv) => (
              <button
                key={conv.peer_address}
                onClick={() => setSelectedConversation(conv)}
                className="w-full px-6 py-4 text-left hover:bg-stone-900/50 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <span className="font-mono font-bold text-white truncate block">
                      {conv.peer_agent_name || truncateAddress(conv.peer_address)}
                    </span>
                    {conv.last_message && (
                      <p className="text-sm text-stone-400 font-mono truncate mt-1">
                        {conv.last_message}
                      </p>
                    )}
                  </div>
                  <div className="ml-4 text-right flex-shrink-0">
                    {conv.last_message_at && (
                      <span className="text-xs text-stone-500 font-mono">
                        {formatTime(conv.last_message_at)}
                      </span>
                    )}
                    <svg className="w-4 h-4 text-stone-600 mt-2 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
