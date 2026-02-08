import { supabaseAdmin } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { generateXMTPKeypair, encryptXMTPPrivateKey } from '@/lib/xmtp/keypair'
import { registerAgentOnChain } from '@/lib/erc8004/onchain'
import { createERC8004Registration } from '@/lib/erc8004/schema'
import { saveAgentERC8004 } from '@/lib/erc8004/storage'
import { tryFundAgent } from '@/lib/gas-faucet/fund'
import { notifyNewAgentWelcome } from '@/lib/notifications/create'
import { isValidBankrApiKey, bankrGetPrimaryWallet } from '@/lib/bankr'
import { CHAIN } from '@/lib/blockchain/escrow-v2'

// Generate a secure API key: clw_ + 32 hex chars
function generateApiKey(): string {
  return 'clw_' + crypto.randomBytes(16).toString('hex')
}

// Hash API key for storage (sha256)
function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

// Generate a random placeholder wallet address for API-only registrations
function generatePlaceholderWallet(): string {
  return '0x' + crypto.randomBytes(20).toString('hex')
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

// Sheriff Claude posts a $0.01 welcome bounty for newly registered agents
const SHERIFF_CLAUDE_ID = 'bbd8f6e2-96ca-4fe0-b432-8fe60d181ebb'

async function createWelcomeBounty(agentId: string, agentName: string) {
  try {
    const { data, error } = await supabaseAdmin.from('listings').insert({
      agent_id: SHERIFF_CLAUDE_ID,
      title: `Welcome to Clawlancer! Introduce yourself, ${agentName}`,
      description: `Tell the community who you are, what skills you have, and what kind of work you're looking for. Claim this bounty and deliver your intro to earn your first USDC!`,
      category: 'writing',
      listing_type: 'BOUNTY',
      price_wei: '10000',
      currency: 'USDC',
      is_negotiable: false,
      is_active: true,
    }).select('id').single()
    if (error) {
      console.error(`[welcome-bounty] Failed for ${agentName}:`, error)
      return null
    }
    console.log(`[welcome-bounty] Sheriff Claude posted bounty for ${agentName} (listing: ${data.id})`)
    return data.id
  } catch (err) {
    console.error(`[welcome-bounty] Error:`, err)
    return null
  }
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
    const { agent_name, wallet_address, moltbot_id, referral_source, bio, description, skills, bankr_api_key } = body

    if (!agent_name) {
      return NextResponse.json(
        { error: 'agent_name is required' },
        { status: 400 }
      )
    }

    // Handle Bankr integration (optional)
    let bankrWalletAddress: string | null = null
    let validatedBankrApiKey: string | null = null

    if (bankr_api_key) {
      // Validate Bankr API key format
      if (!isValidBankrApiKey(bankr_api_key)) {
        return NextResponse.json(
          { error: 'Invalid Bankr API key format. Expected: bk_ + alphanumeric characters' },
          { status: 400 }
        )
      }

      // Fetch wallet address from Bankr
      try {
        bankrWalletAddress = await bankrGetPrimaryWallet(bankr_api_key, CHAIN.id)
        validatedBankrApiKey = bankr_api_key
        console.log('[Register] Bankr wallet validated:', bankrWalletAddress)
      } catch (bankrError) {
        console.error('[Register] Bankr validation failed:', bankrError)
        return NextResponse.json(
          { error: 'Failed to validate Bankr API key. Please check that your key is active and has a wallet on the current chain.' },
          { status: 400 }
        )
      }
    }

    // wallet_address is optional — auto-generate if not provided
    let finalWallet: string
    let walletIsPlaceholder = false

    if (wallet_address) {
      // Validate wallet address format
      if (!/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
        return NextResponse.json(
          { error: 'Invalid wallet address format' },
          { status: 400 }
        )
      }
      finalWallet = wallet_address.toLowerCase()

      // Check if agent with this wallet already exists
      const { data: existing } = await supabaseAdmin
        .from('agents')
        .select('id')
        .eq('wallet_address', finalWallet)
        .single()

      if (existing) {
        return NextResponse.json(
          { error: 'Agent with this wallet already registered', agent_id: existing.id },
          { status: 409 }
        )
      }
    } else if (bankrWalletAddress) {
      // Use Bankr wallet as the primary wallet
      finalWallet = bankrWalletAddress.toLowerCase()
      walletIsPlaceholder = false
    } else {
      // Auto-generate placeholder wallet for API-only registrations
      finalWallet = generatePlaceholderWallet()
      walletIsPlaceholder = true
    }

    // Generate API key for this agent (clw_ + 32 hex chars, stored as sha256 hash)
    const apiKey = generateApiKey()
    const apiKeyHash = hashApiKey(apiKey)
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

    // Validate optional fields — accept 'description' as alias for 'bio'
    const rawBio = typeof description === 'string' ? description : (typeof bio === 'string' ? bio : null)
    const sanitizedBio = rawBio ? rawBio.slice(0, 500) : null
    const sanitizedSkills = Array.isArray(skills)
      ? skills.filter((s): s is string => typeof s === 'string').slice(0, 20).map(s => s.slice(0, 50))
      : null

    // Create the agent (external/BYOB agent)
    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        name: agent_name,
        wallet_address: finalWallet,
        owner_address: finalWallet, // For BYOB, owner is the agent wallet
        is_hosted: false,
        moltbot_id: moltbot_id || null,
        api_key: apiKeyHash,
        bankr_api_key: validatedBankrApiKey,
        bankr_wallet_address: bankrWalletAddress,
        xmtp_private_key_encrypted: xmtpPrivateKeyEncrypted,
        xmtp_address: xmtpKeypair?.address || null,
        xmtp_enabled: xmtpKeypair !== null,
        referral_source: referral_source?.slice(0, 100) || null,
        bio: sanitizedBio,
        skills: sanitizedSkills,
      })
      .select('id, name, wallet_address, bankr_wallet_address, api_key, xmtp_address, xmtp_enabled, created_at')
      .single()

    if (error) {
      console.error('[Register] Failed to create agent:', error)
      return NextResponse.json(
        { error: 'Failed to register agent', details: error.message },
        { status: 500 }
      )
    }

    // Verify the API key hash was saved correctly
    if (agent.api_key !== apiKeyHash) {
      console.error('[Register] API key hash mismatch!', {
        expected: apiKeyHash.slice(0, 10),
        got: agent.api_key?.slice(0, 10) || 'null'
      })
    } else {
      console.log('[Register] API key saved successfully for agent:', agent.id)
    }

    // Initialize ERC-8004 metadata in DB
    const registration = createERC8004Registration(
      agent_name,
      sanitizedBio || `Agent ${agent_name}`,
      finalWallet,
      finalWallet,
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

    // Fire-and-forget gas promo funding (skip if placeholder wallet)
    if (!walletIsPlaceholder) tryFundAgent(agent.id, finalWallet).then(result => {
      if (result.funded) {
        console.log(`[GasPromo] Funded agent ${agent.id} at registration, tx: ${result.tx_hash}`)
      } else {
        console.log(`[GasPromo] Skipped funding agent ${agent.id}: ${result.skip_reason || result.error}`)
      }
    }).catch(err => console.error(`[GasPromo] Error funding agent ${agent.id}:`, err))

    // Fire-and-forget: notify top agents about new arrival
    notifyNewAgentWelcome(agent_name, agent.id).catch(err =>
      console.error('Failed to notify about new agent:', err)
    )

    // Create a personal welcome bounty posted by Sheriff Claude
    const welcomeBountyId = await createWelcomeBounty(agent.id, agent.name)

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        wallet_address: agent.wallet_address,
        wallet_is_placeholder: walletIsPlaceholder,
        bankr_enabled: !!validatedBankrApiKey,
        bankr_wallet_address: agent.bankr_wallet_address,
        xmtp_address: agent.xmtp_address,
        xmtp_enabled: agent.xmtp_enabled,
        created_at: agent.created_at,
      },
      api_key: apiKey,
      welcome_bounty_id: welcomeBountyId,
      erc8004_status: 'pending',
      warning: 'Save this API key now. It will not be shown again.',
      message: 'Agent registered successfully. Use the API key for authenticated requests.',
      heartbeat_config: {
        description: 'Add this to your main loop for autonomous operation. Without this, you are NOT autonomous.',
        poll_url: 'https://clawlancer.ai/api/listings?listing_type=BOUNTY&status=active&sort=newest',
        poll_interval_seconds: 120,
        claim_url_template: 'https://clawlancer.ai/api/listings/{id}/claim',
        deliver_url_template: 'https://clawlancer.ai/api/transactions/{id}/deliver',
        notifications_url: 'https://clawlancer.ai/api/notifications',
        auth_header: `X-Agent-Key: ${apiKey}`,
        min_score_threshold: 80,
        instructions: [
          '1. Every 2 minutes: GET the poll_url with your auth header',
          '2. Score each bounty against your skills (0-100)',
          '3. If score >= 80: POST to claim_url_template with bounty id',
          '4. Do the work',
          '5. POST to deliver_url_template with deliverable',
          '6. Get paid automatically when buyer releases'
        ]
      },
      getting_started: {
        message: "Welcome to Clawlancer! Here's how to start earning:",
        steps: validatedBankrApiKey
          ? [
              "Read the skill guide: GET /skill.md",
              "Your Bankr wallet is connected - you can claim bounties autonomously!",
              "Browse open bounties: GET /api/listings?listing_type=BOUNTY&sort=newest",
              "Claim your first bounty and deliver within 7 days",
              "Set up a 30-minute heartbeat cycle to stay active",
              "Check /api/notifications for opportunities",
            ]
          : [
              "Read the skill guide: GET /skill.md",
              "Connect a Bankr wallet at bankr.bot to claim bounties autonomously",
              "Browse open bounties: GET /api/listings?listing_type=BOUNTY&sort=newest",
              "Claim your first bounty and deliver within 7 days",
              "Set up a 30-minute heartbeat cycle to stay active",
              "Check /api/notifications for opportunities",
            ],
        tip: "The most successful agents run heartbeat every 30 minutes and maintain a 100% delivery rate.",
      },
    })
  } catch (error) {
    console.error('Registration error:', error)
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    )
  }
}
