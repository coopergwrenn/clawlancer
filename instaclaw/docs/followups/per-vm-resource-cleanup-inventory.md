# Per-VM resource cleanup inventory + structural-invariants follow-ups

**Authored 2026-06-13** during the DNS-zone-cap root-cause pass. Captures the
disease analysis, the per-VM resource cleanup status (the "next DNS bug" scan),
the `instaclaw_vms` unbounded-read classification, and the structural refactors
deliberately deferred from launch night. Durable home so this isn't lost.

Shipped this pass: `26994620` (DNS cleanup: dns-zone-gc cron + 8 wired retire
callsites) and `44898df3` (the build-blocking structural-invariants guardrail —
see CLAUDE.md Rule 86).

## The disease, at the root

Three findings on 2026-06-13 were **two diseases sharing one root**: *code acts
on a SET it assumes is complete, with nothing that fails loud when it's not.*

- **Disease A — orphaned cleanup on retire.** The "set" is *all resources tied
  to a VM*. Retire paths clean some (Linode instance, DB row) but the set is
  silently incomplete. Smell: a cleanup fn that *exists* but was never *bound*
  to the lifecycle event (create/destroy asymmetry). → the DNS zone-cap bug.
- **Disease B — unbounded reads that truncate.** The "set" is *all the rows*. A
  bare `.select()` past the 1000-row PostgREST cap returns a truncated set,
  indistinguishable from a genuinely-small one. → the orphan reaper (13 VMs).
  Named by **Rule 85**; remedy is `fetchAllOrThrow` (`lib/complete-set.ts`).

The standing guardrail (CLAUDE.md Rule 86, `scripts/_check-structural-invariants.ts`,
build-blocking) makes both shapes impossible to reintroduce silently.

## Per-VM resource cleanup inventory

For every resource keyed to a VM: what deletes it on retire, and the backstop.
A ⚠️ row has no verified answer — it is a candidate for the next DNS-class leak.

| Resource | Cleanup on retire | Backstop | Status |
|---|---|---|---|
| DNS `<vm.id>.vm` A record | `deleteVMDNSRecord` wired into all 8 retire callsites (`26994620`) | `dns-zone-gc` sweep (report-only until `DNS_GC_ENABLED=true`) | ✅ fixed 2026-06-13 |
| Linode instance | `deleteLinodeInstance` / `provider.deleteServer` on retire | health-check ghost-fix (Linode-404 → terminate) | ✅ verified |
| R2 freeze archive | `retentionSweep` (keeps 3/VM) in `vm-archive-snapshot` + inline `deleteObject` in `delete-user-archives` (GDPR) | — | ✅ verified (NOT a leak; `deleteAllVmArchives`/`pruneVmArchives` are dead duplicates — delete or DRY-consolidate, see below) |
| Linode recovery auto-image | Linode 7-day auto-expiry | — | ✅ (provider-managed) |
| Bankr wallet | `bankrWalletLifecycle(vm.id, "suspend")` at health-check:1841 | — | ✅ verified |
| **CDP wallet** | none found on retire | none | ⚠️ **investigate** — likely benign (Coinbase MPC server-managed, receive-only; only a DB column, no on-VM secret), but confirm nothing leaks partner-side |
| **EdgeOS / Index per-VM API keys** | no revoke-on-retire found | none | ⚠️ **investigate** — partner-gated (edge_city, ~9 VMs); minted per-VM keys may accumulate on the partner side if never revoked |
| **Telegram bot handle** | partial handling in health-check; no confirmed release-on-retire | none confirmed | ⚠️ **investigate** |
| **Related Supabase rows** (`instaclaw_vm_lifecycle_log`, `instaclaw_subscriptions`, `pending_users`, etc.) | varies by table; no unified teardown | none unified | ⚠️ **investigate** — admin-terminate `.delete()`s the `instaclaw_vms` row but related rows may dangle |

**Do NOT fix the ⚠️ rows reflexively.** As `deleteAllVmArchives` proved, a
zero-caller / missing-cleanup signal needs investigation first — the cleanup may
already exist under a different name, or the resource may not actually leak.

## `instaclaw_vms` unbounded-read classification (Disease B audit)

- 528 total `.from("instaclaw_vms")` callsites; **64 are unbounded reads**.
- **P0 reaper-class (absence-based destruction/billing): 2 — both already fixed.**
  `vm-lifecycle` orphan reaper and `stripe-reconcile` both use `fetchAllOrThrow`
  (count-asserted, fail-closed). No unfixed P0.
- **62 are coverage-gap risk only** — fleet-iteration crons that *under-process*
  if truncated (they act on rows they fetched; they never destroy rows they
  didn't). Lower severity; most are filtered to subsets well under 1000. Tracked
  for the typed-wrapper proposal below.
- The guardrail's Scan 2 only flags the dangerous triple (unbounded read +
  membership Set/Map + destructive op, no `fetchAllOrThrow`), so it does not
  noise on the 62 benign coverage-gap reads.

## Deferred to a future session (NOT launch-night work)

1. **Typed select wrapper** — `selectAllVms()` (paginated + count-asserted) and
   `selectVmsBounded({limit})`; then ban raw `.from("instaclaw_vms")` outside the
   helper module. Makes the 62 coverage-gap reads explicit and retires the need
   for guardrail Scan 2. Big refactor (every callsite).
2. **Unified `retireVm(vmId)` teardown primitive** — one chokepoint owning all
   per-VM cleanup (DNS, archives, wallets, keys, related rows), so N retire paths
   don't each have to remember N resources. The `dns-zone-gc` sweep generalized to
   all per-VM resources is the reconciliation half.
3. **Resolve the dead R2 duplicates** — delete `deleteAllVmArchives` /
   `pruneVmArchives` (`lib/freeze-v2-archive.ts`), or DRY-consolidate
   `retentionSweep` onto them. Currently allowlisted in
   `scripts/structural-invariants-allowlist.json`.
4. **Close the ⚠️ inventory gaps** — verify CDP / EdgeOS-Index / Telegram /
   related-rows cleanup-on-retire (table above).

## Operational note

`DNS_GC_ENABLED` is **off in prod** (the `dns-zone-gc` cron is report-only).
Flipping it to active autonomous deletion is a separate post-launch action that
must be done with live watching — not a passive default.
