/**
 * POST /api/match/v1/contact-info
 *
 * Resolve contact details (XMTP wallet, identity wallet, agent name) for
 * a list of matched user_ids. Used by the matching pipeline AFTER it has
 * already deliberated and posted results — the pipeline calls this
 * endpoint to enrich top-3 with the addresses needed to fire an
 * agent-to-agent intro DM.
 *
 * Body:
 *   { "user_ids": ["uuid1", "uuid2", ...] }   -- max 12 per call
 *
 * Auth: Bearer <gateway_token> OR x-gateway-token: <token>.
 *       The caller's VM must have an existing matchpool_deliberations
 *       row referencing each requested user_id within the last 7 days
 *       (anti-harvest gate).
 *
 * Response:
 *   {
 *     "ok": true,
 *     "contacts": [
 *       {
 *         "user_id": "...",
 *         "name": "Cooper",                 -- display only
 *         "agent_name": "Edge City Bot",    -- display only
 *         "telegram_bot_username": "edgecitybot",  -- "@edgecitybot" without prefix
 *         "xmtp_address": "0x...",          -- routing target for the DM
 *         "identity_wallet": "0x...",       -- bankr_evm_address first, world_wallet_address fallback
 *         "vm_name": "instaclaw-vm-780"
 *       }
 *     ]
 *   }
 *
 * Per Cooper's wallet-routing rule: identity_wallet = bankr_evm_address
 * if present, else world_wallet_address from instaclaw_users. Bankr is
 * universal in our fleet; World is gated on a separate signup path.
 *
 * Returns 200 with `contacts` containing only the users who:
 *   - Are in the caller's recent deliberations (anti-harvest)
 *   - Have a healthy VM with a non-null xmtp_address
 *   - Are not the caller themselves (defensive)
 *
 * Missing or filtered user_ids are silently dropped. The pipeline
 * handles partial responses gracefully (skips outreach for unresolvable
 * targets).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_USER_IDS = 12;
const DELIBERATION_WINDOW_DAYS = 7;

function extractGatewayToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

function isUUID(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function POST(req: NextRequest) {
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json(
      { error: "Missing authentication. Provide Authorization: Bearer or x-gateway-token." },
      { status: 401 }
    );
  }

  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const callerUserId = vm.assigned_to as string;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const rawIds = (body as Record<string, unknown>).user_ids;
  const includeSelf = (body as Record<string, unknown>).include_self === true;
  if (!Array.isArray(rawIds)) {
    return NextResponse.json({ error: "user_ids must be an array" }, { status: 400 });
  }
  if (rawIds.length === 0) {
    return NextResponse.json({ ok: true, contacts: [] });
  }
  if (rawIds.length > MAX_USER_IDS) {
    return NextResponse.json({ error: `user_ids exceeds ${MAX_USER_IDS}` }, { status: 400 });
  }
  for (const id of rawIds) {
    if (!isUUID(id)) return NextResponse.json({ error: "user_ids contains non-UUID" }, { status: 400 });
  }
  // Caller's own user_id is excluded from the deliberation-gate check
  // (you can't deliberate against yourself), and also from the harvested
  // VM lookup unless include_self=true. The introducer needs its own
  // contact info to compose the envelope; that's the only legitimate
  // self-lookup case. include_self does NOT require the caller's own
  // id to be in the request array — the introducer doesn't always know
  // its own user_id (it auths via gateway_token), so a "give me the
  // caller's contact info" call passes any UUID + include_self=true.
  const selfRequested = includeSelf;
  const requestedIds = (rawIds as string[]).filter((id) => id !== callerUserId);

  const supabase = getSupabase();

  // Anti-harvest gate: only resolve contacts that the caller has actually
  // deliberated against within the recent window. Service-role read; we
  // intersect requestedIds with the caller's recent candidates.
  let safeIds: string[] = [];
  if (requestedIds.length > 0) {
    const sinceIso = new Date(Date.now() - DELIBERATION_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const { data: delibRows, error: delibErr } = await supabase
      .from("matchpool_deliberations")
      .select("candidate_user_id")
      .eq("user_id", callerUserId)
      .gte("deliberated_at", sinceIso)
      .in("candidate_user_id", requestedIds);

    if (delibErr) {
      return NextResponse.json({ error: "deliberation lookup failed" }, { status: 503 });
    }
    const allowedIds = new Set((delibRows || []).map((r) => r.candidate_user_id as string));
    safeIds = requestedIds.filter((id) => allowedIds.has(id));
  }
  if (selfRequested) {
    safeIds.push(callerUserId);
  }
  if (safeIds.length === 0) {
    return NextResponse.json({ ok: true, contacts: [] });
  }

  // Resolve VM contacts. Use select("*") per Rule 19 since the surface
  // is small and we need to dodge any future column-grant misconfig.
  const { data: vmRows, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .in("assigned_to", safeIds)
    .eq("health_status", "healthy")
    .not("xmtp_address", "is", null);

  if (vmErr) {
    return NextResponse.json({ error: "vm lookup failed" }, { status: 503 });
  }

  const { data: userRows, error: userErr } = await supabase
    .from("instaclaw_users")
    .select("id, name, world_wallet_address, telegram_handle")
    .in("id", safeIds);

  if (userErr) {
    return NextResponse.json({ error: "user lookup failed" }, { status: 503 });
  }
  const userById = new Map((userRows || []).map((u) => [u.id as string, u]));

  const contacts = (vmRows || [])
    .map((vmRow) => {
      const userId = vmRow.assigned_to as string;
      const u = userById.get(userId);
      const identityWallet =
        (vmRow.bankr_evm_address as string | null) ||
        (u?.world_wallet_address as string | null) ||
        null;
      const tgUsername = (vmRow.telegram_bot_username as string | null) || null;
      // Normalize the personal handle for renderers — stored
      // without "@", returned without "@", renderer prepends.
      const personalHandle = (u?.telegram_handle as string | null);
      return {
        user_id: userId,
        name: (u?.name as string | null) || (vmRow.agent_name as string | null) || "InstaClaw user",
        agent_name: (vmRow.agent_name as string | null) || null,
        telegram_handle: personalHandle ? personalHandle.replace(/^@/, "") : null,
        telegram_bot_username: tgUsername ? tgUsername.replace(/^@/, "") : null,
        xmtp_address: vmRow.xmtp_address as string,
        identity_wallet: identityWallet,
        vm_name: (vmRow.name as string | null) || null,
      };
    })
    .filter((c) => !!c.xmtp_address);

  return NextResponse.json({ ok: true, contacts });
}
