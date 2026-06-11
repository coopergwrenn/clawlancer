/**
 * Central Higgsfield account balance — World A (direct read) + World B
 * (ledger inference). Launch build order §5.
 *
 * WHY TWO WORLDS: the HF API is auth-first (every unauthenticated POST
 * returns 401 BEFORE routing — verified 2026-06-11 with a fake-path
 * calibration), so whether a balance endpoint exists is unknowable without
 * the key. The key lives only in Vercel env (sensitive). So the cron
 * SELF-DISCOVERS at runtime: try a bounded list of candidate endpoints with
 * the key (World A); if none yields a recognizable balance, fall back to
 * inference (World B): a known anchor balance minus our own settle ledger's
 * burn since the anchor. Our DB is a PROVEN burn meter — the 2026-06-11
 * reconciliation matched the HF dashboard to the credit (171 == 171).
 *
 * World B anchor: env HIGGSFIELD_BALANCE_ANCHOR = "<credits>@<ISO8601>"
 *   e.g.  56@2026-06-11T23:00:00Z
 * Operator updates it after every manual top-up / dashboard reading. If
 * auto-top-up fires between anchor updates, inference UNDERESTIMATES —
 * the fail-safe direction (false low-alarm beats silent zero).
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const HF_BASE = "https://platform.higgsfield.ai";

/** Candidate balance endpoints, tried in order. Bounded + cheap (10s each).
 *  The /v1 router is POST-shaped (GETs 405 at the edge), so all POST.
 *  BILLABLE-SUBMIT SAFETY: these are single-segment account-ish paths, NOT
 *  model-slug-shaped generation endpoints (those look like
 *  kling-video/v3.0/pro/...), and the body is {} which fails any generation
 *  endpoint's validation — a probe can never start a billable render. */
const BALANCE_CANDIDATES = ["/v1/balance", "/v1/me", "/v1/account", "/v1/credits"];

/** Sanity bounds for a parsed balance — rejects absurd parses. */
const BALANCE_MIN = 0;
const BALANCE_MAX = 1e9;

export type BalanceReading =
  | { world: "A"; balanceCredits: number; endpoint: string }
  | { world: "B"; balanceCredits: number; anchorCredits: number; anchorAt: string; burnSinceAnchor: number }
  | { world: "none"; reason: string };

/** Walk a parsed JSON object (depth ≤ 2) for a numeric field whose key
 *  matches /balance|credit/i. Strict: finite, within sanity bounds. */
function extractBalance(obj: unknown): number | null {
  if (!obj || typeof obj !== "object") return null;
  const tryVal = (k: string, v: unknown): number | null => {
    if (!/balance|credit/i.test(k)) return null;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= BALANCE_MIN && n < BALANCE_MAX ? n : null;
  };
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const direct = tryVal(k, v);
    if (direct !== null) return direct;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const nested = tryVal(k2, v2);
        if (nested !== null) return nested;
      }
    }
  }
  return null;
}

/** World A: probe candidate endpoints with the cloud key. Returns the first
 *  recognizable balance, or null if no candidate yields one. */
export async function probeBalanceDirect(cloudKey: string): Promise<{ balanceCredits: number; endpoint: string } | null> {
  for (const ep of BALANCE_CANDIDATES) {
    try {
      const res = await fetch(`${HF_BASE}${ep}`, {
        method: "POST",
        headers: { Authorization: `Key ${cloudKey}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue; // 404/405/422 → not this candidate
      const body = (await res.json().catch(() => null)) as unknown;
      const bal = extractBalance(body);
      if (bal !== null) return { balanceCredits: bal, endpoint: ep };
      logger.info("higgsfield balance probe: 200 but no recognizable balance field", {
        route: "lib/higgsfield-balance", endpoint: ep,
      });
    } catch {
      // timeout / network — try the next candidate
    }
  }
  return null;
}

/** Parse env HIGGSFIELD_BALANCE_ANCHOR ("<credits>@<ISO>"). */
export function parseAnchor(raw: string | undefined): { credits: number; at: string } | null {
  if (!raw) return null;
  const at = raw.indexOf("@");
  if (at <= 0) return null;
  const credits = Number(raw.slice(0, at));
  const iso = raw.slice(at + 1);
  const t = Date.parse(iso);
  if (!Number.isFinite(credits) || credits < 0 || !Number.isFinite(t)) return null;
  return { credits, at: new Date(t).toISOString() };
}

/** World B: anchor − Σ(hf_cost_credits of settled renders since the anchor).
 *  created_at is used (uniformly present, within minutes of settle).
 *  NOTE: rows created before the §2 COGS correction store the old
 *  hfCostCredits=15 for kling (real cost 13), so burn over a window spanning
 *  them OVER-counts ~2 cr/render → balance UNDERestimates → false-low, never
 *  false-high. Fail-safe direction; self-heals as the anchor is refreshed
 *  (only post-anchor rows count, and new rows store 13). */
export async function inferBalanceFromLedger(anchor: { credits: number; at: string }): Promise<{ balanceCredits: number; burnSinceAnchor: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_video_transactions")
    .select("hf_cost_credits")
    .eq("status", "settled")
    .gte("created_at", anchor.at);
  if (error) throw new Error(`ledger burn query failed: ${error.message}`);
  const burn = (data ?? []).reduce((s, r) => s + Number(r.hf_cost_credits || 0), 0);
  return { balanceCredits: anchor.credits - burn, burnSinceAnchor: burn };
}

/** Full reading: World A first, World B fallback, "none" with reason. */
export async function readCentralBalance(): Promise<BalanceReading> {
  const cloudKey = process.env.HIGGSFIELD_CLOUD_KEY;
  if (cloudKey) {
    const direct = await probeBalanceDirect(cloudKey);
    if (direct) return { world: "A", ...direct };
  } else {
    logger.error("higgsfield balance: HIGGSFIELD_CLOUD_KEY not configured", {
      route: "lib/higgsfield-balance",
    });
  }
  const anchor = parseAnchor(process.env.HIGGSFIELD_BALANCE_ANCHOR);
  if (!anchor) {
    return {
      world: "none",
      reason: cloudKey
        ? "no balance endpoint discovered (World A) and HIGGSFIELD_BALANCE_ANCHOR unset (World B)"
        : "HIGGSFIELD_CLOUD_KEY unset and HIGGSFIELD_BALANCE_ANCHOR unset",
    };
  }
  const inferred = await inferBalanceFromLedger(anchor);
  return { world: "B", anchorCredits: anchor.credits, anchorAt: anchor.at, ...inferred };
}
