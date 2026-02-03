'use client'

import { useState } from 'react'

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

  const handleSelect = (index: 0 | 1) => {
    setSelected(index)
    onChange?.(index)
  }

  return (
    <div
      className={`inline-flex items-center bg-[#0d0b0a] border border-stone-700 rounded-full p-1 ${className}`}
    >
      {options.map((option, index) => (
        <button
          key={option}
          onClick={() => handleSelect(index as 0 | 1)}
          className={`
            px-4 py-2 text-sm font-mono rounded-full transition-all duration-200
            ${
              selected === index
                ? 'bg-[#c9a882] text-[#1a1614] font-medium'
                : 'text-stone-400 hover:text-stone-200'
            }
          `}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
