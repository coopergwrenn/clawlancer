# Build design -- `human_approved` hardening (Model C tiered + D notify, phased)

**Date:** 2026-06-10
**Status:** BUILD design. Companion to the approved design (`human-approved-hardening-2026-06-10.md`) and Cooper's rulings. Captures the two security surfaces (pending-approvals table + confirm endpoint) and the notify/revoke surface at the precision the build needs. Design-first, same isolation discipline as `/settings`.
**Rulings carried in:** Model C (tiered) with threshold = the tier's `justDoItPerTx`; D's notification layered onto the forgeable tier; residual risk accepted (bounded + visible); delivery = Telegram URL-button into a session-authed confirm page; phased migration (1 additive / 2 skill flow / 3 flip gated on Rule 27 coverage).
**Read-flag CLOSED:** `frontier_reserve_spend` RPC (`20260602210000`) confirmed — `p_human_approved=true` lifts ONLY `p_cap_earned`; `p_cap_daily` always binds (`:58-65`, quoted in the build log). The inference held; no design change.

---

## The tiering, in one line

`threshold = evaluation.effectiveBands.justDoItPerTx` (the tier's calibrated autonomy line, already computed in the route -- no new constant).

- **amount < threshold** -- in-chat `--human-approved` (forgeable) is honored, AND every such spend fires an out-of-band notification ("your agent spent $X with your approval -- was that you?") + one-tap revoke. The blast radius is the band we already trust autonomously; below the line the agent's word adds nothing it couldn't already do.
- **amount >= threshold** -- session-rooted approval required, no exceptions (after the phase-3 flip). The forgeable bool is ignored at/above the line; only the human's browser session speaks.

Session approval (unforgeable) is honored at ALL amounts -- it is the strict superset of authority.

---

## Surface 1 -- `instaclaw_frontier_spend_approvals` (the pending-approvals table)

Captures the EXACT spend the agent proposed (server-side, from the gateway-token-authed authorize call) so the human approves precisely that spend and the agent cannot later mutate the amount. One row per spend, keyed `(vm_id, request_id)`.

```sql
CREATE TABLE IF NOT EXISTS public.instaclaw_frontier_spend_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id         uuid NOT NULL,
  owner_id      uuid NOT NULL,           -- = instaclaw_vms.assigned_to; the ONLY identity that may approve
  request_id    text NOT NULL,           -- the agent's spend idempotency key (single-use)
  amount_usd    numeric(14,6) NOT NULL,  -- the exact proposed amount; re-authorize MUST match
  category      text,                    -- spend identity (display + match)
  counterparty  text,                    -- display + match (address / endpoint / vm-id, whichever supplied)
  status        text NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('pending_approval','approved','denied','expired','consumed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,    -- created_at + 15min; a stale approval URL cannot be used later
  approved_at   timestamptz,             -- when the session approved
  consumed_at   timestamptz,             -- when the authorize route honored it (single-use)
  CONSTRAINT uq_fsa_vm_request UNIQUE (vm_id, request_id)
);
ALTER TABLE public.instaclaw_frontier_spend_approvals ENABLE ROW LEVEL SECURITY;  -- Rule 60: deny-all baseline
-- NO anon/authenticated policies. Service-role (route + confirm endpoint) bypasses RLS;
-- the confirm endpoint scopes every read/write by owner_id = session.user.id in code.
CREATE INDEX IF NOT EXISTS idx_fsa_owner_status ON public.instaclaw_frontier_spend_approvals (owner_id, status);
```

Lives in `pending_migrations/` until Cooper applies it, then `git mv` to `migrations/` (Rule 56). Has a `CREATE TABLE`, so it WOULD gate the build if it landed in `migrations/` un-applied.

**State machine:** `pending_approval` --[session approve]--> `approved` --[authorize honors]--> `consumed`. Or `pending_approval` --[session deny]--> `denied`. Or `pending_approval`/`approved` --[15min TTL, lazily marked on read]--> `expired`. Terminal: `consumed`, `denied`, `expired`. Single-use: `consumed_at` set on the first authorize that honors it; a replay finds `consumed` and falls through (no second honor).

**Identity binding (anti-amount-swap):** the re-authorize's `(amount, category, counterparty)` MUST match the row. A mismatch (agent proposed $1, got it approved, re-authorizes $100 on the same request_id) is NOT silently ignored -- it returns `ask_first` reason `approval_identity_mismatch` (a security-relevant signal, surfaced).

## Surface 2 -- `GET/POST /api/agent-economy/approve` (the confirm endpoint)

**Auth: NextAuth session ONLY** (`auth()` -> `session.user.id`), mirroring `/spend-settings`. NEVER gateway-token. The VM/agent provably cannot reach this with its own credentials -- consent is a channel property (the committed design's core principle). Session route, so NOT added to `selfAuthAPIs` (Rule 13).

- `GET ?id=<approval_id>` -> the spend details for the page (`{ amount_usd, category, counterparty, vm_name, status, expires_at }`), scoped `owner_id === session.user.id`. Lazily marks `expired` if past TTL. 404 if not owned / not found.
- `POST { id, decision: "approve" | "deny" }` -> flips `pending_approval` -> `approved`/`denied` (guard: only from `pending_approval` AND not expired). Idempotent-safe: approving an already-`approved` row is a no-op success; approving `consumed`/`expired`/`denied` returns a clear terminal-state error.

**Page:** `app/(dashboard)/economy/approve/page.tsx` -- session-protected by the dashboard layout. Renders the exact spend + Approve/Deny. The Telegram URL-button points here.

## Surface 3 -- notification + one-tap revoke (D, layered on the forgeable tier)

**Notification (out-of-band, platform-sent, NOT agent-relayed):** when the authorize route honors a spend via the FORGEABLE raw-bool path (mode `human_approved`, reason `human_approved` -- distinct from the session reason), it sends a Telegram message to the owner via the VM bot token + lazily-discovered `telegram_chat_id`: *"Your agent just spent $X on <category> with <counterparty> -- with your approval. Was that you?"* + a **Revoke** URL-button. Platform-sent so a compromised agent cannot suppress it. Best-effort (a push failure never blocks or reverses the spend -- the spend already happened; the notification is detection, the revoke is the control).

**One-tap revoke:** `GET /api/agent-economy/revoke-spend?token=<hmac>` -- the token is an HMAC over `(vm_id, issued_at)` signed with `NEXTAUTH_SECRET` (mirrors `lib/openai-signup-token.ts`), short TTL (24h). On valid token: set `instaclaw_vms.frontier_spend_enabled = false` (the existing fail-closed master opt-in -- `lib/frontier-spend-optin.ts`) and stamp a flag. Renders a tiny confirmation page.
- **Why a signed GET, not a session, is correct here:** revoke only ever DISABLES spend -- the fail-safe direction. The worst an attacker with the link can do is turn a customer's spend off (an annoyance, never a loss). "One-tap" is the explicit requirement; the HMAC makes the link unguessable + unforgeable by the agent (it never holds `NEXTAUTH_SECRET`). This is the deliberate asymmetry: ENABLING spend routes through the session (`/spend-settings`), DISABLING is one-tap. Self-auth route -> added to `selfAuthAPIs` (Rule 13).

---

## The authorize-route flow (phase 1, both honored, zero break)

1. **Lookup** the approval row for `(vm_id, request_id)`. Derive `sessionApproved` = (`status='approved'` AND not expired AND identity matches). Identity mismatch -> short-circuit `ask_first` reason `approval_identity_mismatch`.
2. **Decide** via the extended pure `decideAuthorization` (below), passing `sessionApproved`, `humanApprovedForgeable` (the raw body bool), `justDoItPerTx`, and the flip flag.
3. **Authorized via session** -> consume the row (`status='consumed'`) -> reserve hold (RPC `p_human_approved=true`). No notification (the user just approved in-browser).
4. **Authorized via forgeable** -> reserve hold -> fire the notification + revoke link. (Phase 1: at all amounts. Post-flip: only below threshold, because at/above the forgeable path no longer authorizes.)
5. **Not authorized, outcome `ask_first`, human-resolvable reason** (`exceeds_earned_budget` / `unknown_category` / `velocity_anomaly` / policy `ask_first`; NOT hard denies) -> mint-or-reuse the `pending_approval` row (idempotent on `(vm_id,request_id)`, capturing exact identity, `expires_at = now+15min`) -> attach `approval_url` + `approval_id` to the response -> fire the escalation Telegram push ("your agent wants to spend $X ... Approve: <button>"). Hard denies (Gate 1) get NO approval URL -- a human cannot per-spend-override a configured ceiling/ban/drain/privacy.

## The pure decision change (`decideAuthorization`, tested -- Rule 31)

New inputs: `sessionApproved: boolean`, `humanApprovedForgeable: boolean`, `justDoItPerTxUsd: number`, `requireSessionAboveThreshold: boolean`. Gate 3 becomes:

```
aboveThreshold = amountUsd >= justDoItPerTxUsd
if (sessionApproved)            -> authorized, mode human_approved, reason "human_approved_session"   // unforgeable, any amount
else if (humanApprovedForgeable) {
  if (aboveThreshold && requireSessionAboveThreshold)
                                -> NOT authorized, ask_first, reason "needs_session_approval"          // post-flip, >= threshold
  else                          -> authorized, mode human_approved, reason "human_approved"            // forgeable-honored -> route notifies
}
// else: fall through to the unchanged autonomy gate (2a..2d)
```

Hard denies (Gate 1) still precede everything -- unchanged. The keystone (2c earned-budget) is untouched. Distinct reasons (`human_approved_session` vs `human_approved`) are what drive the route's notify decision.

## The flip flag (Rule 61)

`FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD` -- boolean env, validated by VALUE (Rule 61 pattern: warn loud on set-but-not-`"true"`). Default/unset = **phase 1** (`requireSessionAboveThreshold=false`, both honored at all amounts, zero break). Flip to `"true"` = **phase 3** (forgeable ignored at/above threshold). The flip is gated on a Rule 27 coverage query proving no old-flow VMs remain -- NEVER flipped before that, and it STOPs for Cooper.

## Phase boundaries (Cooper's STOPs)

- **Phase 1 (this build):** migration + table + confirm endpoint + page + revoke + notification + route wiring + decideAuthorization tiering + tests. Both paths honored. Zero break. Ships behind preview-first approval.
- **Phase 2:** `frontier-spend.mjs` learns the escalation flow (ask_first -> relay approval_url -> poll/re-authorize). Fleet via reconciler. Coverage query (Rule 27) built here.
- **Phase 3 (STOP before):** flip `FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD=true`, gated on coverage proving no old-flow VMs. One env flip, reversible.

## Failure modes tested (Rule 31)

decideAuthorization: (a) session-approved above threshold -> authorized; (b) forgeable above threshold, flip OFF -> authorized + notify-reason; (c) forgeable above threshold, flip ON -> ask_first needs_session_approval; (d) forgeable below threshold, flip ON -> authorized (forgeable honored below the line); (e) hard deny + session-approved -> still denied (Gate 1 precedence); (f) session-approved does NOT lift the daily ceiling (RPC enforces; decision authorizes, RPC can still bounce). Pure-helper: identity match/mismatch, TTL expiry, single-use consume, HMAC token mint/verify round-trip + tamper + wrong-secret + expiry.
