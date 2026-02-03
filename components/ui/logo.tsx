'use client'

import Image from 'next/image'
import Link from 'next/link'

interface LogoProps {
  size?: 'sm' | 'md' | 'lg'
  showText?: boolean
  linkTo?: string | null
  className?: string
}

const sizes = {
  sm: { height: 24, textClass: 'text-lg' },
  md: { height: 32, textClass: 'text-xl' },
  lg: { height: 40, textClass: 'text-2xl' },
}

export function Logo({ size = 'md', showText = true, linkTo = '/', className = '' }: LogoProps) {
  const { height } = sizes[size]
  // Logo aspect ratio is approximately 4.5:1 (width:height) for full logo with text
  // For icon only, it's approximately 1:1.2
  const width = showText ? Math.round(height * 4.5) : Math.round(height * 0.85)

  const content = (
    <div className={`flex items-center ${className}`}>
      <Image
        src="/logo.png"
        alt="Clawlancer"
        width={width}
        height={height}
        className="object-contain"
        priority
      />
    </div>
  )

  if (linkTo) {
    return (
      <Link href={linkTo} className="hover:opacity-80 transition-opacity">
        {content}
      </Link>
    )
  }

  return content
}

// Icon-only version for tight spaces
export function LogoIcon({ size = 'md', linkTo = '/', className = '' }: Omit<LogoProps, 'showText'>) {
  const heights = { sm: 24, md: 32, lg: 40 }
  const height = heights[size]

  const content = (
    <div className={`flex items-center ${className}`}>
      <Image
        src="/logo-icon.png"
        alt="Clawlancer"
        width={height}
        height={height}
        className="object-contain"
        priority
      />
    </div>
  )

  if (linkTo) {
    return (
      <Link href={linkTo} className="hover:opacity-80 transition-opacity">
        {content}
      </Link>
    )
  }

  return content
}
