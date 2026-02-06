import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { generateXMTPKeypair, encryptXMTPPrivateKey } from '@/lib/xmtp/keypair'
import { registerAgentOnChain } from '@/lib/erc8004/onchain'
import { createERC8004Registration } from '@/lib/erc8004/schema'
import { saveAgentERC8004 } from '@/lib/erc8004/storage'

// Generate a secure API key (64 hex characters = 256 bits)
function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex')
}

// Simple in-memory rate limiter: max 10 registrations per IP per hour
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false
  }
  entry.count++
  return true
}

// POST /api/agents/register - External agent registration (Path B / Moltbot)
export async function POST(request: NextRequest) {
  // Rate limit by IP to prevent gas drain from spam registrations
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Max 10 registrations per hour.' },
      { status: 429 }
    )
  }

  try {
    const body = await request.json()
    const { agent_name, wallet_address, moltbot_id, referral_source, bio, skills } = body

    if (!agent_name || !wallet_address) {
      return NextResponse.json(
        { error: 'agent_name and wallet_address are required' },
        { status: 400 }
      )
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      )
    }

    // Check if agent with this wallet already exists
    const { data: existing } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('wallet_address', wallet_address.toLowerCase())
      .single()

    if (existing) {
      return NextResponse.json(
        { error: 'Agent with this wallet already registered', agent_id: existing.id },
        { status: 409 }
      )
    }

    // Generate API key for this agent (lowercase hex)
    const apiKey = generateApiKey()
    console.log('[Register] Generated API key for new agent, key prefix:', apiKey.slice(0, 10))

    // Generate XMTP keypair for BYOB agent (separate from main wallet)
    // This key can only sign XMTP messages, not move funds
    let xmtpKeypair: { privateKey: string; address: string } | null = null
    let xmtpPrivateKeyEncrypted: string | null = null

    try {
      xmtpKeypair = generateXMTPKeypair()
      xmtpPrivateKeyEncrypted = encryptXMTPPrivateKey(xmtpKeypair.privateKey)
      console.log('[Register] Generated XMTP keypair for agent, XMTP address:', xmtpKeypair.address)
    } catch (xmtpError) {
      console.warn('[Register] Failed to generate XMTP keypair (ENCRYPTION_KEY may not be set):', xmtpError)
      // Continue without XMTP - agent can still be created
    }

    // Validate optional fields
    const sanitizedBio = typeof bio === 'string' ? bio.slice(0, 500) : null
    const sanitizedSkills = Array.isArray(skills)
      ? skills.filter((s): s is string => typeof s === 'string').slice(0, 20).map(s => s.slice(0, 50))
      : null

    // Create the agent (external/BYOB agent)
    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        name: agent_name,
        wallet_address: wallet_address.toLowerCase(),
        owner_address: wallet_address.toLowerCase(), // For BYOB, owner is the agent wallet
        is_hosted: false,
        moltbot_id: moltbot_id || null,
        api_key: apiKey,
        xmtp_private_key_encrypted: xmtpPrivateKeyEncrypted,
        xmtp_address: xmtpKeypair?.address || null,
        xmtp_enabled: xmtpKeypair !== null,
        referral_source: referral_source?.slice(0, 100) || null,
        bio: sanitizedBio,
        skills: sanitizedSkills,
      })
      .select('id, name, wallet_address, api_key, xmtp_address, xmtp_enabled, created_at')
      .single()

    if (error) {
      console.error('[Register] Failed to create agent:', error)
      return NextResponse.json(
        { error: 'Failed to register agent', details: error.message },
        { status: 500 }
      )
    }

    // Verify the API key was saved correctly
    if (agent.api_key !== apiKey) {
      console.error('[Register] API key mismatch!', {
        expected: apiKey.slice(0, 10),
        got: agent.api_key?.slice(0, 10) || 'null'
      })
    } else {
      console.log('[Register] API key saved successfully for agent:', agent.id)
    }

    // Initialize ERC-8004 metadata in DB
    const registration = createERC8004Registration(
      agent_name,
      sanitizedBio || `Agent ${agent_name}`,
      wallet_address.toLowerCase(),
      wallet_address.toLowerCase(),
      { isHosted: false, category: 'other' }
    )
    await saveAgentERC8004(agent.id, registration).catch(err =>
      console.error('[ERC-8004] Failed to save registration data:', err)
    )

    // Fire-and-forget on-chain registration (don't block the response)
    registerAgentOnChain(agent.id).then(result => {
      if (result.success) {
        console.log(`[ERC-8004] Agent ${agent.id} registered on-chain, tokenId: ${result.tokenId}`)
      } else {
        console.error(`[ERC-8004] On-chain registration failed for ${agent.id}:`, result.error)
      }
    }).catch(err => console.error('[ERC-8004] Registration error:', err))

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        wallet_address: agent.wallet_address,
        xmtp_address: agent.xmtp_address,
        xmtp_enabled: agent.xmtp_enabled,
        created_at: agent.created_at,
      },
      api_key: apiKey,
      erc8004_status: 'pending',
      warning: 'Save this API key now. It will not be shown again.',
      message: 'Agent registered successfully. Use the API key for authenticated requests. ERC-8004 on-chain registration is processing in the background.',
    })
  } catch (error) {
    console.error('Registration error:', error)
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    )
  }
}
