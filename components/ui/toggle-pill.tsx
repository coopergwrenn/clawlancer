'use client'

import { useState, useRef, useEffect } from 'react'

interface TogglePillProps {
  options: [string, string]
  defaultValue?: 0 | 1
  onChange?: (index: 0 | 1) => void
  className?: string
}

export function TogglePill({
  options,
  defaultValue = 0,
  onChange,
  className = '',
}: TogglePillProps) {
  const [selected, setSelected] = useState<0 | 1>(defaultValue)
  const [sliderStyle, setSliderStyle] = useState<React.CSSProperties>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])

  const updateSlider = () => {
    const btn = buttonRefs.current[selected]
    const container = containerRef.current
    if (btn && container) {
      const containerRect = container.getBoundingClientRect()
      const btnRect = btn.getBoundingClientRect()
      setSliderStyle({
        width: btnRect.width,
        transform: `translateX(${btnRect.left - containerRect.left - 4}px)`,
      })
    }
  }

  useEffect(() => {
    updateSlider()
    window.addEventListener('resize', updateSlider)
    return () => window.removeEventListener('resize', updateSlider)
  }, [selected])

  const handleSelect = (index: 0 | 1) => {
    setSelected(index)
    onChange?.(index)
  }

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-center rounded-full p-1 ${className}`}
      style={{
        background: 'linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        boxShadow: `
          rgba(0,0,0,0.05) 0px 2px 2px 0px inset,
          rgba(255,255,255,0.5) 0px -2px 2px 0px inset,
          rgba(0,0,0,0.1) 0px 2px 4px 0px,
          rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset
        `,
      }}
    >
      {/* Sliding pill indicator */}
      <div
        className="absolute top-1 bottom-1 rounded-full shadow-md"
        style={{
          ...sliderStyle,
          background: '#c9a882',
          transition: 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), width 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
          willChange: 'transform, width',
        }}
      />

      {options.map((option, index) => (
        <button
          key={option}
          ref={(el) => { buttonRefs.current[index] = el }}
          onClick={() => handleSelect(index as 0 | 1)}
          className="relative z-10 px-4 py-2 text-sm font-mono rounded-full select-none"
          style={{
            color: selected === index ? '#1a1614' : '#a8a29e',
            fontWeight: selected === index ? 500 : 400,
            background: 'transparent',
            transition: 'color 0.35s cubic-bezier(0.16, 1, 0.3, 1), font-weight 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
