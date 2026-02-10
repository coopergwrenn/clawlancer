'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePrivySafe } from '@/hooks/usePrivySafe'
import { Logo } from '@/components/ui/logo'
import { NotificationBell } from '@/components/notification-bell'

const glassStyle = {
  background: 'linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  boxShadow: `
    rgba(0,0,0,0.05) 0px 2px 2px 0px inset,
    rgba(255,255,255,0.5) 0px -2px 2px 0px inset,
    rgba(0,0,0,0.1) 0px 2px 4px 0px,
    rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset
  `,
  color: '#e8ddd0',
}

const greenGlassStyle = {
  background: 'linear-gradient(-75deg, rgba(34,197,94,0.08), rgba(34,197,94,0.25), rgba(34,197,94,0.08))',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  boxShadow: `
    rgba(0,0,0,0.08) 0px 2px 2px 0px inset,
    rgba(34,197,94,0.4) 0px -2px 2px 0px inset,
    rgba(34,197,94,0.25) 0px 0px 12px 0px,
    rgba(34,197,94,0.15) 0px 0px 1.6px 4px inset
  `,
  color: '#4ade80',
  border: '1px solid rgba(34,197,94,0.25)',
}

const navLinks = [
  { href: '/marketplace', label: 'marketplace' },
  { href: '/agents', label: 'agents' },
  { href: '/leaderboard', label: 'leaderboard' },
]

interface NavBarProps {
  activePath?: string
}

export function NavBar({ activePath }: NavBarProps) {
  const { ready, authenticated, login } = usePrivySafe()
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <header className="border-b border-stone-800 px-3 sm:px-6 py-4 relative z-50">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <Logo size="md" linkTo="/" />

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-6">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`text-sm font-mono transition-colors ${
                activePath === link.href
                  ? 'text-[#c9a882]'
                  : 'text-stone-400 hover:text-[#c9a882]'
              }`}
            >
              {link.label}
            </Link>
          ))}
          {!ready ? (
            <span className="text-sm font-mono text-stone-500">...</span>
          ) : authenticated ? (
            <>
              <NotificationBell />
              <Link
                href="/marketplace?post=true"
                className="flex items-center gap-1.5 px-4 py-2 font-mono text-sm rounded-lg transition-all hover:scale-[1.04] active:scale-[0.97]"
                style={greenGlassStyle}
              >
                Post Bounty
              </Link>
              <Link
                href="/dashboard"
                className="px-4 py-2 font-mono text-sm rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={glassStyle}
              >
                dashboard
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/marketplace?post=true"
                className="flex items-center gap-1.5 px-4 py-2 font-mono text-sm rounded-lg transition-all hover:scale-[1.04] active:scale-[0.97]"
                style={greenGlassStyle}
              >
                Post Bounty
              </Link>
              <button
                onClick={login}
                className="px-4 py-2 font-mono text-sm rounded-lg cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={glassStyle}
              >
                Sign In
              </button>
            </>
          )}
        </nav>

        {/* Mobile: action button + hamburger */}
        <div className="flex md:hidden items-center gap-2">
          {ready && authenticated && <NotificationBell />}
          <Link
            href="/marketplace?post=true"
            className="flex items-center gap-1 px-3 py-1.5 font-mono text-xs rounded-lg transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={greenGlassStyle}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 5v14m-7-7h14" /></svg>
            Post Bounty
          </Link>
          {ready && !authenticated && (
            <button
              onClick={login}
              className="px-3 py-1.5 font-mono text-xs rounded-lg cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
              style={glassStyle}
            >
              Sign In
            </button>
          )}
          {ready && authenticated && (
            <Link
              href="/dashboard"
              className="px-3 py-1.5 font-mono text-xs rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98]"
              style={glassStyle}
            >
              dashboard
            </Link>
          )}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="relative w-8 h-8 flex flex-col items-center justify-center gap-[5px] rounded-lg cursor-pointer"
            aria-label="Toggle menu"
          >
            <span
              className="block w-5 h-[1.5px] bg-stone-400 rounded-full transition-all duration-300"
              style={{
                transform: mobileOpen ? 'rotate(45deg) translateY(3.25px)' : 'none',
              }}
            />
            <span
              className="block w-5 h-[1.5px] bg-stone-400 rounded-full transition-all duration-300"
              style={{
                opacity: mobileOpen ? 0 : 1,
              }}
            />
            <span
              className="block w-5 h-[1.5px] bg-stone-400 rounded-full transition-all duration-300"
              style={{
                transform: mobileOpen ? 'rotate(-45deg) translateY(-3.25px)' : 'none',
              }}
            />
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      <div
        className="md:hidden overflow-hidden"
        style={{
          maxHeight: mobileOpen ? '300px' : '0px',
          opacity: mobileOpen ? 1 : 0,
          transition: 'max-height 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease',
        }}
      >
        <nav className="pt-4 pb-2 flex flex-col gap-1 max-w-7xl mx-auto">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className={`block px-3 py-2.5 text-sm font-mono rounded-lg transition-colors ${
                activePath === link.href
                  ? 'text-[#c9a882] bg-white/[0.04]'
                  : 'text-stone-400 hover:text-[#c9a882] hover:bg-white/[0.03]'
              }`}
            >
              {link.label}
            </Link>
          ))}
          <div
            className="mt-2 h-[1px]"
            style={{
              background: 'linear-gradient(90deg, transparent, rgba(201,168,130,0.15), transparent)',
            }}
          />
        </nav>
      </div>
    </header>
  )
}
