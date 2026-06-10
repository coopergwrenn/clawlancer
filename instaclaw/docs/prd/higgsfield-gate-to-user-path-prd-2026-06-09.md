# Higgsfield Video/Image — "Gate → Real User" Launch-Readiness PRD

**Date:** 2026-06-09 · **Status:** baseline + full gap register + build plan. **READ-ONLY doc pass — no code/build/spend.**
**Purpose:** the durable doc driving the cleanup + build from "gate proven at the contract level" to "a real user cleanly gets an image/video back, on any surface, and can buy more." Followable with zero memory of the session that produced it. Every gap cites `file:line` + quoted code, **re-verified against current state 2026-06-09** (fresh `git fetch`).

**This pass went deeper than the verification trace.** It interrogated the brief's 8 leads rather than transcribing them: **2 turned out to be non-issues** (de-scoped below with evidence), and **6 new gaps** the brief never named were found (G9–G14), including a high-severity Rule-14 platform-interaction hazard. Read §0.2.

**Companions (same folder):** `higgsfield-official-rail-2026-06-08.md`, `higgsfield-cost-calibration-2026-06-08.md`, `higgsfield-spend-guardrails-spec-2026-06-08.md`, `higgsfield-rail-decision-mcp-vs-proxy-2026-06-08.md`, `higgsfield-profitability-proof-2026-06-08.md`, `higgsfield-allowlist-expansion-research-2026-06-09.md`.

---

## §0.1 Re-verification snapshot — what changed vs the trace: nothing material

| Re-checked (fresh `git fetch`, 2026-06-09) | Result |
|---|---|
| Gate on `origin/main`? | **No** — `git ls-tree -r origin/main` → 0 gate files (HEAD `c01fef5f`). Canary-only holds. |
| `HIGGSFIELD_WEBHOOK_SECRET` scope | **Production only** (`vercel env ls`); `HIGGSFIELD_CLOUD_KEY` = Preview+Production. Unchanged. |
| ssh.ts deploys Muapi skill? | **Yes** — `ssh.ts:8278 HF_SKILL_DIR=…/higgsfield-video`, `ssh.ts:6329 INSTACLAW_MUAPI_PROXY=https://instaclaw.io`. |
| Muapi proxy on `origin/main`? | **Yes** — `app/api/gateway/muapi/[...path]/route.ts` present. Old rail live. |

## §0.2 Corrections to the brief (interrogated, not transcribed)

**Two of the brief's worries are NOT real gaps — de-scoped with evidence:**
- **"Free-allowance reset cron real?"** There is **no cron and none is needed.** Reset is window-based: `route.ts:169 windowStart = utcDayStartISO()` is passed into the reserve RPC, which counts free rows `created_at >= p_window_start`. The daily free count resets at UTC midnight automatically by the query window. Correct as built.
- **"Gateway token — spend someone else's credits?"** Not exploitable. `route.ts:98 vm = lookupVMByGatewayToken(token)` and every spend/deliver op uses the authenticated `vm.id` (`route.ts:176 p_vm_id: vm.id`, `:234 v: vm.id`). A VM can only spend its own `video_credit_balance` and deliver via its own bot token. Cross-VM spend requires another VM's secret token, which a fleet-VM adversary doesn't have. Scoping is sound.

**Six new gaps the brief never named (found this pass): G9–G14** (see register). The highest, **G14**, is a Rule-14 financial-loss hazard.

## §0.3 Captured side-finding (out of scope for this PRD — flagged, not chased)

**`AGENTS.md:189` tells agents the cron `delivery.target` (numeric Telegram chat ID) lives at `channels.telegram.chatId` in `~/.openclaw/openclaw.json` — but that field is `null` on every VM checked** (vm-050 + the 4 healthy assigned VMs 788/469/956/435, 2026-06-09 G1a spike). The chat_id only appears inside the session jsonl (e.g. vm-956: `chatId":"8189289081`), not in config. AGENTS.md also warns that a cron with a null/empty `delivery.target` "produce[s] silent error loops at fire time and burn[s] credits on every retry." **So agent-created crons that follow this guidance may be silently failing to deliver fleet-wide.** This is the discovery that made the G1 async-webhook delivery model unviable (→ Option B). It is **out of scope for the video gate** (it's the cron-delivery subsystem) but worth its own investigation — capture, don't chase here.

---

## §1. CURRENT STATE — honest baseline

### 1a. Real and proven (the solid foundation — credit where due)
- **validate → estimate → reserve → submit → settle** all execute: `route.ts:141 HF_MODELS[endpoint]` + `lib/higgsfield-models.ts:validateInput`; reserve at `route.ts:174/197/215` over `migrations/20260608220000_video_credit_gate.sql` (advisory-lock RPC); submit `route.ts:240 createHiggsfieldClient` → `:243 client.subscribe(endpoint,{input,withPolling:false,webhook})`; settle/release `webhook/route.ts:143/:163` with clamp `LEAST(GREATEST(p_actual_credits,0),est_credits)` in `migrations/20260608230000`.
- **Telegram delivery real + canary-proven:** `webhook/route.ts:244 sendTelegramVideo(…)`; real jobs delivered native video (`higgsfield-cost-calibration-2026-06-08.md`, req `d2adde8d`, Kling `4f40be27`).
- **Contract proof:** `scripts/_test-video-credit-gate.ts` = **49/49** vs live prod RPCs, zero spend. Margins ≥1.92× (`higgsfield-profitability-proof-2026-06-08.md`).
- **Concurrency-safe within the gate:** the reserve/settle/release RPCs serialize per-VM via `pg_advisory_xact_lock(hashtext(vm_id))` — no balance race even under concurrent generations from the same VM.
- **Reachable:** `middleware.ts:61 "/api/gateway"` allow-lists the prefix.

### 1b. What a real user message hits TODAY: the OLD Muapi rail (agent-polled)
- Fleet-wired: `ssh.ts:8255/8278` installs the `higgsfield-video` Muapi skill; `ssh.ts:6329` sets `INSTACLAW_MUAPI_PROXY=https://instaclaw.io`; `generate.py:124-128 get_base_url()` → `/api/gateway/muapi`.
- **Delivery is AGENT-POLL, not webhook:** `SKILL.md:133 "Async Pattern (MANDATORY for video): Submit with --submit-only → … After ~3 min: status --id"`; `generate.py:343 poll_for_result` → `/api/v1/predictions/{id}/result`. **The agent itself is the delivery mechanism** — it submits, waits, polls, then relays the result. (This matters for cutover — §5.)
- Live on prod: Muapi proxy on `origin/main`; `MUAPI_API_KEY` in all envs. In prod since March.

### 1c. New gate deployment status
**Canary-branch/preview-only, not on `main`.** `instaclaw.io/api/gateway/higgsfield` does not exist. Gate lives on branch `worktree-higgsfield-official-rail` (HEAD `97cbedfb`) + its preview.

---

## §2. GAP REGISTER (14)

| # | Gap | Severity | In brief? | Evidence | Size |
|---|---|---|---|---|---|
| G1 | No agent entry path to the new gate | **HARD BLOCKER** | yes | 0 refs to `api/gateway/higgsfield` outside its route dir | new skill |
| G8 | Agent model knowledge = Muapi slugs, not Cloud slugs | **HARD BLOCKER** | yes | `generate.py` Muapi slugs vs `higgsfield-models.ts:113` Cloud `DEFAULT_MODEL` | content in G1 |
| G4 | No video-credit top-up/purchase path | **HARD BLOCKER (paid)** | yes | 0 writers of `video_credit_balance` in app/+lib; settle only debits | commerce flow |
| **G14** | **billing-status / freeze / lifecycle blind to `video_credit_balance`** | **HARD BLOCKER (paid) — Rule 14** | **NO (new)** | `billing-status.ts` has 0 `video_credit_balance` refs; `vm-freeze-thaw.ts:636` checks only `credit_balance` | SoT + cron edits |
| **G9** | No fleet kill-switch (guardrail #3 unbuilt) | **SHIP BLOCKER (safety)** | **NO (new)** | 0 kill-switch refs in gate; spec deferred it | admin-setting + 1 check |
| G7 | Env-secret scoping (webhook secret Production-only) | SHIP BLOCKER | yes | `vercel env ls`; `route.ts:106-112` 500-guard | env verify |
| G2 | Gate not on production (`main`) | SHIP BLOCKER | yes | `git ls-tree origin/main` → 0 gate files | merge |
| G3 | Fleet on old Muapi rail (+ cutover orphans in-flight jobs) | SHIP BLOCKER | yes (orphan = new) | `ssh.ts:8278/6329`; agent-poll delivery `SKILL.md:133` | fleet migration |
| **G11** | No stale-hold sweeper + no alerting → stuck jobs invisible | **SHIP BLOCKER (reliability)** | **NO (new)** | 0 cron refs to `video_transactions`; 0 alerting in gate | cron + alert |
| **G13** | `video_credit_balance` not reset/transferred on reassignment | HIGH (paid) | **NO (new)** | `vm/assign/route.ts:170` sets `credit_balance`, never `video_credit_balance` | assign/release edit |
| G6 | Telegram-only + no storage + **false "Studio" copy** | POLISH (copy fix NOW) | yes | `webhook:236` stub, `webhook:281` false copy, no Blob/S3 | storage+UI+1-line |
| G5 | No dashboard/web generation surface | POLISH (web) | yes | no `app/(dashboard)/studio`; 0 UI refs | new UI |
| **G12** | Webhook delivery not idempotent → double-delivery on retry | MINOR (UX) | **NO (new)** | `webhook` delivery ungated on settle-first-winner | delivery guard |
| **G10** | Count-cap (guardrail #2) not wired | MINOR (backstop) | **NO (new)** | 0 `check_video_limit` refs in gate | optional check |

### — Path-to-user gaps —

**G1 — No agent entry path · HARD BLOCKER.** Nothing routes chat → `/api/gateway/higgsfield` (grep = 0 refs outside its route dir; the canary hit it via curl). **Done:** a Cloud-rail skill on VMs that POSTs `{endpoint, image_url?, prompt, duration?, chat_id}` and surfaces gate responses. **Deps:** G8, and a reachable gate (G2/G7) to test. **Size:** skill + `ssh.ts` wiring.

**G8 — Muapi vs Cloud slugs · HARD BLOCKER (folds into G1).** Deployed catalog is Muapi slugs (`generate.py`: `kling-3.0`, `seedance-2.0`); the gate needs Cloud slugs (`higgsfield-models.ts:113 DEFAULT_MODEL="higgsfield-ai/dop/lite"`, `kling-video/v2.1/pro/image-to-video`, `higgsfield-ai/soul/standard`). Unknown slug → `route.ts:144 "unsupported_model"` 400 (safe, no spend). **Done:** Cloud-slug model-selection guidance in the G1 skill (incl. "Seedance/Veo not yet available"). **Size:** content in G1.

**G4 — No credit top-up · HARD BLOCKER (paid).** `video_credit_balance` is `DEFAULT 0` and only ever debited (`migrations/20260608220000 … SET video_credit_balance = video_credit_balance - v_charge`; 0 writers in app/+lib). **Impact:** every user sits at 0; only the free daily allowance works (`higgsfield-models.ts:240` starter 2/pro 5/power 15); after that, `insufficient_balance` forever. **Paid video is literally unbuyable today.** **Done:** Stripe pack flow + a grant RPC that credits `video_credit_balance` + ledger, priced to `higgsfield-models.ts:30 VIDEO_CREDIT_SALE_USD=0.1`. **Deps:** pricing (Q6), existing Stripe + `instaclaw_credit_ledger`. **Size:** new commerce flow. **Pairs with G14 — do not ship paid credits without G14.**

### — Credit-economy integrity (the deep dive the brief asked for) —

**G14 — billing-status + freeze + lifecycle are BLIND to video credits · HARD BLOCKER (paid), Rule 14.** This is the 2am incident. `lib/billing-status.ts` (the single source of truth for "is this customer paying", per CLAUDE.md Rule 14) computes `isPaying` from sub status, `credit_balance`, partner, all-inclusive tier — and has **0 references to `video_credit_balance`** (verified). `lib/vm-freeze-thaw.ts:636-638` gates freeze on `vmHasCredits(vm.credit_balance)` — **not** video credits. No lifecycle cron checks `video_credit_balance` (0 refs in `app/api/cron/`). **Impact (once G4 ships):** a user who paid *only* for video credits (no message sub, `credit_balance=0`) reads as **non-paying** → eligible for suspend/freeze/orphan-reclaim → **loses their VM and their purchased video credits** (the `video_credit_balance` row is destroyed when a frozen VM is eventually deleted). Silent churn + a refund/chargeback fight. **Done:** add a `video_credit_balance > 0` clause to `getBillingStatus`/`getBillingStatusVerified` `isPaying`, and to the freeze safety check; per Rule 14, fix it *in the SoT module*, not inline. **Deps:** must land *with or before* G4. **Size:** SoT + freeze-check edits (small code, high stakes).

**Refund-on-fail — user side wired, supplier side unreconciled.** The *user* is correctly protected: on failed/nsfw, `webhook:163 instaclaw_video_release` sets `settled_credits=0`, no debit; on submit-throw, the route releases the hold (`route.ts` catch → `instaclaw_video_release … reason:"submit_failed"`) then 503s. **But** our *central Higgsfield account* refund on failed/nsfw is **assumed, never reconciled** (calibration #7 + profitability §4 caveat) — no job compares our settled+released ledger against the Higgsfield balance delta. **Done:** a periodic recon (part of the G9/§ observability cron) flags divergence. **Size:** a recon query. Severity: low (bounded to ≤$0.94/Kling/failed job; doesn't touch user margin).

**Balance races — clean (no gap).** Per-VM advisory lock serializes reserve/settle/release; the route's free-then-paid two-call sequence re-checks atomically under the lock each time. No double-spend.

**Free-allowance reset — clean (no gap).** Window-based via `utcDayStartISO()` (§0.2). No cron needed.

### — Reliability / observability gaps —

**G11 — No stale-hold sweeper + no alerting · SHIP BLOCKER (reliability).** If a webhook never fires (Higgsfield drops it past its 2h retry, or our endpoint is down), the hold stays `pending` forever: it stops counting against availability after `FRESH_PENDING_TTL_MS` (30 min, `route.ts:170`) so no permanent balance loss, **but the row is orphaned and the user is never told their video failed** — and **we never find out either** (0 cron references `video_transactions`; 0 alerting in the gate — failures only hit `logger.*`). **Done:** (a) a sweeper cron that marks long-pending video holds failed + notifies the user; (b) admin alert on stuck-pending rate / submit-error spikes (mirror `sendAdminAlertEmail`). **Size:** a cron + an alert hook. **This is what turns a silent vanish into a known event.**

**G12 — Webhook delivery not idempotent · MINOR (UX).** Delivery is **not** gated on settle being the first-winner — the webhook runs settle (idempotent) then *unconditionally* `sendTelegramVideo`. On a Higgsfield retry (only if our endpoint 5xx'd within 2h; we normally always-200 so it's rare), the user gets the **same video twice** (billing is safe — settle CAS prevents a double charge). **Done:** gate delivery on `settle.settled === true && !settle.idempotent`, or persist a `delivered` flag on the tx row. **Size:** a small guard.

### — Ship-readiness / safety gaps —

**G9 — No fleet kill-switch · SHIP BLOCKER (safety).** Guardrail #3 from the spec is **not built** (0 kill-switch refs in the gate). There is **no fleet-wide emergency stop** — if a bug or abuse causes runaway spend, the only lever is pulling `HIGGSFIELD_CLOUD_KEY` from Vercel (blunt, affects everything, slow to propagate). **Done:** `higgsfield_video_kill_switch` in `instaclaw_admin_settings` + an `isVideoSpendKilled()` check before reserve (mirror `lib/frontier-kill-switch.ts`, fail-open); optionally auto-cancel queued jobs. **Size:** an admin-setting + one check. **Don't flip the canary to real users without this.**

**G7 — Env-secret scoping · SHIP BLOCKER (verify).** `HIGGSFIELD_WEBHOOK_SECRET` is **Production-only**; the canary runs on **Preview**, and `route.ts:106-112` 500s if either secret is missing. The current preview gate likely **500s on submit** for the missing secret — consistent with "no real generation through the committed gate." **Done:** confirm both secrets exist in the gate's actual environment (Rule 6: `printf`). **Size:** env verify.

**G10 — Count-cap not wired · MINOR.** The gate doesn't call `instaclaw_check_video_limit` (guardrail #2). The credit gate is the real $ bound, so this is a defense-in-depth backstop only. **Done:** optionally add a per-VM/day count check. **Size:** optional.

### — Ship + platform gaps —

**G2 — Gate not on `main` · SHIP BLOCKER.** `instaclaw.io` 404s the gate. **Done:** merge after the flip decision; `verify-migrations` passes (schema applied). **Size:** merge.

**G3 — Fleet on Muapi + cutover orphans in-flight jobs · SHIP BLOCKER.** See §5. The new finding beyond the trace: because old-rail delivery is **agent-poll** (`SKILL.md:133`), disabling the Muapi skill mid-flight makes in-progress jobs **un-pollable** → the user never gets that video. Cutover must drain or grace-window in-flight jobs.

**G13 — Credits not transferred on reassignment · HIGH (paid).** `vm/assign/route.ts:170` sets `credit_balance: body.initialCredits` on assignment but **never touches `video_credit_balance`**. So a reassigned VM carries its leftover `video_credit_balance` to the next user (User B inherits User A's video credits, or A's purchased credits are stranded/lost). Credits are **per-VM** by design (`migrations/20260608220000:15 "KEYING: per-VM"`), consistent with the existing per-VM `credit_balance`, but once video credits are *sold* this is a real correctness/financial bug. **Done:** zero/transfer `video_credit_balance` on assignment + release (and decide per-VM-vs-per-user keying — Q5). **Size:** assign/release edit + a keying decision.

### — Polish / web surface —

**G6 — Telegram-only + no storage + false Studio copy · POLISH (copy fix NOW).** Delivery is Telegram-only; no persistence; and `webhook:281 "(also saved in your Studio)"` is **shipped copy that currently lies** (`webhook:236` "Studio gallery pin is a no-op stub"). `>50 MB`/send-fail → raw Higgsfield URL that **expires ≤7 days**. Also flagged: **bot-token rotation/revocation** — the webhook reads `telegram_bot_token` from the DB (gets the current token on rotation, fine), but if the user *deleted/revoked* the bot, `sendTelegramVideo` fails → link fallback also targets that bot → **user silently gets nothing** (ties to G11 alerting). **Done:** remove the false copy line *now*; add Blob/S3 storage; build the Studio gallery; on delivery failure, surface via G11. **Size:** 1-line copy fix (now) + storage + gallery.

**G5 — No dashboard/web surface · POLISH (web).** No `/studio`, 0 UI refs to the gate. **Done:** a generate UI + result view; requires a web delivery model (no `chat_id` on web — Q1). **Size:** new UI.

---

## §3. Security review (explicit)

- **Spend scoping: sound.** Each VM is bound to its own `vm.id` via its gateway token (§0.2). No cross-VM credit spend. The per-VM daily ceiling `VIDEO_DAILY_CREDIT_CEILING=300` bounds blast radius (`higgsfield-models.ts`).
- **Webhook integrity: sound.** `d` (vmId, chatId, ts, internalRequestId) is HMAC-signed with the server-only `HIGGSFIELD_WEBHOOK_SECRET`; the webhook re-fetches authoritative status with our key (doesn't trust the ping body); replay bounded to `WEBHOOK_TTL_MS=60min`. The secret never reaches a VM.
- **Residual (minor):** (a) a compromised VM can deliver to any chat its *own* bot can message (Telegram limits bots to users who started them); (b) within 60 min, a captured webhook URL replay re-delivers the user's *own* video (settle idempotent → no double charge) — same family as G12; (c) `image_url` is passed to Higgsfield (their SSRF surface, not ours). None are auth bypasses.
- **The real "security-class" risks here are economic/reliability, not classic authz: G13 (credit leak on reassignment) and G14 (freeze loses paid credits).**

---

## §4. TIERING + SEQUENCE (re-prioritized with the new gaps)

### Tier 1 — HARD BLOCKERS (no clean paid product without these)
1. **G1 + G8 — Cloud-rail entry skill** (with Cloud-slug selection). The staircase; nothing reaches the gate without it.
2. **G4 — credit top-up** *and* **G14 — make billing/freeze video-credit-aware, shipped together.** *Why coupled:* selling credits (G4) without G14 means a paying user can be frozen and lose what they bought — never ship G4 without G14. (A **free-only** soft-launch can skip both — see fork.)

### Tier 2 — SHIP BLOCKERS (turn it on safely)
3. **G7 — verify env secrets** (cheap; else the gate 500s).
4. **G9 — kill-switch** (no emergency stop without it; build before real-user exposure).
5. **G11 — stale-hold sweeper + alerting** (so failures are known, not silent).
6. **G2 — merge to `main`.**
7. **G3 — fleet cutover** Muapi→Cloud (§5; depends on G1/G2/G7; Rule 64 gated).

### Tier 3 — POLISH / WEB (not blocking a Telegram-first launch)
8. **G6 copy fix — NOW, regardless of tier** (stop lying about "your Studio").
9. **G13 — reassignment credit transfer** (before paid credits see real reassignment volume; pairs with the Q5 keying decision).
10. **G12 — delivery idempotency**, **G10 — count-cap**, **G6 storage + gallery**, **G5 web surface.**

**Forks (→ Cooper, §6):** Telegram-first (Tier 1+2 only) vs web (adds G5/G6-storage). Free-only soft-launch (skip G4+G14 initially) vs paid-from-day-one (G4+G14 required).

---

## §5. CUTOVER PLAN — Muapi → Cloud (highest-risk step)

**Today:** `ssh.ts` installs the Muapi skill (`:8255/8278`) + `INSTACLAW_MUAPI_PROXY` (`:6329`); Muapi proxy on `main`; delivery is **agent-poll** (`SKILL.md:133`).

**Steps:**
1. **Pre-reqs:** G1 skill built, G4+G14 live (or free-only decision), G7 verified, G9 kill-switch live, G2 merged.
2. **vm-1019 canary (Rule 64):** install the new skill on vm-1019 only; real end-to-end generation (chat→agent→gate→Higgsfield→Telegram); verify Cloud-slug selection, hold/settle debit, delivery. Cooper "ship it."
3. **Drain/grace in-flight Muapi jobs (NEW — the orphan hazard):** because old delivery is agent-poll, disabling the Muapi skill mid-flight orphans in-progress jobs. Mitigate: cut over during low traffic AND/OR keep `higgsfield-status.py` runnable for a grace window so in-flight jobs can still be polled+delivered before the skill is fully disabled.
4. **Fleet rollout (Rule 64 + 47):** `ssh.ts` installs the new skill + cloud-rail env; **renames** the Muapi skill to `higgsfield-video.disabled` (mirrors `ssh.ts:8277`), never deletes; bump `VM_MANIFEST.version`. Verify complete install (Rule 24).
5. **Keep the old rail warm:** do NOT remove the Muapi proxy or `MUAPI_API_KEY` until the Cloud rail is proven fleet-wide. Coexistence = the safety net.
6. **Verify (Rule 27):** coverage query for "VMs on the Cloud rail"; sample real generations.
7. **Sunset (separate later decision, Q5):** retire Muapi skill/proxy/key after a soak.

**Rollback (instant):** `mv higgsfield-video.disabled → higgsfield-video`, restore env, revert the manifest bump. The Muapi proxy never left. Document exact commands in the cutover PR.

---

## §6. OPEN QUESTIONS / DECISIONS COOPER OWES

1. **Launch surface — Telegram-first or web?** Telegram delivery is real now (Tier 1+2). Web adds G5 + G6-storage.
2. **Free-only soft-launch vs paid day-one?** Free-only skips G4+G14 initially (bounded cost, validate the path). Paid requires G4+G14 together.
3. **Flip timing — merge+cutover before or after the Homer/extend design pass?**
4. **Funded measurements now?** Seedance + first-last-frame spot-measures (`higgsfield-allowlist-expansion-research-2026-06-09.md`); extend likely needs Seedance measured.
5. **Credit keying — per-VM (current) or per-user?** Video credits live on `instaclaw_vms` like message credits. Per-VM means credits follow the machine, not the buyer (G13). For a *purchased* credit, per-user is arguably correct. Decide before G4, since it shapes the schema + G13 fix.
6. **Commerce economics — confirm before building G4:** free counts (starter 2/pro 5/power 15) and sale price (`$0.10/credit`). Lock these.
7. **Old-rail sunset date** once the Cloud rail is proven (Q5-adjacent).

---

## §7. HOMER / EXTEND dependency (on the record)

Both marquee features are generation features — they reach Higgsfield only through this same path and **inherit G1–G14.** Per the archaeology pass, the old Homer/extend code is Muapi-rail (a rebuild), and extend depends on **un-allowlisted, unmeasured Seedance** + an **unconfirmed Cloud extension endpoint**. **The Homer/extend architecture pass is downstream of at least Tier 1** (entry skill + credit path + G14) — designing them first is building the second floor before the staircase.

**Ship-v1 decision (2026-06-09):** v1 ships the new `higgsfield-cloud` gate for basic generation, and the old `higgsfield-video` rail stays installed (NOT disabled) as the **sole provider of HOMER + EXTEND + audio + story** until those are rebuilt into the Cloud rail. M6 (disable old skill) is **replaced by a re-scope** of the old skill's routing surface — see the canary prereqs. Disabling the old skill would drop HOMER/EXTEND fleet-wide; re-scoping keeps them served while making the new gate the sole owner of basic "make a video / make an image" so everything meters.

**Routing surface is 3 layers (file-proven 2026-06-09), not 1.** The metering-bypass risk (a plain "make me a video" routing to the OLD Muapi rail and bypassing the gate — no metering, no credit gate, no free-cap) is driven primarily by the SOUL **intelligence supplement**, not the skill keyword block:
1. **`agent-intelligence.ts` §1J-3 (DOMINANT)** — in **upfront context every session** (`ssh.ts:6934` concatenates `SOUL_MD_INTELLIGENCE_SUPPLEMENT` into deployed SOUL). It routes basic video/image to `higgsfield-video` (lines 192-201) and line 202 says **"Prefer Higgsfield for model variety."** The new gate appears **nowhere** in it. Also referenced at the skill table (line 165), the TL;DR set (line 569), and the capability card (lines 675-678). V2 templates have **zero** higgsfield routing — they rely entirely on this supplement.
2. **Old `higgsfield-video/SKILL.md` (weak, on-demand)** — `description` (line 3) + `triggers` keywords/phrases (lines 15-16) both advertise generic "make a video / generate an image."
3. **New `higgsfield-cloud/SKILL.md`** — `description`-only, already correctly scoped to basic generation; no `triggers` block.
A SKILL.md-only re-scope is **necessary but NOT sufficient** — the supplement (upfront, "prefer Higgsfield") would still magnetize basic asks to the old rail. The re-scope must touch BOTH the old SKILL.md AND the supplement. The supplement edit is a **fleet-bootstrap change** (propagates via reconciler SOUL deploy / SOUL migration, counts against `bootstrapMaxChars`; net char delta expected ~neutral — remove verbose old block, add lean new-gate block — but must be measured). **Honesty flag:** descriptions/keywords/supplement content are file-proven; actual LLM routing between two overlapping skills is **inferred, not observed**. The re-scope is itself an unproven routing change, blessed by the canary observation below, not by the edit looking right.

---

## §8. Self-audit (this doc)
- ✅ All gaps present with `file:line` + quoted evidence; **6 new gaps (G9–G14)** beyond the brief; **2 leads corrected to non-issues** (free-reset cron, cross-VM spend) with evidence (§0.2).
- ✅ Deep-dives the brief asked for: credit economy (top-up, refund recon, races, reset, reassignment, freeze), cutover (agent-poll orphan), delivery failure modes (webhook-never-fires, >50MB, bot revoked, double-delivery), error/observability (silent vanish, no alerting), security (scoping sound; economic risks are the real ones), platform interaction (billing-status/freeze/assign blindness — G13/G14).
- ✅ Re-verified against current state 2026-06-09 (§0.1: nothing changed).
- ✅ Tiering (re-prioritized), cutover (+orphan + rollback), Homer/extend dependency, open questions.
- ✅ Severity honest: G14 elevated to hard-blocker; the "saved in your Studio" line named as shipped copy that lies.
- Boundary held: **this one doc only**; read-only elsewhere; no code/build/spend.

---

## §9. G1 build + adversarial-review outcomes (2026-06-09)

Free-only path under construction (commerce stack G4/G14/G13 deferred). Shipped to the canary branch (not on a VM): G6 copy fix; G1 Part A (gate-side agent-poll: `?action=status`, optional chat_id, settle-only-unless-c webhook); G1 Part B (the `higgsfield-cloud` skill files + discriminating model-select guard). Adversarial self-review of the Part B skill produced the findings below.

### H1 — RESOLVED 2026-06-09: native delivery already works; chat_id capture DROPPED
**Original (WRONG) finding:** "Option B delivers a link, not native video; native needs chat_id capture." That conclusion was based on grepping for an agent media-send tool by names like `send_video`/`send_media` and not finding one (absence-of-evidence).

**Live observation (vm-050, observed not inferred):** one `openclaw agent ... --deliver` turn instructed to attach a sample video produced, in the gateway journal: `[telegram] outbound send ok chatId=5918081163 operation=sendVideo deliveryKind=video` — a **native inline video**. The `--json` showed the agent delivered it via its **built-in `message` tool** (`messagingToolSentMediaUrls:[...mov_bbb.mp4]`, `didSendViaMessagingTool:true`), and OpenClaw resolved the chat target itself. **Root cause of the H1 miss:** the native media-send tool is named **`message`** (generic), not `send_video`/`send_media`, so the name-based greps missed it. The earlier "all media skills use direct-API+chat_id" was true but not exhaustive of the agent's options.

**Version check:** vm-050 + 9 more healthy VMs = **10/10 on OpenClaw 2026.5.22** (the "fleet is 2026.4.26" premise was stale; the fleet upgraded). The `message` tool + native media + `message send --media` + `agent --deliver` are present on the version the fleet runs, so **the native answer generalizes fleet-wide.**

**Consequence:** **chat_id capture is UNNECESSARY for delivery.** The agent delivers native video via its `message` tool, resolving the chat from the live session. The chat_id-capture build (and the "v2 async webhook delivery" path) are **dropped from the critical path.** The webhook stays **settle-only** (Part A, correct as-is). The only change needed is the SKILL.md delivery copy: instruct the agent to deliver natively via its message tool, never as a text link (done 2026-06-09).

**Honest residual (the canary must prove this):** the observation used an **explicit reply-target on an isolated session**. The fully-live path — *real inbound Telegram message → session resolves the user's chat → the agent's `message` tool delivers there* — is **high-confidence** (it is OpenClaw's normal reply-routing; the agent always replies to the chat it is in) but was **not** end-to-end tested. **The canary's job is to prove the live delivery path** ("ask timmy to make a video" → native clip lands in the user's chat), not just that the generation pipeline runs.

### H2 (scope decision pending) — "animate my photo" (user-sent Telegram photo → i2v)
The new skill has no Telegram-file_id → public-URL bridge (the old Muapi rail had one: `higgsfield-video/scripts/higgsfield-generate.py:245-293`, download via Telegram getFile → upload to Muapi CDN). A user's Telegram photo is a file_id, not an http URL; the gate requires http(s). So "animate this selfie" can't work; the text→generate-image→animate flow does (soul returns an http URL). **Cost to port:** a new gate `?action=upload` (~30-50 lines: auth, server-side Telegram getFile via bot token, upload to a public store, return URL) + skill file_id detection (~15 lines) + SKILL.md guidance. The public-store options: **(a) Higgsfield's own upload endpoint** (SDK references `uploadImage`/`upload`; cleanest since Higgsfield ingests its own CDN URL, but the Cloud upload path/auth is **unverified**), or **(b) Vercel Blob** (definitely available, one more hop). **~half a day, low-moderate risk** (bounded: Blob is the fallback if Higgsfield-upload isn't on Cloud). **Recommendation: v1 = text→image→video only** (covers "make a video of X," the dominant ask); "animate my photo" = **fast-follow #1**. The canary's goal (prove the pipeline) is met without it. **Hold for Cooper's scope call.**

### Fixed this pass (M1, M2)
- **M1** — `mapHiggsfieldStatus` flipped to a transient whitelist (queued/in_progress/unknown only); any undocumented terminal status now ends the poll as a failure instead of poll-to-timeout "still rendering." Guard: 62/62.
- **M2** — persistent upstream errors (429/5xx) surface a distinct "busy, try again" outcome instead of a "still rendering" mislabel (poll-loop error-streak + create/status 503/429 mapping).

### v1 known limitations / hardening backlog (do NOT build now)
- **M3** — "make a video" with no source image consumes **2 free slots** (image + video). v1 accepts it (SKILL.md tells the agent). Backlog: a combined path or discount.
- **M4** — `>10s` not code-enforced (`resolve_model` maps quality, not requested seconds); SKILL.md-guidance-only. Backlog: a duration ceiling in `resolve_model`/the gate.
- **M5** — the blocking `generate` poll (≤480s) vs OpenClaw's bash-tool timeout is **unverified**; the canary reveals it. Backlog: if the tool timeout < 480s, switch to submit-only + agent-driven polling across turns, or lower `max-wait`.
- **M7** — agent re-check bound: SKILL.md now says "after a couple re-checks over ~10 min, tell them it's taking unusually long." Backlog: a hard bound.
- **M8** — settle is **webhook-only** in Option B; a dropped webhook → delivered-but-unbilled (paid era only; free-only charges 0). Backlog: have the status-poll settle as a backstop (idempotent with the webhook) for the paid era.
- **Nits** — N1 generic create-error still improvises (busy/blocked are handled); N2 "standard clip" (=dop/lite, free) vs the "standard" model (=dop/standard, hq) terminology; N3 request_id/JSON leak is soft-prevented (SKILL.md instruction); N4 kling + non-10 `--duration` → graceful gate 400.

### Separate findings captured (NOT blocking video; do NOT build now)
These rode alongside the chat_id-capture work that was dropped; recording them so they aren't lost.
- **CRON-DELIVERY (own backlog item).** `AGENTS.md:189` points agent-created crons at `channels.telegram.chatId` for `delivery.target`, but that field is **null fleet-wide** (G1a spike). Unlike the live agent path, a cron **fires with no live inbound session**, so the `message` tool's live chat-resolution does **not** help it — a cron still needs a *configured* target, which is null. So agent-created crons may be **silently failing to deliver fleet-wide**. Real, separate, **not** blocking video delivery. Needs its own investigation (a conflict-free way to populate the cron delivery target). Also recorded in §0.3.
- **LIVE-DELIVERY RESIDUAL (the canary owns this).** The H1 native observation used an explicit reply-target on an isolated session. The fully-live path (real inbound → session resolves the user's chat → `message` tool delivers there) is high-confidence but **untested end-to-end**. The canary **must prove the live delivery path**, not just the pipeline (see prereq 3 below).

### Canary prerequisites (vm-050) — all need Cooper's go (Rule 64)
1. **Gate reachable from vm-050:** the gate is on the canary branch (not main). Either point `INSTACLAW_GATEWAY_BASE` at the stable branch-alias preview (ensure both `HIGGSFIELD_CLOUD_KEY` + `HIGGSFIELD_WEBHOOK_SECRET` exist in that env; SSO off), OR merge the dark gate to main (G2) and use `instaclaw.io` + Production secrets. **[decision]**
2. **Re-scope the old `higgsfield-video` skill (REPLACES M6 — do NOT disable it).** Narrow the old skill's routing surface to its unique capabilities (HOMER character-consistency, EXTEND, audio, story) so the new gate is the sole owner of basic generation and **everything meters**; the old rail stays installed + warm as the sole HOMER/EXTEND provider. Two surfaces must change together (per §7's 3-layer finding): (a) old `higgsfield-video/SKILL.md` `description` + `triggers` — strip "make a video / create video / animate this image / generate an image" and the bare model names; keep character/extend/story/audio. (b) `agent-intelligence.ts` §1J-3 + skill table (165) + TL;DR (569) + capability card (675-678) — narrow the old block to its unique caps, **delete line 202 "Prefer Higgsfield for model variety,"** and **add a `higgsfield-cloud` routing entry** as the default owner of "make a video / make an image / animate a photo" (metered through the gate). New `higgsfield-cloud/SKILL.md` stays description-only unless the canary shows it needs an explicit `triggers` block.
   - **Canary assertion A1 (metering):** on the re-scoped both-skills VM, a real "make me a video" / "make me an image" routes to **`higgsfield-cloud`** AND **meters** (a row in `instaclaw_video_transactions` and/or the free-cap decrements) — **NOT** the old Muapi rail (no Muapi proxy call in the agent's tool trace). If it leaks to the old rail, the re-scope is insufficient — harden (explicit `triggers` block on the new skill / stronger supplement entry).
   - **Canary assertion A2 (no HOMER/EXTEND regression):** "extend this video" / "keep the same character across these clips" routes to the **old `higgsfield-video` rail** and is **served** (not the new skill's "not available yet"). If it hits the wall, the new gate is wrongly intercepting — widen the old skill's pull on extend/character.
   - **A1/A2 are blessed by live observation, not by the keyword edit looking right** (the routing-behavior honesty flag in §7). Re-scoping is an unproven routing change until the canary proves it.
3. **The canary must prove the LIVE delivery path end-to-end**: a real "ask timmy to make a video" → the agent runs the skill → generation → **the finished clip lands in the user's chat as native inline video** (confirms the live-delivery residual above, not just that the pipeline ran).
4. **(If H2 in scope)** port the photo-upload bridge before testing "animate my photo." **[decision — H2 held: v1 is text→image→video only, photo bridge is fast-follow #1.]**
5. **Rule 64 + explicit Cooper approval** for the install + end-to-end test.

**Note (2026-06-09): chat_id capture is no longer a prerequisite** — native delivery works via the agent's `message` tool (see the resolved H1 above). The earlier "H1 delivery decision (link vs chat_id)" prereq is removed.
