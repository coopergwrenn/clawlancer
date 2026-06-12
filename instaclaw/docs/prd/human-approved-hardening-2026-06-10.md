# Design — `human_approved` hardening (forgeable per-spend consent)

**Date:** 2026-06-10
**Status:** DESIGN — STOP at the fork. No code, no build. Captures the analysis + the open decisions for Cooper's ruling; the build is the next step after the fork is chosen.
**Origin:** surfaced while building the `/settings` endpoint (PRD step 2) — the same forgeable-consent shape we closed there already lives, unclosed, in `/authorize`. Locked as ruling #3, "your immediate next build after /settings ships."
**Builds on:** the `/settings` monotonic design (`economy-settings-ownership-2026-06-09.md`) and its core principle: **consent is a channel property, not a payload — the VM-resident agent can only be trusted through a channel it cannot emit on (the human's NextAuth session).**

---

## The threat (verified against the code)

`/authorize` reads `human_approved` straight from the request body — `boolOr(b.human_approved, false)` (`authorize/route.ts:277`) — and passes it to **two** enforcers:

1. `decideAuthorization` **Gate 3** (`frontier-authz.ts:114`): `if (humanApproved) → authorized`, lifting the earned-budget keystone (Gate 2c). Only Gate-1 hard denies still bind.
2. The atomic reserve RPC (`authorize/route.ts:479`, `p_human_approved`): lifts `p_cap_earned` while still enforcing `p_cap_daily`.

The gateway token authenticates the **VM**, not the user's intent (`GATEWAY_TOKEN` is in `~/.openclaw/.env`, readable by the agent). So **a hostile prompt in the agent's context can set `human_approved: true` and bypass the earned budget at both layers.**

**Blast radius of a forged `human_approved`:** bounded only by the hard walls that bind even with it — `neverPerTx` / `neverPerDay` (unraisable, `clampOverrides:82-83`), the reserve/drain floor (`would_drain_wallet`, Gate 1 `:222`), the category allowlist (`category_not_allowed`, Gate 1 `:206`), the master switch (`spend_not_enabled`, `:339`), privacy/emergency stop (`:325`), and the wallet balance + on-chain settlement. The one wall it removes is the **earned budget** — which is exactly the wall that should bound a low-trust agent to pennies. A hijacked starter agent could drain ~`neverPerDay` ($25)/day, ~`neverPerTx` ($10)/tx, down to the reserve floor, on allowed categories.

This is the same class as the `/settings` loosening hole, but **per-spend and frequent** — which is what makes it harder.

## The sole sender (migration blast radius)

The **only** caller that sets `human_approved=true` is the frontier-spend skill's `--human-approved` flag (`skills/frontier/scripts/frontier-spend.mjs:354`, `human_approved: !!args["human-approved"]`). The live flow (`SKILL.md:173`): gate returns `ask_first` → the agent tells the user "get a human 👍" → user says yes **in chat** → agent re-runs `frontier-spend --human-approved`. **The forgeable point:** the agent decides to set the flag, and the "user said yes" lives in the agent's chat context — which a hostile prompt can fabricate. There is no other sender, so the migration surface is exactly this one skill flow.

## The hard part: frequency × friction

`/settings` loosenings are rare, so routing each to a session-authed tap is fine. Per-spend approval is **frequent** — especially for low-earned agents, where almost everything exceeds the tiny earned budget and lands in `ask_first`. Routing *every* `ask_first` spend through a session-authed dashboard tap is unforgeable but brutal UX (a tap per exceed-earned purchase, plus latency while the agent waits). This is the genuine prevention-vs-friction fork.

| Option | Mechanism | Unforgeable? | Friction | New surface |
|---|---|---|---|---|
| **A. Full session-route** | every `ask_first` spend stages a pending approval (keyed by `request_id` + owner); human approves via session (dashboard / Telegram URL-button to the session-authed page). authorize honors `human_approved` only if a matching session approval exists. | **Yes** | High (a tap per exceed-earned spend) | approvals table + confirm endpoint + approve UI |
| **B. Bound-harder (soft)** | keep the in-chat flag, but cap what it lifts: a separate per-approval ceiling and/or N approvals/day. | No (still self-asserted) | None | small |
| **C. Tiered (lean)** | below a threshold, in-chat `--human-approved` honored (forgeable but small blast radius, bounded by `neverPerTx`/wallet); above it (or beyond a daily human-approved budget), require session-rooted approval (A). | Yes for the value that matters | Low for common small spends; high only for large | A's surface, gated by threshold |
| **D. Notify-not-prevent** | `human_approved` stays agent-asserted, but every such spend fires a real-time push ("your agent just spent $X with your approval — was that you?") + one-tap REVOKE (disables spend + flags VM). | No (detection, not prevention) | None | push + revoke |

**Recommendation: C (tiered), with A as the upper-tier mechanism.** The wallet is the funded backstop and small forged approvals are bounded by `neverPerTx`/wallet (a real but small loss the user chose to fund); the unforgeable session gate is reserved for the high-value spends where the loss would actually hurt. It keeps the common low-friction flow while closing the large-loss hole. The threshold choice (and whether "frequent small forged drains" is acceptable at all) is a risk-appetite call only Cooper can make — if the bar is zero forgeable spend, it is **A** (and we accept the friction). B and D are weaker (don't make it unforgeable); D is a useful *addition* to any option (cheap detection), not a replacement.

## Migration / backward-compat (no live ask-first spend breaks mid-transition)

Whatever model is chosen, the same phased rollout — mirrors the Watchdog-v2 shadow→flip discipline (Rule 17): additive, verify, then flip behind a coverage gate.

1. **Additive build (no break).** Ship the session-rooted approval path (pending-spend-approvals table + a session-authed confirm endpoint + the approve UI) **alongside** the existing `human_approved`. `/authorize` accepts **both** during transition. The live skill keeps working unchanged (raw `human_approved` still honored). Zero live break.
2. **New skill flow.** Update frontier-spend: `ask_first` → stage approval → human session-approves → authorize references the approval. Reconciler-deploy to the fleet. Old VMs on the old flow + new VMs on the new flow both work.
3. **The flip (security-closing).** Once a coverage query (Rule 27) confirms the fleet's skills are on the new flow, flip `/authorize` to **stop trusting the raw `human_approved` body bool** (require the session approval, or the tier-C threshold). Gate the flip on that coverage — never flip while old-flow VMs exist, or their live `ask_first` spends break. One-line server change, reversible.

**Backward-compat window** = phases 1–2 (both honored). The flip is the only behavior-changing step and it is coverage-gated.

## Open fork (the STOP — Cooper's ruling)

1. **Approval model:** A (full session, zero forgeable, high friction) / **C (tiered, the lean)** / B (bound-soft) / D (notify+revoke, or as an add-on to A/C)? If C: what threshold — a per-tx `$`, a daily human-approved budget, or the tier's `justDoItPerTx`?
2. **Residual-risk appetite:** is "small forged drains, bounded by `neverPerTx`/wallet" an acceptable residual for the low-friction tier — or is zero-forgeable the bar (→ A)?
3. **Delivery channel:** same as `/settings` — a Telegram URL-button to the session-authed confirm page is safe (consent happens in the browser session); a callback the VM processes is forgeable (the agent is the bot's brain). Confirm URL-button-to-session is the delivery for A/C.

## Self-audit

- **Verified, not assumed:** the dual enforcement of `human_approved` (Gate 3 `frontier-authz.ts:114` AND the RPC `p_human_approved` `authorize/route.ts:479`); the sole sender (`frontier-spend.mjs:354` + the SKILL.md `ask_first` flow); the bounding hard walls.
- **Not yet read:** the `frontier_reserve_spend` RPC body. I inferred from `p_cap_earned` / `p_cap_daily` / `p_human_approved` that it lifts the earned cap but still enforces the daily cap. Worth confirming in the migration build, but it does not change the fork (the design holds regardless of the RPC's exact internal arithmetic — `human_approved` demonstrably bypasses earned at the decision layer).
- **Scope frozen:** this design is `human_approved` only. No `/settings` rework, no §7.2 perDay, nothing else leaks in.

## Related

- `economy-settings-ownership-2026-06-09.md` — the `/settings` monotonic design + the session-as-channel principle this inherits.
- `frontier-settings-monotonic.ts` — the shipped precedent for "the VM-reachable path is structurally incapable of loosening; loosenings route to the session."
- CLAUDE.md Rule 28 (model behavior overrides) and the broader Frontier gate (`frontier-authz.ts` Gate 3) — the earned-budget-is-the-real-bound principle that `human_approved` currently lets the agent self-lift.
