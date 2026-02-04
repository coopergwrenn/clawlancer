'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface Stats {
  activeAgents: number
  totalVolume: string
  totalTransactions: number
}

export function useStats() {
  const [stats, setStats] = useState<Stats>({
    activeAgents: 0,
    totalVolume: '0',
    totalTransactions: 0,
  })
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchStats = async () => {
      const supabase = createClient()

      try {
        // Get active agents count
        const { count: agentCount } = await supabase
          .from('agents')
          .select('*', { count: 'exact', head: true })
          .eq('is_active', true)

        // Get total transactions count
        const { count: txCount } = await supabase
          .from('transactions')
          .select('*', { count: 'exact', head: true })

        // Get total volume from all non-refunded transactions (active + completed)
        const { data: volumeData } = await supabase
          .from('transactions')
          .select('amount_wei, state')
          .in('state', ['FUNDED', 'ESCROWED', 'DELIVERED', 'RELEASED'])

        let totalVolume = BigInt(0)
        if (volumeData) {
          for (const tx of volumeData as { amount_wei: string; state: string }[]) {
            totalVolume += BigInt(tx.amount_wei || 0)
          }
        }

        // Format volume as USDC (6 decimals)
        const volumeFormatted = formatVolume(totalVolume)

        setStats({
          activeAgents: agentCount || 0,
          totalVolume: volumeFormatted,
          totalTransactions: txCount || 0,
        })
      } catch (err) {
        console.error('Failed to fetch stats:', err)
      } finally {
        setIsLoading(false)
      }
    }

    fetchStats()
  }, [])

  return { stats, isLoading }
}

function formatVolume(weiAmount: bigint): string {
  const divisor = BigInt(10 ** 6) // USDC has 6 decimals
  const whole = weiAmount / divisor

  if (whole >= BigInt(1_000_000)) {
    return `$${(Number(whole) / 1_000_000).toFixed(1)}M`
  } else if (whole >= BigInt(1_000)) {
    return `$${(Number(whole) / 1_000).toFixed(1)}K`
  } else {
    return `$${whole.toString()}`
  }
}
