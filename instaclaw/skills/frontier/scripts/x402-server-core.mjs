/**
 * Frontier earn server — PURE CORE (no I/O, no deps, Node built-ins only).
 *
 * The §6.1.1 per-VM x402 server is the SELL side of the two-sided economy: it
 * exposes the agent's offerings as paid HTTP endpoints. This module is the
 * deterministic, unit-testable heart of it — every money-correctness decision
 * lives here so it can be proven without a network, a VM, or a real payment.
 *
 * Threat model (research-grounded, "Five Attacks on x402" + Halborn controls):
 *   - Attack II (replay/idempotency): one valid payment must yield exactly ONE
 *     service grant. IdempotencyStore.claim() is the pre-grant dedup.
 *   - payTo redirection (x402 V2 dynamic payTo): payTo comes ONLY from env
 *     (the seller's own wallet), never from the request. resolvePayTo enforces.
 *   - handler RCE-via-path: validateHandlerPath re-validates against the SAME
 *     allow-list the offerings API uses (defense in depth — never trust the
 *     stored value), so the server can't be tricked into exec'ing a non-handler.
 *   - privacy (Rule 22): privacyOn → the shell 503s before any paid work.
 *   - stale-config fail-open: OfferingsCache serves last-known-good if a refresh
 *     fails, so a control-plane blip never takes the earner down (it does NOT
 *     fail closed on offerings).
 *
 * The wire schema (PaymentRequirements / verify / settle) is handled by the shell
 * via @x402/core (schema-correct); settle-before-serve + Cache-Control:no-store
 * are enforced by the shell's flow ordering. This core is protocol-shape-agnostic
 * except buildPaymentRequirements, which mirrors the x402 v2 accepts[] entry.
 */

// ── handler_path + slug allow-lists — COPIED VERBATIM from
//    app/api/agent-economy/offerings/route.ts. The server re-validates the stored
//    handler_path against THIS before exec (the route comment mandates it). ──
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HANDLER_RE =
  /^~\/(?:\.openclaw\/skills\/[a-z0-9_-]+\/scripts\/handlers|scripts\/handlers)\/[a-z0-9_-]+\.(?:py|ts|mjs|sh)$/;
const MAX_HANDLER_PATH = 200;

/** Re-validate a stored handler_path before exec. Necessary (path-traversal/RCE
 *  guard) but NOT sufficient on its own — the shell ALSO bounds exec with a
 *  timeout + resource limit + the 256KB input cap (resource-exhaustion guard). */
export function validateHandlerPath(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= MAX_HANDLER_PATH &&
    !p.includes("..") &&
    HANDLER_RE.test(p)
  );
}

export function validateSlug(s) {
  return typeof s === "string" && SLUG_RE.test(s);
}

// ── handler env boundary (🟡-1) — default-DENY. The spawned handler env is built
//    from {} and gets ONLY these benign vars, NEVER a spread of the server's
//    process.env (which, via EnvironmentFile=~/.openclaw/.env, carries
//    BANKR_API_KEY, GATEWAY_TOKEN, X402_PROXY_SECRET, and every other secret).
//    Allow-list, not deny-list → a NEW secret added to the server env later is
//    excluded automatically, no maintenance. PATH + HOME are explicit opts so the
//    future sandbox layer can curate/jail them for foreign code.
//
//    SCOPE (do not oversell): this closes the ENV channel ONLY. A handler can still
//    read ~/.openclaw/.env (and the wallet, auth-profiles.json) OFF DISK — that's the
//    FILESYSTEM channel, closed by the systemd sandbox battery + per-handler rlimit
//    jail (separate before-fleet items). The §7 compute marketplace runs untrusted
//    handlers through this exact seam; the full foreign-code boundary is env ∧
//    filesystem ∧ resources ∧ network, not env alone.
export const HANDLER_ENV_ALLOWLIST = ["LANG", "LC_ALL", "TZ"]; // benign locale only — never a credential

/** Construct the minimal env for a spawned handler. Built from {} (NOT a spread of
 *  parentEnv), so every var not explicitly allow-listed — every secret — is absent.
 *  PATH is curated (default standard dirs; the server passes one that also includes
 *  the node bin). HOME is an explicit opt the sandbox layer jails for foreign code. */
export function buildHandlerEnv(parentEnv, opts = {}) {
  const p = parentEnv || {};
  const out = {};
  out.PATH = opts.path || "/usr/local/bin:/usr/bin:/bin";
  out.HOME = opts.home ?? p.HOME ?? "/tmp";
  for (const k of HANDLER_ENV_ALLOWLIST) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

// ── per-handler RESOURCE jail (rlimit) — run the handler in its OWN transient cgroup
//    via `systemd-run --user` (a SIBLING of the server's unit, NOT a child), so a
//    handler OOM / fork-bomb / CPU-spin is killed/throttled in ITS cgroup and can't
//    starve the payment server. cgroup control is delegated + ENFORCES on this kernel
//    (verified: MemoryMax OOM-kills; memory/pids/cpu controllers live) — unlike the
//    mount-namespace filesystem directives, which silently no-op under
//    apparmor_restrict_unprivileged_userns=1.
//
//    Limits measured off node's real baseline (42MB RSS, ~7-11 threads) → real headroom:
const HANDLER_LIMITS = {
  memoryMax: "256M",     // node ≈ 42MB RSS → 6× headroom; a >256M bomb is OOM-killed
  tasksMax: "64",        // node ≈ 7-11 threads → headroom; caps a fork-bomb
  cpuQuota: "100%",      // 1 of 2 vCPU; bounds a spinner, leaves a core for the server
  runtimeMaxSec: 20,     // = HANDLER_TIMEOUT_MS; systemd-enforced wall-time (no orphan)
};
//    SCOPE: closes the RESOURCES channel only. Filesystem (Landlock) + network are §7-gated.
//    Deliberately ABSENT (footguns / no-ops on this kernel): MemoryDenyWriteExecute (breaks
//    node's V8 JIT), InaccessiblePaths/ProtectHome (silently no-op for --user services here).

/** Build the `systemd-run` argv (sans the leading "systemd-run") that runs `interp
 *  handlerAbsPath` in a resource-jailed transient user unit with a clean minimal env.
 *  `env` is the buildHandlerEnv output; `env -i` re-applies EXACTLY those keys inside the
 *  unit, preserving the 🟡-1 boundary regardless of what the transient unit inherits. */
export function buildHandlerSandboxArgs(interp, handlerAbsPath, env, limits = HANDLER_LIMITS) {
  const envAssignments = Object.keys(env || {}).map((k) => `${k}=${env[k]}`);
  return [
    "--user", "--pipe", "--quiet", "--wait", "--collect",
    `--property=MemoryMax=${limits.memoryMax}`,
    `--property=TasksMax=${limits.tasksMax}`,
    `--property=CPUQuota=${limits.cpuQuota}`,
    `--property=RuntimeMaxSec=${limits.runtimeMaxSec}`,
    "--",
    "/usr/bin/env", "-i", ...envAssignments,
    interp, handlerAbsPath,
  ];
}

// ── payTo: ONLY from env, never the request (x402 V2 payTo-redirection guard). ──
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/** Resolve the seller payTo from env. Returns {payTo} or {error}. There is no
 *  parameter by which a request could supply payTo — that's the whole point. */
export function resolvePayTo(env) {
  const a = (env && env.BANKR_WALLET_ADDRESS) || "";
  if (!EVM_ADDR_RE.test(a)) {
    return { error: "BANKR_WALLET_ADDRESS missing or not a 0x EVM address" };
  }
  return { payTo: a };
}

// ── privacy gate (Rule 22): parse ~/.openclaw/.privacy-state content. ──
/** True iff privacy mode is ON. Fail-SAFE: unreadable/garbage → treat as OFF is
 *  WRONG for a privacy gate; we fail toward privacy only when the marker says so.
 *  Matches the doc's `.includes("on")`, tightened to a word-boundary token. */
export function isPrivacyOn(stateText) {
  if (typeof stateText !== "string") return false;
  return /\bon\b/i.test(stateText.trim());
}

// ── USDC atomic conversion (6 decimals on Base). String to avoid float drift. ──
export function atomicUsdc(priceUsdc) {
  if (typeof priceUsdc !== "number" || !Number.isFinite(priceUsdc) || priceUsdc <= 0) {
    throw new Error("price_usdc must be a positive finite number");
  }
  // round to 6 dp, then to integer atomic units, as a base-10 string
  return String(Math.round(priceUsdc * 1e6));
}

/**
 * Build one x402 v2 PaymentRequirements (`accepts[]`) entry for an offering.
 * Mirrors @x402/core's PaymentRequirements shape; the buyer's
 * selectPaymentRequirement reads scheme/network/asset/amount(or maxAmountRequired)/
 * payTo/maxTimeoutSeconds. We emit BOTH `amount` (v2) and `maxAmountRequired`
 * (v1 compat) so either buyer path selects correctly. payTo is the env wallet.
 */
export function buildPaymentRequirements(offering, ctx) {
  const atomic = atomicUsdc(offering.price_usdc);
  return {
    scheme: "exact",
    network: ctx.network, // e.g. "base" | "eip155:8453"
    asset: ctx.asset, // Base USDC contract
    amount: atomic, // v2
    maxAmountRequired: atomic, // v1 compat
    payTo: ctx.payTo, // env, never request
    resource: ctx.resource, // the full https URL of POST /v1/<slug>
    description: String(offering.description || "").slice(0, 2000),
    mimeType: "application/json",
    maxTimeoutSeconds: ctx.maxTimeoutSeconds ?? 60,
    // EIP-712 domain of Base USDC — VERIFIED ON-CHAIN: name()="USD Coin", version()="2".
    // The buyer feeds extra.name straight into the typed data it signs; "USDC" here
    // (a common mistake) recovers the wrong signer and the facilitator rejects it.
    extra: { name: "USD Coin", version: "2" },
  };
}

/**
 * Idempotency store (Attack II defense) — a three-state lifecycle per payment,
 * keyed by the EIP-3009 nonce + offering slug:
 *
 *   claim()   → PENDING   (concurrency gate, taken BEFORE settle so two concurrent
 *                          same-nonce requests serialize to exactly one "fresh")
 *   commit()  → COMMITTED (settle SUCCEEDED — keep it; replays rejected until TTL,
 *                          then the on-chain nonce backstops)
 *   release() → deleted   (settle FAILED — free the nonce for retry)
 *
 * CRITICAL: this store is NOT the double-spend guard — the on-chain nonce
 * consumption is. So release-on-settle-failure is safe even for an ambiguous
 * throw that actually settled: a later same-nonce replay's verify rejects the
 * consumed nonce. The store's only jobs are (a) serialize concurrent dups and
 * (b) fast-reject committed replays. release() refuses to delete a COMMITTED
 * entry (defensive — a settled nonce must never be freed).
 *
 * In-memory + TTL for the canary. Fleet follow-up (🟡-6, before-fleet): a durable
 * SELLER-side store keyed on the nonce (the schema's UNIQUE(vm_id,request_id) is
 * buyer-side, a different key).
 */
export class IdempotencyStore {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this._seen = new Map(); // key -> { state: "pending" | "committed", at: ms }
  }
  _key(nonce, slug) {
    return `${String(nonce)}::${String(slug)}`;
  }
  /** Atomically claim (PENDING). "fresh" → proceed; "duplicate" → reject (pending
   *  OR committed). Synchronous: no await between has-check and set, so the gate is
   *  atomic against concurrent same-nonce requests. */
  claim(nonce, slug, nowMs) {
    this._prune(nowMs);
    const k = this._key(nonce, slug);
    if (this._seen.has(k)) return "duplicate";
    this._seen.set(k, { state: "pending", at: nowMs });
    return "fresh";
  }
  /** Settle SUCCEEDED → mark COMMITTED (refresh TTL). No-op if the entry is gone. */
  commit(nonce, slug, nowMs) {
    const e = this._seen.get(this._key(nonce, slug));
    if (e) { e.state = "committed"; e.at = nowMs; }
  }
  /** Settle FAILED → free a PENDING nonce for retry. NEVER deletes a COMMITTED
   *  entry (a settled nonce must stay blocked). No-op if absent. */
  release(nonce, slug) {
    const k = this._key(nonce, slug);
    const e = this._seen.get(k);
    if (e && e.state === "pending") this._seen.delete(k);
  }
  _prune(nowMs) {
    for (const [k, e] of this._seen) {
      if (nowMs - e.at > this.ttlMs) this._seen.delete(k);
    }
  }
  size() {
    return this._seen.size;
  }
}

/**
 * Offerings cache — hydrate from the offerings API, refresh on a timer, and
 * SERVE LAST-KNOWN-GOOD on a failed refresh (fail-open on stale config; a brief
 * control-plane outage must never take the earner down). The doc's
 * frontier-offerings.json is the restart cache (last-good persisted), not the
 * source of truth. This class is the in-memory truth + refresh policy; the shell
 * supplies the fetch fn (GET /offerings, gateway token) and the disk persistence.
 */
export class OfferingsCache {
  constructor() {
    this._offerings = null; // null until first successful hydrate
    this._lastGoodAtMs = 0;
    this._lastError = null;
    this._lastErrorAtMs = 0;
  }
  /** Active offerings only, keyed by slug. {} before first hydrate. */
  current() {
    if (!this._offerings) return {};
    const out = {};
    for (const o of this._offerings) if (o && o.active && validateSlug(o.slug)) out[o.slug] = o;
    return out;
  }
  hasData() {
    return this._offerings !== null;
  }
  status() {
    return {
      hasData: this.hasData(),
      count: this._offerings ? this._offerings.length : 0,
      lastGoodAtMs: this._lastGoodAtMs,
      lastError: this._lastError,
      lastErrorAtMs: this._lastErrorAtMs,
    };
  }
  /**
   * Refresh via fetchFn() → array of offerings. On success, replace the cache.
   * On failure, KEEP the last-known-good and record the error (serve-stale).
   * Returns "ok" | "stale" (kept last-good) | "empty" (failed, no last-good yet).
   */
  async refresh(fetchFn, nowMs) {
    try {
      const list = await fetchFn();
      if (!Array.isArray(list)) throw new Error("offerings fetch did not return an array");
      this._offerings = list;
      this._lastGoodAtMs = nowMs;
      this._lastError = null;
      return "ok";
    } catch (e) {
      this._lastError = String((e && e.message) || e).slice(0, 200);
      this._lastErrorAtMs = nowMs;
      return this._offerings ? "stale" : "empty";
    }
  }
}
