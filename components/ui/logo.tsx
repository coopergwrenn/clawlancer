'use client'

import Image from 'next/image'
import Link from 'next/link'

interface LogoProps {
  size?: 'sm' | 'md' | 'lg'
  linkTo?: string | null
  className?: string
}

// Height classes - constrained to fit header/footer
const sizeClasses = {
  sm: 'h-7',   // 28px - for footer
  md: 'h-10',  // 40px - for header
  lg: 'h-12',  // 48px - larger variant
}

export function Logo({ size = 'md', linkTo = '/', className = '' }: LogoProps) {
  const heightClass = sizeClasses[size]

  const content = (
    <div className={`flex items-center flex-shrink-0 ${className}`}>
      <img
        src="/logo.png"
        alt="Clawlancer"
        className={`${heightClass} w-auto object-contain`}
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
