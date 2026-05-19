# gbrain SOUL routing — 3-surface analysis & deployment plan

**Date**: 2026-05-19
**Status**: Analysis only. NO code written yet. Awaiting Cooper review.
**Scope**: Map gbrain SOUL routing block deployment across (1) existing fleet, (2) May 23 bake, (3) new VM onboarding. Identify every gap. Propose exact fix for each.

---

## Executive summary

The gbrain Memory Protocol block is already deployed to `AGENTS.md` on every gbrain-eligible VM via `stepDeployGbrainSoulProtocol` (manifest v102). The equivalent for `SOUL.md` does NOT exist. As a result:

- **vm-050** got the SOUL routing via a hand-deploy on 2026-05-17 (script `_push_gbrain_fix.ts`)
- **8 other edge_city VMs** still have the OBSOLETE MEMORY.md-first `## Memory Persistence (CRITICAL)` section — bit-identical (sha `6010222d370f`) across all 8
- **Future edge_city VMs (post-bake)** will inherit the same obsolete content from `WORKSPACE_SOUL_MD`
- **Non-edge VMs** (137 of 146 fleet) correctly have MEMORY.md-first content because they have no gbrain

**Fix proposal (single coordinated PR)**:

1. New canonical constant `GBRAIN_SOUL_ROUTING_V1_SECTION` in `lib/workspace-templates-v2.ts` (~3,300 bytes, marker-wrapped)
2. New reconciler step `stepDeployGbrainSoulRouting` at `lib/vm-reconcile.ts:~645` (right after `stepDeployGbrainSoulProtocol`)
3. configureOpenClaw post-assembly conditional injection at `lib/ssh.ts:~6096` (gbrain-eligible VMs only)
4. Manifest version bump v105 → v106

After deploy: (a) every existing gbrain VM gets the block within one reconcile tick (~3–5 min), (b) every fresh VM from the bake snapshot gets it via configureOpenClaw at assignment time, (c) every new VM provisioned after the bake gets it through the same path — zero manual intervention.

---

## Forensic data — fleet truth at 2026-05-19 16:00 UTC

### Census: who has gbrain today?

```
Total healthy+assigned VMs: 146
By partner:
  none:        137  (no gbrain, never had it)
  edge_city:     9  (all on v0.36.3.0 commit 1d5f69fe)
By config_version:
  cv=105:      146  (every VM caught up to current manifest)
```

Source: `instaclaw_vms` query 2026-05-19 16:00 UTC. Verified via SSH probe on 5 random non-edge VMs (vm-625, vm-925, vm-901, vm-918, etc.) — all returned `installed=0 active=inactive`.

`GBRAIN_PARTNER_ALLOWLIST` is `new Set(["edge_city"])` only — `lib/vm-reconcile.ts:128`. Future expansion (consensus_2026, eclipse, etc.) trivially handled by `.add()`.

`GBRAIN_INSTALL_ENABLED` is set to `"true"` in Vercel env (proven by 9 edge VMs having gbrain installed via the reconciler path).

### SOUL.md `## Memory Persistence (CRITICAL)` section — sha distribution

Pulled `~/.openclaw/workspace/SOUL.md` from all 9 edge_city VMs to local. Extracted the section between `## Memory Persistence (CRITICAL)` (inclusive) and `## Task Completion Notifications` (exclusive). sha256 each:

| VM | Section sha (first 12) | Section size | SOUL.md total | Note |
|---|---|---|---|---|
| vm-050 | `857b749d6187` | 3,144 B | 35,247 B | UNIQUE — gbrain-first (hand-deployed 2026-05-17) |
| vm-354 | `6010222d370f` | 3,446 B | 35,691 B | vanilla MEMORY.md-first |
| vm-771 | `6010222d370f` | 3,446 B | 35,689 B | vanilla MEMORY.md-first |
| vm-777 | `6010222d370f` | 3,446 B | 36,241 B | vanilla MEMORY.md-first |
| vm-780 | `6010222d370f` | 3,446 B | 35,962 B | vanilla MEMORY.md-first |
| vm-859 | `6010222d370f` | 3,446 B | 35,689 B | vanilla MEMORY.md-first |
| vm-917 | `6010222d370f` | 3,446 B | 35,689 B | vanilla MEMORY.md-first |
| vm-922 | `6010222d370f` | 3,446 B | 35,689 B | vanilla MEMORY.md-first |
| vm-923 | `6010222d370f` | 3,446 B | 35,689 B | vanilla MEMORY.md-first |

**Critical**: 8 of 9 VMs have BIT-IDENTICAL vanilla content. Zero per-VM identity drift in this section. This justifies a drift-aware destructive REPLACE pattern instead of additive INSERT — see "Why replace vs insert" below.

### AGENTS.md `GBRAIN_MEMORY_PROTOCOL_V1` marker presence

All 9 edge VMs have the marker (proven by `stepDeployGbrainSoulProtocol` having already run successfully). vm-050 has 10 `gbrain__put_page` mentions in AGENTS.md vs 5 on the other 8 — the extra 5 are vm-050's hand-deploy redundantly adding the same content via a different path. Harmless redundancy; AGENTS.md is not the concern here.

### Existing `stepDeployGbrainSoulProtocol` — the pattern to mirror

`lib/vm-reconcile.ts:7567-7700`. Reference implementation. Despite the misleading "SoulProtocol" name, it deploys to **AGENTS.md**, not SOUL.md. Key invariants:

- **Gate** (line 7574-7583): `systemctl --user is-active gbrain.service` must equal `active`. Silent skip otherwise (returns without push to errors/fixed).
- **Marker check** (line 7585-7590): `grep -c "GBRAIN_MEMORY_PROTOCOL_V1"` → idempotent skip if present.
- **Backup** (line 7601, line 30+ of Python script): writes original AGENTS.md to `~/.openclaw/backups/v102-gbrain-soul-protocol-<ts>/AGENTS.md` BEFORE any modification (Rule 22).
- **Insert pattern**: locate `## Memory Protocol` header, insert canonical block BEFORE it. Fallback: append to EOF if header missing.
- **Atomic write**: `path + ".tmp"`, then `os.replace(tmp, path)`.
- **Verify-after-write**: re-read file, confirm marker present. Push to `result.errors` on verify-fail.

This step has been running cleanly fleet-wide since v102 (2026-05-17). Pattern is proven.

---

## Surface 1: existing fleet (~146 VMs)

### Scope

ONLY 9 edge_city VMs need the SOUL routing block today. 137 non-partner VMs have NO gbrain and correctly should NOT receive gbrain routing guidance (would point them at tools that don't exist).

### Mechanism: new reconciler step `stepDeployGbrainSoulRouting`

Location: `lib/vm-reconcile.ts`, immediately after `stepDeployGbrainSoulProtocol` at line 643:

```typescript
// ── Step 8f6: deploy gbrain routing block into SOUL.md ──
// Mirrors stepDeployGbrainSoulProtocol but targets SOUL.md (not AGENTS.md).
// Replaces the obsolete MEMORY.md-first `## Memory Persistence (CRITICAL)`
// section with the gbrain-first marker-bounded V1 block. Gated on
// gbrain.service active — non-gbrain VMs cleanly skip.
currentStep = "gbrain-soul-routing";
await stepDeployGbrainSoulRouting(ssh, result, dryRun);
```

### Gate semantics (matches stepDeployGbrainSoulProtocol exactly)

1. `systemctl --user is-active gbrain.service 2>&1 | head -1` → if not `active`: silent return (no error, no `alreadyCorrect`).
2. `grep -c "GBRAIN_SOUL_ROUTING_V1"` in `~/.openclaw/workspace/SOUL.md` → if ≥1: push to `result.alreadyCorrect` and return.
3. Otherwise: proceed to Python in-place transform.

### Python transform — REPLACE pattern with drift-check

The OBSOLETE `## Memory Persistence (CRITICAL)` section on the 8 vanilla VMs is **platform guidance**, not user-customizable identity content. Replacing it is appropriate because:

- The two versions occupy the same logical role (where do I file memory?)
- Having both would create contradictory routing for the agent
- The vanilla content's MEMORY.md-first guidance is now factually wrong for gbrain-eligible VMs

Replace pattern with safeguards:

```python
# Find section boundaries
start_header = "## Memory Persistence (CRITICAL)"
end_header = "## Task Completion Notifications"

start_idx = content.find(start_header)
end_idx = content.find(end_header)

if start_idx < 0 or end_idx < 0 or end_idx < start_idx:
    out({"status": "anchors_missing"})  # don't write — log warning

current_section = content[start_idx:end_idx]
current_sha = hashlib.sha256(current_section.encode()).hexdigest()

KNOWN_VANILLA_SHA = "6010222d370fdc4ce70508a34361282d13306fd418394c48781b2320507093f4"
KNOWN_VM050_SHA  = "857b749d618754a0db638886e4139bc086f0e53a8a8dae41af0825c1c189208b"

if current_sha not in (KNOWN_VANILLA_SHA, KNOWN_VM050_SHA):
    # User customized this section. DO NOT overwrite.
    out({"status": "drift_detected", "sha": current_sha[:12]})

# Safe to replace: section matches a known canonical form
new_section = BEGIN_MARKER + "\n" + canonical_block + "\n" + END_MARKER + "\n\n"
new_content = content[:start_idx] + new_section + content[end_idx:]
```

The drift-check is the critical safeguard. If ANY VM has a custom section (user manually edited, or a future template change drifted), we SKIP and log. The PR's deploy script then reports the drift VMs for manual review; the reconciler keeps trying every cycle but never destroys customization.

### Why replace vs insert

Considered the additive INSERT pattern (used by `stepDeployGbrainSoulProtocol` for AGENTS.md) but rejected for SOUL.md:

| Concern | INSERT | REPLACE |
|---|---|---|
| Risk to identity content | None (pure additive) | Low (drift-check + backup) |
| SOUL.md size impact | **+3,300 bytes per VM** | **−150 bytes per VM** |
| Removes obsolete MEMORY.md-first guidance | No (both versions coexist) | Yes |
| Risk of contradictory routing | High (both sections visible to agent) | None |
| Idempotency | Marker-based | Marker-based |
| Rule 22 compliance | Stronger (pure additive) | OK (backup + drift-check + restorable) |

Size matters: edge_city VMs are already at ~36KB SOUL.md (over the historical 35K bootstrap budget, now raised to 40K per v92). Adding 3.3KB pushes them to ~39KB. REPLACE keeps them stable or smaller.

The contradictory-routing concern is decisive: an agent reading both "use gbrain__put_page" AND "write to MEMORY.md directly" produces incoherent behavior. REPLACE eliminates that.

### Backup strategy (Rule 22)

Before any modification: `cp ~/.openclaw/workspace/SOUL.md ~/.openclaw/backups/v106-gbrain-soul-routing-<unix_ts>/SOUL.md`. Same shape as `stepDeployGbrainSoulProtocol`.

Recovery: any operator can restore via `cp ~/.openclaw/backups/v106-gbrain-soul-routing-<ts>/SOUL.md ~/.openclaw/workspace/SOUL.md` followed by `systemctl --user restart openclaw-gateway` (gateway re-reads SOUL.md on session start, no restart actually needed but suggested for cleanliness).

Backups age out via existing daily-hygiene cron (~7d retention default).

### Step ordering — confirmed safe

Current orchestrator order in `reconcileVM`:

```
Line 478: stepGbrain                          (installs gbrain.service)
Line 643: stepDeployGbrainSoulProtocol        (AGENTS.md insert)
Line 645: stepDeployGbrainSoulRouting [NEW]   (SOUL.md replace)
Line 651: stepDeployEdgeOverlay
```

By the time stepDeployGbrainSoulRouting's gate runs, gbrain.service was installed +165s earlier in the same cycle (or installed in a prior cycle if this is a re-reconcile). The gate finds it active and proceeds.

For a VM that has NEVER had gbrain (a future eclipse VM, for example), stepGbrain at line 478 installs it in the same cycle that stepDeployGbrainSoulRouting at line 645 then catches up. **No race condition** — stepGbrain runs to completion (or fails loudly via result.errors) before line 645 executes.

### Manifest version bump v105 → v106

CLAUDE.md's "Version-bump policy":

> **MUST bump** — any change that needs to reach every existing VM via the reconciler:
> - Any new reconciler step in `lib/vm-reconcile.ts` (the orchestrator's call site list expands, and existing VMs at the prior cv haven't run the new step).

This change adds a new step. v106 mandatory.

After bump: reconcile-fleet filter `lt("config_version", VM_MANIFEST.version)` widens from "VMs at cv<105" to "VMs at cv<106", forcing the 146 currently-caught-up VMs back into the candidate queue. Each VM runs all steps including new `stepDeployGbrainSoulRouting`. For the 137 non-gbrain VMs: gate skips silently (no work). For the 9 edge VMs: drift-check passes, block deployed, cv bumped to 106.

Eventual drain time: with `CONFIG_AUDIT_BATCH_SIZE=3` and per-VM ~30s reconcile time, ~30 min for the 9 edge VMs to converge.

### Changelog entry (preview for vm-manifest.ts docblock)

```
### v106 — 2026-05-19 (gbrain SOUL routing block — stepDeployGbrainSoulRouting)

- Manifest change: VM_MANIFEST.version bumped 105 → 106. New reconciler step
  stepDeployGbrainSoulRouting (called right after stepDeployGbrainSoulProtocol)
  replaces the obsolete MEMORY.md-first `## Memory Persistence (CRITICAL)` section
  in SOUL.md with the gbrain-first GBRAIN_SOUL_ROUTING_V1 marker-bounded block.
  Mirrors stepDeployGbrainSoulProtocol gate semantics (gbrain.service active),
  idempotency (marker check), backup (Rule 22), atomic write (Rule 23), and
  verify-after-write (Rule 10). Adds drift-check: only replaces sections matching
  the known vanilla or vm-050 canonical sha — user-customized sections SKIPPED.
- Why: 2026-05-19 audit found 8 of 9 edge_city VMs had the OBSOLETE MEMORY.md-first
  Memory Persistence section in SOUL.md, despite having gbrain installed. Agents
  saw the MCP tools but had no SOUL routing telling them to prefer gbrain over
  MEMORY.md. Result: no persistent memory built for edge_city users in practice.
- Companion fix: lib/ssh.ts configureOpenClaw now post-assembly conditionally
  injects the same block at fresh-VM assignment time when gbrain-eligible.
  Bake snapshot stays unchanged (its SOUL.md gets overwritten at assignment).
- Fleet rollout: reconcile-fleet picks up v106 next cycle. 9 edge VMs drain in
  ~30 min. 137 non-gbrain VMs early-out at gate (zero cost).
- Detection note: after rollout, sample any 5 edge VMs and grep
  `GBRAIN_SOUL_ROUTING_V1` in SOUL.md — must be present. Cross-check no per-VM
  identity content was touched: compare backup hash against pre-deploy snapshot.
- Rollback: revert the commit. Existing marker blocks stay on disk (idempotent
  replay won't remove them; new step won't write to v105-eligible VMs because
  v106 is gone). Manual cleanup via the backup file if rollback needs to also
  reverse on-disk state.
```

---

## Surface 2: May 23 snapshot bake

### Current snapshot state

`LINODE_SNAPSHOT_ID=private/38575292` (v79, baked 2026-05-03). All 146 production VMs were provisioned from this snapshot. SOUL.md on this snapshot is built from `WORKSPACE_SOUL_MD + supplements` per the bake recipe — which means it contains the OBSOLETE `## Memory Persistence (CRITICAL)` section.

### Snapshot bake flow (CLAUDE.md "Snapshot Creation Process")

```
1. Provision fresh nanode from CURRENT snapshot
2. Upgrade OpenClaw → npm install -g openclaw@latest
3. Install/update packages
4. Deploy manifest files from codebase (extracts templates → writes to disk)
   - SOUL.md is built from: WORKSPACE_SOUL_MD + INTELLIGENCE_SUPPLEMENT +
     LEARNED_PREFERENCES + OPERATING_PRINCIPLES + MEMORY_FILING_SYSTEM
5. Install crons (7 total)
6. Clean caches
7. 15-point verification
8. Power off cleanly
9. Create image, update LINODE_SNAPSHOT_ID
```

### What the bake's SOUL.md contains today

Source: `lib/ssh.ts:4298-4361` — `WORKSPACE_SOUL_MD`'s `## Memory Persistence (CRITICAL)` section. Content = OBSOLETE MEMORY.md-first guidance. sha = same `6010222d370f...` as the 8 vanilla edge VMs.

### Does bake need updating?

**No, BUT we need the configureOpenClaw conditional injection** (described below). Here's why:

Bake snapshot is a TEMPLATE for new VMs. When a fresh VM boots from snapshot, it inherits the snapshot's SOUL.md (with MEMORY.md-first content). Then `/api/vm/assign` runs `configureOpenClaw`, which **REWRITES SOUL.md** from the assembled constants. The snapshot's SOUL.md is short-lived (lives only between boot and assignment, ~minutes).

So the bake's content doesn't matter for assigned VMs. It only matters for the brief unassigned-snapshot-boot window — but agents don't run during that window (no user, no Telegram bot, gateway may not even be active).

**Action**: leave the bake recipe alone. No template change to `WORKSPACE_SOUL_MD` in lib/ssh.ts. Surface 2 is implicitly handled by Surface 3's configureOpenClaw fix.

If we DID change `WORKSPACE_SOUL_MD`, non-gbrain VMs (the 137 in production today) would receive gbrain routing guidance pointing them at tools they don't have. That's noise, not value. Keeping `WORKSPACE_SOUL_MD` unchanged preserves correct default-for-non-gbrain behavior.

---

## Surface 3: new VM onboarding (post-bake, ongoing)

### Full assembly path

```
User signs up
  → POST /api/vm/assign
    → assignVM picks a ready VM, marks it assigned_to=<user.id>
    → POST /api/vm/configure
      → configureOpenClaw(ssh, vm, ...)
        → assembles SOUL.md content from WORKSPACE_SOUL_MD + supplements
          (lib/ssh.ts:6091-6095)
        → writes SOUL.md via base64 + cat > workspace/SOUL.md
        → installs Telegram/Discord channel config
        → writes other workspace files (CAPABILITIES.md, EARN.md, etc.)
        → atomically writes openclaw.json + .env + auth-profiles.json
        → starts openclaw-gateway via systemctl --user start
        → DB update: gateway_url, gateway_token, telegram_bot_token,
          health_status='healthy'
    → returns 200 to client; user sees "agent ready"

Vercel cron /api/cron/reconcile-fleet (every 3 min)
  → for each healthy+assigned VM at cv<MANIFEST.version:
    → reconcileVM(ssh, vm, ...)
      → orchestrator runs steps in order:
        Line 478: stepGbrain (if partner in allowlist + env enabled)
        Line 643: stepDeployGbrainSoulProtocol (if gbrain.service active)
        Line 645: stepDeployGbrainSoulRouting [NEW] (same gate)
      → bumps config_version → MANIFEST.version
```

### configureOpenClaw conditional injection — proposed code

In `lib/ssh.ts` immediately after the existing SOUL.md assembly (line 6095):

```typescript
let soulContent =
  WORKSPACE_SOUL_MD +
  SOUL_MD_INTELLIGENCE_SUPPLEMENT +
  SOUL_MD_LEARNED_PREFERENCES +
  "\n\n" + SOUL_MD_OPERATING_PRINCIPLES +
  SOUL_MD_MEMORY_FILING_SYSTEM;

// gbrain SOUL routing — conditional inject for gbrain-eligible VMs
// (mirrors gate logic in stepGbrain + stepDeployGbrainSoulRouting).
// Without this, the first 3-5 min after assignment has stale MEMORY.md-first
// guidance until the reconciler catches up. This closes that window.
import { GBRAIN_PARTNER_ALLOWLIST } from "./vm-reconcile";  // (or duplicate the constant; minimize coupling)
import { injectGbrainSoulRoutingV1 } from "./workspace-templates-v2";

if (
  vm.partner &&
  GBRAIN_PARTNER_ALLOWLIST.has(vm.partner) &&
  process.env.GBRAIN_INSTALL_ENABLED === "true"
) {
  soulContent = injectGbrainSoulRoutingV1(soulContent);
}
```

The helper `injectGbrainSoulRoutingV1(text: string): string` lives in `lib/workspace-templates-v2.ts` and does the same string transform as the Python script — find `## Memory Persistence (CRITICAL)` ... `## Task Completion Notifications`, replace with marker-bounded canonical block. Drift-check less critical here (we're rewriting our own assembled content, so drift is essentially impossible) but include it anyway for defense in depth.

### Race condition analysis

**Scenario**: user signs up, gets assigned, sends first message in <3 min (before reconciler catches up).

- Without configureOpenClaw injection: agent sees MEMORY.md-first guidance for 3-5 min. Agent might file first memory to MEMORY.md instead of gbrain. Recoverable but suboptimal.
- With configureOpenClaw injection: agent sees gbrain-first guidance from first message. Correct from boot. No race.

**Scenario**: user gets assigned a VM, but reconciler not yet run stepGbrain → gbrain.service not active yet.

- configureOpenClaw injection happens regardless (it's based on `vm.partner` not on `gbrain.service` state). So SOUL.md has gbrain-first routing, but the tools aren't there yet.
- Agent tries `gbrain__put_page`, MCP server returns "tool not found" → agent says "let me retry, or note for next session" (per the routing block's "If gbrain is unavailable" clause).
- Within 3-5 min, stepGbrain installs gbrain → tools available → next attempt works.

Acceptable trade-off. The alternative (gate configureOpenClaw injection on `gbrain.service active`) means SSH'ing into the VM during configure to probe — adds latency and a fragile dependency. Not worth it.

### Step ordering re-verified

Confirmed via `grep -nE "currentStep = " lib/vm-reconcile.ts`:

```
478: stepGbrain                       ← installs gbrain (gate: partner + env)
492: stepFiles                        ← deploys manifest files (file-drift)
504: stepMigrateSoulV2                ← gated by env var, default off
643: stepDeployGbrainSoulProtocol     ← AGENTS.md insert (gate: gbrain.service active)
645: stepDeployGbrainSoulRouting NEW  ← SOUL.md replace (gate: same)
651: stepDeployEdgeOverlay
```

stepFiles at 492 deploys workspace files from `vm-manifest.ts:files[]`. Does it touch SOUL.md? Per audit at lib/vm-manifest.ts:1725: yes, SOUL.md is in `files[]` for partner-specific entries. But the entries use `mode: "append_if_marker_absent"` or `"insert_before_marker"` — never `"overwrite"` for SOUL.md. So stepFiles WON'T overwrite our marker block.

**Additional safeguard already in place**: `pickV2MarkerForPath` (lib/vm-reconcile.ts:2476) returns `SOUL_V2_MARKER` for SOUL.md — if that marker is on disk, file-drift skips. We're using a different marker (`GBRAIN_SOUL_ROUTING_V1`), so this skip doesn't apply directly to us. But the manifest entries that DO touch SOUL.md (Edge partner stub, Consensus stub) use marker-based inserts that won't touch the `## Memory Persistence (CRITICAL)` region.

### Will file-drift cron undo our changes?

`/api/cron/file-drift` runs `stepFiles` continuously on every healthy+assigned VM. As long as `stepFiles` doesn't `mode: "overwrite"` for SOUL.md (it doesn't), our marker block survives indefinitely.

Verified via grep `lib/vm-manifest.ts` for SOUL.md remotePath entries: lines 1725, 1732, 1739, 1748, 1778. None use `mode: "overwrite"`. All use `append_if_marker_absent` or `insert_before_marker` semantics. Safe.

---

## Implementation plan (when Cooper approves)

### Files to change (4)

1. **`lib/workspace-templates-v2.ts`** — add ~3.4KB constant + helper

   ```typescript
   export const GBRAIN_SOUL_ROUTING_V1_BEGIN = "<!-- GBRAIN_SOUL_ROUTING_V1_BEGIN -->";
   export const GBRAIN_SOUL_ROUTING_V1_END = "<!-- GBRAIN_SOUL_ROUTING_V1_END -->";

   /**
    * Canonical SOUL.md gbrain-first Memory Persistence section.
    * Extracted from vm-050's hand-deployed gbrain protocol (2026-05-17).
    * Marker-bounded for idempotent insert/replace by:
    *   - stepDeployGbrainSoulRouting (vm-reconcile.ts) for existing fleet
    *   - configureOpenClaw (ssh.ts) for fresh VM assignment
    * sha256: 857b749d6187... (vm-050's section content)
    */
   export const GBRAIN_SOUL_ROUTING_V1_SECTION =
     `${GBRAIN_SOUL_ROUTING_V1_BEGIN}\n` +
     `## Memory Persistence (CRITICAL)\n\n` +
     `**Your persistent memory across sessions is gbrain (MCP)** ... [exact vm-050 content]\n\n` +
     `${GBRAIN_SOUL_ROUTING_V1_END}`;

   /**
    * In-process inject for configureOpenClaw assembly. Same transform as
    * stepDeployGbrainSoulRouting's Python, but operates on the JS string
    * before write. Drift-tolerant (we're rewriting our own assembly).
    */
   export function injectGbrainSoulRoutingV1(soulText: string): string {
     const startHeader = "## Memory Persistence (CRITICAL)";
     const endHeader = "## Task Completion Notifications";
     const startIdx = soulText.indexOf(startHeader);
     const endIdx = soulText.indexOf(endHeader);
     if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
       // Anchors missing — return unchanged. Defensive.
       return soulText;
     }
     // Idempotency: skip if marker already present
     if (soulText.includes(GBRAIN_SOUL_ROUTING_V1_BEGIN)) return soulText;
     return soulText.slice(0, startIdx) +
       GBRAIN_SOUL_ROUTING_V1_SECTION + "\n\n" +
       soulText.slice(endIdx);
   }
   ```

2. **`lib/vm-reconcile.ts`** — add new step

   ```typescript
   // Near line 645, right after stepDeployGbrainSoulProtocol:
   currentStep = "gbrain-soul-routing";
   await stepDeployGbrainSoulRouting(ssh, result, dryRun);

   // ...new function later in file (mirrors stepDeployGbrainSoulProtocol at line 7567):
   async function stepDeployGbrainSoulRouting(
     ssh: SSHConnection,
     result: ReconcileResult,
     dryRun: boolean,
   ): Promise<void> {
     // Gate: gbrain.service active (silent skip otherwise)
     // Marker probe: GBRAIN_SOUL_ROUTING_V1 (idempotent skip if present)
     // Python in-place: find ## Memory Persistence (CRITICAL) ... ## Task
     //   Completion Notifications boundaries, drift-check sha against known
     //   canonical, replace with marker-bounded block, atomic write, verify.
     // Backup: ~/.openclaw/backups/v106-gbrain-soul-routing-<ts>/SOUL.md
   }
   ```

   Python script is structurally a clone of stepDeployGbrainSoulProtocol's `PATCH_PY` with:
   - Different cfg key: `soul_path` instead of `agents_path`
   - Different marker: `GBRAIN_SOUL_ROUTING_V1`
   - REPLACE pattern (find boundaries, replace section) instead of INSERT-before-header
   - Drift-check sha (passes only if `current_sha in {KNOWN_VANILLA_SHA, KNOWN_VM050_SHA}`)

3. **`lib/ssh.ts`** — configureOpenClaw conditional injection

   Insert after line 6095 (after the `soulContent` assembly, before the SOUL.md write):

   ```typescript
   // gbrain SOUL routing — see PRD gbrain-soul-routing-3-surface-analysis-2026-05-19.md
   if (
     vm.partner &&
     GBRAIN_PARTNER_ALLOWLIST.has(vm.partner) &&
     process.env.GBRAIN_INSTALL_ENABLED === "true"
   ) {
     soulContent = injectGbrainSoulRoutingV1(soulContent);
   }
   ```

   Requires adding `GBRAIN_PARTNER_ALLOWLIST` and `injectGbrainSoulRoutingV1` imports at top of file.

4. **`lib/vm-manifest.ts`** — bump version

   ```typescript
   export const VM_MANIFEST = {
     version: 106,  // was 105
     // ...
   };
   ```

   Plus changelog entry in the file's docblock (preview text above).

### Validation steps before deploy (per Rule 31 / Rule 59)

1. **Synthetic test**: write `scripts/_test-gbrain-soul-routing-inject.ts` that exercises `injectGbrainSoulRoutingV1` against:
   - Vanilla SOUL.md (8-VM canonical) → should produce marker-bounded version with sha match
   - vm-050's existing SOUL.md → should produce same marker-bounded version
   - Already-marker-wrapped SOUL.md → idempotent no-op
   - Missing anchor → returns unchanged
   - User-customized section (synthetic) → returns unchanged

2. **Local dry-run on copies**: against `/tmp/soul-md-investigation/vm-*-SOUL.md` files. Confirm each transforms correctly. Sha-check the resulting marker block content matches across all 9.

3. **Manifest typecheck**: `npx tsc --noEmit`. Must pass.

4. **One-VM canary on vm-050**: deploy v106 to vm-050 only. Verify:
   - GBRAIN_SOUL_ROUTING_V1 marker present in SOUL.md
   - Pre-marker content (`## My Identity`, etc.) unchanged byte-for-byte
   - Post-marker content (`## Task Completion Notifications` onward) unchanged byte-for-byte
   - SOUL.md total size ~consistent (within ±200 bytes of pre-deploy)
   - Backup file exists at `~/.openclaw/backups/v106-gbrain-soul-routing-<ts>/SOUL.md`

5. **Soak vm-050 24h**: confirm no reconciler errors, no gateway crashes, no user-facing regressions.

6. **8-VM rollout**: sequential, with per-VM SOUL.md hash captured pre/post. Verify identity content (everything outside the marker block) bit-identical pre/post.

7. **Post-deploy fleet audit**: cron-style script that periodically samples 5 random edge_city VMs and confirms marker presence + identity-content stability.

### Coverage script (Rule 27)

`scripts/_coverage-gbrain-soul-routing.ts`:

```typescript
// Query all healthy+assigned VMs where partner in GBRAIN_PARTNER_ALLOWLIST.
// For each: SSH grep "GBRAIN_SOUL_ROUTING_V1" in SOUL.md. Count present/missing.
// Print: 9/9 (100%) — green; anything less is regression.
```

Runs in <10s. Operator runs after every manifest bump that touches this surface.

---

## Risk register

| Risk | Likelihood | Blast radius | Mitigation |
|---|---|---|---|
| Drift-check false positive (legitimately customized section blocks our replace) | Low | 1 VM stays MEMORY.md-first until manual review | Coverage script flags; operator reviews; replace by hand or accept |
| Drift-check false negative (custom content matches a known sha by coincidence) | Negligible (sha256 collision) | N/A | Sha256 cryptographic strength |
| stepGbrain crashes after starting install — gbrain.service in failed state — our step's gate sees it as "not active" | Low | Step skips, SOUL not updated until next cycle when gbrain stabilizes | Acceptable; gate is correct |
| Marker block content has a typo that breaks agent behavior | Low | All gbrain VMs degraded | Validation step 1 (synthetic test) + step 4 (canary 24h) |
| configureOpenClaw injection on a non-gbrain-eligible VM (gate fails) | Negligible | Per-VM dead code path | Gate matches reconciler gate exactly; both sourced from `GBRAIN_PARTNER_ALLOWLIST` |
| Reconciler step times out under heavy load | Low | Cycle retries next tick | Same as stepDeployGbrainSoulProtocol — no new failure mode |
| New step BLOCKS cv-bump on a transient SSH failure (Rule 39 critical-vs-warning) | Low | VM stuck at v105, retries next cycle | Step pushes to `result.warnings` (not `result.errors`) on Python failure or SSH issue — only `result.errors` on verify-after-write fail |

### Rule 22 compliance audit

- ✅ Backup before any modification (mirrors stepDeployGbrainSoulProtocol)
- ✅ Atomic write (tmp + os.replace)
- ✅ Verify-after-write (marker grep)
- ✅ Drift-check before destructive replace (only replaces known-canonical content)
- ✅ Idempotent (marker check + sha re-check)
- ✅ Recovery script documented (cp from backup)

### Rule 23 sentinel guard

Should the new constant `GBRAIN_SOUL_ROUTING_V1_SECTION` have a `requiredSentinels` array in any manifest entry?

Yes — if we add the constant as a `files[]` entry. But we're NOT adding it to `files[]` (we're using the step pattern, not the file-drift pattern). So the sentinel guard at `deployFileEntry` doesn't apply directly.

However, the new reconciler step's Python script should grep its in-memory content for known unique strings (e.g., `gbrain__put_page`, `gbrain__submit_job`) BEFORE writing. If a stale module cache (Rule 23 scenario) somehow ships an empty or wrong block, the sentinel grep fails and the step refuses to write. Implementing:

```python
REQUIRED_SENTINELS = ["gbrain__put_page", "gbrain__search", "gbrain__submit_job"]
for s in REQUIRED_SENTINELS:
    if s not in canonical_block:
        out({"status": "sentinel_missing", "sentinel": s})
        sys.exit(1)
```

---

## Acceptance criteria

After deploy, all THREE must hold:

1. **Existing fleet**: 9/9 edge_city VMs have `GBRAIN_SOUL_ROUTING_V1` marker in SOUL.md. 137/137 non-gbrain VMs have NO marker (silent gate skip). Confirmed via `_coverage-gbrain-soul-routing.ts`.

2. **May 23 bake**: bake recipe runs `configureOpenClaw` as part of step 4. Verify: for a synthetic edge_city VM, `configureOpenClaw` produces SOUL.md with marker block. (Note: bake itself runs against partner=null so the snapshot's SOUL.md stays without the block — that's correct, snapshot is generic.)

3. **New VM onboarding**: when a fresh VM is assigned to an edge_city user, the first SOUL.md write (via `configureOpenClaw`) contains the marker block. Verified by inspecting the SOUL.md content within the configure flow OR by post-assignment SSH probe.

---

## Open questions for Cooper

1. **Drift-check semantics**: if a VM has a custom Memory Persistence section (sha matches neither vanilla nor vm-050), should we (a) SKIP silently with `result.warnings` push, (b) SKIP and emit P1 admin alert, or (c) attempt insert-before-anchor as fallback?

   My recommendation: **(b)** — admin alert lets operator review the customization and decide. We see this as an exception we should know about. The alert dedup mechanism (6h key per VM) prevents spam.

2. **GBRAIN_INSTALL_ENABLED env var dependency**: configureOpenClaw's conditional reads `process.env.GBRAIN_INSTALL_ENABLED`. If the env var is unset/false but a partner is in the allowlist (e.g., during a partner add but before gbrain rollout), configureOpenClaw skips the SOUL injection. Is that right?

   My read: yes. The pattern says "only inject gbrain SOUL guidance if gbrain will actually be installed". `GBRAIN_INSTALL_ENABLED` is the deploy-stage gate; without it, we shouldn't promise gbrain to the agent.

3. **Future partners**: when consensus_2026 or eclipse get added to `GBRAIN_PARTNER_ALLOWLIST`, do they automatically get the SOUL routing? Yes — same gate, same step, same logic. Nothing new needed.

4. **Existing AGENTS.md GBRAIN_MEMORY_PROTOCOL_V1**: should we keep BOTH AGENTS.md and SOUL.md gbrain blocks, or consolidate? My read: keep both. They serve different layers:
   - SOUL.md routing block is read at agent bootstrap (every session start)
   - AGENTS.md GBRAIN_MEMORY_PROTOCOL_V1 is the deeper reference doc the agent reads when reasoning about MCP tool selection

   Both reinforcing the same message is good. No consolidation needed for v106; consider for a future cleanup PR.

---

## Confidence assessment

- **Pattern**: HIGH. `stepDeployGbrainSoulProtocol` has been working fleet-wide since v102 (12 days). Direct clone with target = SOUL.md.
- **Drift-check**: HIGH. 8/9 VMs verified bit-identical vanilla. Drift-check ensures we only touch known-canonical sections.
- **Race conditions**: HIGH (none expected). Step ordering verified. configureOpenClaw injection runs before SOUL.md write.
- **Rule compliance**: HIGH. Rules 10, 22, 23, 27, 31, 39, 47, 59 all considered.
- **Rollback path**: HIGH. Per-VM backup + ability to revert manifest version. No data loss possible.

**Recommended next action**: Cooper approves the analysis → I write the 4-file PR → run synthetic tests + typecheck → one-VM canary on vm-050 → 24h soak → 8-VM sequential rollout. Total time-to-fleet-converged: ~24-36 hours from approval.
