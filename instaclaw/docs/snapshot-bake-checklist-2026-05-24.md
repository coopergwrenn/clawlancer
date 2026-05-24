# Snapshot Bake Checklist — 2026-05-24

**Status**: PRE-BAKE PREP, awaiting Cooper greenlight
**Author**: Claude (autonomous prep — Cooper testing Edge VMs in parallel)

**Target outcome**: New Linode private image at manifest v120, OpenClaw 2026.4.26, gbrain v0.36.3.0, replacing `private/38977398` (v113, baked 2026-05-22).

**Do not initiate the bake without Cooper's greenlight.**

---

## 1. Current state baseline

### What's live right now

| Field | Value | Source |
|---|---|---|
| Manifest on `main` | **v120** | `instaclaw/lib/vm-manifest.ts:1676` |
| `OPENCLAW_PINNED_VERSION` | **`2026.4.26`** (deliberately NOT bumped to 2026.5.20 per Rule 65) | `instaclaw/lib/ssh.ts:97` |
| `LINODE_SNAPSHOT_ID` in Vercel env | `private/38977398` | `vercel env ls production` |
| Snapshot label | `instaclaw-base-v113-2026-05-22` | Linode API `/v4/images/private/38977398` |
| Snapshot bake date | 2026-05-22 22:09 UTC (2 days old) | same |
| Snapshot size | 5780 MB (under 6144 cap; 364 MB headroom) | same |
| Snapshot bake notes (from description) | OpenClaw 2026.4.26, Node v22.22.2, bun 1.3.13, gbrain v0.36.3.0 (1d5f69f), 55 reconciler fixes, 9 bake-gap fixes, ext4 used 6069 MB before fstrim, fstrim released 1139 MiB | same |

### Delta to apply: v113 → v120 (7 manifest versions)

The bake-VM reconcile pass must land all changes between v113 and v120. Material deltas:

- **v118 → v120 typing keys**: `agents.defaults.typingMode=instant`, `agents.defaults.typingIntervalSeconds=3` (closure-captured per Rule 32 — required `RESTART_REQUIRED_CONFIG_PREFIXES += agents.defaults.` in same commit so reconciler restarts gateway after set)
- **v120 systemd**: `TasksMax=120` → `TasksMax=infinity` (removes artificial cap; pids.max kernel default at cgroup level)
- **v120 strip-thinking.py guard**: `STRIP_THINKING_v2026_5_20_COMPAT_v1` sentinel — `SKIP_ACTIVE_SESSION:` 120s-mtime skip path. Benign on 2026.4.26 (the takeover error class doesn't exist there); load-bearing if/when 2026.5.20 ships
- **v119 emergency revert**: `messages.statusReactions.enabled=false` (was momentarily true in v118; reverted because the typing-keepalive patch we attempted wasn't sound)
- **v118 bonjour dual-gate**: `discovery.mdns.mode=off` + `Environment=OPENCLAW_DISABLE_BONJOUR=true` in systemd unit (the v113 snapshot may not have the env-var half — needs verification)
- **EDGEOS_EVENTS_BEARER_TOKEN** distribution: not a snapshot concern (per-VM keys minted at assignment via `stepEdgeOSApiKey`; bearer reads from Vercel env at runtime)
- **CDP backup wallet infrastructure (2026-05-24, Rule 67)**: NEW additive subsystem restored after a months-long gap. Bake VM must verify ALL of the following are present + functional BEFORE imagize:
  - `instaclaw/lib/cdp-wallet.ts` exists (`provisionCdpWallet` helper)
  - `@coinbase/cdp-sdk ^1.44.0` in `instaclaw/package.json`
  - Migration `20260524180000_vm_cdp_wallet.sql` applied to prod (`cdp_wallet_id` + `cdp_wallet_address` columns exist on `instaclaw_vms`)
  - `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` + `CDP_WALLET_SECRET` in Vercel `instaclaw` project (production + preview)
  - Backfill cron `/api/cron/provision-missing-cdp-wallets` registered in `vercel.json` at `*/30 * * * *`
  - Agent-facing wallet docs include "Bankr Outage Fallback" section in `lib/agent-intelligence.ts` SOUL supplement + `lib/workspace-templates-v2.ts` AGENTS.md V2 + `buildWalletMd` (Backup Wallet (Coinbase CDP) section)
  - `scripts/_pre-bake-check.ts` includes `checkCdpReadiness()` (already wired into the autonomous bake's preflight via `REQUIRED_BAKE_TOOLING_ENV` extension)

  **Verification commands** (run as part of §4 verification phase on bake VM):
  ```bash
  # On bake VM (post-assignment + post-reconcile)
  test -n "$(grep ^CDP_WALLET_ADDRESS= ~/.openclaw/.env)" && echo "  CDP env line ✓" || echo "  ✗ CDP_WALLET_ADDRESS missing from .env"
  grep -q "Backup Wallet (Coinbase CDP)" ~/.openclaw/workspace/WALLET.md && echo "  WALLET.md CDP section ✓" || echo "  ✗ WALLET.md missing CDP section"
  grep -q "Bankr Outage Fallback" ~/.openclaw/workspace/AGENTS.md && echo "  AGENTS.md fallback section ✓" || echo "  ✗ AGENTS.md missing Bankr Outage Fallback section"

  # From operator workstation (DB row)
  curl -s "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/instaclaw_vms?id=eq.${BAKE_VM_ID}&select=cdp_wallet_address" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
  # → should return `[{"cdp_wallet_address":"0x..."}]` (not null)
  ```

  **Why a special note**: the original CDP infrastructure was lost during the 2026-02 Bankr partner cutover and silently absent for months. Restored 2026-05-24 (Cooper P0). The bake from this snapshot is the FIRST that ships with CDP working end-to-end. Any one of the above missing means new VMs from this snapshot will have no backup wallet during a Bankr outage.

### Fleet rollout context (parallel — informational)

| Snapshot time | cv=120 cohort | cv=119 cohort |
|---|---|---|
| 13:48 UTC | 5 | 149 |
| 15:25 UTC | 22 | 132 |
| 17:35 UTC | 40 | 113 |
| 18:00 UTC | 46 | 107 |

Velocity ~9-12/h. Full convergence to cv=120 projected by tomorrow morning UTC. **Does not gate the bake** — the bake VM is provisioned independently from the pool.

---

## 2. VERIFIED (with evidence)

### ✓ Manifest + version pin

- [x] **v120 on main** — `lib/vm-manifest.ts:1676` shows `version: 120`. Latest commit `d35d0014` (changelog auto-update on top of `d74013d0` nft-cache fix on top of `93355a13` v120).
- [x] **`OPENCLAW_PINNED_VERSION = "2026.4.26"`** in `lib/ssh.ts:97`. Per Rule 65: bake at 2026.4.26 for THIS snapshot. 2026.5.20 bake is post-Edge per Cooper's prior call.
- [x] **Strip-thinking template includes v120 sentinels** in `lib/ssh.ts:STRIP_THINKING_SCRIPT` — sentinels `STRIP_THINKING_v2026_5_20_COMPAT_v1` + `SKIP_ACTIVE_SESSION:`, both listed in `vm-manifest.ts:files[].requiredSentinels` so Rule 23 will catch any stale write.

### ✓ Reconciler can deliver v120 to a fresh VM

- [x] **v120 deltas land correctly on production VMs** — confirmed today across 5+ VMs that bumped from cv≤119 → cv=120 naturally via reconcile-fleet. All show:
  - `TasksMax=infinity` in systemd override.conf
  - `typingMode=instant` + `typingIntervalSeconds=3` via `openclaw config get`
  - `STRIP_THINKING_v2026_5_20_COMPAT_v1` sentinel in `~/.openclaw/scripts/strip-thinking.py`
  - Gateway restarted cleanly, `is-active`, `/health=200`
- [x] **nft-cache pre-commit hook** extended to cover both `reconcile-fleet` AND `file-drift` routes (`.husky/pre-commit`, commit `d74013d0`). Future manifest bumps won't have the file-drift-bundle-stale bug we hit earlier today.

### ✓ EdgeOS chain end-to-end

- [x] **`EDGEOS_EVENTS_BEARER_TOKEN` in Vercel prod** (set via Web UI ~16:55 UTC by Cooper). Bearer-JWT validates against `api.edgeos.world` with `portal:api_keys:manage` scope.
- [x] **9/10 edge_city VMs minted** their per-VM `eos_live_*` keys. Canonical `_verify-edgeos-api-key.ts` reports 9 pass / 1 fail (vm-1019 expected fail per quarantine). 6 independently SSH-verified.
- [x] **End-to-end events query from edge VMs** returns real EE26 events (HTTP 200 in <1s from vm-771, vm-922, vm-1005, vm-923, vm-354, vm-917).

### ✓ vm-771 (representative current-fleet VM at cv=120) shows correct v120 state

```
TasksMax=infinity                                          ✓
typingMode=instant, typingIntervalSeconds=3                ✓
STRIP_THINKING_v2026_5_20_COMPAT_v1 count=1                ✓
SKIP_ACTIVE_SESSION: count=1                               ✓
discovery.mdns.mode=off                                    ✓
Environment=OPENCLAW_DISABLE_BONJOUR=true                  ✓ (in override.conf)
gbrain.service: active, enabled                            ✓
gbrain HTTP /health=200 on 127.0.0.1:3131                  ✓
gbrain MCP wired in openclaw.json (transport=streamable-http) ✓
pglite-checkpoint cron present, every 30 min, latest entry ok latency_ms=3 ✓
pg_control mtime fresh (2026-05-24 18:00:01)               ✓
```

### ✓ Watchdog crons not present (per Rule P1-10)

- [x] `crontab -l | grep -E 'silence-watchdog|vm-watchdog|openclaw-config-watchdog'` → 0 matches on vm-771

---

## 3. NOT YET VERIFIED (needs checking on the bake VM specifically)

These items must be verified ON THE BAKE VM (a fresh g6-nanode-1 provisioned from `private/38977398`) BEFORE imagize. They cannot be inferred from production VMs alone — the snapshot's baseline state is what matters.

### 3.1 Snapshot state inheritance

The v113 snapshot description claims:
- gbrain v0.36.3.0 installed via install-gbrain.sh
- Rule 54 checkpoint cron + ExecStop drop-in
- SOUL.md V2 migration
- OPENAI_API_KEY auto-push
- pi-ai reasoning router
- compaction.* config
- ufw 9100

**Action**: provision the bake VM. Before any reconcile, confirm:
- `bun --version` works (bun was in v113 per description)
- `~/.gbrain/` directory exists with installed sidecar
- `crontab -l | grep -E 'pglite-checkpoint|gateway-health-textfile'` shows expected crons
- `crontab -l | grep -E 'silence-watchdog|vm-watchdog|openclaw-config-watchdog'` returns 0 (watchdog crons should NOT exist in the v113 snapshot since they were removed in v76)

### 3.2 v113 → v120 reconcile delta lands cleanly on the bake VM

After provisioning + manually running reconcileVM against the bake VM (one VM, in non-strict mode):

- [ ] `TasksMax=infinity` written to `~/.config/systemd/user/openclaw-gateway.service.d/override.conf`
- [ ] `typingMode=instant` + `typingIntervalSeconds=3` in `~/.openclaw/openclaw.json` AND `openclaw config get` returns them
- [ ] strip-thinking.py has both v120 sentinels (Rule 23 verify-after-write)
- [ ] `statusReactions.enabled=false` (per v119 revert)
- [ ] OPENCLAW_DISABLE_BONJOUR=true present in override.conf (v118)
- [ ] discovery.mdns.mode=off in openclaw.json (v71-onward)
- [ ] Gateway restarts cleanly per Rule 32 (typing keys are closure-captured, restart is required)
- [ ] `/health=200` after restart, NRestarts=0
- [ ] `config_version=120` in instaclaw_vms row for the bake VM (DB)

### 3.3 15-point verification per CLAUDE.md `Snapshot Creation Process`

| # | Check | Expected |
|---|---|---|
| 1 | `openclaw --version` | `2026.4.26` |
| 2 | `node --version \| grep v22` | matches |
| 3 | `test -x /usr/local/bin/chromium-browser` | exists |
| 4 | `which ffmpeg` | found |
| 5 | `which jq` | found |
| 6 | `which node_exporter` | found |
| 7 | `which Xvfb && which x11vnc && which websockify` | all found |
| 8 | `cat ~/.openclaw/exec-approvals.json` | `security: "full"` |
| 9 | `wc -l < ~/.ssh/authorized_keys` | ≥ 2 |
| 10 | `loginctl show-user openclaw \| grep Linger=yes` | yes |
| 11 | `grep -q run_session_end_hook ~/.openclaw/scripts/strip-thinking.py` | present |
| 12 | `grep -q MEMORY_FILING_SYSTEM ~/.openclaw/workspace/SOUL.md` | present |
| 13 | `test -f ~/.openclaw/workspace/memory/session-log.md` | exists |
| 14 | `test -f ~/.openclaw/workspace/memory/active-tasks.md` | exists |
| 15a-g | All 7 crons present | strip-thinking.py, auto-approve-pairing.py, vm-watchdog (REMOVED — should NOT be there), push-heartbeat.sh, silence-watchdog (REMOVED — should NOT be there), openclaw memory index, SHM cleanup |

**NOTE on 15a-g**: The 15-point list in CLAUDE.md is partially STALE — it still lists `vm-watchdog` and `silence-watchdog` as required crons, but those have been removed at the manifest level (v76 cleanup + P1-10 remediation). The bake VM should have ZERO watchdog crons. Update CLAUDE.md after this bake to reflect the correct cron set.

### 3.4 v120-specific bake additions (not in CLAUDE.md's 15-point list)

These were added between v79 and v120 and need explicit verification:

- [ ] `~/.openclaw/scripts/pglite-checkpoint.sh` exists + executable (Rule 54 — bounds gbrain pg_control staleness to 30 min)
- [ ] `~/.openclaw/scripts/gateway-health-textfile.sh` exists + executable (v99 — feeds node_exporter textfile collector)
- [ ] `~/.openclaw/scripts/ack-watchdog.py` exists (v95 — slow-warning watchdog for >30s LLM stalls)
- [ ] `~/.openclaw/scripts/skill-integrity-check.sh` exists (Rule 24)
- [ ] `~/.openclaw/scripts/check-skill-updates.sh` exists
- [ ] `~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md` present IF partner=edge_city would be tagged (won't be at bake time — partner is applied at assignment)
- [ ] `~/.openclaw/scripts/strip-thinking.py` has BOTH `def trim_failed_turns` AND `SESSION TRIMMED:` sentinels (Rule 23 — pre-v120 sentinels still required)
- [ ] systemd override.conf has `MemoryHigh=3G`, `MemoryMax=3500M`, `OOMScoreAdjust=500` (load-bearing safety nets when TasksMax=infinity)
- [ ] systemd override.conf does NOT have `RuntimeMaxSec` (removed in v100)
- [ ] systemd override.conf has `ExecStartPre=` chain including `--startup-repair-active` (v101 orphan-tool_use repair)
- [ ] No `silence-watchdog.py` cron (Rule P1-10 / v76 removal)

### 3.5 Disk + image sizing

- [ ] `df -h /` shows < 5900 MB used (target: leaves 244 MB headroom under 6144 cap)
- [ ] `du -sh ~/.cache ~/.npm ~/.bun /var/cache/apt /var/lib/apt/lists 2>/dev/null` shows minimal cache (per CLAUDE.md aggressive clean recipe)
- [ ] `journalctl --vacuum-time=1d` was run pre-bake
- [ ] No stale `~/.gbrain/brain.pglite.stale-quarantine-*` directories (these are vm-specific leftover from Rule 54 recovery; should not be in snapshot)
- [ ] No stale `~/.gbrain/brain.pglite.pre-upgrade-*.tar.gz` files
- [ ] No `~/.openclaw/openclaw.json.bak*` files (per `configureOpenClaw` cleanup, Rule 38)
- [ ] No `~/.openclaw/.openclaw-pinned-version` user-specific file (or if present, set to `2026.4.26`)

### 3.6 Workspace files in TEMPLATE state (not user-personalized)

The bake VM should NOT have:
- [ ] Customized SOUL.md with user identity content
- [ ] MEMORY.md with > template stub content
- [ ] USER.md with user-specific fields filled in
- [ ] `.bootstrap_consumed` flag (would tell the agent "skip first-turn intake" — wrong for fresh provisions)
- [ ] Any session jsonl files in `~/.openclaw/agents/main/sessions/`
- [ ] `~/.openclaw/wallet/agent.key` (private key from a specific account)
- [ ] `~/.openclaw/.env` with user-specific tokens (GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN, EDGEOS_API_KEY)
- [ ] gbrain `brain.pglite` with non-default content (should be the fresh-init state from install-gbrain.sh)

These are all set/written by `configureOpenClaw` at assignment time — never bake them.

---

## 4. BLOCKERS (must fix before bake)

### 4.1 CLAUDE.md is stale

CLAUDE.md's "VM Provisioning Standard" section says current snapshot is `private/38575292 (v79, baked 2026-05-03)`. **Reality**: Vercel env has `private/38977398 (v113, baked 2026-05-22)`. The CLAUDE.md doc is 2 days behind the actual snapshot pin.

**Why this is a blocker**: any future operator (terminal or human) reading CLAUDE.md to provision a VM would use the WRONG snapshot ID. The Vercel env is correct, so production cron auto-provisioning is fine — but manual `linode-cli` provisions would land on the stale snapshot.

**Fix**: update CLAUDE.md `VM_PROVISIONING_STANDARD` block + the snapshot description in the project-memory `reference_vm_provisioning.md` BEFORE this bake (so the doc reflects v113→v120 transition cleanly).

### 4.2 No verified-working bake script in the recent past

The Snapshot Creation Process in CLAUDE.md is a manual 12-step procedure. I haven't found a `scripts/_bake-*.ts` or similar that automates it for v120-era. The previous bake (v113, 2026-05-22) was driven manually by Cooper with `_autonomous-bake.ts` per CLAUDE.md memory references — verify that script still works against the current manifest before running it.

**Fix**: spot-check `scripts/_autonomous-bake.ts` exists + at least loads cleanly (`npx tsc --noEmit -p .` clean for that file). If it's out of date, EITHER bring it up to date OR drive the bake manually per CLAUDE.md procedure.

### 4.3 No `bun` in PATH from default shell on vm-771

`which bun` returned nothing on vm-771 (vm-771 is at cv=120, edge_city). gbrain DOES work because the systemd unit sets the path explicitly. But scripts that depend on `bun` from a fresh SSH session would fail. The v113 snapshot description claims `bun 1.3.13` is installed via `_bake-gap-fixes.sh` with a "bun-PATH drop-in" — so this MAY already be fixed for the bake VM via a profile.d snippet. Verify on the actual bake VM:
- [ ] `/etc/profile.d/bun.sh` exists (or equivalent) so `which bun` resolves under any login shell
- [ ] OR `bun` is symlinked into `/usr/local/bin`

### 4.4 Confirm with Cooper which OPENCLAW version to bake

Per CLAUDE.md Rule 65: `OPENCLAW_PINNED_VERSION` is `2026.4.26`. Bake should pin to that version. **DO NOT bake at 2026.5.20** — that's a future post-Edge bake (per Cooper's earlier call). The current canary on vm-1019 is not declared production-ready. Need explicit re-confirmation from Cooper that we're baking at 2026.4.26.

### 4.5 EDGEOS_THIRD_PARTY_API_KEY needs Vercel-env reachability

The bake doesn't bake this in — it's per-VM-key minted at assignment. But the reconciler at assignment time needs `EDGEOS_EVENTS_BEARER_TOKEN` (which IS set) AND `EDGEOS_THIRD_PARTY_API_KEY` (which IS set). Confirm both are still in Vercel env immediately before the bake (no surprise rotation).

---

## 5. Outstanding cleanup observed on vm-771 (not blockers — bake-VM-specific cleanup)

These are NOT blockers because they're vm-771-specific artifacts, not snapshot-state. But they're a reminder that the bake VM needs aggressive pre-imagize cleanup:

- Duplicate git-pull cron lines for edge-esmeralda (one uses `$HOME`, one uses `/home/openclaw` — same effect, cosmetic duplicate). Bake should ensure exactly ONE entry.
- `~/.gbrain/brain.pglite.stale-quarantine-20260518T211959Z/` (61 MB) — vm-771 specific recovery leftover
- `~/.gbrain/brain.pglite.pre-upgrade-20260519T153444Z.tar.gz` (3.7 MB) — vm-771 specific upgrade leftover
- User-personalized MEMORY.md (80 lines) — vm-771 specific
- `~/.openclaw/.env` with user tokens — vm-771 specific

Bake VM should never have ANY of the above (it's a fresh provision, not a copy of vm-771).

---

## 6. POST-BAKE (after image is `available`)

After Linode finalizes the new image:

- [ ] Update `LINODE_SNAPSHOT_ID` in Vercel prod env (use `printf '%s' ... | npx vercel env add` per Rule 6 — though Web UI also works)
- [ ] Update `LINODE_SNAPSHOT_ID` in `.env.local` (after `vercel env pull`)
- [ ] Update CLAUDE.md `VM Provisioning Standard` section with new snapshot ID + label + description
- [ ] Update project-memory `reference_vm_provisioning.md` AND `MEMORY.md` snapshot pointers
- [ ] Trigger replenish-pool to provision 1-2 fresh pool VMs from the new snapshot. Verify they configure cleanly via `configureOpenClaw` → cv=120
- [ ] Run `scripts/_audit-canary-vs-manifest.ts` against one of the fresh-from-new-snapshot pool VMs to confirm zero drift findings (should be 0 findings; if any, that's a bake-gap to fix and re-bake)
- [ ] Keep OLD snapshot (`private/38977398`) for 7 days as rollback window (per CLAUDE.md retention rule)
- [ ] Schedule deletion of OLD snapshot for 2026-06-01 if no rollback needed

---

## 7. ROLLBACK PLAN (if bake produces a broken snapshot)

If a fresh provision from the new snapshot fails:

```bash
# Revert Vercel env to the previous snapshot
printf 'private/38977398' | npx vercel env add LINODE_SNAPSHOT_ID production --force
npx vercel deploy --prod  # or wait for next deploy
# Next pool replenishment provisions from the v113 snapshot again

# Delete the broken new image
curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  "https://api.linode.com/v4/images/private/<new-id>"
```

The fleet is unaffected by rollback because the snapshot is only used for NEW provisions.

---

## 8. DEFERRED (intentionally NOT in this bake)

- **OpenClaw 2026.5.20 upgrade** — per Rule 65, vm-1019 is the quarantined canary; full fleet rollout is post-Edge (June 2+). The 2026.5.20 bake is a separate future PR with its own readiness PRD.
- **INDEX_API_KEY for matching** — fleet-wide gap (10/10 edge VMs missing). Tomorrow's work. Separate from snapshot bake; uses `INDEX_NETWORK_MASTER_KEY` flow.
- **vm-1019 EDGEOS key** — mint when un-quarantining post-Edge. Not a snapshot concern.

---

## 9. Confidence summary

| Section | State |
|---|---|
| Code on main is bake-ready (manifest v120, pin 2026.4.26) | ✅ |
| Production fleet proves v120 deltas reconcile cleanly | ✅ |
| EdgeOS chain works end-to-end | ✅ |
| Current snapshot identity discovered | ✅ (private/38977398, v113, 2 days old) |
| Bake VM hasn't been provisioned yet — all sections 3.x and 4.x verifications pending | ⏳ |
| CLAUDE.md doc currency | ❌ stale (v79 vs reality v113) |

**Recommended sequence on greenlight**:
1. Fix blocker 4.1 (CLAUDE.md update — 5 min)
2. Verify blocker 4.2 (`_autonomous-bake.ts` loads cleanly — 1 min)
3. Re-confirm 4.4 with Cooper ("baking at OpenClaw 2026.4.26, not 2026.5.20, correct?")
4. Confirm 4.5 (`vercel env ls production | grep EDGEOS_THIRD_PARTY_API_KEY`)
5. Provision bake VM from current snapshot
6. Walk section 3.1–3.6 verifications (the 15-point list + v120 deltas + cleanup)
7. Image
8. Section 6 post-bake updates
9. Section 7 rollback path stays ready for 7 days
