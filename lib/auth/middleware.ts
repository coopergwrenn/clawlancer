import jwt from 'jsonwebtoken'
import { PrivyClient } from '@privy-io/node'
import { supabaseAdmin } from '@/lib/supabase/server'

type AuthResult =
  | { type: 'user'; wallet: string }
  | { type: 'system' }
  | { type: 'agent'; agentId: string; wallet: string }
  | null

// Initialize Privy client for token verification
const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET

let privyClient: PrivyClient | null = null
if (appId && appSecret) {
  privyClient = new PrivyClient({
    appId,
    appSecret,
  })
  console.log('[Auth] Privy client initialized with appId:', appId.slice(0, 10) + '...')
} else {
  console.warn('[Auth] Privy client NOT initialized - missing credentials:', { hasAppId: !!appId, hasAppSecret: !!appSecret })
}

export async function verifyAuth(request: Request): Promise<AuthResult> {
  const auth = request.headers.get('authorization')

  // System auth (agent runner, cron)
  if (
    auth === `Bearer ${process.env.AGENT_RUNNER_SECRET}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  ) {
    return { type: 'system' }
  }

  // Check for API key auth (Path B agents)
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7)

    // Check if it's an agent API key (64 char hex string)
    if (/^[a-f0-9]{64}$/.test(token)) {
      const { data: agent } = await supabaseAdmin
        .from('agents')
        .select('id, wallet_address')
        .eq('api_key', token)
        .single()

      if (agent) {
        return { type: 'agent', agentId: agent.id, wallet: agent.wallet_address }
      }
    }

    // Try Privy access token verification first
    if (privyClient) {
      try {
        console.log('[Auth] Attempting Privy token verification...')
        const verifiedClaims = await privyClient.utils().auth().verifyAuthToken(token)
        console.log('[Auth] Privy token verified, user_id:', verifiedClaims.user_id)

        // Get user's linked wallets
        if (verifiedClaims.user_id) {
          // Use _get to fetch user by ID (internal method but available in SDK)
          const user = await privyClient.users()._get(verifiedClaims.user_id)
          console.log('[Auth] User fetched, linked_accounts count:', user.linked_accounts?.length || 0)

          // Find the user's wallet address (embedded wallet or linked wallet)
          const walletAccount = user.linked_accounts?.find(
            (account) => account.type === 'wallet'
          )

          if (walletAccount && 'address' in walletAccount && walletAccount.address) {
            console.log('[Auth] Found wallet address:', walletAccount.address.slice(0, 10) + '...')
            return { type: 'user', wallet: walletAccount.address.toLowerCase() }
          } else {
            console.warn('[Auth] No wallet found in user linked accounts')
          }
        }
      } catch (privyError) {
        // Token is not a valid Privy token, try other methods
        console.error('[Auth] Privy token verification failed:', privyError)
      }
    } else {
      console.warn('[Auth] Privy client not available, skipping Privy auth')
    }

    // Fallback: User auth (Supabase JWT from Privy bridge)
    try {
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET!) as {
        wallet_address: string
      }
      return { type: 'user', wallet: decoded.wallet_address }
    } catch {
      return null
    }
  }

  return null
}

export function requireAuth(auth: AuthResult): auth is NonNullable<AuthResult> {
  return auth !== null
}

export function requireSystemAuth(auth: AuthResult): auth is { type: 'system' } {
  return auth?.type === 'system'
}

export function requireUserAuth(auth: AuthResult): auth is { type: 'user'; wallet: string } {
  return auth?.type === 'user'
}

export function requireAgentAuth(auth: AuthResult): auth is { type: 'agent'; agentId: string; wallet: string } {
  return auth?.type === 'agent'
}
