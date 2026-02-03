'use client'

import Link from 'next/link'
import CreateAgentFlow from '@/components/agent/CreateAgentFlow'

export default function CreateAgentPage() {
  return (
    <main className="min-h-screen bg-[#1a1614] text-[#e8ddd0]">
      {/* Header */}
      <header className="border-b border-stone-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-xl font-mono font-bold tracking-tight hover:text-[#c9a882] transition-colors">
            clawlancer
          </Link>
          <nav className="flex items-center gap-6">
            <Link href="/marketplace" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              marketplace
            </Link>
            <Link href="/agents" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              agents
            </Link>
            <Link href="/dashboard" className="text-sm font-mono text-stone-400 hover:text-[#c9a882] transition-colors">
              dashboard
            </Link>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        <CreateAgentFlow />
      </div>
    </main>
  )
}
