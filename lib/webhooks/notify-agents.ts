/**
 * Agent Webhook Notifications
 * Sends push notifications to agents when bounties matching their skills are posted
 */

import { supabaseAdmin } from '@/lib/supabase/server'

interface BountyWebhookPayload {
  event: 'bounty.posted'
  bounty: {
    id: string
    title: string
    description: string
    category: string | null
    price_wei: string
    price_usdc: number
    created_at: string
    deadline_hours: number
  }
  actions: {
    claim_url: string
    view_url: string
  }
  matched_skills: string[]
}

/**
 * Notify agents via webhook when a bounty is posted
 * Filters agents whose skills match the bounty category
 */
export async function notifyAgentsOfBounty(
  bountyId: string,
  title: string,
  description: string,
  category: string | null,
  priceWei: string,
  deadlineHours: number = 168
): Promise<void> {
  try {
    // Find agents with webhooks enabled
    let query = supabaseAdmin
      .from('agents')
      .select('id, name, webhook_url, skills')
      .eq('webhook_enabled', true)
      .eq('is_active', true)
      .not('webhook_url', 'is', null)

    // If category is specified, filter by matching skills
    if (category) {
      query = query.contains('skills', [category.toLowerCase()])
    }

    const { data: agents, error } = await query

    if (error) {
      console.error('Failed to query agents for webhook notifications:', error)
      return
    }

    if (!agents || agents.length === 0) {
      console.log('[Webhooks] No agents with webhooks match this bounty')
      return
    }

    console.log(`[Webhooks] Notifying ${agents.length} agents of bounty ${bountyId}`)

    const priceUsdc = Number(priceWei) / 1e6

    // Send webhooks in parallel (but don't await - fire and forget)
    const webhookPromises = agents.map(async (agent) => {
      const matchedSkills = category
        ? agent.skills?.filter((s: string) => s === category.toLowerCase()) || [category.toLowerCase()]
        : []

      const payload: BountyWebhookPayload = {
        event: 'bounty.posted',
        bounty: {
          id: bountyId,
          title,
          description,
          category,
          price_wei: priceWei,
          price_usdc: priceUsdc,
          created_at: new Date().toISOString(),
          deadline_hours: deadlineHours,
        },
        actions: {
          claim_url: `https://clawlancer.ai/api/listings/${bountyId}/claim`,
          view_url: `https://clawlancer.ai/bounties/${bountyId}`,
        },
        matched_skills: matchedSkills,
      }

      try {
        const response = await fetch(agent.webhook_url!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Clawlancer-Webhook/1.0',
            'X-Clawlancer-Event': 'bounty.posted',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000), // 5 second timeout
        })

        if (response.ok) {
          // Update last success timestamp
          await supabaseAdmin
            .from('agents')
            .update({
              last_webhook_success_at: new Date().toISOString(),
              last_webhook_error: null,
            })
            .eq('id', agent.id)

          console.log(`[Webhooks] ✓ Notified ${agent.name} (${agent.id})`)
        } else {
          const errorText = await response.text().catch(() => 'Unknown error')
          console.error(`[Webhooks] ✗ Failed to notify ${agent.name}: HTTP ${response.status} - ${errorText}`)

          // Log error but don't disable webhook (temporary failures are ok)
          await supabaseAdmin
            .from('agents')
            .update({
              last_webhook_error: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
            })
            .eq('id', agent.id)
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[Webhooks] ✗ Failed to notify ${agent.name}:`, errorMsg)

        // Log error
        await supabaseAdmin
          .from('agents')
          .update({
            last_webhook_error: errorMsg.slice(0, 200),
          })
          .eq('id', agent.id)
      }
    })

    // Fire and forget - don't block the response
    Promise.all(webhookPromises).catch((err) =>
      console.error('[Webhooks] Error in batch notification:', err)
    )

  } catch (err) {
    console.error('[Webhooks] Failed to notify agents:', err)
  }
}
