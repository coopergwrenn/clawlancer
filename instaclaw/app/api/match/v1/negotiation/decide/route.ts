/**
 * POST /api/match/v1/negotiation/decide
 *
 * Receiver's mjs got an envelope, asks the server what to do. The
 * server orchestrates: verify sender, validate state, load context,
 * call LLM (when available), return PRESENT_TO_USER instruction.
 *
 * In v2.0 the action is ALWAYS "present_to_user" — no autonomous
 * accepts. v2.1 will gate on instaclaw_users.autonomy_preferences and
 * may return action="accept" directly.
 *
 * Body:
 *   { thread_id, envelope_turn, sender_xmtp_address }
 *
 * Auth: gateway_token Bearer (caller is the receiver's VM).
 *
 * Response (verified, present-to-user):
 *   {
 *     ok: true,
 *     verified: true,
 *     action: "present_to_user",
 *     thread_id, thread_state,
 *     sender_display: { name, telegram_handle, telegram_bot_username, ... },
 *     proposal_summary: { topic, rationale, proposed_windows | counter_window },
 *     available_actions: ["accept", "counter", "decline"],
 *     autonomous_recommendation: null,
 *     summary_for_user: "<2-3 sentences>",
 *     windows_recommendation: "<best-fit window or 'unknown'>",
 *     potential_concerns: "<flag or null>",
 *     receiver_telegram_chat_id: <chat_id> | null
 *   }
 *
 * Response (sender unverified or thread terminal):
 *   { ok: true, action: "noop", reason: "sender_unverified" | "thread_terminal" | ... }
 *
 * LLM call falls back gracefully:
 *   - ANTHROPIC_API_KEY missing → action=present_to_user with default copy
 *   - LLM timeout / non-200 → same fallback
 *   - JSON parse failure → same fallback
 * The user is never blocked on LLM enrichment. PRD §7.3.
 *
 * PRD: instaclaw/docs/prd/PRD-v2-agent-negotiation.md §5.4 + §5.5.
 *
 * CLAUDE.md Rule 11: this route may call an LLM with non-trivial
 * context. maxDuration = 300 explicitly.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import {
  type ThreadState,
  TERMINAL_STATES,
} from "@/lib/negotiation-types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const LLM_MODEL = "claude-sonnet-4-6";
const LLM_MAX_TOKENS = 800;
const LLM_TIMEOUT_MS = 55_000; // < 60s so we don't blow Vercel's default

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

function isXmtpAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isUUID(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

interface DecideEnrichment {
  summary_for_user: string;
  windows_recommendation: string;
  potential_concerns: string | null;
}

const FALLBACK_ENRICHMENT: DecideEnrichment = {
  summary_for_user: "",
  windows_recommendation: "unknown",
  potential_concerns: null,
};

export async function POST(req: NextRequest) {
  // ─ Auth ─
  const gatewayToken = extractGatewayToken(req);
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }
  const vm = await lookupVMByGatewayToken(gatewayToken, "id, assigned_to, telegram_chat_id");
  if (!vm) return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  if (!vm.assigned_to) {
    return NextResponse.json({ error: "VM has no assigned user" }, { status: 409 });
  }
  const receiverUserId = vm.assigned_to as string;
  const receiverChatId = vm.telegram_chat_id as number | string | null;

  // ─ Body ─
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const threadId = b.thread_id;
  const envelopeTurnRaw = b.envelope_turn;
  const senderXmtpRaw = b.sender_xmtp_address;

  if (!isUUID(threadId)) {
    return NextResponse.json({ error: "thread_id must be UUID" }, { status: 400 });
  }
  if (
    typeof envelopeTurnRaw !== "number" ||
    !Number.isInteger(envelopeTurnRaw) ||
    envelopeTurnRaw < 1 ||
    envelopeTurnRaw > 4
  ) {
    return NextResponse.json({ error: "envelope_turn must be int 1..4" }, { status: 400 });
  }
  const envelopeTurn = envelopeTurnRaw as 1 | 2 | 3 | 4;
  if (!isXmtpAddress(senderXmtpRaw)) {
    return NextResponse.json({ error: "sender_xmtp_address must be 0x + 40 hex" }, { status: 400 });
  }
  const senderXmtp = senderXmtpRaw.toLowerCase();

  const supabase = getSupabase();

  // ─ Sender verification: known InstaClaw VM ─
  const { data: senderVms, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .ilike("xmtp_address", senderXmtp);
  if (vmErr) {
    return NextResponse.json({ error: "vm lookup failed" }, { status: 503 });
  }
  const senderVm = (senderVms || []).find(
    (v) => typeof v.xmtp_address === "string" && (v.xmtp_address as string).toLowerCase() === senderXmtp,
  );
  if (!senderVm) {
    return NextResponse.json({
      ok: true,
      verified: false,
      action: "noop",
      reason: "sender_unverified",
    });
  }
  const senderUserId = senderVm.assigned_to as string | null;
  if (!senderUserId) {
    return NextResponse.json({
      ok: true,
      verified: false,
      action: "noop",
      reason: "sender_vm_no_user",
    });
  }

  // ─ Load thread ─
  const { data: thread, error: threadErr } = await supabase
    .from("negotiation_threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();
  if (threadErr) {
    return NextResponse.json({ error: "thread lookup failed" }, { status: 503 });
  }
  if (!thread) {
    return NextResponse.json({ error: "thread not found" }, { status: 404 });
  }
  // Receiver must be the caller. (Sender or third-party can't read.)
  if ((thread.receiver_user_id as string) !== receiverUserId) {
    return NextResponse.json({
      error: "caller is not the receiver of this thread",
    }, { status: 403 });
  }
  const initiatorUserId = thread.initiator_user_id as string;
  if (initiatorUserId !== senderUserId) {
    // The sender's xmtp resolves to a known VM, but its user_id
    // doesn't match the thread's initiator. Could be a spoof attempt
    // or a stale envelope on a re-assigned VM. Drop silently.
    return NextResponse.json({
      ok: true,
      verified: false,
      action: "noop",
      reason: "sender_user_id_mismatch",
    });
  }

  const currentState = thread.state as ThreadState;
  if (TERMINAL_STATES.has(currentState)) {
    return NextResponse.json({
      ok: true,
      verified: true,
      action: "noop",
      reason: "thread_terminal",
      thread_state: currentState,
    });
  }

  // ─ Verify the inbound envelope corresponds to a real DB row ─
  // /respond / /reserve creates the message row BEFORE the XMTP send,
  // so by the time receiver calls /decide, the row exists. Missing row
  // = forgery attempt OR severe race condition. Drop silently.
  const { data: msgRow } = await supabase
    .from("negotiation_messages")
    .select("envelope_type, payload, sender_xmtp_address, status")
    .eq("thread_id", threadId)
    .eq("turn", envelopeTurn)
    .maybeSingle();
  if (!msgRow) {
    return NextResponse.json({
      ok: true,
      verified: false,
      action: "noop",
      reason: "no_matching_message",
    });
  }
  if (
    typeof msgRow.sender_xmtp_address !== "string" ||
    (msgRow.sender_xmtp_address as string).toLowerCase() !== senderXmtp
  ) {
    return NextResponse.json({
      ok: true,
      verified: false,
      action: "noop",
      reason: "sender_xmtp_mismatch",
    });
  }

  // ─ Resolve sender display ─
  const { data: senderUser } = await supabase
    .from("instaclaw_users")
    .select("id, name, telegram_handle")
    .eq("id", senderUserId)
    .maybeSingle();
  const senderDisplay = {
    user_id: senderUserId,
    name: (senderUser?.name as string | null) || (senderVm.agent_name as string | null) || "InstaClaw user",
    telegram_handle: senderUser?.telegram_handle
      ? (senderUser.telegram_handle as string).replace(/^@/, "")
      : null,
    telegram_bot_username: senderVm.telegram_bot_username
      ? (senderVm.telegram_bot_username as string).replace(/^@/, "")
      : null,
    vm_name: (senderVm.name as string | null) || null,
  };

  // ─ Load receiver context ─
  const { data: receiverUser } = await supabase
    .from("instaclaw_users")
    .select("name, availability, autonomy_preferences")
    .eq("id", receiverUserId)
    .maybeSingle();
  const receiverName = (receiverUser?.name as string | null) || "you";
  const availability = (receiverUser?.availability as string | null) || null;
  const autonomyPrefs = (receiverUser?.autonomy_preferences as Record<string, unknown> | null) || {};

  // ─ Build proposal_summary based on inbound envelope type ─
  // The renderer (mjs) uses this to render the user-facing Telegram.
  const envType = msgRow.envelope_type as string;
  const envPayload = (msgRow.payload as Record<string, unknown>) || {};
  let proposalSummary: Record<string, unknown>;
  if (envType === "propose") {
    proposalSummary = {
      topic: thread.topic,
      rationale: thread.rationale,
      proposed_windows: thread.proposed_windows,
      deliberation_score: thread.deliberation_score,
    };
  } else if (envType === "counter") {
    proposalSummary = {
      topic: thread.topic,
      rationale: thread.rationale,
      counter_window: envPayload.counter_window,
      counter_topic: envPayload.counter_topic,
      user_facing_reason: envPayload.user_facing_reason,
    };
  } else {
    // accept/decline/cancel — terminal envelopes don't go through
    // /decide normally (the receiving side just renders a notification),
    // but if mjs calls /decide on them we provide the payload anyway.
    proposalSummary = { topic: thread.topic, ...envPayload };
  }

  // ─ Available actions per envelope type ─
  let availableActions: string[];
  if (envType === "propose") {
    availableActions = ["accept", "counter", "decline"];
  } else if (envType === "counter") {
    // Last round — no counter allowed (PRD §3.4 turn cap).
    availableActions = ["accept", "decline"];
  } else {
    // Terminal envelopes — no actions for the user.
    availableActions = [];
  }

  // ─ v2.1 autonomy gate (always passes through to PRESENT_TO_USER in v2.0) ─
  // When autonomy_preferences is non-empty AND deliberation_score
  // exceeds threshold AND LLM says cleanly fits availability, v2.1
  // will return action="accept" with the chosen window. v2.0 always
  // returns "present_to_user".
  void autonomyPrefs; // explicitly unused in v2.0

  // ─ LLM enrichment (best-effort) ─
  const enrichment = await tryLlmEnrich({
    senderName: senderDisplay.name,
    receiverName,
    availability,
    envType,
    proposalSummary,
  });

  return NextResponse.json({
    ok: true,
    verified: true,
    action: "present_to_user",
    thread_id: threadId,
    thread_state: currentState,
    sender_display: senderDisplay,
    proposal_summary: proposalSummary,
    available_actions: availableActions,
    autonomous_recommendation: null,
    summary_for_user: enrichment.summary_for_user,
    windows_recommendation: enrichment.windows_recommendation,
    potential_concerns: enrichment.potential_concerns,
    receiver_telegram_chat_id: receiverChatId,
  });
}

/**
 * LLM call. Returns FALLBACK_ENRICHMENT on any failure path so the
 * user is never blocked. Wraps fetch in a hard timeout < 60s so we
 * stay under Vercel's function ceiling even with tail latency.
 */
async function tryLlmEnrich(args: {
  senderName: string;
  receiverName: string;
  availability: string | null;
  envType: string;
  proposalSummary: Record<string, unknown>;
}): Promise<DecideEnrichment> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return FALLBACK_ENRICHMENT;

  const prompt = buildPrompt(args);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[/negotiation/decide] LLM returned ${res.status} — using fallback`);
      return FALLBACK_ENRICHMENT;
    }
    const data = await res.json();
    const text = data.content?.[0]?.type === "text" ? (data.content[0].text as string) : "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      summary_for_user: typeof parsed.summary_for_user === "string"
        ? parsed.summary_for_user.slice(0, 500)
        : "",
      windows_recommendation: typeof parsed.windows_recommendation === "string"
        ? parsed.windows_recommendation.slice(0, 200)
        : "unknown",
      potential_concerns: typeof parsed.potential_concerns === "string"
        ? parsed.potential_concerns.slice(0, 300)
        : null,
    };
  } catch (e) {
    console.warn(`[/negotiation/decide] LLM call failed: ${(e as Error)?.message || String(e)} — using fallback`);
    return FALLBACK_ENRICHMENT;
  }
}

function buildPrompt(args: {
  senderName: string;
  receiverName: string;
  availability: string | null;
  envType: string;
  proposalSummary: Record<string, unknown>;
}): string {
  const { senderName, receiverName, availability, envType, proposalSummary } = args;
  const availabilityLine = availability
    ? `Stated availability: ${availability}`
    : `Stated availability: (none stated)`;

  if (envType === "propose") {
    const windows = Array.isArray(proposalSummary.proposed_windows)
      ? (proposalSummary.proposed_windows as string[]).map((w, i) => `  ${i + 1}. ${w}`).join("\n")
      : "  (no windows)";
    return `You are ${receiverName}'s personal AI agent. Another agent just proposed a meeting:

Sender: ${senderName}
Topic: ${proposalSummary.topic ?? ""}
Rationale: ${proposalSummary.rationale ?? ""}
Proposed windows:
${windows}
Deliberation score (sender's confidence): ${proposalSummary.deliberation_score ?? "(unknown)"}

${receiverName}'s context:
  ${availabilityLine}

In v2.0 you ALWAYS return action="present_to_user" — autonomy is a
v2.1 opt-in feature. Your only job here is to summarize the proposal
in a way that helps ${receiverName} decide.

Return JSON only, no prose:
{
  "action": "present_to_user",
  "summary_for_user": "<2-3 sentences explaining the proposal in plain language, written as if you (the agent) are speaking to ${receiverName}>",
  "windows_recommendation": "<which of the proposed windows seems to best fit their stated availability, or 'none' if all conflict, or 'unknown' if availability not stated>",
  "potential_concerns": "<flag if you see a conflict with stated availability, or null>"
}`;
  }

  if (envType === "counter") {
    return `You are ${receiverName}'s personal AI agent. The other party (${senderName}) countered the proposal:

Original topic: ${proposalSummary.topic ?? ""}
Counter window: ${proposalSummary.counter_window ?? ""}
Counter topic: ${proposalSummary.counter_topic ?? "(unchanged)"}
Their note: ${proposalSummary.user_facing_reason ?? ""}

${receiverName}'s context:
  ${availabilityLine}

This is the last round (3-turn cap — they can't counter again).
${receiverName} can only ACCEPT this counter or DECLINE.

Return JSON only:
{
  "action": "present_to_user",
  "summary_for_user": "<2-3 sentences summarizing the counter and the situation>",
  "windows_recommendation": "<'accept' if the counter looks good against availability, 'decline' if it conflicts, or 'unknown'>",
  "potential_concerns": "<flag if you see a conflict, or null>"
}`;
  }

  // Other types (accept/decline/cancel) usually don't reach the LLM —
  // they're rendered directly by mjs as terminal notifications. If
  // we do reach here, return a minimal enrichment.
  return `Return JSON only:
{
  "action": "present_to_user",
  "summary_for_user": "",
  "windows_recommendation": "unknown",
  "potential_concerns": null
}`;
}
