'use client'

import { useRef, useState, useCallback, ReactNode } from 'react'

interface TiltCardProps {
  children: ReactNode
  className?: string
  tiltMaxX?: number
  tiltMaxY?: number
  glareOpacity?: number
  scale?: number
  transitionDuration?: number
}

export function TiltCard({
  children,
  className = '',
  tiltMaxX = 15,
  tiltMaxY = 15,
  glareOpacity = 0.5,
  scale = 1.02,
  transitionDuration = 400,
}: TiltCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState('')
  const [glarePosition, setGlarePosition] = useState({ x: 50, y: 50 })
  const [isHovering, setIsHovering] = useState(false)

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!cardRef.current) return

      const rect = cardRef.current.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2

      // Calculate mouse position relative to center (-1 to 1)
      const mouseX = (e.clientX - centerX) / (rect.width / 2)
      const mouseY = (e.clientY - centerY) / (rect.height / 2)

      // Calculate tilt angles
      const tiltX = mouseY * -tiltMaxX // Invert Y for natural tilt
      const tiltY = mouseX * tiltMaxY

      // Set transform
      setTransform(
        `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale3d(${scale}, ${scale}, ${scale})`
      )

      // Calculate glare position (0-100%)
      const glareX = ((e.clientX - rect.left) / rect.width) * 100
      const glareY = ((e.clientY - rect.top) / rect.height) * 100
      setGlarePosition({ x: glareX, y: glareY })
    },
    [tiltMaxX, tiltMaxY, scale]
  )

  const handleMouseEnter = useCallback(() => {
    setIsHovering(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false)
    setTransform('')
    setGlarePosition({ x: 50, y: 50 })
  }, [])

  // Calculate gradient offset based on mouse position for holographic shift
  const holoOffset = (glarePosition.x - 50) * 0.8
  const holoOffsetY = (glarePosition.y - 50) * 0.3

  return (
    <div
      ref={cardRef}
      className={`relative ${className}`}
      style={{
        transform: transform,
        transition: isHovering
          ? 'transform 0.1s ease-out'
          : `transform ${transitionDuration}ms ease-out`,
        transformStyle: 'preserve-3d',
        willChange: 'transform',
      }}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {/* RGB Holographic overlay container */}
      <div
        className="pointer-events-none absolute inset-0 rounded-xl overflow-hidden"
        style={{
          opacity: isHovering ? 1 : 0,
          transition: `opacity ${transitionDuration}ms ease-out`,
        }}
      >
        {/* LAYER 1: Main RGB bands with HARD color stops - shifts with mouse */}
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(
              ${125 + holoOffsetY}deg,
              transparent ${0 + holoOffset}%,
              transparent ${5 + holoOffset}%,
              rgba(255,50,150,0.35) ${5 + holoOffset}%,
              rgba(255,50,150,0.35) ${12 + holoOffset}%,
              rgba(255,0,100,0.3) ${12 + holoOffset}%,
              rgba(255,0,100,0.3) ${18 + holoOffset}%,
              rgba(150,50,255,0.3) ${18 + holoOffset}%,
              rgba(150,50,255,0.3) ${25 + holoOffset}%,
              rgba(50,150,255,0.35) ${25 + holoOffset}%,
              rgba(50,150,255,0.35) ${32 + holoOffset}%,
              rgba(0,255,200,0.4) ${32 + holoOffset}%,
              rgba(0,255,200,0.4) ${40 + holoOffset}%,
              rgba(50,255,100,0.4) ${40 + holoOffset}%,
              rgba(50,255,100,0.4) ${48 + holoOffset}%,
              rgba(150,255,50,0.35) ${48 + holoOffset}%,
              rgba(150,255,50,0.35) ${55 + holoOffset}%,
              rgba(255,255,50,0.3) ${55 + holoOffset}%,
              rgba(255,255,50,0.3) ${62 + holoOffset}%,
              rgba(255,150,50,0.3) ${62 + holoOffset}%,
              rgba(255,150,50,0.3) ${70 + holoOffset}%,
              rgba(255,100,80,0.3) ${70 + holoOffset}%,
              rgba(255,100,80,0.3) ${78 + holoOffset}%,
              rgba(255,50,120,0.3) ${78 + holoOffset}%,
              rgba(255,50,120,0.3) ${85 + holoOffset}%,
              transparent ${85 + holoOffset}%,
              transparent 100%
            )`,
            mixBlendMode: 'screen',
            transition: isHovering ? 'none' : `all ${transitionDuration}ms ease-out`,
          }}
        />

        {/* LAYER 2: Secondary bands - offset and shifts opposite direction */}
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(
              ${155 - holoOffsetY * 0.5}deg,
              transparent ${0 - holoOffset * 0.5}%,
              transparent ${15 - holoOffset * 0.5}%,
              rgba(0,255,255,0.25) ${15 - holoOffset * 0.5}%,
              rgba(0,255,255,0.25) ${25 - holoOffset * 0.5}%,
              rgba(100,100,255,0.3) ${25 - holoOffset * 0.5}%,
              rgba(100,100,255,0.3) ${35 - holoOffset * 0.5}%,
              rgba(200,50,255,0.2) ${35 - holoOffset * 0.5}%,
              rgba(200,50,255,0.2) ${45 - holoOffset * 0.5}%,
              rgba(255,50,200,0.15) ${45 - holoOffset * 0.5}%,
              rgba(255,50,200,0.15) ${55 - holoOffset * 0.5}%,
              transparent ${55 - holoOffset * 0.5}%,
              transparent 100%
            )`,
            mixBlendMode: 'screen',
            opacity: 0.8,
            transition: isHovering ? 'none' : `all ${transitionDuration}ms ease-out`,
          }}
        />

        {/* LAYER 3: Bright hotspot glare following mouse */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(
              ellipse 60% 50% at ${glarePosition.x}% ${glarePosition.y}%,
              rgba(255, 255, 255, ${glareOpacity * 0.6}) 0%,
              rgba(0, 255, 200, ${glareOpacity * 0.3}) 30%,
              transparent 70%
            )`,
            transition: isHovering ? 'none' : `all ${transitionDuration}ms ease-out`,
          }}
        />

        {/* LAYER 4: Edge glow effect */}
        <div
          className="absolute inset-0"
          style={{
            background: `
              linear-gradient(90deg, rgba(255,50,150,0.2) 0%, transparent 10%, transparent 90%, rgba(0,255,200,0.2) 100%),
              linear-gradient(180deg, rgba(50,150,255,0.15) 0%, transparent 10%, transparent 90%, rgba(150,255,50,0.15) 100%)
            `,
            opacity: isHovering ? 1 : 0,
            transition: `opacity ${transitionDuration}ms ease-out`,
          }}
        />

        {/* LAYER 5: Noise/grain texture overlay */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            backgroundSize: '100px 100px',
            opacity: 0.08,
            mixBlendMode: 'overlay',
          }}
        />
      </div>

      {/* RGB Glow drop shadow for depth */}
      <div
        className="absolute inset-0 -z-10 rounded-xl"
        style={{
          boxShadow: isHovering
            ? `${(glarePosition.x - 50) * 0.5}px ${(glarePosition.y - 50) * 0.5 + 15}px 50px rgba(0, 0, 0, 0.6),
               ${(glarePosition.x - 50) * 0.3}px ${(glarePosition.y - 50) * 0.3 + 8}px 25px rgba(0, 0, 0, 0.5),
               0 0 60px rgba(0, 255, 200, 0.15),
               0 0 100px rgba(150, 50, 255, 0.1)`
            : '0 15px 50px rgba(0, 0, 0, 0.5), 0 5px 20px rgba(0, 0, 0, 0.4)',
          transition: isHovering ? 'box-shadow 0.1s ease-out' : `box-shadow ${transitionDuration}ms ease-out`,
        }}
      />
    </div>
  )
}
