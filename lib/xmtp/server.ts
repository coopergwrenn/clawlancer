/**
 * XMTP Server Service
 *
 * Manages XMTP clients for agents server-side.
 * - Hosted agents: Uses Privy to sign messages
 * - BYOB agents: Uses stored XMTP keypair
 */

import { Client, Conversation, DecodedMessage } from '@xmtp/xmtp-js'
import { supabaseAdmin } from '@/lib/supabase/server'
import { signMessageForAgent } from '@/lib/privy/server-wallet'
import { createSignerFromEncryptedKey } from '@/lib/xmtp/keypair'

// Environment config
const XMTP_ENV = process.env.NEXT_PUBLIC_CHAIN === 'sepolia' ? 'dev' : 'production'

// Cache XMTP clients to avoid re-creating (expensive operation)
const clientCache = new Map<string, { client: Client; expiresAt: number }>()
const CACHE_TTL = 30 * 60 * 1000 // 30 minutes

interface AgentXMTPInfo {
  id: string
  wallet_address: string
  privy_wallet_id: string | null
  xmtp_private_key_encrypted: string | null
  xmtp_address: string | null
  is_hosted: boolean
  xmtp_enabled: boolean
}

/**
 * Get or create an XMTP client for an agent
 */
export async function getXMTPClientForAgent(agentId: string): Promise<Client> {
  // Check cache
  const cached = clientCache.get(agentId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.client
  }

  // Get agent details
  const { data: agent, error } = await supabaseAdmin
    .from('agents')
    .select('id, wallet_address, privy_wallet_id, xmtp_private_key_encrypted, xmtp_address, is_hosted, xmtp_enabled')
    .eq('id', agentId)
    .single()

  if (error || !agent) {
    throw new Error(`Agent not found: ${agentId}`)
  }

  const agentInfo = agent as AgentXMTPInfo

  let signer: { getAddress: () => Promise<string>; signMessage: (msg: string) => Promise<string> }

  if (agentInfo.is_hosted && agentInfo.privy_wallet_id) {
    // HOSTED AGENT: Use Privy to sign messages
    console.log(`[XMTP] Creating client for hosted agent ${agentId} via Privy`)
    signer = {
      getAddress: async () => agentInfo.wallet_address,
      signMessage: async (message: string) => {
        return signMessageForAgent(agentInfo.privy_wallet_id!, message)
      },
    }
  } else if (agentInfo.xmtp_private_key_encrypted && agentInfo.xmtp_address) {
    // BYOB AGENT: Use stored XMTP keypair
    console.log(`[XMTP] Creating client for BYOB agent ${agentId} with XMTP address ${agentInfo.xmtp_address}`)
    signer = await createSignerFromEncryptedKey(
      agentInfo.xmtp_private_key_encrypted,
      agentInfo.xmtp_address
    )
  } else {
    throw new Error(`Agent ${agentId} is not configured for XMTP messaging`)
  }

  // Create XMTP client
  console.log(`[XMTP] Initializing XMTP client for agent ${agentId}...`)
  const client = await Client.create(signer, { env: XMTP_ENV })
  console.log(`[XMTP] Client created for agent ${agentId}`)

  // Cache the client
  clientCache.set(agentId, {
    client,
    expiresAt: Date.now() + CACHE_TTL,
  })

  // Mark agent as XMTP enabled if not already
  if (!agentInfo.xmtp_enabled) {
    await supabaseAdmin
      .from('agents')
      .update({ xmtp_enabled: true })
      .eq('id', agentId)
  }

  return client
}

/**
 * Get the XMTP address for an agent
 * For BYOB agents, this is the separate XMTP address
 * For hosted agents, this is their main wallet address
 */
export async function getXMTPAddressForAgent(agentId: string): Promise<string> {
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('wallet_address, xmtp_address, is_hosted')
    .eq('id', agentId)
    .single()

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`)
  }

  // BYOB agents use their XMTP address, hosted agents use wallet address
  return agent.xmtp_address || agent.wallet_address
}

/**
 * Check if an agent can receive XMTP messages
 */
export async function canMessageAgent(
  fromAgentId: string,
  toAgentId: string
): Promise<boolean> {
  try {
    const client = await getXMTPClientForAgent(fromAgentId)
    const toAddress = await getXMTPAddressForAgent(toAgentId)
    return client.canMessage(toAddress)
  } catch {
    return false
  }
}

/**
 * Send a message from one agent to another
 */
export async function sendAgentMessage(
  fromAgentId: string,
  toAgentId: string,
  content: string
): Promise<{ messageId: string; sentAt: Date }> {
  const client = await getXMTPClientForAgent(fromAgentId)
  const toAddress = await getXMTPAddressForAgent(toAgentId)

  // Check if recipient can receive messages
  const canMsg = await client.canMessage(toAddress)
  if (!canMsg) {
    throw new Error(`Recipient agent ${toAgentId} cannot receive XMTP messages`)
  }

  // Get or create conversation
  const conversation = await client.conversations.newConversation(toAddress)

  // Send message
  const sent = await conversation.send(content)

  return {
    messageId: sent.id,
    sentAt: sent.sent,
  }
}

/**
 * Get all conversations for an agent
 */
export async function getAgentConversations(agentId: string): Promise<
  Array<{
    peerAddress: string
    peerAgentId: string | null
    peerAgentName: string | null
    lastMessage: string | null
    lastMessageAt: Date | null
  }>
> {
  const client = await getXMTPClientForAgent(agentId)
  const conversations = await client.conversations.list()

  // Get peer info for each conversation
  const results = await Promise.all(
    conversations.map(async (conv) => {
      // Try to find agent by XMTP address or wallet address
      const { data: peerAgent } = await supabaseAdmin
        .from('agents')
        .select('id, name')
        .or(`wallet_address.eq.${conv.peerAddress.toLowerCase()},xmtp_address.eq.${conv.peerAddress}`)
        .single()

      // Get last message
      let lastMessage: string | null = null
      let lastMessageAt: Date | null = null
      try {
        const messages = await conv.messages({ limit: 1 })
        if (messages.length > 0) {
          lastMessage = messages[0].content as string
          lastMessageAt = messages[0].sent
        }
      } catch {
        // Ignore errors loading messages
      }

      return {
        peerAddress: conv.peerAddress,
        peerAgentId: peerAgent?.id || null,
        peerAgentName: peerAgent?.name || null,
        lastMessage,
        lastMessageAt,
      }
    })
  )

  // Sort by most recent message
  results.sort((a, b) => {
    if (!a.lastMessageAt) return 1
    if (!b.lastMessageAt) return -1
    return b.lastMessageAt.getTime() - a.lastMessageAt.getTime()
  })

  return results
}

/**
 * Get message thread between two agents
 */
export async function getAgentMessageThread(
  agentId: string,
  peerAgentId: string,
  limit: number = 50
): Promise<
  Array<{
    id: string
    content: string
    senderAddress: string
    senderAgentId: string | null
    sentAt: Date
  }>
> {
  const client = await getXMTPClientForAgent(agentId)
  const peerAddress = await getXMTPAddressForAgent(peerAgentId)

  // Find conversation with peer
  const conversations = await client.conversations.list()
  const conv = conversations.find(
    (c) => c.peerAddress.toLowerCase() === peerAddress.toLowerCase()
  )

  if (!conv) {
    return []
  }

  // Get messages
  const messages = await conv.messages({ limit })

  // Get agent's XMTP address to determine who sent each message
  const agentAddress = await getXMTPAddressForAgent(agentId)

  return messages.map((msg) => ({
    id: msg.id,
    content: msg.content as string,
    senderAddress: msg.senderAddress,
    senderAgentId:
      msg.senderAddress.toLowerCase() === agentAddress.toLowerCase()
        ? agentId
        : msg.senderAddress.toLowerCase() === peerAddress.toLowerCase()
        ? peerAgentId
        : null,
    sentAt: msg.sent,
  }))
}

/**
 * Clear XMTP client cache for an agent
 */
export function clearClientCache(agentId?: string): void {
  if (agentId) {
    clientCache.delete(agentId)
  } else {
    clientCache.clear()
  }
}
