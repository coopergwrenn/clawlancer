# Higgsfield-Cloud — PRD Reconciliation + Remaining Work (2026-06-10)

Line-by-line reconciliation of `docs/prd/higgsfield-gate-to-user-path-prd-2026-06-09.md`
(gap register §2; cutover §5; decisions §6; HOMER/EXTEND §7; build/H/M items + canary
prereqs + A1/A2 criteria §9 lines 205-251) against actual state after the 2026-06-10
vm-050 canary. The verdict doc (`higgsfield-canary-verdict-2026-06-10.md`) is *what happened*;
**this is what REMAINS.** Status ∈ {DONE, PARTIAL, NOT DONE, INVALIDATED}, evidence per line.

## Current state in one line
The `higgsfield-cloud` skill + gate are **built and canary-proven at the routing+plumbing+hold
level** (branch `worktree-higgsfield-official-rail` @ `0ece4ccf`), **not on main, not on the
fleet.** vm-050 torn down to canonical. Free-only path; commerce stack deferred.

---

## §2 Gap register (14)

| Gap | Status | Evidence |
|---|---|---|
| **G1** entry skill | **DONE (canary-proven, branch-only)** | `higgsfield-cloud.py` built (commit `3667484c`); canary trace shows agent invoking `higgsfield-cloud.py generate`, 0 Muapi/Director refs. **Not fleet-deployed → that's G3.** |
| **G8** Cloud slugs | **DONE** | `_test-higgsfield-model-select.py` 35/35; canary used `dop/lite` + `soul/standard` correctly (DB rows). |
| **G7** env secrets | **DONE** | Canary: `HIGGSFIELD_WEBHOOK_SECRET` added to Preview, gate flipped 500→200/400 after a clean build (probe). Prod already has both (Prod-scoped). |
| **G6** false Studio copy | **PARTIAL** | Copy fix DONE (`webhook/route.ts` false "saved in Studio" line removed, §9). **Storage (Blob/S3) + Studio gallery NOT DONE.** |
| **G2** gate on main | **NOT DONE (deliberate)** | Chose branch-alias preview to keep the gate dark (canary prereq #1 fork (a)). Gate still branch-only; `instaclaw.io/api/gateway/higgsfield` 404s. |
| **G3** fleet cutover | **NOT DONE** | Only a single-VM canary (vm-050) was run; surfaced blockers (M5, settle, fable). No fleet rollout. |
| **G9** kill-switch | **NOT DONE** | Never built. SHIP BLOCKER before real-user exposure. |
| **G11** stale-hold sweeper + alerting | **NOT DONE — and canary PROVED the need** | The 2 canary holds are stuck `pending` forever, never settled, no alert fired. Exactly the silent-vanish G11 describes. |
| **G4** credit top-up | **NOT DONE (deferred — free-only)** | Commerce stack intentionally deferred. Paid video still unbuyable. |
| **G14** billing/freeze video-aware | **NOT DONE (deferred, coupled to G4)** | Not needed for free-only; MUST land with/before G4. |
| **G13** credit transfer on reassign | **NOT DONE (deferred)** | No purchased credits yet (free-only). |
| **G12** webhook delivery idempotency | **INVALIDATED (moot in Option B)** | Webhook is settle-only (delivery via the agent's `message` tool, H1). The webhook doesn't deliver → no double-delivery-on-retry. Re-applies only if webhook-delivery (chat_id signed) ever returns. |
| **G10** count-cap | **NOT DONE (minor, optional)** | Defense-in-depth backstop only; credit gate is the real bound. |
| **G5** web surface | **NOT DONE (polish)** | Telegram-first chosen for v1. |
| Refund-on-fail supplier recon | **NOT DONE** | Recon query never built; folds into G9/G11 observability. |
| Balance races / free-reset cron | **N/A (confirmed clean, §0.2)** | Not gaps. |

## §5 cutover steps
| Step | Status | Evidence |
|---|---|---|
| 1 pre-reqs | **PARTIAL** | G1✓ G7✓; G9/G2/G4+G14 ✗. |
| 2 canary (was "vm-1019") | **PARTIAL — ran on vm-050; A1 routing+holds proven, happy-path NOT** | A1 routing+metering-hold+402 proven; settle + native delivery NOT (M5/free-exhausted/SSO-wall). |
| 3 drain in-flight Muapi | **NOT DONE** | No cutover occurred. |
| 4 fleet rollout | **NOT DONE** | — |
| 5 keep old rail warm | **N/A** | No cutover. |
| 6 verify coverage | **NOT DONE** | — |
| 7 Muapi sunset | **NOT DONE** | — |

## §6 decisions Cooper owed
| Q | Status |
|---|---|
| 1 Telegram-first vs web | **DECIDED: Telegram-first (v1)** — canary was Telegram. |
| 2 free-only vs paid | **DECIDED: free-only (v1)** — G4/G14 deferred. |
| 3 flip before/after Homer/extend | **DECIDED: ship v1 basic now, Homer/Extend after (§7).** |
| 4 funded Seedance/FLF measurements | **NOT DECIDED** |
| 5 credit keying per-VM vs per-user | **NOT DECIDED (deferred with G4)** |
| 6 commerce economics lock | **NOT DECIDED (deferred with G4)** — values exist in code, not "locked." |
| 7 Muapi sunset date | **NOT DECIDED** |

## §7 HOMER/EXTEND + the re-scope
- Ship-v1 decision (basic now, Homer/Extend later): **DECIDED.**
- The 3-layer re-scope (old SKILL.md + `agent-intelligence.ts` supplement + CAPABILITIES): **ATTEMPTED on vm-050, INVALIDATED as an approach** — the `skill-integrity-check.sh` cron (`:17`) reverted the on-disk edits at 05:09 (Rule 47: on-disk canary edits aren't durable; must go via source/manifest). **Plus a finding that questions its necessity:** the 10:54 video request routed to `higgsfield-cloud` cleanly (0 Muapi) **even though the skills were already cron-reverted to canonical** — i.e., the new skill's description won routing **without** the re-scope. One observation, possibly non-deterministic → **NEW open question: is the re-scope actually necessary, or does higgsfield-cloud win on its own?**

## §9 H/M/build items
| Item | Status | Evidence |
|---|---|---|
| G6 copy fix | **DONE** | §9; shipped to branch. |
| G1 Part A (gate `?action=status`, settle-only webhook) | **DONE** | Canary plumbing green (skill→gate→Higgsfield). |
| G1 Part B (skill + model guard) | **DONE** | 35/35; canary routing proven. |
| **H1** native delivery | **DONE (resolved)** | `message` tool delivers native inline video; chat_id capture dropped. |
| **A1** (basic→cloud→meters, no Muapi) | **PARTIAL** | Routing✓ + metering-hold✓ + 402 fail-closed✓ **proven**; **settle + delivery NOT** (no completed happy-path). |
| **A2** (extend→old rail served) | **NOT DONE** | Never exercised. |
| **Live delivery** (prereq #3) | **NOT PROVEN** | Run hit free-exhausted + M5 before a completed-video delivery. |
| M1 transient-status whitelist | **DONE** | 62/62. |
| M2 busy/rate-limit | **DONE** | — |
| **M5** block-poll vs bash timeout | **CONFIRMED REAL (was "unverified"); FIX NOT DONE** | Canary: the video poll was killed (`failed/exitCode 0/empty`), poisoning the session. |
| **M8** settle webhook-only | **NOT DONE — canary surfaced a worse variant** | Settle never fired on the SSO-walled preview (0 webhook callbacks); holds stuck pending. |
| H2 photo→i2v bridge | **NOT DONE (deferred, fast-follow #1)** | — |
| M3 / M4 / M7 / N1-N4 | **NOT DONE (backlog/accepted)** | — |
| CRON-DELIVERY (AGENTS.md:189 null chatId) | **NOT DONE (separate subsystem)** | Confirmed real (G1a spike); out of scope for video. |
| §9 prereq #5 Rule 64 approval | **DONE** | Cooper approved the canary. |

---

## NEW items the walk surfaced (not in the original PRD)

- **N-A. fable-5 empty-completion incident** (fleet-wide latent): pinned premium model returns empty (`payloads=0`) on tool-heavy/heavy-context turns AND **bills 38 each**. Fix = don't-bill-empty + model-fallback-on-empty (cross-terminal w/ onboarding). Detail in the verdict doc.
- **N-B. Re-scope necessity is unproven** — higgsfield-cloud routed correctly *without* the re-scope (§7 above). Needs a deterministic test before investing in the 3-layer re-scope.
- **N-C. On-disk canary edits aren't durable** — the integrity crons revert them; any re-scope/cutover edit must go via source/manifest (Rule 47). Changes HOW, not whether.
- **N-D. Settle is untestable on an SSO-walled dark preview** — Higgsfield's webhook can't carry the bypass token. A canary that must prove settle needs a reachable webhook URL (merge to main, or a non-SSO preview, or status-poll settle).
- **N-E. Open spend surface** — the canary gate is still live with a valid bypass token (verdict doc); revoke before walking away.

---

## ORDERED WORK LIST — from RIGHT NOW to fleet-shipped (free-only v1, then paid)

**Immediate (operational):**
- **0.** Revoke the canary gate bypass token / take down the preview, OR accept the risk window. `[my decision / external (Vercel)]` · minutes · blocked on: nothing.
- **0b.** Decide the re-scope-necessity question (N-B): is higgsfield-cloud's own description enough, or is the 3-layer re-scope required? `[my decision]` (informed by a deterministic routing test) · blocked on: a re-run.

**Free-only v1 critical path (build):**
1. **M5 fix — submit-only + agent-poll-across-turns.** The proven blocker to a working video happy-path (block-poll gets killed → session poison). `[build]` · **~1 day** · blocked on: nothing. *(Highest priority — without it, video can't reliably complete.)*
2. **Settle on a reachable path** — either status-poll settle backstop (M8) or ensure the webhook URL is reachable (not SSO-walled). For free-only it's reliability not billing, but the happy-path proof needs settle to fire. `[build]` · **~0.5-1 day** · blocked on: a reachable gate (G2 or non-SSO preview).
3. **G11 — stale-hold sweeper + alerting.** SHIP BLOCKER (reliability); canary proved holds vanish silently. `[build]` · **~0.5 day** · blocked on: nothing.
4. **G9 — kill-switch.** SHIP BLOCKER (safety); no real-user exposure without it. `[build]` · **~0.5 day** · blocked on: nothing.
5. **Re-scope via SOURCE/manifest (IF 0b says yes)** — `agent-intelligence.ts` supplement + old SKILL.md + manifest bump (durable, Rule 47), with a `bootstrapMaxChars` budget check. `[build]` · **~0.5-1 day** · blocked on: 0b + budget measure.
6. **N-A — don't-bill-empty + model-fallback-on-empty.** Not strictly higgsfield, but it bit the canary and bites announce-scale. `[build / external]` (coordinate w/ onboarding terminal) · **~1 day** · blocked on: cross-terminal ownership.

**Canary re-run (prove what's UNPROVEN):**
7. **Re-run canary on a REACHABLE gate, with 1-5 done + credit/cap headroom** — prove A1 *happy-path* (basic → generate → **settle** → native delivery in chat), **A2** (extend → old rail served), and **live delivery** (the residual). `[canary re-run]` · **~0.5 day run** · blocked on: 1-5 + reachable gate + Cooper Rule-64 go.

**Ship (free-only):**
8. **G2 — merge to main** (after canary green) or keep dark. `[my decision]` · hours · blocked on: 7 green.
9. **G3 — fleet cutover** (Rule 64): deploy skill fleet-wide via `ssh.ts` + manifest bump; re-scope old skill via source; drain in-flight Muapi jobs; keep old rail warm; coverage query (Rule 27). `[canary re-run → fleet]` · **~1-2 days** · blocked on: 8 + canary green.
10. **G6 — Blob/S3 storage + Studio gallery** (copy fix already done). `[build]` · **~1-2 days** · Tier 3, not blocking Telegram launch.

**Paid era (deferred — only after free-only proven):**
11. **Lock Q5 (keying) + Q6 (economics).** `[my decision]` · blocked on: free-only validated.
12. **G4 — credit top-up** (Stripe pack + grant RPC). `[build]` · **~1-2 days** · blocked on: 11.
13. **G14 — billing/freeze video-credit-aware** (MUST ship with/before G4). `[build]` · **~0.5 day** · blocked on: coupled to 12.
14. **G13 — credit transfer on reassign.** `[build]` · **~0.5 day** · blocked on: 11 + 12.
15. **M8 status-poll settle backstop** (paid billing integrity), **G10** count-cap, **G5** web surface, **H2** photo bridge (fast-follow #1), **supplier refund recon.** `[build]` · days, individually small · post-paid.

**Separate (non-video, do-not-forget):**
- **CRON-DELIVERY** fix (AGENTS.md:189 null chatId fleet-wide). `[build]` · own investigation.
- **fable-5 fleet-wide pin failure** → model-browser/pin owner. `[external]`

## Honest sizing caveats
- "~1 day" items assume no new surprises; the canary's whole lesson is that surprises hide in the tool-timeout/settle/routing seams — budget slack.
- Nothing here is "documented = done." Every DONE above cites a probe/commit/DB row; every NOT DONE is either never-attempted or attempted-and-blocked with the blocker named.
- The single highest-leverage item is **#1 (M5)** — it's the proven blocker to a working video, and it's the upstream trigger of the session poison that the whole incident cascaded from.

---

## 2026-06-10 e2e canary — delivery-tail findings, fixes, ledger, G-list

### Defects found + fixed (deployed to prod, main 4db1a85b)
- **Free-cap counted released holds** (Rule 25): G11 swept 2 orphans to `failed`; the all-statuses free count consumed vm-050's starter cap → image submit denied `insufficient_credits` → silent legacy fallback. Fix: `instaclaw_video_reserve_spend` counts only `status IN ('pending','settled')` (migration `20260610193000`, applied to prod).
- **Image delivered as video** (00:00 unplayable): `soul/standard` (kind:image) webhook-delivered as `higgsfield.mp4` via the `images[].url` fallback; A2 signed its chat_id. Fix: gate forces no chat_id for `kind:image`; webhook branches on registry kind + delivers `video.url` only.
- **Duplicate delivery**: image webhook double-fired (3:57+3:58; video once at 4:03) — handler is slow (inline asset fetch+upload) so Higgsfield retried. Fix: `instaclaw_video_claim_delivery` per-render CAS (migration `20260610203000`, applied to prod); webhook fails open if absent.

### G-list (rollout gates — G9 review, DO NOT build yet)
- **Quality default (Cooper: option A leaning).** dop/lite as free default is a downgrade vs legacy muapi (kling-class, effectively free in-plan). Cost-per-render (HF credit = $0.0625):

  | Model | Cost/render | vs lite | Tier |
  |---|---|---|---|
  | dop/lite | $0.125 | — | current free default |
  | dop/standard | $0.5625 | 4.5× | **option A: new free default** |
  | kling v2.1 pro (10s) | $0.9375 | 7.5× | paid premium (= legacy kling-3.0) |

  Option A (dop/standard free, kling paid premium): starter 2/day ≈ $34/mo/VM (vs lite $7.5). Final call at G9. Change touches `resolve_model` default + the model's `freeEligible` flag + SKILL.md expectation-setting + upsell path.
- **Guard 3b (narrow legacy higgsfield-video to extend-only).** Can't be canary-scoped — higgsfield-video is reconciler-managed from main (file-drift reverts a vm-050 SCP). Ships WITH the fleet rollout (when higgsfield-cloud replaces it), not before. Canary relies on guard 3a (higgsfield-cloud hard-rule, Rule 28).
- **Gate-side structural fallback guard.** Legacy muapi lane server-side-rejects new-video requests (belt beyond SKILL.md). Rollout item.

### Canary teardown ledger (reverse/account at e2e close)
- vm-050 `video_credit_balance`: granted 0 → **40** (2026-06-10, for the kling parity (a) run). Reverse to 0 at close, accounting for the ~18 credits one kling render consumes (≈ $0.9375 real Higgsfield spend).
- Synthetic rows: claim-RPC verify test row inserted + deleted (count baseline 4 → 4, clean). Scenario (d) will insert + delete a synthetic orphan — account for it at close.

---

## 2026-06-10 — CORRECTED quality/cost table (real parity bar = kling-3.0, NOT our v2.1)

**Premise correction (evidence, not memory):** the crab clip users loved rendered on **`kling-3.0`** via muapi — proven from vm-050 `~/.openclaw/workspace/higgsfield/jobs.json` (request_id ab520b9d, model "kling-3.0", output cdn.muapi.ai), NOT the agent's narration. Our rail's current premium is **`kling-video/v2.1/pro`** — a *different, older* Kling. That version gap (v2.1 < 3.0) is the most likely reason the surfer kling clip didn't match the crab. **The parity bar is kling-3.0-class frontier, and our v2.1 may itself be below it.**

**Higgsfield catalog (from `higgsfield-catalog-capabilities-sweep`):** documented Cloud image→video = house **DoP lite/turbo/standard** (short-clip only, no duration — NOT the product), **Kling v2.1 pro**, **`bytedance/seedance/v1/pro`**. Auth-gated Gallery reference lineup names **Veo 3.1, Kling v3.0/2.6, Seedance 2.0/1.5, Wan 2.7/2.6, Hailuo**. Per-model pricing is dashboard-gated — Cooper should export the Models Gallery for the 100% picture. Cost anchor (validated on 3 models): **Higgsfield credits ≈ fal.ai $ × 16**.

**Corrected cost table** (HF credit = $0.0625; "/mo per VM" = HF cost × free-cap × 30):

| Model | Class | HF $/render | starter (2/day) | pro (5/day) | power (15/day) | status |
|---|---|---|---|---|---|---|
| dop/lite | house fast-draft | $0.125 | $7.50 | $18.75 | $56 | current free default (the downgrade) |
| dop/standard | house HQ | $0.5625 | $34 | $84 | $253 | measured |
| **seedance v1 pro** | **frontier** | **~$0.625** (pred, 5s/1080p) | **~$38** | **~$94** | **~$281** | **UNVETTED — pivotal** |
| kling v2.1 pro | frontier (older) | $0.9375 | $56 | $141 | $422 | measured; our premium; < legacy 3.0 |
| kling v3.0/2.6 | frontier (= legacy bar) | ~$0.94–1.25 (pred) | ~$56–75 | ~$141–188 | ~$422–563 | UNVETTED; Gallery slug unconfirmed |
| veo 3.1 | premium hero | ~$1.19–3.19 (pred) | ~$71–191 | ~$179–478 | ~$536–1434 | UNVETTED; Cloud membership unconfirmed |

**Direction (Cooper, → G9):** frontier models as defaults; DoP relegated to fast-draft at most; costs priced honestly into tiers. The honest read: a frontier free default is **4.5–7.5× the current lite cost** ($34–56/mo/VM at starter, up to $250–420/mo at power). Tiers must price this in, or cap free frontier renders below the current allowance.

**Vetting path (what enabling seedance/newer-kling takes):** the gate only allows MEASURED-cost models (allowlist discipline). To enable a frontier default: (1) confirm Cloud Gallery membership (read-only dashboard, or one spot-submit); (2) **one funded spot-test render to MEASURE actual HF credit cost + confirm whether it honors `duration`** (the open question — real long clips vs DoP-style pin); (3) add to `HF_MODELS` with measured cost + `freeEligible` flag + (if duration-variable) a small 5s/10s lookup; (4) set as `resolve_model` default. Cost to vet: ~a few credits per model. **Seedance is the pivotal vet** (frontier, cheapest, likely the best quality/cost). Recommend vetting seedance v1 pro + confirming a kling v3.0/2.6 slug at G9 before picking the free default.
