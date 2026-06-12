# Higgsfield Spend Guardrails — Full Spec + GATE ZERO

**Date:** 2026-06-08 · **Status:** Phase-1 spec complete; **Phase-2 build of #1 BLOCKED at GATE ZERO** (one design decision needed — §7). Real-money gate engineering; mirror the proven Frontier spend pattern, don't invent. Companion to the calibration / sweep / rail-decision docs.

---

## 0. GATE ZERO — verified against the actual schema/code (not assumed)

| Foundation the design leans on | Reality | Source |
|---|---|---|
| Reserve/hold/settle pattern to copy | ✅ `frontier_reserve_spend` — `pg_advisory_xact_lock(hashtext(vm_id))`, `UNIQUE(vm_id,request_id)` idempotency, status `pending→settled/failed`, **TTL release** (stale pending excluded on read, no explicit release RPC), caps passed IN by the route (drift guard). Hold table `frontier_transactions`. Routes `/api/agent-economy/{authorize,settle}`. | `migrations/20260602210000_frontier_reserve_spend.sql`, `20260601000000_frontier_economy.sql`, `app/api/agent-economy/authorize/route.ts`, `settle/route.ts` |
| Kill-switch table | ✅ **`instaclaw_admin_settings` EXISTS** (key/`bool_value`/notes). `frontier-kill-switch.ts` reads `setting_key='frontier_spend_kill_switch'`, fail-open. | `migrations/20260422_phase2c_strict_mode.sql:62`, `lib/frontier-kill-switch.ts` |
| `credit_balance` is fractional | ✅ **NUMERIC** (altered from INTEGER). | `migrations/20260227b_minimax_fractional_cost_weights.sql:13` |
| Count-based video cap exists | ✅ `instaclaw_check_video_limit` (daily **counts**: Starter 5 / Pro 10 / Power 30 video; img/audio 10/30/100; BYOK 5/15) + `instaclaw_video_usage` + `instaclaw_increment_video_usage`. | `migrations/20260304_video_usage_tracking.sql` |
| Cron lock helper | ✅ `tryAcquireCronLock(name, ttlSeconds, holder)` / `releaseCronLock(name)`. | `lib/cron-lock.ts` |
| **A video-CREDIT balance store** | ❌ **DOES NOT EXIST.** No `video_credit_balance` column anywhere. No video hold table. No video reserve/settle RPCs. | grep of all migrations |
| Allowlist source | ⚠️ **The official Skill's slugs are the AGENT rail** (`seedance_2_0`, `kling3_0`, `gpt_image_2`, `brain_activity`…) — **NOT our Cloud API paths.** Our allowlist must be the **Cloud paths we empirically validated** (below). | rail-decision doc; calibration doc |

**GATE ZERO VERDICT: the "video-credit balance store exists" assumption is FALSE.** Everything else (reserve pattern, kill-switch table, fractional balance, count cap, cron lock) is real and reusable. Building #1's hold/settle/release therefore needs a **new migration** (balance + hold table + RPCs) and **one design decision** (§7) → **STOP before building.**

**Cloud allowlist (validated empirically — use THESE, not the Skill's agent-rail slugs):**
`higgsfield-ai/dop/lite`, `higgsfield-ai/dop/turbo`, `higgsfield-ai/dop/standard` (+ `*/first-last-frame`), `kling-video/v2.1/pro/image-to-video`, `bytedance/seedance/v1/pro/image-to-video`, `higgsfield-ai/soul/standard`, `reve/text-to-image`. (The Skill catalog remains useful for *prompt patterns* and *duration facts* — Seedance 4–15s, Kling 3–15s — just not slugs.)

---

## The three guardrails as one system

### Guardrail #1 — Pre-call credit gate + atomic hold (THE core)
**Shape: a near-exact clone of `frontier_reserve_spend` / `frontier_transactions` / authorize+settle.**

Flow in the proxy, before any Higgsfield submit:
1. **VALIDATE** `endpoint` against the Cloud allowlist + per-model param schema. **Reject unknown slug or bad params with 400 BEFORE submit** — the Higgsfield API silently coerces+bills bad input (calibration finding), so we cannot rely on it to reject. *(This also closes the calibration-mode passthrough hole — see §6.)*
2. **ESTIMATE** cost from the measured table (image 1, lite 2, turbo 6.5, standard 9, Kling 15.68 Higgsfield-cr) → convert to **our video-credits** (× margin, `ceil` at the user-facing charge only; cost stays fractional internally).
3. **RESERVE (atomic hold):** `instaclaw_video_reserve_spend(p_vm_id, p_request_id, p_est_credits, p_cap_daily, p_window_start, p_fresh_pending_cutoff)` → `pg_advisory_xact_lock(hashtext(vm_id))`, sum live (non-stale) pending+settled today, deny if `+est > cap_daily` or `> balance`, else insert `status='pending'`. `UNIQUE(vm_id,request_id)` ⇒ idempotent. Returns `{reserved, id, committed, reason?}`. **If not reserved → do NOT submit (no spend).**
4. **SUBMIT** to Higgsfield (`withPolling:false` + webhook) only after a successful hold.
5. **SETTLE at webhook:** on `completed` → `instaclaw_video_settle(vm_id, request_id, 'settled', actual_credits)` (compare-and-set on `pending`; charge actual, release remainder of the hold). On `failed`/`nsfw`/`cancelled` → `instaclaw_video_settle(..., 'released', 0)` — **no charge** (provider auto-refunds us too). Stale pending self-expire on read (TTL, like Frontier) as the backstop if a webhook never lands.

**New schema (the §7 decision):**
- `instaclaw_vms.video_credit_balance NUMERIC DEFAULT 0` *(Option A)* — or reuse `credit_balance` *(Option B, not recommended)*.
- `instaclaw_video_transactions { id, vm_id, request_id, status('pending'|'settled'|'released'|'failed'), endpoint, est_credits numeric, actual_credits numeric, created_at, settled_at, metadata jsonb, UNIQUE(vm_id,request_id) }`.
- RPCs `instaclaw_video_reserve_spend` + `instaclaw_video_settle` (mirror frontier signatures; caps passed in by the route per Rule 45). Reuse `instaclaw_credit_ledger` with a new `source='video_deduction'`/`'video_topup'`.

### Guardrail #2 — Per-VM daily video cap (REUSE existing)
**`instaclaw_check_video_limit` fits as-is** — it already enforces per-tier daily **counts** (Starter 5 / Pro 10 / Power 30). Use it as a **coarse abuse backstop** alongside #1: the credit gate (#1) is the precise **$** control; the count cap is a cheap secondary ceiling on *number* of jobs/VM/day. **One tuning note:** the existing caps were sized for the Sjinn era; 30 Kling/day = ~$30, so either lower the Power video count for the Higgsfield default tier or (better) rely on #1's credit gate for the real $ bound and keep the count cap as a loose backstop. **No new migration needed for #2.**

### Guardrail #3 — Fleet kill-switch + $ ceiling (REUSE `instaclaw_admin_settings`)
- **Kill-switch:** add key `higgsfield_video_kill_switch` to `instaclaw_admin_settings`; `isVideoSpendKilled(supabase)` mirrors `frontier-kill-switch.ts` (fail-open). Proxy checks it **before reserve**; engaged → 503 + **auto-cancel any QUEUED jobs** via `POST /requests/{id}/cancel` (refundable; `in_progress` is committed — the docs-crawl cancel-while-queued lever).
- **Fleet daily $ ceiling:** a cron sums today's `settled` video credits fleet-wide; alert at a threshold and optionally auto-engage the kill-switch above a hard $ ceiling. Plus a **Higgsfield-account low-balance** signal (their "Configure when balance gets low" + a periodic balance read) so we're warned before the central balance hits 0. **No new table needed** (admin_settings + a cron).

---

## Webhook realities reconciled (from the docs crawl)
- **2-hour retry until 2xx** → proxy webhook **always returns 200**; settle is **idempotent compare-and-set on `pending`** so retries/dupes can't double-charge. ✓ (already always-200).
- **No signature** → webhook **re-fetches `/requests/{id}/status` with our key**, never trusts the body. ✓ (already does).
- **Fractional cost** → settle on the real cost; `ceil` only at the user-facing charge. ✓
- **7-day output retention** → *(product-layer)* pull delivered media into our storage (Vercel Blob/CDN); don't rely on Higgsfield URLs long-term.

---

## Sequencing (one-line rationale each, Frontier-style)
1. **#1 credit gate — FIRST.** The structural guarantee: *no generation without a pre-debited hold* → bounds spend per user. Nothing else matters if this isn't in.
2. **#3 kill-switch — SECOND.** Fleet-wide emergency stop (+ auto-cancel queued) → bounds blast radius if #1 has a bug or a supplier issue. Cheap (reuse `instaclaw_admin_settings`).
3. **#2 count cap — THIRD.** Coarse per-VM/day backstop (reuse `instaclaw_check_video_limit`) → defense-in-depth; least critical since #1 already bounds $.

## MUST be true before fleet exposure  vs  product-layer (after)
**MUST (the gate):** #1 live + tested; #3 kill-switch live; Cloud-allowlist param validation; idempotent settle; **proxy un-wired from calibration passthrough** (§6).
**Product-layer (after the gate):** the video-credit UX — packs, daily free allowance, `/dashboard/studio`, estimate-then-charge quotes in chat, media storage/retention, native image delivery via `sendTelegramPhoto`.

## §6 Pre-build sanity — what must happen before #1 can safely land
1. **§7 balance-store decision** (Option A vs B).
2. **Migration** (`pending_migrations/`: `video_credit_balance` + `instaclaw_video_transactions` + reserve/settle RPCs) → **Cooper applies to prod (Rule 56)** before the gate code can be tested against real RPCs.
3. **Un-wire the proxy from calibration mode.** Today `app/api/gateway/higgsfield/route.ts` accepts **arbitrary `endpoint` + `input` passthrough** (added for calibration). That is a spend hole — before #1/fleet it MUST be locked to the Cloud allowlist with validated per-model input shapes. The gate's VALIDATE step replaces the passthrough.
4. **Allowlist = Cloud slugs** (above), not the Skill's agent-rail slugs.
5. `instaclaw_admin_settings` is already in `migrations/` (applied) → #3 is unblocked.

---

## §7 GATE ZERO decision required before I build #1
**Which balance store backs the hold?**
- **Option A (recommended): a dedicated `video_credit_balance NUMERIC` + `instaclaw_video_transactions` hold table + new reserve/settle RPCs**, mirroring `frontier_transactions`/`frontier_reserve_spend` exactly. Clean separation from message/media credits, fractional-safe, its own product surface (video packs, /studio), no entanglement with the message-overage logic in `instaclaw_increment_media_usage`.
- **Option B: reuse the existing media `credit_balance`.** Fewer columns, but it's shared with message-overage deductions (`instaclaw_increment_media_usage`) and the media-credit-pack semantics — risk of double-spend/contention and a muddier product. Not recommended.

**Recommendation: Option A.** It's the faithful Frontier mirror and keeps video billing clean. Once approved, I write the migration to `pending_migrations/`, you apply it to prod, and I build + test the gate (insufficient→block/no-submit/no-spend; valid→hold→settle real cost→release; bad-slug→reject pre-submit; failed/nsfw→release/no-charge) preview-first, then stop for your review — exactly the Frontier #1 flow.

*Spec complete. Build of #1 paused at GATE ZERO pending the §7 decision. Read-only so far — no migration written, no code changed, no spend.*
