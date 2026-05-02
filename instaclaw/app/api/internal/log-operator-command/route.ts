/**
 * POST /api/internal/log-operator-command
 *
 * Append-only sink for the VM-side privacy-bridge. Called on EVERY operator
 * SSH command attempt (allowed and blocked). Body:
 *   { command: string, decision: "allowed"|"blocked"|"allowed_privacy_off",
 *     privacy_mode_active: boolean, reason?: string }
 *
 * Auth: X-Gateway-Token (the VM's own gateway_token, same as every
 * /api/gateway/* and /api/internal/* route). Defense-in-depth: only inserts
 * if the VM's assigned user is partner=edge_city — non-edge calls are dropped
 * as 200 OK with `accepted: false` to keep bridge logic simple.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

const COMMAND_MAX_CHARS = 1024;
const REASON_MAX_CHARS = 256;

interface LogBody {
  command: string;
  decision: "allowed" | "blocked" | "allowed_privacy_off";
  privacy_mode_active: boolean;
  reason?: string;
}

function isValidDecision(s: string): s is LogBody["decision"] {
  return s === "allowed" || s === "blocked" || s === "allowed_privacy_off";
}

export async function POST(req: NextRequest) {
  const gatewayToken =
    req.headers.get("x-gateway-token") || req.headers.get("x-api-key");
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }

  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) {
    return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  }
  if (!vm.assigned_to) {
    return NextResponse.json({ accepted: false, reason: "VM has no assigned user" });
  }

  let body: LogBody;
  try {
    const raw = await req.json();
    if (
      typeof raw?.command !== "string" ||
      !isValidDecision(raw?.decision) ||
      typeof raw?.privacy_mode_active !== "boolean"
    ) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    body = {
      command: raw.command.slice(0, COMMAND_MAX_CHARS),
      decision: raw.decision,
      privacy_mode_active: raw.privacy_mode_active,
      reason: typeof raw.reason === "string" ? raw.reason.slice(0, REASON_MAX_CHARS) : undefined,
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("partner")
    .eq("id", vm.assigned_to)
    .single();

  if (user?.partner !== "edge_city") {
    return NextResponse.json({ accepted: false, reason: "Not an edge_city user" });
  }

  const { error: insertErr } = await supabase
    .from("instaclaw_operator_audit_log")
    .insert({
      vm_id: vm.id,
      user_id: vm.assigned_to,
      command: body.command,
      decision: body.decision,
      privacy_mode_active: body.privacy_mode_active,
      reason: body.reason ?? null,
    });

  if (insertErr) {
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ accepted: true });
}
