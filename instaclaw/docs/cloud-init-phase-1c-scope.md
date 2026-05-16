# Cloud-Init Phase 1C — Scope Doc

**Status:** draft, 2026-05-16
**Target start:** 2026-05-28 (Edge City partner cohort)
**Anchor:** `docs/cloud-init-builder-plan-2026-05-13.md` §14 — Phase 1C is "real-user-cohort canary, first cohort = Edge City partner-tagged users."

---

## TL;DR

Phase 1A shipped the bootstrap+fetch endpoints. Phase 1B-1 wired createUserVM into all 5 signup callsites behind `CLOUD_INIT_ONDEMAND_ENABLED`. Phase 1B-2 (byte-parity audit) runs after the 2026-05-17 self-test. **Phase 1C flips real user traffic onto cloud-init for one partner-tagged cohort.** Pool path stays alive in parallel for non-cohort users.

---

## §1. Goal

Drive 100% of `partner='edge_city'` new signups through the cloud-init path for 7 days starting 2026-05-28. Pool path remains the default for all other users. Measure:

1. **Provisioning success rate** — cohort cloud-init signups that reach `health_status='healthy'` + `onboarding_complete=true` + dashboard-renderable in <15 min, no manual intervention.
2. **Mean time to "agent responds to first Telegram message"** — compare cohort cloud-init vs same-cohort pool path baseline (from pre-flip historical data).
3. **Zero Rule-33 trap states** introduced. Watchdog query `SELECT count(*) FROM instaclaw_users u JOIN instaclaw_vms v ON v.assigned_to=u.id WHERE u.onboarding_complete=false AND v.gateway_url IS NOT NULL` must stay at 0 throughout.
4. **No SSH-clobber incidents** — `journalctl --user -u openclaw-gateway` on cohort VMs shows no "configure-overlap" patterns that the 2026-05-16 retry-configure short-circuit was added to prevent.

Pass = ≥95% on (1), parity-or-better on (2), zero on (3) + (4) → cleared to expand cutover (Phase 2).

---

## §2. Pre-flight gates (ALL must pass before §3 fires)

| Gate | Owner | Status | How to verify |
|---|---|---|---|
| **G1: Phase 1B-1 self-test** | Cooper, 2026-05-17 | pending | `docs/cloud-init-self-test-runbook.md` §3 Q1–Q5 all pass on a fresh signup |
| **G2: Phase 1B-2 byte-parity audit** | Anyone, post-G1 | pending | Run `scripts/_compare-old-vs-new-path.ts <pool-vm> <cloud-init-vm>` — verdict PASS or only explainable per-user deltas |
| **G3: Lying-DB rate <2%** | Already verified 2026-05-14 | ✓ closed | P1-1 closure (CLAUDE.md Fleet Health Rule 39 acceptance criteria) |
| **G4: Snapshot freshness** | Cooper | pending — v79 is 21 versions behind v100 | Per CLAUDE.md Rule 7, bake a fresh snapshot before any "spots 20" — Phase 1C will provision ~15-30 VMs over 7 days, well under the threshold but should still confirm |
| **G5: Edge City partner sign-off** | Timour Kosters | pending | Confirm Edge City team is OK with new signups going through the cloud-init path during the 7-day window |
| **G6: Pool path remains primary for everyone else** | flag check | ✓ ready | `CLOUD_INIT_ONDEMAND_ENABLED` defaults to false. §3 below adds a partner-gate, NOT a global flip |

---

## §3. In-scope work (the actual Phase 1C deliverables)

### §3.1 Partner-gated flag

Today's `assignOrProvisionUserVm` (`lib/createUserVM.ts:476`) flips on a single env-var boolean. For 1C we want **per-partner gating** so only `partner='edge_city'` users take cloud-init. Two implementation options:

- **Option A — env var with allowlist:** `CLOUD_INIT_PARTNER_ALLOWLIST=edge_city,consensus_2026`. assignOrProvisionUserVm reads it + checks `user.partner` membership. Roughly +15 LOC.
- **Option B — DB-driven feature flag:** new `instaclaw_feature_flags` table keyed on `(flag_name, partner)`. More flexible, more infra.

Pick A unless we have a real reason to want runtime DB toggling — for one cohort + 7 days, env-var allowlist is sufficient.

**Estimated:** ~30 LOC + test extension to `_test-assignOrProvisionUserVm.ts`.

### §3.2 Monitoring + alerting during canary

The fleet-health and health-check crons already catch most failure modes. Need to ADD:

- **`onboarding_complete=false` watchdog** (Rule 33 trap-state detector). Should already exist per the runbook's §6 mention; verify it actually fires + alerts. If not, add to `cron/health-check`.
- **Per-cohort provisioning dashboard.** Hourly SELECT over cohort VMs grouped by `(status, health_status)`. Slack/email digest once a day during the 7-day window.
- **Per-cohort callback-latency telemetry.** New column `instaclaw_vms.cloud_init_callback_consumed_at` already exists (Phase 1A). Add daily report: median + p95 of `(callback_consumed_at - created_at)` for cohort VMs.

**Estimated:** ~80 LOC across 1-2 new cron routes + 1 dashboard page (or just SQL templates in the runbook for now).

### §3.3 Cutover criteria + decision doc

Write `docs/cloud-init-phase-2-cutover-criteria.md` capturing:
- Numeric thresholds from §1
- 7-day measurement window
- Decision tree: PASS → expand to all partners → eventually pool retirement; FAIL → rollback + post-mortem.
- Pre-decided rollback triggers (e.g., "any Rule 33 trap state during canary = immediate rollback, no debate").

**Estimated:** ~150 lines of markdown.

### §3.4 Edge City-specific onboarding hooks

Edge City users get the `edge-esmeralda` skill installed (per CLAUDE.md Rule 9). Verify the cloud-init path's `setup.sh` correctly installs partner-gated skills (lib/cloud-init-setup-sh.ts has the skill-clone block). The `_compare-old-vs-new-path.ts` byte-parity audit should already cover this — confirm during G2.

**Estimated:** 0 new code if G2 passes. Up to ~50 LOC if a partner-skill gap surfaces.

---

## §4. Out of scope (Phase 2 or later)

| Item | Why deferred | Where it lands |
|---|---|---|
| **Pool path retirement** | 1C is canary; pool stays primary for the 92% non-cohort traffic. Retirement needs ≥30 days of cloud-init-as-primary clean data | Phase 3 (provisional) |
| **WLD mini-app cloud-init support** | `assignOrProvisionUserVm` throws "no pending_users row" for mini-app users (lib/createUserVM.ts:526). Mini-app signup doesn't create pending_users; would need its own per-signup-source branch | Phase 2 |
| **Re-subscriber migration via cloud-init** | `migrateUserData(previousVm, vm)` is invoked from `/api/vm/configure:698`. Cloud-init never calls configure → re-subscribers lose previous VM workspace. Pool path stays default for re-subscribers until this lands | Phase 2 |
| **TLS retry cron** | setupTLSBackground fires ONCE via callback's `after()`. On failure (Caddy install error, GoDaddy 500, etc.) VM stays on HTTP forever. No auto-retry. Acceptable for canary (VM works on HTTP) but a real gap for production scale | Phase 2 P1 |
| **callback's 3-stage write as a SQL transaction** | Current: atomic-claim VM update → instaclaw_users update → pending_users update. Sequential, not transactional. If user_users update fails after VM update succeeds, user is in Rule 33 trap state. Mitigation today: try/catch + logged warn + admin alert. Real fix: wrap in a Postgres transaction or RPC | Phase 2 P1 |
| **Bankr wallet provisioning for cloud-init signups** | Need to verify whether `provisionBankrWallet` fires for cloud-init users (the pool path calls it from `vm/configure:760` and `billing/webhook`). Cloud-init's billing/webhook callsite (post-`assignOrProvisionUserVm`) — confirm it still hits the Bankr provisioning block. If not, P1 follow-up | Phase 1C verification, possibly P0 if missing |
| **Sentry/external observability for cloud-init metrics** | We have Vercel function logs + Supabase + Resend dashboards. For 1C canary that's enough. External APM (Sentry, Datadog) is overkill at this scale | Phase 3+ |

---

## §5. Dependencies

| Dep | Owner | Required by | Block? |
|---|---|---|---|
| G1 self-test pass | Cooper, 2026-05-17 10AM | §3.1 wire | YES |
| G2 byte-parity audit | Cooper or me, post-G1 | §3.1 wire | YES |
| G4 fresh snapshot bake | Cooper | §3.1 fleet provisions | SOFT — current v79 works, but ≥3 manifest bumps since bake per Rule 7 |
| G5 Edge City sign-off | Timour | §3.1 enabling | YES |
| Reconciler stability | Already verified — fleet caught up to v100 2026-05-16 | §3 monitoring | NO |
| Cloud-init flag remains "production-ready" | Self-test confirms; nothing scheduled to change | §3 | NO |

---

## §6. Sequencing (proposed)

```
Day 0  (2026-05-17)  — Self-test (G1) + byte-parity audit (G2)
Day 1-3              — Implement §3.1 (partner allowlist), §3.2 (watchdog +
                       cohort dashboard), §3.3 (cutover criteria doc)
Day 4-7              — Ping Timour for G5 sign-off + bake snapshot G4
Day 7  (2026-05-24)  — Code freeze. Final integration test pass. Stand up
                       7-day canary in a follow-up branch off main, NOT in
                       production main, so a single revert can disable.
Day 11 (2026-05-28)  — Cooper flips CLOUD_INIT_PARTNER_ALLOWLIST=edge_city
                       in production env. Monitor for 24h with red-team
                       intensity.
Day 12-17            — Continue cohort monitoring. Daily digest review.
Day 18 (2026-06-04)  — 7-day window closes. Aggregate metrics. Make
                       Phase 2 expand-vs-rollback decision per §3.3.
```

---

## §7. Rollback contingency

Three levels:

1. **Single-user rollback:** If a specific cloud-init signup hits an issue mid-canary, the runbook's §5 SQL cleanup template handles it. No fleet-wide effect.

2. **Cohort rollback:** Flip `CLOUD_INIT_PARTNER_ALLOWLIST` to empty string in Vercel. Existing cohort cloud-init VMs continue running (no live impact). Future Edge City signups fall back to pool path. ~30s rollback.

3. **Emergency disable:** Flip `CLOUD_INIT_ONDEMAND_ENABLED=false` (master kill-switch from 1B-1). Returns ENTIRE fleet to pool path. ~30s rollback. **Cloud-init VMs already provisioned continue to work** — only NEW signups are affected.

---

## §8. Open questions (Cooper)

1. **Edge City as first cohort vs Consensus 2026** — both are partner-tagged. Edge City was the original 1C plan; Consensus is newer (2026-04-26 announcement) and might be a softer canary (fewer users). Worth picking?
2. **Pool retirement timeline** — what's the bar for retiring pool entirely? "30 days clean cloud-init at 100% of new signups" is a starting point but you may have other criteria.
3. **TLS retry cron priority** — P2 in my Phase 5 risk, but you may want it as a 1C deliverable if Edge City needs HTTPS for some specific integration (their Frontier app?).
4. **Snapshot rebake timing** — v79 is 21 versions behind v100. Per Rule 7, ≥3 bumps since bake. Bake-during-1C or bake-before-1C? Baking during creates more variables; baking before adds a day.
5. **Mini-app cloud-init support priority** — WLD users currently can't take cloud-init. If we want cloud-init parity across all signup sources before retiring pool, this needs to land in Phase 1C or Phase 2.
6. **Cutover criteria thresholds** — §3.3 mentions 95% success rate. Is that the right bar? Pool path's actual provisioning success rate today (which we should measure as baseline) might be ~98% — using "match pool baseline" is more defensible than a fixed number.
