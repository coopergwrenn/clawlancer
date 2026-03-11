/**
 * Supabase-backed AgentKitStorage for WDP 71 x402 AgentKit integration.
 *
 * Implements the AgentKitStorage interface from @worldcoin/agentkit,
 * persisting usage counts and nonces to Supabase instead of in-memory.
 * Required because InMemoryAgentKitStorage resets on every Vercel cold start.
 */

import { getSupabase } from "@/lib/supabase";
import type { AgentKitStorage } from "@worldcoin/agentkit";

export class SupabaseAgentKitStorage implements AgentKitStorage {
  async getUsageCount(endpoint: string, humanId: string): Promise<number> {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("instaclaw_agentkit_usage")
      .select("usage_count")
      .eq("endpoint", endpoint)
      .eq("human_id", humanId)
      .single();

    return data?.usage_count ?? 0;
  }

  async incrementUsage(endpoint: string, humanId: string): Promise<void> {
    const supabase = getSupabase();
    const { data: existing } = await supabase
      .from("instaclaw_agentkit_usage")
      .select("id, usage_count")
      .eq("endpoint", endpoint)
      .eq("human_id", humanId)
      .single();

    if (existing) {
      await supabase
        .from("instaclaw_agentkit_usage")
        .update({
          usage_count: existing.usage_count + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("instaclaw_agentkit_usage").insert({
        endpoint,
        human_id: humanId,
        usage_count: 1,
      });
    }
  }

  async hasUsedNonce(nonce: string): Promise<boolean> {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("instaclaw_agentkit_nonces")
      .select("nonce")
      .eq("nonce", nonce)
      .single();

    return !!data;
  }

  async recordNonce(nonce: string): Promise<void> {
    const supabase = getSupabase();
    await supabase.from("instaclaw_agentkit_nonces").insert({
      nonce,
    });
  }
}
