import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
    }
    _client = createClient(url, key);
  }
  return _client;
}

// --- Direct Supabase reads (server-side, scoped to authenticated user) ---

export async function getAgentStatus(userId: string) {
  const { data, error } = await supabase()
    .from("instaclaw_vms")
    .select(
      "id, status, health_status, credit_balance, model, xmtp_address, telegram_bot_token, telegram_bot_username, assigned_at, last_health_check"
    )
    .eq("assigned_to", userId)
    .single();
  if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows
  return data;
}

export async function getCreditBalance(userId: string) {
  const { data } = await supabase()
    .from("instaclaw_vms")
    .select("credit_balance")
    .eq("assigned_to", userId)
    .single();
  return data?.credit_balance ?? 0;
}

export async function getSkillsList(userId: string) {
  // First get the VM id for this user
  const { data: vm } = await supabase()
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", userId)
    .single();
  if (!vm) return [];

  const { data } = await supabase()
    .from("instaclaw_skills")
    .select("skill_name, enabled, config")
    .eq("vm_id", vm.id);
  return data ?? [];
}

export async function getDelegationHistory(userId: string) {
  const { data } = await supabase()
    .from("instaclaw_wld_delegations")
    .select("*")
    .eq("user_id", userId)
    .order("delegated_at", { ascending: false })
    .limit(10);
  return data ?? [];
}

export async function getPaymentHistory(userId: string) {
  const { data } = await supabase()
    .from("instaclaw_world_payments")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);
  return data ?? [];
}

export async function getDailyUsage(vmId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase()
    .from("instaclaw_daily_usage")
    .select("message_count, heartbeat_count")
    .eq("vm_id", vmId)
    .eq("usage_date", today)
    .single();
  return data;
}

export async function getUserByWallet(walletAddress: string) {
  const { data } = await supabase()
    .from("instaclaw_users")
    .select("*")
    .eq("world_wallet_address", walletAddress)
    .single();
  return data;
}

export async function getUserByNullifier(nullifierHash: string) {
  const { data } = await supabase()
    .from("instaclaw_users")
    .select("*")
    .eq("world_id_nullifier_hash", nullifierHash)
    .single();
  return data;
}

export async function createWorldUser(walletAddress: string) {
  const { data, error } = await supabase()
    .from("instaclaw_users")
    .insert({
      world_wallet_address: walletAddress,
      auth_provider: "world",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function linkWalletToUser(
  userId: string,
  walletAddress: string
) {
  const { error } = await supabase()
    .from("instaclaw_users")
    .update({ world_wallet_address: walletAddress })
    .eq("id", userId);
  if (error) throw error;
}

export async function markWorldIdVerified(
  userId: string,
  nullifierHash: string,
  verificationLevel: string
) {
  const { error } = await supabase()
    .from("instaclaw_users")
    .update({
      world_id_verified: true,
      world_id_nullifier_hash: nullifierHash,
      world_id_verified_at: new Date().toISOString(),
      world_id_verification_level: verificationLevel,
    })
    .eq("id", userId);
  if (error) throw error;
}
