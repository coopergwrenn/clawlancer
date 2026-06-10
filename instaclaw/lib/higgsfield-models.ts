/**
 * Higgsfield Cloud API — model registry, cost table, and pre-submit param
 * validation. The SINGLE source of truth shared by the gateway proxy, the
 * completion webhook, and the safety-contract test suite.
 *
 * WHY THIS EXISTS (calibration findings, 2026-06-08):
 *   #6 — the Higgsfield Cloud API SILENTLY COERCES bad params and BILLS the job
 *        instead of rejecting it. So we MUST validate model-slug + params BEFORE
 *        submit. A bad request that reaches Higgsfield = unintended real spend.
 *   #7 — billing is FRACTIONAL and cost is FLAT per model (DoP ignores
 *        `duration`; same tier = same credits). So the per-model cost here is a
 *        constant, and the held estimate == the actual charge.
 *
 * ALLOWLIST DISCIPLINE: only models whose Higgsfield credit cost we have
 * EMPIRICALLY MEASURED appear here. The gate must never bill a job whose cost it
 * is guessing. Seedance / reve / dop-first-last-frame / veo / speak are
 * deliberately EXCLUDED until measured (see calibration doc "Open / next").
 */

// Higgsfield credit economics (measured): 16 credits = $1.
export const HF_CREDIT_USD = 1 / 16; // $0.0625 per Higgsfield credit

// Margin applied to the measured Higgsfield cost to get OUR video-credits.
// charge(video-credits) = ceil(hfCostCredits * VIDEO_MARGIN). Margin lives
// here so the profitability proof and the gate read the same number.
export const VIDEO_MARGIN = 1.15;

// A sold video-credit is ~$0.10 (packs). Used only for the user-facing $ in
// quotes/proofs; the gate meters in video-credits, not dollars.
export const VIDEO_CREDIT_SALE_USD = 0.1;

export type HFModelKind = "image" | "image2video";

export interface HFModel {
  /** Cloud API slug — the endpoint path itself (NOT a body field). */
  endpoint: string;
  kind: HFModelKind;
  /**
   * MEASURED Higgsfield credit cost. Flat per model — correct ONLY because any
   * duration-variable model is LOCKED to a single measured length (see
   * allowedDurations). Never a guessed value.
   */
  hfCostCredits: number;
  /** Draws from the per-tier daily FREE allowance (charges 0) when available. */
  freeEligible: boolean;
  /** Short human label for quotes/UX. */
  label: string;
  /**
   * Per-model duration ENUM, in seconds. Present ONLY for duration-variable
   * models, and ONLY listing lengths whose cost we have MEASURED. The flat
   * hfCostCredits is the cost AT these length(s); to stay correct, validation
   * pins/locks the forwarded duration to this set so we never forward a length
   * we can't price. Kling = [10] today ($0.9375 measured); widens to [5,10]
   * once the 5s cell is measured (then estimate becomes params-aware — see the
   * DEFERRED note on estimateVideoCredits). Absent ⇒ duration is not a priced
   * lever (DoP ignores it; images have none).
   */
  allowedDurations?: number[];
}

/**
 * The allowlist. Endpoint slug → model. Costs are MEASURED (calibration table).
 * Keep keys === endpoint so a lookup is `HF_MODELS[endpoint]`.
 */
export const HF_MODELS: Record<string, HFModel> = {
  // ── Image (text→image). ~free to us; covered by the free allowance. ──
  "higgsfield-ai/soul/standard": {
    endpoint: "higgsfield-ai/soul/standard",
    kind: "image",
    hfCostCredits: 1, // measured (req be853742)
    freeEligible: true,
    label: "Image",
  },

  // ── Image→video. DoP-lite is the default (cheapest + fastest). ──
  "higgsfield-ai/dop/lite": {
    endpoint: "higgsfield-ai/dop/lite",
    kind: "image2video",
    hfCostCredits: 2, // measured (req d61e3bac)
    freeEligible: true, // the free-allowance default
    label: "Clip (fast)",
  },
  "higgsfield-ai/dop/turbo": {
    endpoint: "higgsfield-ai/dop/turbo",
    kind: "image2video",
    hfCostCredits: 6.5, // measured (req f20cac70)
    freeEligible: false, // dominated tier — paid only, not surfaced as a default
    label: "Clip (turbo)",
  },
  "higgsfield-ai/dop/standard": {
    endpoint: "higgsfield-ai/dop/standard",
    kind: "image2video",
    hfCostCredits: 9, // measured (req d2adde8d / 9f0ada5b / 935dfa01)
    freeEligible: false,
    label: "Clip (HQ short)",
  },
  "kling-video/v2.1/pro/image-to-video": {
    endpoint: "kling-video/v2.1/pro/image-to-video",
    kind: "image2video",
    // MEASURED 10s tier = $0.9375 = 15.0 cr (req 4f40be27, dashboard).
    // (15.68 was fal's estimate, not our measurement — re-pinned to the real
    //  number.) Kling is duration-SELECTABLE (5s/10s); the 5s tier is UNMEASURED,
    //  so we LOCK to 10s via allowedDurations until 5s is measured — that keeps
    //  this flat cost correct (one length = one price) and closes the overcharge.
    hfCostCredits: 15.0,
    freeEligible: false,
    label: "Clip (premium, 10s)",
    allowedDurations: [10],
  },
};

/** The product default when no model is specified: cheapest + fastest. */
export const DEFAULT_MODEL = "higgsfield-ai/dop/lite";

/**
 * Our held/charged video-credits for a model = ceil(hfCost * margin).
 * Integer at the user-facing charge; the *cost* stays fractional (calibration
 * #7 — never round the cost, only the charge).
 *
 * This is FLAT (model-only, no params) and is correct TODAY only because every
 * duration-variable model is LOCKED to a single measured length via
 * `allowedDurations` (Kling → 10s only). No mispricing is possible while that
 * lock holds: one length ⇒ one measured cost.
 *
 * DEFERRED FOLLOW-UP (funded-measurement round): once the 5s Kling cell (and
 * Seedance/Veo durations) are MEASURED, this becomes params-aware —
 * `estimateVideoCredits(model, validatedInput)` with a per-duration lookup
 * keyed on `input.duration`, and the relevant `allowedDurations` widens
 * (Kling → [5,10]). Until each cell is MEASURED (never guessed from fal's
 * price), models stay locked to their measured length(s). The settle clamp
 * (charge ≤ hold) already guards us if an estimate is ever slightly off.
 */
export function estimateVideoCredits(model: HFModel): number {
  return Math.ceil(model.hfCostCredits * VIDEO_MARGIN);
}

/** Our raw cost in USD for a model (for margin proofs). */
export function modelCostUSD(model: HFModel): number {
  return model.hfCostCredits * HF_CREDIT_USD;
}

// ── Param validation (pre-submit; closes calibration finding #6) ───────────

const MAX_PROMPT = 2000;
const MAX_URL = 2048;
const DURATION_MIN = 1;
const DURATION_MAX = 15;

export type ValidatedInput = Record<string, unknown>;
export type ValidationResult =
  | { ok: true; input: ValidatedInput }
  | { ok: false; error: string };

function isHttpUrl(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= MAX_URL &&
    /^https?:\/\//i.test(v)
  );
}

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

/**
 * Validate the caller's raw fields against the model's kind, returning ONLY the
 * sanitized fields we pass to Higgsfield. No passthrough of arbitrary keys —
 * anything not in this allow-shape is dropped, so a malformed/oversized/extra
 * field can never reach the provider and trigger a coerced bill.
 */
export function validateInput(
  model: HFModel,
  raw: {
    image_url?: unknown;
    prompt?: unknown;
    duration?: unknown;
  },
): ValidationResult {
  if (!isNonEmptyString(raw.prompt, MAX_PROMPT)) {
    return { ok: false, error: "prompt is required (1–2000 chars)" };
  }
  const prompt = (raw.prompt as string).trim();

  if (model.kind === "image") {
    // text→image: prompt only.
    return { ok: true, input: { prompt } };
  }

  // image→video: image_url + prompt (+ optional duration).
  if (!isHttpUrl(raw.image_url)) {
    return { ok: false, error: "image_url must be a valid http(s) URL" };
  }
  const input: ValidatedInput = {
    image_url: raw.image_url as string,
    prompt,
  };

  if (model.allowedDurations && model.allowedDurations.length > 0) {
    // Duration-variable model with a per-model ENUM of MEASURED lengths
    // (Kling = {10} today). Two rules close the overcharge path:
    //   • explicit duration NOT in the enum → REJECT (honest: we don't silently
    //     up-charge a 5s request to the 10s price, and we don't forward a length
    //     we can't price — never bill a guessed cost).
    //   • duration OMITTED → PIN to the canonical (first) measured length, so the
    //     forwarded job always matches the flat price we hold/charge (robust even
    //     if Higgsfield's default ever drifts off our priced length).
    if (raw.duration !== undefined && raw.duration !== null) {
      const d = Number(raw.duration);
      if (!model.allowedDurations.includes(d)) {
        return {
          ok: false,
          error: `${model.label} currently supports only ${model.allowedDurations.join("/")}s clips`,
        };
      }
      input.duration = d;
    } else {
      input.duration = model.allowedDurations[0];
    }
    return { ok: true, input };
  }

  // No per-model enum (e.g. DoP — flat cost, ignores duration upstream):
  // accept an optional duration in the generic range and forward as-is.
  if (raw.duration !== undefined && raw.duration !== null) {
    const d = Number(raw.duration);
    if (!Number.isFinite(d) || d < DURATION_MIN || d > DURATION_MAX) {
      return { ok: false, error: `duration must be ${DURATION_MIN}–${DURATION_MAX} seconds` };
    }
    input.duration = Math.round(d);
  }

  return { ok: true, input };
}

// ── Per-tier daily FREE allowance (count of free-eligible jobs). ───────────
// Cost-bounded in DoP-lite-equivalents ($0.125 each): starter ~2/day (~$7.5/mo),
// pro ~5/day, power ~15/day (calibration money model). null tier → starter.
export const FREE_CAP_BY_TIER: Record<string, number> = {
  starter: 2,
  pro: 5,
  power: 15,
  premium: 15,
};
export const FREE_CAP_DEFAULT = 2;

export function freeCapForTier(tier: string | null | undefined): number {
  if (!tier) return FREE_CAP_DEFAULT;
  return FREE_CAP_BY_TIER[tier] ?? FREE_CAP_DEFAULT;
}

/**
 * Per-VM DAILY PAID video-credit ceiling — a blast-radius safety cap (NOT a
 * product limit). Bounds how much a single compromised/abusive VM can spend in
 * one UTC day even with a large balance. The route ALWAYS passes this (never
 * NULL) so the reserve RPC's paid path can never run uncapped (hole #2 fix).
 * ~300 vc ≈ $30 user-facing / ~$15 our cost worst-case. Env-tunable.
 */
export const VIDEO_DAILY_CREDIT_CEILING = (() => {
  const raw = Number(process.env.VIDEO_DAILY_CREDIT_CEILING);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
})();

/** Stale-hold TTL: a pending hold older than this stops counting against the
 *  balance (longer than any observed job time ~6.5 min + webhook latency). */
export const FRESH_PENDING_TTL_MS = 30 * 60 * 1000;

/** Start of the current UTC day as an ISO string (the daily window anchor). */
export function utcDayStartISO(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

// ── Agent-poll status mapping (G1 Option B) ────────────────────────────────
// The agent polls `?action=status`; the gate proxies Higgsfield's
// /requests/{id}/status and maps it to this shape. The agent keeps polling
// while !done and delivers in-conversation when `ok`. Pure (no I/O) so it's
// unit-testable (Rule 31). Higgsfield status enum (catalog sweep): queued,
// in_progress, completed, failed, nsfw (+ legacy "cancelled" tolerated).
export type HFPollStatus = {
  status: string;
  done: boolean; // terminal — stop polling
  ok: boolean; // completed AND a media URL is present → deliver
  video_url: string | null;
};
// TRANSIENT-whitelist (fail-safe, M1): only these mean "still working — keep
// polling." ANYTHING ELSE is terminal — so an undocumented terminal status (a
// future "moderated"/"error"/etc.) ENDS the poll as a failure instead of looping
// to timeout and lying "still rendering." "unknown" (missing/garbled status) is
// transient so a one-off blip keeps polling. Docs' terminal set is
// completed/failed/nsfw; this is robust to the set growing.
const HF_TRANSIENT = new Set(["queued", "in_progress", "unknown"]);
export function mapHiggsfieldStatus(
  a:
    | { status?: string; video?: { url?: string }; images?: Array<{ url?: string }> }
    | null
    | undefined,
): HFPollStatus {
  const status = a?.status ?? "unknown";
  const url = a?.video?.url || a?.images?.[0]?.url || null;
  const done = !HF_TRANSIENT.has(status);
  const ok = status === "completed" && !!url;
  return { status, done, ok, video_url: ok ? url : null };
}
