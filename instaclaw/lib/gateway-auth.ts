/**
 * Shared gateway token authentication for all proxy routes.
 *
 * Supports a "grace period" during token rotation: if the incoming token
 * doesn't match `gateway_token`, we also check `previous_gateway_token`.
 * This prevents 401s when the cron health-check resyncs a token while
 * the gateway is still sending the old one.
 */
import { getSupabase } from "@/lib/supabase";

/**
 * Look up a VM by its gateway token, with fallback to previous_gateway_token.
 * Returns the VM row (with requested columns) or null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lookupVMByGatewayToken(
  gatewayToken: string,
  selectColumns: string,
): Promise<any | null> {
  const supabase = getSupabase();

  // Primary lookup: current gateway_token
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select(selectColumns)
    .eq("gateway_token", gatewayToken)
    .single();

  if (vm) return vm;

  // Fallback: previous_gateway_token (grace period during rotation)
  const { data: prevVm } = await supabase
    .from("instaclaw_vms")
    .select(selectColumns)
    .eq("previous_gateway_token", gatewayToken)
    .single();

  return prevVm ?? null;
}
