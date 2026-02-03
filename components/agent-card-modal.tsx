'use client'

import { useState, useEffect } from 'react'
import { TiltCard } from '@/components/ui/tilt-card'

interface AgentCardModalProps {
  agentId: string
  agentName: string
  isOpen: boolean
  onClose: () => void
}

export function AgentCardModal({ agentId, agentName, isOpen, onClose }: AgentCardModalProps) {
  const [copied, setCopied] = useState(false)
  const cardUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/agents/${agentId}/card`
  const imageUrl = `/api/agents/${agentId}/card`

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      window.addEventListener('keydown', handleEscape)
    }
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(cardUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const handleDownload = async () => {
    try {
      const response = await fetch(imageUrl)
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agentName.toLowerCase().replace(/\s+/g, '-')}-id-card.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to download:', err)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* Modal content */}
      <div
        className="relative z-10 flex flex-col items-center gap-6 p-6 max-w-4xl w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-2 text-stone-400 hover:text-white transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Card with tilt effect */}
        <TiltCard className="w-full max-w-2xl aspect-[1200/630] rounded-lg overflow-hidden">
          <img
            src={imageUrl}
            alt={`${agentName} ID Card`}
            className="w-full h-full object-cover"
          />
        </TiltCard>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3 justify-center">
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-2 px-5 py-2.5 bg-[#1c1917] border border-stone-700 rounded-lg text-sm font-mono text-stone-300 hover:border-stone-500 hover:text-white transition-colors"
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
            className="flex items-center gap-2 px-5 py-2.5 bg-[#1c1917] border border-stone-700 rounded-lg text-sm font-mono text-stone-300 hover:border-stone-500 hover:text-white transition-colors"
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
            href={`https://twitter.com/intent/tweet?text=Check out my agent ${encodeURIComponent(agentName)} on Wild West Bots!&url=${encodeURIComponent(cardUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-5 py-2.5 bg-[#1c1917] border border-stone-700 rounded-lg text-sm font-mono text-stone-300 hover:border-stone-500 hover:text-white transition-colors"
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

        {/* Hint text */}
        <p className="text-xs text-stone-500 font-mono">
          Move your mouse over the card for a holographic effect
        </p>
      </div>
    </div>
  )
}

// Simple button to trigger the modal
interface ViewCardButtonProps {
  agentId: string
  agentName: string
  variant?: 'default' | 'small' | 'icon'
  className?: string
}

export function ViewCardButton({
  agentId,
  agentName,
  variant = 'default',
  className = '',
}: ViewCardButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false)

  if (variant === 'icon') {
    return (
      <>
        <button
          onClick={() => setIsModalOpen(true)}
          className={`p-2 text-stone-400 hover:text-[#c9a882] transition-colors ${className}`}
          title="View ID Card"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="2" />
            <path d="M15 8h2" />
            <path d="M15 12h2" />
            <path d="M7 16h10" />
          </svg>
        </button>
        <AgentCardModal
          agentId={agentId}
          agentName={agentName}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
        />
      </>
    )
  }

  if (variant === 'small') {
    return (
      <>
        <button
          onClick={() => setIsModalOpen(true)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-stone-400 hover:text-[#c9a882] transition-colors ${className}`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="2" />
            <path d="M15 8h2" />
            <path d="M15 12h2" />
            <path d="M7 16h10" />
          </svg>
          ID Card
        </button>
        <AgentCardModal
          agentId={agentId}
          agentName={agentName}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
        />
      </>
    )
  }

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className={`flex items-center gap-2 px-4 py-2 bg-[#1c1917] border border-stone-700 rounded text-sm font-mono text-stone-300 hover:border-[#c9a882] hover:text-[#c9a882] transition-colors ${className}`}
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
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="2" />
          <path d="M15 8h2" />
          <path d="M15 12h2" />
          <path d="M7 16h10" />
        </svg>
        View ID Card
      </button>
      <AgentCardModal
        agentId={agentId}
        agentName={agentName}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </>
  )
}
