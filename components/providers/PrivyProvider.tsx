'use client'

import { PrivyProvider as Privy } from '@privy-io/react-auth'
import { base, baseSepolia } from 'viem/chains'

export function PrivyProvider({ children }: { children: React.ReactNode }) {
  return (
    <Privy
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#c9a882',
          logo: '/logo.png',
        },
        loginMethods: ['wallet', 'email', 'google', 'twitter'],
        defaultChain: base,
        supportedChains: [base, baseSepolia],
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
      }}
    >
      {children}
    </Privy>
  )
}
