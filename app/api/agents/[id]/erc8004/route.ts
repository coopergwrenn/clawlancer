/**
 * ERC-8004 Agent Metadata Endpoint
 *
 * Per PRD Section 1 (Trust Model):
 * - Agent identity stored locally in ERC-8004 format
 * - Ready for future on-chain migration
 */

import { supabaseAdmin } from '@/lib/supabase/server'
import { verifyAuth } from '@/lib/auth/middleware'
import { NextRequest, NextResponse } from 'next/server'
import {
  getAgentERC8004,
  saveAgentERC8004,
  getTokenMetadata,
} from '@/lib/erc8004/storage'
import { ERC8004Registration, AgentCapability } from '@/lib/erc8004/schema'

// GET /api/agents/[id]/erc8004 - Get ERC-8004 registration
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { searchParams } = new URL(request.url)
  const format = searchParams.get('format') // 'full' or 'token'

  const registration = await getAgentERC8004(id)

  if (!registration) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Return token metadata format for on-chain compatibility
  if (format === 'token') {
    const tokenMetadata = await getTokenMetadata(id)
    return NextResponse.json(tokenMetadata)
  }

  return NextResponse.json({
    agent_id: id,
    registration,
    chainStatus: registration.chainStatus,
  })
}

// PATCH /api/agents/[id]/erc8004 - Update ERC-8004 registration
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Get agent to check ownership
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('owner_address')
    .eq('id', id)
    .single()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Check ownership
  if (auth.type === 'user' && agent.owner_address !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  } else if (auth.type === 'agent' && auth.agentId !== id) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { description, capabilities, metadata } = body

    // Build update object
    const update: Partial<ERC8004Registration> = {}

    if (description !== undefined) {
      update.description = description
    }

    if (capabilities !== undefined) {
      // Validate capabilities
      if (!Array.isArray(capabilities)) {
        return NextResponse.json({ error: 'capabilities must be an array' }, { status: 400 })
      }

      for (const cap of capabilities) {
        if (!cap.id || !cap.name || !cap.version) {
          return NextResponse.json({
            error: 'Each capability must have id, name, and version'
          }, { status: 400 })
        }
      }

      update.capabilities = capabilities as AgentCapability[]
    }

    if (metadata !== undefined) {
      if (typeof metadata !== 'object') {
        return NextResponse.json({ error: 'metadata must be an object' }, { status: 400 })
      }

      update.metadata = {
        ...metadata,
        updated: new Date().toISOString(),
      }
    }

    const result = await saveAgentERC8004(id, update)

    if (!result.success) {
      return NextResponse.json({ error: result.errors?.join(', ') }, { status: 400 })
    }

    // Return updated registration
    const registration = await getAgentERC8004(id)

    return NextResponse.json({
      success: true,
      agent_id: id,
      registration,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}

// POST /api/agents/[id]/erc8004 - Initialize ERC-8004 registration
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const auth = await verifyAuth(request)

  if (!auth) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Get agent (only core columns that exist)
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('id, name, owner_address, wallet_address, is_hosted')
    .eq('id', id)
    .single()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Check ownership
  if (auth.type === 'user' && agent.owner_address !== auth.wallet.toLowerCase()) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  // Check if ERC-8004 registration exists (separate query to handle missing column)
  let hasExistingRegistration = false
  try {
    const { data: regCheck } = await supabaseAdmin
      .from('agents')
      .select('erc8004_registration')
      .eq('id', id)
      .single()
    hasExistingRegistration = !!regCheck?.erc8004_registration
  } catch {
    // Column might not exist
  }

  if (hasExistingRegistration) {
    return NextResponse.json({
      error: 'ERC-8004 registration already exists',
      hint: 'Use PATCH to update'
    }, { status: 400 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const { capabilities, metadata } = body

    // Create initial registration
    const { createERC8004Registration } = await import('@/lib/erc8004/schema')

    const registration = createERC8004Registration(
      agent.name,
      body.description || `Agent ${agent.name}`,
      agent.owner_address,
      agent.wallet_address,
      {
        isHosted: agent.is_hosted,
        category: body.category || 'other',
        capabilities: capabilities || [],
      }
    )

    // Merge additional metadata
    if (metadata) {
      registration.metadata = {
        ...registration.metadata,
        ...metadata,
      }
    }

    const result = await saveAgentERC8004(id, registration)

    if (!result.success) {
      return NextResponse.json({ error: result.errors?.join(', ') }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      message: 'ERC-8004 registration initialized',
      agent_id: id,
      registration,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
