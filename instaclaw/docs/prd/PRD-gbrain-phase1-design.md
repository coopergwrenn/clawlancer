# PRD: gbrain Phase 1 — design doc

**Status:** draft, awaiting Cooper review before any execution.
**Author:** 2026-05-09 (claude-opus-4-7)
**Supersedes for Phase 1 only:** PRD-gbrain-integration.md §5.3 (the original Phase 1 sketch). The PRD-corrections audit-trail in PRD-gbrain-integration.md §6.7 is the prerequisite reading.
**Implements:** PRD §5.3 with the 8 corrections from the §6.7 audit-trail baked in.

---

## 1. Executive summary

Phase 0 succeeded on vm-050 (smoke tests #1/#2/#3, 3-day soak audit clean — gateway healthy, zero zombies, MCP entry intact, PGLite pages persisted across 3 planned 24h restarts). Phase 1 takes gbrain to **3 VMs across tiers** via per-VM SSH installs (NOT reconciler — that's Phase 3). Each VM holds for 48h between installs. Total Phase 1 window: 1 week minimum.

**Phase 1 deliverables:**
1. `scripts/_install-gbrain-on-vm.ts` — per-VM SSH install (TS wrapper around the bash template below)
2. `scripts/_uninstall-gbrain-on-vm.ts` — clean rollback per-VM (mirror of #1)
3. `scripts/_verify-gbrain-on-vm.ts` — read-only state inspection (re-run weekly)
4. Three Phase 1 canary VMs installed, audited, holding for the soak window
5. Observability dashboard (or at minimum a query script) for `gbrain stats` per VM

**Phase 1 does NOT include:**
- Reconciler integration (`stepGbrain`) — that's Phase 3 (this doc has the spec)
- SOUL.md update telling agents to USE gbrain — that's Phase 5 (this doc has the plan)
- Manifest version bump — Phase 3
- Snapshot bake — Phase 4

---

## 2. Phase 1 scope: 3 canary VMs

### 2.1 Selection criteria

Per Rule 17 (canary discipline) + PRD §5.3:

| # | Tier | Owner | Why | Status |
|---|---|---|---|---|
| 1 | starter | Cooper (vm-050 / `@timmytimmytimbot`) | already done in Phase 0 — counts as starter canary | ✅ done |
| 2 | pro | Cooper or InstaClaw team | mid-tier load (more skills loaded, larger context) | TBD |
| 3 | power | Cooper or InstaClaw team | heaviest tier (1M ctx, more partner integrations, busiest cron) | TBD |

**Selection rules** — must hold for VMs #2 and #3:
- `assigned_to` is Cooper, Claude, or someone who has explicitly consented to dogfood
- `health_status = 'healthy'` AND `health_fail_count = 0` AND `last_health_check < 30min ago`
- `config_version >= 88` (TasksMax=120 + prctl-subreaper required precondition; if cv<88, run reconciler manually first)
- TCP-reachable on port 22 (non-broken SSH)
- Has had at least one real chat session in the past 7 days (so the agent has context to migrate)
- NOT vm-893 / vm-895 (the lying-DB cohort from 2026-05-05 — different problem class, don't conflate)
- NOT a partner-tagged VM unless explicitly approved (edge_city skill assumes specific SOUL.md content; vm-050 is the one exception we already handled)

### 2.2 Selection helper script

`scripts/_select-phase1-candidates.ts` runs the criteria + outputs 5 candidates per tier with a one-line summary. Cooper picks 1 each. The script is read-only.

```ts
// pseudocode
const eligible = await sb.from("instaclaw_vms")
  .select("name,ip_address,tier,assigned_to,config_version,health_status,health_fail_count,last_health_check,partner")
  .eq("status","assigned").eq("provider","linode")
  .eq("health_status","healthy").eq("health_fail_count",0)
  .gte("config_version", 88)
  .gt("last_health_check", iso(now - 30*60*1000));

// filter: Cooper/team-owned via assigned_to in known set
const cooperOwned = await sb.from("instaclaw_users")
  .select("id").in("email", ["coop@valtlabs.com","coopergrantwrenn@gmail.com"]);

// rank within tier by least-recent-gbrain-relevant-traffic — pick one with normal cron load, not extremes
```

### 2.3 Ordering + soak

**Day 0:** vm-050 done (Phase 0 canary, 3-day soak complete as of 2026-05-09).
**Day 0 (today):** install on candidate #2 (pro tier). Verify per §5. Hold 48h.
**Day +2:** if #2 audit clean, install on candidate #3 (power tier). Verify. Hold 48h.
**Day +4:** if #3 audit clean, Phase 1 complete. 1 more day of soak across all 3.
**Day +5:** Phase 1 decision gate (Cooper). Either Phase 2 (10 dogfood VMs) or halt+post-mortem.

Sequential, NOT parallel. Per Rule 17.

---

## 3. Install script template (the bash that runs over SSH)

Saved as `scripts/install-gbrain.sh` and uploaded to each target VM via SFTP, then executed. The script is:

- **Idempotent** (re-run on already-installed VM = exit 0 fast)
- **Atomic per phase** (each phase has explicit pre/post state checks)
- **Fail-fast** (any error → exit code, no half-state silently propagated)
- **Backup-first** (Rule 22: backups before any state change)
- **Verify-after-write** (Rule 10: every state-changing phase re-reads to confirm)

### 3.1 Phases + exit codes

| Phase | Action | Failure exit | Rollback |
|---|---|---|---|
| A | Pre-flight: backup + idempotency check | 1-2 | nothing changed; exit clean |
| B | Install Bun (with unzip prereq) | 3 | nothing persistent; exit |
| C | Clone + checkout pinned gbrain commit | 4-5 | `rm -rf ~/gbrain` |
| D | bun install + bun link in gbrain dir | 6-8 | `rm -rf ~/gbrain` |
| E | gbrain init --pglite | 9 | `rm -rf ~/.gbrain` |
| F | gbrain serve standalone probe | 10 | nothing changed; exit |
| G | Wire MCP via `openclaw mcp set` (hot reload) | 11-13 | `openclaw mcp unset gbrain` |

Note: Phases A-F are all reversible without touching the gateway. Only Phase G actually wires gbrain into the live gateway via hot reload. If Phase G fails, the unset is the rollback (also hot reload, also safe).

### 3.2 Full script

```bash
#!/usr/bin/env bash
# install-gbrain.sh
# Usage: GBRAIN_PINNED_COMMIT=2ea5b71 GBRAIN_PINNED_VERSION=0.28.1 ./install-gbrain.sh

set +e   # don't auto-exit; we handle errors per-phase
source ~/.nvm/nvm.sh
export PATH="$HOME/.bun/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# ─── Required pinned values (passed via env from TS wrapper) ───
: "${GBRAIN_PINNED_COMMIT:?GBRAIN_PINNED_COMMIT required}"
: "${GBRAIN_PINNED_VERSION:?GBRAIN_PINNED_VERSION required}"

TS=$(date -u +%Y%m%dT%H%M%SZ)
echo "INSTALL_START ts=$TS commit=$GBRAIN_PINNED_COMMIT version=$GBRAIN_PINNED_VERSION"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE A: pre-flight (backup + idempotency)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_A_START"

# A1: workspace backup per Rule 22
BACKUP_DIR=$HOME/.openclaw/session-backups
mkdir -p "$BACKUP_DIR"
TARBALL="$BACKUP_DIR/$TS-pre-gbrain.tar.gz"
tar -czf "$TARBALL" -C "$HOME" \
    .openclaw/workspace \
    .openclaw/agents/main/sessions/sessions.json \
    > /dev/null 2>&1
[ ! -f "$TARBALL" ] && { echo "FATAL_NO_BACKUP"; exit 1; }
tar -tzf "$TARBALL" > /dev/null 2>&1 || { echo "FATAL_BACKUP_CORRUPT"; exit 1; }

# A2: openclaw.json backup
cp "$HOME/.openclaw/openclaw.json" "/tmp/openclaw.json.bak.$TS"

# A3: prereqs
which openclaw > /dev/null 2>&1 || { echo "FATAL_NO_OPENCLAW"; exit 2; }
OPENAI_KEY=$(grep "^OPENAI_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
KEY_LEN=$(printf "%s" "$OPENAI_KEY" | wc -c)
[ "$KEY_LEN" -lt 20 ] && { echo "FATAL_NO_OPENAI_KEY"; exit 2; }

# A4: idempotency — already correctly installed?
EXISTING_VERSION=$(gbrain --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
EXISTING_MCP=$(openclaw mcp show gbrain 2>&1 | grep -c '/home/openclaw/.bun/bin/gbrain')
if [ "$EXISTING_VERSION" = "$GBRAIN_PINNED_VERSION" ] && [ "$EXISTING_MCP" = "1" ]; then
  echo "ALREADY_INSTALLED version=$EXISTING_VERSION mcp=registered"
  exit 0
fi

echo "PHASE_A_OK backup=$TARBALL config_backup=/tmp/openclaw.json.bak.$TS"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE B: install Bun (with unzip prereq)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_B_START"
if ! command -v bun > /dev/null 2>&1; then
  if ! command -v unzip > /dev/null 2>&1; then
    sudo apt-get install -y -qq unzip 2>&1 | tail -3
    command -v unzip > /dev/null 2>&1 || { echo "FATAL_NO_UNZIP_NO_SUDO"; exit 3; }
  fi
  curl -fsSL https://bun.sh/install | bash 2>&1 | tail -5
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun > /dev/null 2>&1 || { echo "FATAL_BUN_INSTALL_FAILED"; exit 3; }
fi
BUN_VERSION=$(bun --version)
echo "PHASE_B_OK bun=$BUN_VERSION"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE C: clone + checkout pinned commit
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_C_START"
if [ -d "$HOME/gbrain/.git" ]; then
  cd "$HOME/gbrain" || { echo "FATAL_GBRAIN_DIR_EXISTS_BUT_INACCESSIBLE"; exit 4; }
  git fetch origin 2>&1 | tail -3
else
  git clone https://github.com/garrytan/gbrain.git "$HOME/gbrain" 2>&1 | tail -3
  [ ! -d "$HOME/gbrain/.git" ] && { echo "FATAL_CLONE_FAILED"; exit 4; }
  cd "$HOME/gbrain"
fi
git checkout "$GBRAIN_PINNED_COMMIT" 2>&1 | tail -3
VERIFY_HEAD=$(git rev-parse --short HEAD)
[ "$VERIFY_HEAD" != "$GBRAIN_PINNED_COMMIT" ] && {
  echo "FATAL_CHECKOUT_DRIFT verify=$VERIFY_HEAD expected=$GBRAIN_PINNED_COMMIT"
  rm -rf "$HOME/gbrain"
  exit 5
}
echo "PHASE_C_OK head=$VERIFY_HEAD"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE D: bun install + bun link
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_D_START"
cd "$HOME/gbrain"
timeout 300 bun install 2>&1 | tail -5
BUN_INSTALL_RC=$?
[ "$BUN_INSTALL_RC" -ne 0 ] && {
  echo "FATAL_BUN_INSTALL_FAILED rc=$BUN_INSTALL_RC"
  rm -rf "$HOME/gbrain"
  exit 6
}
bun link 2>&1 | tail -3
command -v gbrain > /dev/null 2>&1 || {
  echo "FATAL_BUN_LINK_FAILED"
  rm -rf "$HOME/gbrain"
  exit 7
}
GBRAIN_INSTALLED_VERSION=$(gbrain --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
[ "$GBRAIN_INSTALLED_VERSION" != "$GBRAIN_PINNED_VERSION" ] && {
  echo "FATAL_VERSION_MISMATCH installed=$GBRAIN_INSTALLED_VERSION expected=$GBRAIN_PINNED_VERSION"
  rm -rf "$HOME/gbrain"
  exit 8
}
echo "PHASE_D_OK gbrain=$GBRAIN_INSTALLED_VERSION"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE E: initialize PGLite
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_E_START"
if [ ! -d "$HOME/.gbrain/brain.pglite" ]; then
  gbrain init --pglite 2>&1 | tail -10
  [ ! -d "$HOME/.gbrain/brain.pglite" ] && {
    echo "FATAL_PGLITE_INIT_FAILED"
    rm -rf "$HOME/.gbrain"
    exit 9
  }
fi
DOCTOR_HEALTH=$(gbrain doctor --json --fast 2>&1 | python3 -c "
import json, sys
try: print(json.load(sys.stdin).get('health_score', 0))
except: print(0)
")
echo "PHASE_E_OK health=$DOCTOR_HEALTH"
# Note: health < 90 is a WARN not a FATAL — Phase 0 baseline was 90 with 30+
# unrelated skill warnings. We accept anything >= 80.
[ "$DOCTOR_HEALTH" -lt 80 ] && echo "WARN_DOCTOR_BELOW_80 health=$DOCTOR_HEALTH"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE F: gbrain serve standalone probe
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_F_START"
SERVE_PROBE=$(timeout 5 gbrain serve < /dev/null 2>&1)
echo "$SERVE_PROBE" | grep -q "Starting GBrain MCP server" || {
  echo "FATAL_SERVE_PROBE_FAILED"
  echo "probe_output: $(echo "$SERVE_PROBE" | head -c 200)"
  exit 10
}
echo "PHASE_F_OK"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE G: wire MCP via openclaw mcp set (hot reload — no restart)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_G_START"
GBRAIN_JSON_FILE="/tmp/gbrain-mcp-$TS.json"
OPENAI_KEY="$OPENAI_KEY" python3 > "$GBRAIN_JSON_FILE" <<'PYEOF'
import json, os
print(json.dumps({
    "command": "/home/openclaw/.bun/bin/gbrain",
    "args": ["serve"],
    "env": {
        "OPENAI_API_KEY": os.environ["OPENAI_KEY"],
        "GBRAIN_DATABASE_URL": "pglite:///home/openclaw/.gbrain/brain.pglite",
        "GBRAIN_EMBEDDING_MODEL": "openai:text-embedding-3-large",
        "GBRAIN_EMBEDDING_DIMENSIONS": "1024",
    },
}))
PYEOF

openclaw mcp set gbrain "$(cat "$GBRAIN_JSON_FILE")" 2>&1 | tail -3
SET_RC=$?
[ "$SET_RC" -ne 0 ] && {
  echo "FATAL_MCP_SET_FAILED rc=$SET_RC"
  exit 11
}

# Hot reload takes <1s; give it 2s for slow VMs
sleep 2

# Verify-after-set per Rule 10
SHOW=$(openclaw mcp show gbrain 2>&1)
if ! echo "$SHOW" | grep -q "/home/openclaw/.bun/bin/gbrain"; then
  echo "FATAL_VERIFY_AFTER_SET_FAILED"
  echo "show_output: $(echo "$SHOW" | head -c 200)"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 12
fi

# Verify gateway still healthy (hot reload should not have broken it)
HEALTH=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:18789/health)
[ "$HEALTH" != "200" ] && {
  echo "FATAL_GATEWAY_UNHEALTHY_POST_HOT_RELOAD health=$HEALTH"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 13
}

echo "PHASE_G_OK health=$HEALTH"

# ═════════════════════════════════════════════════════════════════════════════
# DONE
# ═════════════════════════════════════════════════════════════════════════════
echo "INSTALL_COMPLETE"
echo "  bun:      $(bun --version)"
echo "  gbrain:   $(gbrain --version | head -1)"
echo "  pglite:   $HOME/.gbrain/brain.pglite"
echo "  mcp:      registered"
echo "  health:   $HEALTH"
echo "  backup:   $TARBALL"
echo "  cfg_bak:  /tmp/openclaw.json.bak.$TS"
exit 0
```

### 3.3 Exit code reference

| Exit | Phase | Meaning | Recovery |
|---|---|---|---|
| 0 | — | Success OR already-installed (idempotent) | None needed |
| 1 | A | Backup creation failed | Investigate disk space / permissions |
| 2 | A | Missing prereq (no openclaw, no OPENAI_API_KEY) | Fix VM provisioning before retry |
| 3 | B | Bun install failed (unzip missing + no sudo, or curl failed) | Manual install of bun + retry |
| 4 | C | gbrain repo clone failed | Network issue; retry |
| 5 | C | Pinned commit checkout drifted | Investigate gbrain repo; verify GBRAIN_PINNED_COMMIT exists |
| 6 | D | bun install in gbrain dir failed | Disk space / network; rollback already happened |
| 7 | D | bun link failed | bun installation may be broken; rollback already happened |
| 8 | D | gbrain version mismatch post-install | Pin/repo mismatch; rollback already happened |
| 9 | E | PGLite init failed | gbrain bug or filesystem issue; rollback already happened |
| 10 | F | gbrain serve standalone probe failed | gbrain runtime issue; investigate before retry |
| 11 | G | openclaw mcp set CLI failed | OpenClaw issue; investigate; nothing to roll back |
| 12 | G | Verify-after-set failed (entry not present) | Schema reject likely; auto-rolled-back |
| 13 | G | Gateway unhealthy post hot-reload | Auto-rolled-back; investigate why hot-reload broke things |

---

## 4. TS wrapper: `_install-gbrain-on-vm.ts`

```ts
// scripts/_install-gbrain-on-vm.ts
//
// Usage: npx tsx scripts/_install-gbrain-on-vm.ts <vm-name>
//
// Runs install-gbrain.sh on the target VM via SSH. Returns structured
// {success, exitCode, lastPhase, summary, fullLog} so the caller (or
// future stepGbrain) can decide what to do.

import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

// ── Pinned versions ──
// Source of truth. Update here when bumping gbrain.
const GBRAIN_PINNED_COMMIT = "2ea5b71";   // v0.28.1
const GBRAIN_PINNED_VERSION = "0.28.1";

// ── Embedded install script (kept inline so we don't depend on filesystem state) ──
const INSTALL_SCRIPT = `<contents of scripts/install-gbrain.sh>`;

// ... env loading per existing scripts ...

async function installGbrainOnVm(vmName: string): Promise<{
  success: boolean;
  exitCode: number;
  lastPhase: string;
  summary: string;
  fullLog: string;
  alreadyInstalled: boolean;
}> {
  // 1. DB lookup: get IP, verify status=assigned + healthy + cv >= 88
  const { data: vm } = await sb.from("instaclaw_vms")
    .select("ip_address,health_status,health_fail_count,config_version,tier,assigned_to")
    .eq("name", vmName).single();
  if (!vm) throw new Error(`VM ${vmName} not found`);
  if ((vm as any).health_status !== "healthy") throw new Error(`VM ${vmName} not healthy`);
  if ((vm as any).config_version < 88) throw new Error(`VM ${vmName} cv<88; reconcile first`);

  // 2. SSH-upload script + execute with env vars + timeout 600s
  const ssh = new Client();
  // ... standard ssh2 setup with /Users/cooperwrenn/.../.env.ssh-key key ...
  
  // upload script via SFTP to /tmp/install-gbrain.$TS.sh
  // exec: GBRAIN_PINNED_COMMIT=... GBRAIN_PINNED_VERSION=... bash /tmp/install-gbrain.$TS.sh
  // capture stdout + exit code

  // 3. Parse output for PHASE_A_OK / PHASE_B_OK / .../INSTALL_COMPLETE
  // Last "PHASE_X_OK" or "INSTALL_COMPLETE" or "ALREADY_INSTALLED" or "FATAL_*" tells us where we stopped

  // 4. Return structured result
}

// CLI entry point
const vmName = process.argv[2];
if (!vmName) { console.error("usage: ... <vm-name>"); process.exit(1); }
const result = await installGbrainOnVm(vmName);
console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
```

Companion scripts (Phase 1):
- `_uninstall-gbrain-on-vm.ts` — runs `openclaw mcp unset gbrain`, optionally `rm -rf ~/gbrain ~/.gbrain` for full cleanup
- `_verify-gbrain-on-vm.ts` — read-only state inspection (SSH + report); the audit script we already have on vm-050 is the model

---

## 5. Verification gates (Rule 10)

Per the Rule 10 discipline ("verify every config set; never `|| true`-suppress"), the install script has a verify-after-write at every state-changing phase:

| Phase | Action | Verify | If verify fails |
|---|---|---|---|
| C | git checkout pinned commit | `git rev-parse --short HEAD == GBRAIN_PINNED_COMMIT` | rm -rf ~/gbrain, exit 5 |
| D | bun install + link | `gbrain --version` matches `GBRAIN_PINNED_VERSION` exactly | rm -rf ~/gbrain, exit 8 |
| E | gbrain init --pglite | directory `~/.gbrain/brain.pglite` exists | rm -rf ~/.gbrain, exit 9 |
| G | openclaw mcp set | `openclaw mcp show gbrain` returns expected JSON | openclaw mcp unset, exit 12 |
| G | post-hot-reload | `/health` returns 200 | openclaw mcp unset, exit 13 |

**Post-install verification (separate from the install itself):**

```bash
# Run AFTER the install script returns success.
# Purpose: confirm the agent actually has gbrain__ tools in its toolset
# (i.e., the Pi runtime received them via ACP).

# Send a chat completion via /v1/chat/completions:
PAYLOAD='{"model":"openclaw","max_tokens":500,"messages":[{"role":"user","content":"Admin diagnostic: list every tool in your toolset starting with the prefix gbrain (concatenated). Comma separated. If none exist, say NONE."}]}'

curl -s -m 280 -X POST -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  http://localhost:18789/v1/chat/completions

# Expected response: 43 gbrain__* tool names (cooper-favorite-color session
# from Phase 0 had this exact list — see PRD-gbrain-integration §6.7)
```

This post-install verification is run by `_verify-gbrain-on-vm.ts` after each Phase 1 install. Failure here means the install script reported success but the Pi runtime didn't pick up the MCP entry — investigate before declaring the VM Phase-1-complete.

---

## 6. Soak/audit discipline (Rule 17)

Between each Phase 1 install:

**Pre-install audit** (5 min before install starts):
- DB row: health=healthy, fail_count=0, cv >= 88
- SSH reachable (`nc -zv $ip 22`)
- Gateway active + /health 200
- No active long-running tool calls (`pgrep` for chrome/etc + not spinning)

**Install** (~3-5 min via the script above):
- TS wrapper captures full log
- All exit codes ≠ 0 → halt, manual investigation

**Post-install audit** (immediately after):
- Re-run the 6-point Phase 0 verification (TasksMax, gcc, prctl-subreaper, .node binary, drop-in, addon mapped) — confirm install didn't regress any of those
- Run gbrain stats — confirm 0 pages (clean PGLite)
- Run post-install verification (above) — confirm 43 gbrain__ tools
- Tail journalctl --user -u openclaw-gateway for 60s — confirm no crash signals

**48h soak** (between VMs):
- Daily: re-run `_verify-gbrain-on-vm.ts`
- Daily: query `gbrain stats` to confirm no organic growth (since SOUL.md hasn't told the agent to use gbrain, page count should stay 0; if it grows organically, log + investigate which tool call introduced it)
- Daily: check `instaclaw_watchdog_audit` for any actions on the VM
- Daily: check `health_fail_count` — must stay 0
- Daily: confirm `openclaw mcp show gbrain` returns expected (no reconciler clobber)

**Phase 1 decision gate** (Day +5):
- All 3 VMs passed daily audits
- No incidents tied to gbrain in `instaclaw_watchdog_audit`
- Cooper's subjective read: nothing feels off
- Decision: proceed to Phase 2 (10 dogfood VMs) OR halt + post-mortem

---

## 7. stepGbrain reconciler step — Phase 3 spec (NOT for Phase 1 implementation)

Phase 3 (Day 12-13 per PRD) integrates gbrain into the reconciler via a new step. This section specs that step in advance so we don't drift.

### 7.1 Position in the reconcile order

Insert in `lib/vm-reconcile.ts` AFTER `stepPrctlSubreaper` (Step 8c2) and BEFORE `stepSSHDProtection` (Step 8d). New step number: 8c3.

Rationale:
- AFTER stepNpmPinDrift (Step 3c) — needs openclaw at pinned version
- AFTER stepSystemPackages (Step 5) — needs build-essential for any future native compile
- AFTER stepPrctlSubreaper (Step 8c2) — sibling pattern (npm + native + drop-in)
- BEFORE stepGatewayRestart — but stepGbrain explicitly does NOT trigger restart (hot reload)

### 7.2 Function signature

```ts
async function stepGbrain(
  ssh: SSHConnection,
  vm: VMRecord & { gateway_token?: string },
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void>
```

### 7.3 Behavior

```
Read current state (single SSH probe, JSON output):
  - bun --version → BUN_VERSION (or empty)
  - gbrain --version → GBRAIN_VERSION (or empty)
  - openclaw mcp show gbrain --json → MCP_ENTRY (or empty)
  - test -d ~/.gbrain/brain.pglite → PGLITE_PRESENT
  - sha256 of installed gbrain entry's expected fields

Decision matrix:
  IF all 4 present AND versions match AND mcp entry matches expected
    → result.alreadyCorrect.push("gbrain"); return
  
  IF bun missing → result.errors.push (don't try install via reconciler;
    bun install is heavy, dispatch to per-VM script via separate cron)
  
  IF gbrain missing or version drift → result.errors.push (same reasoning)
  
  IF PGLite missing → result.errors.push
  
  IF mcp entry missing or drifted (command, args, env keys) →
    if dryRun: result.fixed.push("[dry-run] gbrain mcp set"); return
    openclaw mcp set gbrain '<JSON>' (env value pulled from VM .env, NOT TS-side)
    sleep 2
    re-read openclaw mcp show gbrain — MUST match expected
    if mismatch: openclaw mcp unset gbrain; result.errors.push; return
    result.fixed.push("gbrain mcp registered")
```

**Note**: stepGbrain does NOT install bun/gbrain/PGLite. Those are HEAVY operations (60-90s each) that don't fit in the reconciler's per-VM time budget. Instead, stepGbrain only handles the lightweight MCP wire-up + verification. Heavy installs go through a dedicated cron (`/api/cron/gbrain-install`) that dispatches `_install-gbrain-on-vm.ts` per VM, sequentially, off the reconciler's hot path.

This separation is critical:
- Reconciler runs every 3 min, batch=3, 300s budget. gbrain install would blow this.
- gbrain install cron runs every 30 min, picks 1 VM at a time, 600s budget per VM.
- After install, reconciler's stepGbrain just verifies the MCP entry stays correct.

### 7.4 requiredSentinels (Rule 23)

If we add a templated install script entry to `lib/vm-manifest.ts:files[]` for gbrain (e.g., the install-gbrain.sh template above), it MUST have:

```ts
requiredSentinels: [
  "GBRAIN_PINNED_COMMIT",     // pinned version variable present
  "PHASE_G_START",            // mcp set phase exists
  "openclaw mcp unset gbrain", // rollback path exists
  "verify-after-set",          // Rule 10 compliance comment
]
```

Per Rule 23 (sentinel-grep before write), a stale reconciler can't ship a pre-Phase-1 install script.

### 7.5 Manifest changes for Phase 3

```ts
// lib/vm-manifest.ts — add to VM_MANIFEST.files[]
{
  remotePath: "~/scripts/install-gbrain.sh",
  source: "template",
  templateKey: "INSTALL_GBRAIN_SH",
  mode: "overwrite",
  executable: true,
  useSFTP: true,
  requiredSentinels: ["GBRAIN_PINNED_COMMIT", "PHASE_G_START", "openclaw mcp unset gbrain"],
},

// lib/vm-manifest.ts — add to VM_MANIFEST.crons[]
{
  schedule: "*/30 * * * *",
  command: "/usr/bin/curl -s -X POST https://instaclaw.io/api/cron/gbrain-install -H 'Authorization: Bearer ${GATEWAY_TOKEN}'",
  marker: "gbrain-install-cron",
},

// VM_MANIFEST.version — bump to N+1 (whatever current is at Phase 3 time)
```

NOT in Phase 1. This is Phase 3 reference only.

---

## 8. SOUL.md update plan (Phase 5 dependency)

### 8.1 Why SOUL.md doesn't change in Phase 1

PRD §5.7 puts SOUL.md slim in Phase 5 (Day 18-20), AFTER fleet rollout (Phase 4). Reasons:
1. **Cache invalidation cost** — every SOUL.md edit invalidates the Anthropic prompt cache for that agent. Per the v62-v88 changelog, we use `<!-- OPENCLAW_CACHE_BOUNDARY -->` to keep the stable prefix cached, but ANY change costs a re-prefill. Don't pay this cost 4 times (Phase 1, 2, 3, 4); pay it once after fleet has gbrain.
2. **Tool-not-found errors** — if SOUL.md tells the agent to use `gbrain__query` and gbrain isn't installed on that VM, the tool call returns "tool not found" and the agent gets confused. Better to ship the tools first (Phases 1-4), then tell the agent to use them (Phase 5).

### 8.2 What changes in Phase 5

Per PRD §5.7, SOUL.md gets:
1. A new `## Knowledge Graph` section (~300 chars) instructing the agent to call `gbrain__query` first for any "do you remember", "what's their", "tell me about" question.
2. Removal of redundant memory-system docs that gbrain replaces (~5K chars net reduction per PRD's 32K → 7K floor target, though actual savings depend on how much of MEMORY.md guidance is replaced by gbrain's documented capabilities).
3. Tool name correction: anywhere SOUL.md references `gbrain.query` (incorrect, dot syntax), change to `gbrain__query` (double underscore — per PRD §6.7 finding #8). Same for all other gbrain tool names.

### 8.3 Phase 5 ordering (NOT in Phase 1)

1. **Pre-condition check**: 100% of fleet has gbrain installed (per Phase 4 audit)
2. **vm-manifest.ts SOUL.md template update**: add knowledge-graph instruction, fix tool naming
3. **Reconciler cycle pushes** new SOUL.md to fleet
4. **Per-VM verification**: spot-check 10 VMs, confirm SOUL.md has new section
5. **Real-traffic monitoring**: watch for tool-not-found errors in journalctl, watchdog audit, user complaints
6. **Decision**: Phase 6 (skill migration to gbrain) OR park

### 8.4 What Cooper does in Phase 1 to test gbrain

Since SOUL.md isn't updated in Phase 1, the agent won't naturally use gbrain. Cooper can test by directly asking:
- "use gbrain__put_page with slug X and body Y" — exercises put
- "use gbrain__query with question Z" — exercises read
- "what tools do you have starting with gbrain__" — exercises tool discovery (this is post-install verification §5)

These direct prompts confirm the integration works. Real-traffic exercise comes in Phase 5.

---

## 9. Open risks + decision gates

### 9.1 Risks specific to Phase 1

| # | Risk | Mitigation | Trigger to halt Phase 1 |
|---|---|---|---|
| R1 | Hot reload breaks gateway on a non-vm-050 VM (different config shape) | Phase G has Rule 5 verify; auto-rolls-back. If it triggers, halt. | Any VM #2 or #3 fails Phase G |
| R2 | bun install fails on a VM (disk full, stale apt) | Per-VM exit code; manual investigation; install on alternate VM | Same VM fails 2 install attempts |
| R3 | gbrain version drift between Phase 0 (vm-050) and Phase 1 candidates (commit hash mismatch) | Pin both commit AND version; fail-closed | Either pin doesn't match canary |
| R4 | Reconciler runs on a Phase 1 VM and clobbers `mcp.servers.gbrain` | Empirically verified safe (per §4 of this audit). Re-verify on each Phase 1 VM after first reconcile cycle | mcp.servers.gbrain disappears after a reconcile |
| R5 | gbrain serve subprocess accumulates as zombie (the very bug 0.28.1 was supposed to fix) | prctl-subreaper@0.1.1 is the safety net. Daily zombie audit per §6 | Any zombie count > 0 |
| R6 | gbrain query latency > 1s p95 (R6 from PRD §8) | Smoke test #2 measures it. If > 1s on any tool call, halt | Any single tool call > 1s in smoke test #2 |
| R7 | Embedding cost ($) higher than projected | Phase 1 has 0 embeddings (no real traffic uses gbrain) so this is a Phase 5 concern | N/A in Phase 1 |
| R8 | Snapshot-vs-reconciler drift after gbrain ships fleet-wide | Phase 4 bakes a new snapshot after Phase 3 reconciler step ships | N/A in Phase 1 |

### 9.2 Cooper-gate decisions

Phase 1 needs Cooper sign-off at three points:

1. **Before Phase 1 candidates are picked**: review `_select-phase1-candidates.ts` output, pick 1 pro + 1 power VM. (Today)
2. **After VM #2 install + 48h soak**: continue to VM #3 OR halt+investigate.
3. **After VM #3 install + 48h soak + 1 day hold**: declare Phase 1 complete + proceed to Phase 2 dogfood OR halt+investigate.

Each gate gets a short audit summary (mirror of the 9-point soak audit we just did on vm-050).

---

## 10. Files this design produces (when implementation starts)

| File | Type | Purpose |
|---|---|---|
| `instaclaw/scripts/install-gbrain.sh` | bash | The install template (§3.2 above) |
| `instaclaw/scripts/_install-gbrain-on-vm.ts` | tsx | TS wrapper that SSHs the bash to a VM |
| `instaclaw/scripts/_uninstall-gbrain-on-vm.ts` | tsx | Mirror — `openclaw mcp unset gbrain` + cleanup |
| `instaclaw/scripts/_verify-gbrain-on-vm.ts` | tsx | Read-only audit; runs daily during soak |
| `instaclaw/scripts/_select-phase1-candidates.ts` | tsx | DB query → 5 candidates per tier for Cooper to pick from |
| `instaclaw/docs/prd/PRD-gbrain-phase1-design.md` | doc | This file |

NO changes to `lib/ssh.ts`, `lib/vm-manifest.ts`, `lib/vm-reconcile.ts`, or any reconciler code in Phase 1. All Phase 1 work is in `scripts/` only. Reconciler changes are Phase 3.

---

## 11. Out of scope for this doc

- Phase 2 dogfood plan (10 InstaClaw-team VMs) — covered by PRD §5.4
- Phase 3 reconciler integration — speced in §7 of this doc; full implementation in a Phase 3 design doc
- Phase 4 fleet rollout — covered by OpenClaw Upgrade Playbook
- Phase 5 SOUL.md slim — speced in §8 of this doc; full implementation in a Phase 5 design doc
- Observability dashboard for `gbrain stats` (Supabase table `instaclaw_gbrain_stats` per PRD §5.4) — Phase 2 work
- Cost monitoring — Phase 5 work
- Migration import (gbrain ingests existing MEMORY.md content) — Phase 5 work

---

## 12. What I need from Cooper before starting

Three explicit decisions:

1. **Approve this doc** as the Phase 1 plan, OR push back on specific sections
2. **Approve VM #2 + #3 selection** after I run `_select-phase1-candidates.ts` and present 5 candidates per tier
3. **Approve cadence**: do Phase 1 sequentially (VM #2 today, VM #3 in 48h, total 5 days) OR compress (acknowledge canary-discipline tradeoff)

If sections 1+2+3 are approved, I'll write the implementation files (scripts/) in a single PR for review, then execute VM #2 install with full audit on Cooper's go-ahead.
