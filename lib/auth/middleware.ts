import jwt from 'jsonwebtoken'

type AuthResult =
  | { type: 'user'; wallet: string }
  | { type: 'system' }
  | null

export async function verifyAuth(request: Request): Promise<AuthResult> {
  const auth = request.headers.get('authorization')

  // System auth (agent runner, cron)
  if (
    auth === `Bearer ${process.env.AGENT_RUNNER_SECRET}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  ) {
    return { type: 'system' }
  }

  // User auth (Supabase JWT from Privy bridge)
  if (auth?.startsWith('Bearer ')) {
    try {
      const token = auth.slice(7)
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
