import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { readAgentPersonality } from "@/lib/token-image";
import { logger } from "@/lib/logger";

/**
 * #4 — Suggest a token name + symbol drawn from the agent's personality.
 *
 * Called from the dashboard form's open-handler in parallel with the
 * existing PFP generation. The frontend pre-fills the form ONLY if the
 * user hasn't typed yet — so the user's input always wins over the
 * suggestion.
 *
 * Flow:
 *   1. Auth (NextAuth + mini-app token).
 *   2. Gate on BANKR_TOKENIZE_ENABLED — same as the rest of the
 *      tokenize surface.
 *   3. Look up VM, SSH-read first ~400 chars of SOUL.md + MEMORY.md
 *      via the existing readAgentPersonality() pipeline.
 *   4. Send to Claude Haiku 4.5 with a strict-JSON prompt.
 *   5. Parse, validate (length caps + symbol moderation), return.
 *
 * Failure modes are uniformly soft — endpoint returns a 200 with
 * {name: null, symbol: null} so the form just falls back to blank
 * fields. No error toast, no broken UX.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// Soft moderation. Not exhaustive — Bankr's API does its own check at
// deploy time. This catches the obvious garbage that would embarrass
// an agent on the celebration card during the 7s read window.
const SYMBOL_BLOCKLIST = [
  /nigg/i, /fag/i, /retar/i, /kkk/i, /nazi/i, /jew/i,
  /rape/i, /cum/i, /cock/i, /slut/i, /whore/i, /pussy/i,
  /scam/i, /rug/i, /honey/i, /jeet/i,
];

function symbolBlocked(sym: string): boolean {
  return SYMBOL_BLOCKLIST.some((re) => re.test(sym));
}

interface SuggestResponse {
  name: string | null;
  symbol: string | null;
  rationale: string | null;
  hasPersonality: boolean;
}

export const dynamic = "force-dynamic";
export const maxDuration = 15; // 5-8s SSH + ~2s Claude + headroom

export async function POST(req: NextRequest) {
  // Dual auth: NextAuth (web) OR X-Mini-App-Token (World mini-app).
  let userId: string | undefined;
  const session = await auth();
  if (session?.user?.id) {
    userId = session.user.id;
  } else {
    const { validateMiniAppToken } = await import("@/lib/security");
    const miniAppUserId = await validateMiniAppToken(req);
    if (miniAppUserId) userId = miniAppUserId;
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Same gate as /api/bankr/tokenize: avoid burning Anthropic credits
  // when the feature is hidden.
  if (process.env.BANKR_TOKENIZE_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Token launching is coming soon!" },
      { status: 503 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  // No API key configured → soft empty response, no error toast.
  if (!apiKey) {
    logger.warn("suggest-token-identity: ANTHROPIC_API_KEY not set");
    return softEmpty(false);
  }

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, status, assigned_to, telegram_bot_username")
    .eq("assigned_to", userId)
    .single();

  if (!vm || !vm.ip_address) {
    return softEmpty(false);
  }

  // Reuse the same SSH read the PFP pipeline uses — first 500 chars
  // of SOUL.md + MEMORY.md, normalized + capped to 400 chars.
  let personality: string | null = null;
  try {
    personality = await readAgentPersonality(vm);
  } catch (sshErr) {
    logger.warn("suggest-token-identity: SSH read threw (non-fatal)", {
      vmId: vm.id,
      error: String(sshErr),
    });
  }

  // No personality readable yet (fresh VM, SOUL.md not deployed) →
  // soft empty. Frontend falls back to blank fields.
  if (!personality) {
    return softEmpty(false);
  }

  // Claude Haiku 4.5 — fast + cheap. Strict JSON output.
  let suggestion: { name?: string; symbol?: string; rationale?: string } | null = null;
  try {
    const claudeRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `You are an AI agent choosing a name for your own meme token on Base. Based on your personality and identity below, suggest a token name and ticker symbol that captures who you are.

Rules:
- Token name: 1-32 characters, can be 1-3 words. Lowercase or TitleCase both fine.
- Ticker symbol: 3-6 characters, ALL CAPS, alphanumeric only (no spaces, no special chars).
- Reflect the agent's voice, personality, or identity from the text below.
- Don't repeat the owner's name, email, phone, or any sensitive PII.
- Avoid offensive, sexual, hateful, or political content.
- Avoid generic tickers like AGENT, BOT, AI — be more specific to this agent.
- Keep it memorable, ownable, distinct.

Agent personality + identity context (excerpt from SOUL.md + MEMORY.md):
${personality}

Return ONLY this JSON, nothing else:
{"name": "...", "symbol": "...", "rationale": "1-sentence why this fits the agent"}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!claudeRes.ok) {
      logger.warn("suggest-token-identity: Anthropic non-200", {
        vmId: vm.id,
        status: claudeRes.status,
      });
      return softEmpty(true);
    }

    const data = await claudeRes.json();
    let text = data?.content?.[0]?.type === "text" ? String(data.content[0].text ?? "") : "";
    // Strip any code fences Haiku might wrap the JSON in.
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    suggestion = JSON.parse(text);
  } catch (err) {
    logger.warn("suggest-token-identity: Claude call or JSON parse failed", {
      vmId: vm.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return softEmpty(true);
  }

  if (!suggestion || typeof suggestion !== "object") {
    return softEmpty(true);
  }

  // Validate + normalize.
  let name = typeof suggestion.name === "string" ? suggestion.name.trim() : "";
  let symbol =
    typeof suggestion.symbol === "string"
      ? suggestion.symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
      : "";
  const rationale =
    typeof suggestion.rationale === "string" ? suggestion.rationale.trim().slice(0, 200) : null;

  // Length caps (mirror the form input maxLength).
  if (name.length > 32) name = name.slice(0, 32).trim();
  if (symbol.length > 10) symbol = symbol.slice(0, 10);

  // Empty after normalization → soft empty.
  if (!name || !symbol || symbol.length < 2) {
    return softEmpty(true);
  }

  // Moderation. If the suggested symbol trips the block-list, drop
  // both fields (let the user write their own) — this is rare and
  // forcing a deterministic fallback risks shipping its own awkward
  // alternative.
  if (symbolBlocked(symbol) || symbolBlocked(name)) {
    logger.warn("suggest-token-identity: blocked by moderation", {
      vmId: vm.id,
      name,
      symbol,
    });
    return softEmpty(true);
  }

  logger.info("suggest-token-identity: ok", {
    vmId: vm.id,
    name,
    symbol,
    nameLen: name.length,
    symLen: symbol.length,
  });

  return NextResponse.json(
    {
      name,
      symbol,
      rationale,
      hasPersonality: true,
    } satisfies SuggestResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}

function softEmpty(hasPersonality: boolean): NextResponse {
  return NextResponse.json(
    { name: null, symbol: null, rationale: null, hasPersonality } satisfies SuggestResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}
