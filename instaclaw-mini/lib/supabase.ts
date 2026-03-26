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
  console.log("[getAgentStatus] Looking up VM for userId:", userId);
  const { data, error } = await supabase()
    .from("instaclaw_vms")
    .select(
      "id, status, health_status, credit_balance, default_model, xmtp_address, telegram_bot_token, telegram_bot_username, assigned_at, last_health_check"
    )
    .eq("assigned_to", userId)
    .single();
  if (error && error.code !== "PGRST116") {
    console.error("[getAgentStatus] Error:", error.code, error.message);
    throw error;
  }
  console.log("[getAgentStatus] Result:", data ? data.id : "null");
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

export async function getGoogleStatus(userId: string): Promise<{
  connected: boolean;
  connectedAt: string | null;
}> {
  const { data } = await supabase()
    .from("instaclaw_users")
    .select("gmail_connected, gmail_connected_at")
    .eq("id", userId)
    .single();
  return {
    connected: data?.gmail_connected === true,
    connectedAt: data?.gmail_connected_at ?? null,
  };
}

export async function getUserByWallet(walletAddress: string) {
  // Try exact match first, then case-insensitive
  const { data } = await supabase()
    .from("instaclaw_users")
    .select("*")
    .ilike("world_wallet_address", walletAddress)
    .single();
  return data;
}

export async function getUserByEmail(email: string) {
  const { data } = await supabase()
    .from("instaclaw_users")
    .select("*")
    .eq("email", email.toLowerCase())
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

export async function createWorldUser(walletAddress: string, email?: string) {
  const { data, error } = await supabase()
    .from("instaclaw_users")
    .insert({
      world_wallet_address: walletAddress,
      auth_provider: "world",
      email: email || null,
    })
    .select()
    .single();
  if (error) {
    const fullErr = new Error(
      `createWorldUser failed: ${error.code} ${error.message} | ${error.details} | hint: ${error.hint}`
    );
    throw fullErr;
  }
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

// ── Duplicate VM prevention ──

/**
 * Check if a user might already have an agent under a different account.
 * Returns the potential match if found, null otherwise.
 * Used during provisioning to prevent duplicate VMs.
 */
export async function findPotentialExistingAgent(
  userId: string,
  nullifierHash?: string | null,
  email?: string | null
): Promise<{ userId: string; vmId: string; matchedBy: string } | null> {
  // 1. Check if this user already has a VM (simplest case)
  const { data: ownVm } = await supabase()
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", userId)
    .single();
  if (ownVm) return null; // Already has a VM, no duplicate risk

  // 2. Check by nullifier hash — another account with same World ID
  if (nullifierHash) {
    const { data: nullUser } = await supabase()
      .from("instaclaw_users")
      .select("id")
      .eq("world_id_nullifier_hash", nullifierHash)
      .neq("id", userId)
      .single();
    if (nullUser) {
      const { data: nullVm } = await supabase()
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", nullUser.id)
        .single();
      if (nullVm) {
        return { userId: nullUser.id, vmId: nullVm.id, matchedBy: "world_id" };
      }
    }
  }

  // 3. Check by email — Google-auth account with same email
  if (email) {
    const { data: emailUser } = await supabase()
      .from("instaclaw_users")
      .select("id")
      .eq("email", email.toLowerCase())
      .neq("id", userId)
      .single();
    if (emailUser) {
      const { data: emailVm } = await supabase()
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", emailUser.id)
        .single();
      if (emailVm) {
        return { userId: emailUser.id, vmId: emailVm.id, matchedBy: "email" };
      }
    }
  }

  return null;
}

// ── Account linking codes ──

export async function createLinkingCode(userId: string): Promise<string> {
  const code = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  await supabase()
    .from("instaclaw_users")
    .update({
      linking_code: code,
      linking_code_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .eq("id", userId);
  return code;
}

export async function redeemLinkingCode(
  code: string,
  walletAddress: string
): Promise<{ success: boolean; userId?: string; error?: string }> {
  const { data: user } = await supabase()
    .from("instaclaw_users")
    .select("id, linking_code_expires_at")
    .eq("linking_code", code.toUpperCase())
    .single();

  if (!user) return { success: false, error: "Invalid code" };

  const expiresAt = new Date(user.linking_code_expires_at);
  if (expiresAt < new Date()) return { success: false, error: "Code expired" };

  // Link wallet to this user
  await supabase()
    .from("instaclaw_users")
    .update({
      world_wallet_address: walletAddress,
      linking_code: null,
      linking_code_expires_at: null,
    })
    .eq("id", user.id);

  // Delete any orphan World-only account with this wallet
  await supabase()
    .from("instaclaw_users")
    .delete()
    .eq("world_wallet_address", walletAddress)
    .neq("id", user.id);

  return { success: true, userId: user.id };
}
