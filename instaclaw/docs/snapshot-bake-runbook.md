# Snapshot Bake Runbook — fresh-nanode path (canonical)

> **Audience**: operator (Cooper). Read this end-to-end before starting.
>
> **Why this exists**: the 2026-05-12 vm-050 audit established that baking
> from a long-running production VM is structurally unsafe (per-customer
> contamination at scale, partner state leakage, disk-bloat above the
> 6144 MB Linode image cap). The correct path is always: provision a
> **fresh g6-nanode-1 from the current base snapshot**, reconcile it to
> the latest manifest, install anything the reconciler doesn't manage
> (gbrain), wipe per-VM state, validate, then image.
>
> **This runbook is reusable.** Same flow for every future bake. Drop the
> version number in §0 and follow the steps.

## §0 — Bake parameters (fill in before starting)

| Field | Value |
|---|---|
| Target manifest version | **v95** (from `lib/vm-manifest.ts:1127`) |
| Source snapshot (rollback target) | **`private/38575292`** (v79, baked 2026-05-03) |
| New image label | `instaclaw-base-v95-<short-desc>` |
| Region | `us-east` |
| Bake VM type | **g6-nanode-1** (NOT dedicated-2 — see §−1) |
| Test VM type (verification) | `g6-nanode-1` (cheap) |
| Reconcile manifest version source | `main` branch of this repo |
| Catch-up script branch | `feat/gbrain-stepGbrain-phase4c` (not on main yet) |
| Bake VM tag | `instaclaw,snapshot-bake,v95-bake-<date>` |

## §−1 — Why not vm-050 (or any production VM)

The audit found vm-050 unsuitable because:
- 24 GB used disk (4× the 6144 MB Linode image cap)
- Customer-specific identity baked in (Timmy persona, MEMORY.md with conversation history, gbrain PGLite with 40 MB of memories)
- Partner-specific state (`edge-esmeralda` skill clone, `edge-city-privacy-bypass` SSH key, `EDGEOS_BEARER_TOKEN`)
- 1.9 GB of session-backups
- 5 backup copies of `openclaw.json` containing live tokens
- Cooper's bean-mining experimentation scripts in `$HOME`
- 25+ partner cron entries (6 duplicate `edge-esmeralda` git-pulls)
- Anthropic + OpenAI API keys baked into `openclaw.json` MCP env block

This category of contamination is fundamentally unfixable on a live VM. The cleanup script in §4 handles all of it for a **fresh** bake VM where there's no live customer to disrupt.

## §0.5 — Pre-flight (do this FIRST, before provisioning anything)

```bash
# Confirm you can talk to Linode + Supabase
cd /Users/cooperwrenn/wild-west-bots/instaclaw
node scripts/_audit-vm050-snapshot-prep.mjs >/dev/null 2>&1 && echo "supabase OK"
curl -sS -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/account 2>&1 | head -1

# Confirm the catch-up script is reachable (on feature branch, not main yet)
git ls-tree feat/gbrain-stepGbrain-phase4c -- instaclaw/scripts/_catch-up-stuck-cohort.ts
# If empty, cherry-pick the script into the bake working branch:
#   git checkout -b bake-v95 main
#   git checkout feat/gbrain-stepGbrain-phase4c -- instaclaw/scripts/_catch-up-stuck-cohort.ts

# Confirm SSH key works
node -e 'const k=Buffer.from(process.env.SSH_PRIVATE_KEY_B64,"base64").toString();require("fs").writeFileSync("/tmp/k",k);require("fs").chmodSync("/tmp/k",0o600);console.log("OK")' \
  --require <(echo "require('dotenv').config({path:'.env.ssh-key'})")

# Confirm gbrain install script exists
ls scripts/_install-gbrain-on-vm.ts scripts/install-gbrain.sh

# Confirm prebake-cleanup + validation scripts exist
ls scripts/_prebake-cleanup.sh scripts/_postbake-validation.ts
```

Read the OpenClaw changelog from `OPENCLAW_PINNED_VERSION` in `lib/ssh.ts` (currently `2026.4.26`). If you're bumping past that for this bake, the §0 row above must change first AND the OpenClaw Upgrade Playbook in `CLAUDE.md` must be followed BEFORE this runbook. Don't bump both at the same time.

## §1 — Provision the bake VM

> **Goal**: fresh `g6-nanode-1` (25 GB disk) booted from the current v79 base.

### 1.1 — Create the Linode

```bash
# Sourced from .env.local
ROOT_PASS=$(openssl rand -base64 32)
SSH_PUB=$(cat ~/.ssh/instaclaw-deploy.pub 2>/dev/null || echo "FETCH_FROM_LINODE_KEY_ID_626767")

curl -sS -X POST https://api.linode.com/v4/linode/instances \
  -H "Authorization: Bearer $LINODE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "label": "snapshot-bake-v95-$(date -u +%Y%m%d)",
  "region": "us-east",
  "type": "g6-nanode-1",
  "image": "${LINODE_SNAPSHOT_ID:-private/38575292}",
  "root_pass": "${ROOT_PASS}",
  "authorized_users": ["instaclaw-deploy"],
  "booted": true,
  "tags": ["instaclaw", "snapshot-bake", "v95-bake"]
}
JSON
)" | tee /tmp/bake-vm.json
```

Capture:
- `id` → `BAKE_VM_ID` (env var for the rest of the runbook)
- `ipv4[0]` → `BAKE_IP`

### 1.2 — Wait for boot + SSH-ready

```bash
# Poll until status=running (typically 60-90s)
for i in $(seq 1 30); do
  s=$(curl -sS -H "Authorization: Bearer $LINODE_API_TOKEN" \
    https://api.linode.com/v4/linode/instances/$BAKE_VM_ID | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  echo "$i: $s"
  [ "$s" = "running" ] && break
  sleep 5
done

# Wait for SSH (cloud-init regen of host keys can take ~60s after status=running)
for i in $(seq 1 12); do
  ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes \
    openclaw@$BAKE_IP 'echo SSH_OK; hostname; uptime' 2>&1 | head -3
  [ $? -eq 0 ] && break
  sleep 10
done
```

**Gate**: SSH must succeed AND `openclaw --version` must return `2026.4.26` (the v79 baseline). If either fails, the v79 snapshot itself is broken — abort and investigate.

```bash
ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$BAKE_IP \
  'source ~/.nvm/nvm.sh; openclaw --version'
# Expected: OpenClaw 2026.4.26 (be8c246)
```

### 1.3 — Record the bake VM's pre-reconcile SSH host key fingerprint

We'll compare it to the test VM's fingerprint in §7 to prove cloud-init regenerated keys. **Important for the snapshot-correctness check.**

```bash
ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$BAKE_IP \
  'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' | tee /tmp/bake-fp.txt
# Save the SHA256:... part — needed for §7 validation
```

## §2 — Reconcile v79 → v95

> **Goal**: push the bake VM from v79 baseline to v95 manifest using the same
> code path the production cron uses, so the image inherits battle-tested
> state.

### 2.1 — Acquire the reconcile-fleet cron lock

The production cron must not race with our local reconcile.

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw
npx tsx -e '
import { tryAcquireCronLock } from "./lib/cron-lock";
import { readFileSync } from "fs";
for (const f of [".env.local",".env.ssh-key"]) for (const l of readFileSync(f,"utf-8").split("\n")) {const m=l.match(/^([^#=]+)=(.*)$/);if(m&&!process.env[m[1].trim()])process.env[m[1].trim()]=m[2].trim().replace(/^["\047]|["\047]$/g,"")}
const ok = await tryAcquireCronLock("reconcile-fleet", 4*3600, "bake-v95");
console.log("lock:", ok ? "acquired (4h TTL)" : "BUSY — abort");
process.exit(ok ? 0 : 1);
'
```

If the lock is busy, the production cron is running — wait for it to finish (Vercel cron tick is ≤300s) and retry.

### 2.2 — Run the reconciler against the bake VM

Two approaches; pick one:

**Option A — catch-up script (preferred, mirrors fleet path)**

The catch-up script reads VMs from the DB. Pre-register the bake VM as a synthetic row so we can target it by name:

```bash
npx tsx -e '
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
for (const f of [".env.local"]) for (const l of readFileSync(f,"utf-8").split("\n")) {const m=l.match(/^([^#=]+)=(.*)$/);if(m&&!process.env[m[1].trim()])process.env[m[1].trim()]=m[2].trim().replace(/^["\047]|["\047]$/g,"")}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
await sb.from("instaclaw_vms").insert({
  name: "instaclaw-bake-v95",
  ip_address: process.env.BAKE_IP,
  ssh_port: 22, ssh_user: "openclaw",
  health_status: "healthy",      // catch-up filter requires healthy
  status: "pool",                // exclude from customer assignment
  provider: "linode",
  provider_server_id: process.env.BAKE_VM_ID,
  config_version: 79,            // start from v79 baseline
  region: "us-ord",
  server_type: "g6-nanode-1",
  api_mode: "all_inclusive",
});
console.log("bake VM registered in DB");
'

# Run catch-up targeting just this VM
npx tsx scripts/_catch-up-stuck-cohort.ts --vms=instaclaw-bake-v95 --yes
```

**Option B — direct auditVMConfig (matches v79 bake recipe)**

```bash
npx tsx -e '
import { auditVMConfig, VM_MANIFEST } from "./lib/ssh";
import { readFileSync } from "fs";
for (const f of [".env.local",".env.ssh-key"]) for (const l of readFileSync(f,"utf-8").split("\n")) {const m=l.match(/^([^#=]+)=(.*)$/);if(m&&!process.env[m[1].trim()])process.env[m[1].trim()]=m[2].trim().replace(/^["\047]|["\047]$/g,"")}
const vm = { id: "bake-v95", ip_address: process.env.BAKE_IP, ssh_port: 22, ssh_user: "openclaw" } as any;
const r = await auditVMConfig(vm, { strict: true, skipGatewayRestart: false });
console.log(JSON.stringify({fixed:r.fixed?.length||0, errors:r.errors||[], alreadyCorrect:r.alreadyCorrect?.length||0}, null, 2));
'
```

Option A is preferred because it uses the same `reconcileVM` path the production cron uses, so the bake inherits every battle-tested code path. Option B is the fallback if Option A is unavailable (script not yet on main).

### 2.3 — Verify v95 state

```bash
ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$BAKE_IP <<'EOF'
source ~/.nvm/nvm.sh

# Manifest version markers
echo "openclaw: $(openclaw --version)"
echo "node: $(node --version)"
echo "TasksMax: $(systemctl --user show openclaw-gateway -p TasksMax)"
echo "build-essential: $(which gcc)"
echo "prctl drop-in: $(ls ~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf)"

# v95 ack-ux 9 keys
for k in messages.ackReactionScope messages.ackReaction \
  channels.telegram.streaming.mode channels.telegram.streaming.preview.toolProgress; do
  echo "$k = $(openclaw config get $k)"
done

# bootstrapMaxChars
echo "bootstrapMaxChars: $(openclaw config get agents.defaults.bootstrapMaxChars)"

# Workspace
ls -la ~/.openclaw/workspace/ | head -20

# Skills (should NOT have edge-esmeralda yet — partner-gated)
ls ~/.openclaw/skills/
EOF
```

**Gate**: `openclaw 2026.4.26`, `node v22.22.2`, `TasksMax=120`, `gcc` present, 9 ack-ux keys correct, `bootstrapMaxChars=40000`, no `edge-esmeralda` skill. If any fail → see §rollback.

## §3 — Install gbrain (manual; not yet reconciler-managed)

Per CLAUDE.md P1-1 tracker: gbrain rollout via the reconciler is not yet proven on fresh VMs (`stepGbrain` is on `feat/gbrain-stepGbrain-phase4c`, not main). Install manually using the canary script.

### 3.1 — Pre-install 6-point check

The installer's own pre-flight does this — but verify externally first:

```bash
ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$BAKE_IP <<'EOF'
source ~/.nvm/nvm.sh
echo "TasksMax: $(systemctl --user show openclaw-gateway -p TasksMax)" # must be =120
echo "gcc: $(which gcc)"                                                # must be present
ls ~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf  # must exist
ls $(npm root -g)/prctl-subreaper/                                       # package dir
node --version                                                            # v22.22.2
EOF
```

### 3.2 — Run installer

```bash
npx tsx scripts/_install-gbrain-on-vm.ts instaclaw-bake-v95
# Expected output ends with:
#   PHASE_A_OK ... PHASE_G_OK ... INSTALL_COMPLETE
# Wait ~3-5 min (PHASE D bun install + clone is the slow step)
```

### 3.3 — Verify gbrain end-to-end

```bash
ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$BAKE_IP <<'EOF'
source ~/.nvm/nvm.sh
export PATH="$HOME/.bun/bin:$PATH"

# Binary
ls -la ~/.bun/bin/gbrain
~/.bun/bin/bun --version

# MCP entry registered
openclaw mcp show gbrain | head -20

# Env vars in .env (will be wiped in §4 but verify install set them)
grep -E '^(GBRAIN_ANTHROPIC_API_KEY|OPENAI_API_KEY)=' ~/.openclaw/.env | sed 's/=.*/=<set>/'

# PGLite directory created (will be empty)
ls ~/.gbrain/
EOF
```

**Gate**: `gbrain` symlink at `~/.bun/bin/gbrain`, MCP entry shows in `openclaw mcp show gbrain`, `GBRAIN_ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env`. If any fail → see installer error logs and re-run.

## §4 — Prebake cleanup (wipe per-VM state)

> **What this does**: 20 sections, ~30 categories of cleanup. Wipes secrets, user data, partner state, caches, logs, /tmp, browser cookies, stale locks, backup file proliferation, shell history, and Cooper's bean-mining experiment scripts. See `_prebake-cleanup.sh` header for the full list.

### 4.1 — Mark the VM as bake-mode

The script refuses to run unless this marker exists (or `--force` is passed).

```bash
ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$BAKE_IP \
  'touch ~/.snapshot-bake-mode'
```

### 4.2 — Dry-run first (mandatory — Rule 4)

```bash
scp -i /tmp/vm-050-key scripts/_prebake-cleanup.sh openclaw@$BAKE_IP:/tmp/
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'bash /tmp/_prebake-cleanup.sh --dry-run' \
  | tee /tmp/bake-v95-dryrun.log
```

Review the dry-run output. Anything surprising (e.g., a file you wanted to keep was scheduled for deletion) → fix the script before proceeding. **Do not skip this step.**

### 4.3 — Real wipe

```bash
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'sudo -v && bash /tmp/_prebake-cleanup.sh --confirm' \
  | tee /tmp/bake-v95-cleanup.log
```

**Expected**: ends with `═══ Cleanup complete — VM is ready to image ═══` and disk usage AFTER ≤ 5900 MB.

If exit code is 4 (non-fatal warnings): review the log for which sub-step warned. Usually safe to proceed if the warnings are about already-absent files. If a P0 cleanup section reports problems, abort and investigate.

### 4.4 — Spot-check critical wipes

```bash
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP <<'EOF'
echo "--- secrets present? ---"
ls ~/.openclaw/.env ~/.openclaw/agents/main/agent/auth-profiles.json \
   ~/.openclaw/gateway.systemd.env ~/.openclaw/xmtp ~/.openclaw/identity 2>&1
echo "--- sessions? ---"
ls ~/.openclaw/agents/main/sessions/ | wc -l
du -sh ~/.openclaw/session-backups/ 2>/dev/null
echo "--- gbrain pglite? ---"
ls ~/.gbrain/brain.pglite 2>/dev/null | wc -l
echo "--- workspace identity ---"
cat ~/.openclaw/workspace/IDENTITY.md | head -5
echo "--- partner state? ---"
ls ~/.openclaw/skills/edge-esmeralda 2>&1 | head
grep edge-city ~/.ssh/authorized_keys
echo "--- gateway token in openclaw.json ---"
grep -E '"token"' ~/.openclaw/openclaw.json | head -3
EOF
```

**All five blocks should report empty / missing / "REPLACE_ON_CONFIGURE".**

## §5 — Validate (bake-mode)

```bash
npx tsx scripts/_postbake-validation.ts \
  --vm-ip=$BAKE_IP --mode=bake --max-disk-mb=5900 \
  | tee /tmp/bake-v95-validation.log
```

**Gate**: exit code 0, "ALL CHECKS PASS". If any P0 fails → DO NOT bake. Investigate.

Common false-positive: P1 "journal log under 50 MB" can fire if the reconcile + gbrain install wrote a lot to journal. If it's > 50 MB but < 100, re-run the cleanup once more (`bash /tmp/_prebake-cleanup.sh --confirm --force`) and re-validate.

The validation script prints the **bake VM's SSH host key fingerprint** — record it for §7.

## §6 — Bake the image

### 6.1 — Final disk-size check (must be < 5900 MB)

```bash
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'df -BM / | tail -1'
# Used field must be < 5900M. If not, see §4.3 disk-overage recovery below.
```

### 6.2 — Power off (Linode requires offline for snapshot)

```bash
curl -sS -X POST -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/$BAKE_VM_ID/shutdown

# Poll for offline
for i in $(seq 1 30); do
  s=$(curl -sS -H "Authorization: Bearer $LINODE_API_TOKEN" \
    https://api.linode.com/v4/linode/instances/$BAKE_VM_ID \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  echo "$i: $s"
  [ "$s" = "offline" ] && break
  sleep 5
done
```

### 6.3 — Get the ext4 disk ID

```bash
curl -sS -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/$BAKE_VM_ID/disks \
  | python3 -c '
import sys, json
data = json.load(sys.stdin)["data"]
for d in data:
  print(f"id={d[\"id\"]} label={d[\"label\"]} filesystem={d[\"filesystem\"]} size={d[\"size\"]}MB")
'
# Pick the row with filesystem=ext4 — that's DISK_ID
```

### 6.4 — Create the image

```bash
curl -sS -X POST https://api.linode.com/v4/images \
  -H "Authorization: Bearer $LINODE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "disk_id": ${DISK_ID},
  "label": "instaclaw-base-v95-<short-desc>",
  "description": "OpenClaw 2026.4.26, Node v22.22.2, manifest v95. \
Built from v79 (private/38575292) via clean fresh-nanode reconcile. \
Includes: build-essential, prctl-subreaper@0.1.1, TasksMax=120, \
v95 ack-ux 9 config keys, bootstrapMaxChars=40000, ack-watchdog.py Layer 3, \
gbrain 0.28.1 (bun 1.3.13, empty PGLite, MCP wired). \
Per-VM state scrubbed via _prebake-cleanup.sh; validated via _postbake-validation.ts."
}
JSON
)" | tee /tmp/bake-v95-image.json
```

Capture the `id` → `NEW_SNAPSHOT_ID = private/<that-id>`.

### 6.5 — Wait for image to become available

```bash
NEW_IMAGE_ID=$(python3 -c 'import json;print(json.load(open("/tmp/bake-v95-image.json"))["id"])')
for i in $(seq 1 30); do
  s=$(curl -sS -H "Authorization: Bearer $LINODE_API_TOKEN" \
    https://api.linode.com/v4/images/$NEW_IMAGE_ID \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"],"size_mb=",d.get("size",-1))')
  echo "$i: $s"
  echo "$s" | grep -q '^available' && break
  sleep 20
done

# Verify size is under 6144 MB
```

**Gate**: status=available, size < 6144 MB. If size is over the cap, the image is silently broken — Linode WILL show it as available but provisions will fail or produce corrupt VMs. Delete the image and clean more aggressively in §4.

## §7 — Verify the image (provision a test VM)

> **Goal**: prove the snapshot deploys correctly. The critical correctness
> check is that cloud-init regenerates SSH host keys and machine-id on first
> boot — if it doesn't, every VM provisioned from this image is the same
> machine identity-wise (MITM vulnerability, broken systemd machine logging,
> etc.).

### 7.1 — Provision a test VM from the new image

```bash
curl -sS -X POST https://api.linode.com/v4/linode/instances \
  -H "Authorization: Bearer $LINODE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "label": "test-v95-snapshot-verify-$(date -u +%H%M)",
  "region": "us-east",
  "type": "g6-nanode-1",
  "image": "private/${NEW_IMAGE_ID}",
  "root_pass": "$(openssl rand -base64 32)",
  "authorized_users": ["instaclaw-deploy"],
  "booted": true,
  "tags": ["instaclaw", "snapshot-test", "v95-verify"]
}
JSON
)" | tee /tmp/test-vm.json
```

Capture `id` → `TEST_VM_ID`, `ipv4[0]` → `TEST_IP`.

### 7.2 — Wait for boot + cloud-init to finish

```bash
# Status=running first
# Then SSH-ready (cloud-init can take 60-120s after running)
for i in $(seq 1 24); do
  ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes \
    openclaw@$TEST_IP 'echo SSH_OK; cloud-init status' 2>&1 | head -3
  ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$TEST_IP \
    'cloud-init status' 2>&1 | grep -q 'status: done' && break
  sleep 10
done
```

### 7.3 — Run configureOpenClaw to set per-VM state

```bash
# Register the test VM in DB (so configureOpenClaw can find it)
# (Adapt this if you have a dedicated test-vm registration script.)

# Trigger configureOpenClaw via the normal assign flow — OR call the function
# directly. The runbook's strongest signal is the actual production code path
# running configureOpenClaw, so prefer assigning the VM to a test account.

# Once configureOpenClaw has completed, verify in DB that:
#   gateway_token is set (random 64-hex)
#   telegram_bot_token is set (for a test bot or null if no bot)
#   partner is null (this is NOT an edge_city VM)
```

### 7.4 — Run validation in test mode

```bash
BAKE_FP=$(grep SHA256 /tmp/bake-v95-validation.log | head -1 | awk '{print $2}')
# OR record from §1.3:
# BAKE_FP=$(cat /tmp/bake-fp.txt | awk '{print $2}')

npx tsx scripts/_postbake-validation.ts \
  --vm-ip=$TEST_IP --mode=test --bake-vm-fingerprint=$BAKE_FP \
  | tee /tmp/test-v95-validation.log
```

**Gates**:
- `cloud-init regenerated SSH host keys` MUST pass (test VM's fp ≠ bake VM's fp). If this fails, the snapshot is fundamentally broken — every fleet VM would have the same SSH identity. Delete the image and investigate cloud-init's `ssh_deletekeys` config.
- `machine-id` should be different from the bake VM's (cloud-init regenerates).
- `gateway active` + `/health returns 200` + `prctl-subreaper loaded` MUST pass.
- All v95 config keys present.

### 7.5 — Send a real chat completion (Rule 12 — `/health` ≠ working)

```bash
# Build a ~29K-token prompt that simulates real fleet load.
# The OpenClaw upgrade playbook calls this out explicitly.

TOK=$(ssh -i /tmp/vm-050-key openclaw@$TEST_IP \
  'python3 -c "import json; print(json.load(open(\"/home/openclaw/.openclaw/openclaw.json\"))[\"gateway\"][\"auth\"][\"token\"])"')

python3 - <<PY
import json, urllib.request, time
# Build a representative upfront context payload
big_msg = "Repeat this exactly: hello. " * 1500   # ~32K characters
payload = {
  "model": "claude-haiku-4-5",
  "max_tokens": 100,
  "messages": [{"role": "user", "content": big_msg}],
}
req = urllib.request.Request(
  "http://${TEST_IP}:18789/v1/chat/completions",
  data=json.dumps(payload).encode(),
  headers={"Authorization": "Bearer ${TOK}", "Content-Type": "application/json"},
)
t0 = time.time()
try:
  with urllib.request.urlopen(req, timeout=60) as r:
    body = r.read()
    print(f"OK {r.status} elapsed={time.time()-t0:.1f}s len={len(body)}")
except Exception as e:
  print(f"FAIL elapsed={time.time()-t0:.1f}s err={e}")
PY
```

**Gate**: completion succeeds in < 30s with non-empty response. If it times out at 60s, the test VM has a watchdog kill-loop or timeout config mismatch — DO NOT promote the snapshot.

### 7.6 — Verify the gbrain MCP responds

```bash
ssh -i /tmp/vm-050-key openclaw@$TEST_IP <<'EOF'
source ~/.nvm/nvm.sh
export PATH="$HOME/.bun/bin:$PATH"
# Probe gbrain MCP — should respond within 5s
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | timeout 10 ~/.bun/bin/gbrain serve 2>&1 | head -20
EOF
```

### 7.7 — Soak the test VM for ≥1 hour (Rule 12 watchdog interaction)

Let the test VM run undisturbed for 1 hour. Watch the journal for SIGTERM cycles, OOMs, watchdog kills:

```bash
ssh -i /tmp/vm-050-key openclaw@$TEST_IP \
  'sudo journalctl --user -u openclaw-gateway --since "1 hour ago" --no-pager' \
  | grep -E 'SIGTERM|OOM|killed|crashed|watchdog' | head -20
# Empty output = healthy
```

## §8 — Promote (update LINODE_SNAPSHOT_ID + Vercel)

Once §7 passes cleanly:

### 8.1 — Update references in repo

| File | Field | New value |
|---|---|---|
| `CLAUDE.md` | "Snapshot" row in VM Provisioning Standard | `private/<NEW_IMAGE_ID>` |
| `CLAUDE.md` | "Rollback snapshot" row | `private/38575292` (current v79; keep until 2026-05-19) |
| `instaclaw/.env.local` | `LINODE_SNAPSHOT_ID` | `private/<NEW_IMAGE_ID>` |
| Memory: `reference_vm_provisioning.md` | snapshot ID + contents list | update |

### 8.2 — Update Vercel environment variables

```bash
# Use printf NOT echo/here-string (CLAUDE.md Rule 6)
printf "private/%s" "$NEW_IMAGE_ID" | npx vercel env rm LINODE_SNAPSHOT_ID production
printf "private/%s" "$NEW_IMAGE_ID" | npx vercel env add LINODE_SNAPSHOT_ID production
# Redeploy to pick up the new env var
npx vercel --prod
```

### 8.3 — Announce the bump in CLAUDE.md changelog

Add an entry to the "Manifest Version Changelog" section in `CLAUDE.md`:

```markdown
### Snapshot v95 baked — 2026-05-12

- **Image**: `private/<NEW_IMAGE_ID>` (instaclaw-base-v95-…)
- **Built from**: v79 (`private/38575292`)
- **Contents**: OpenClaw 2026.4.26, Node v22.22.2, manifest v95.
  - v86 TasksMax=120, v87 prctl-subreaper@0.1.1, v88 build-essential
  - v89-v94 SOUL.md platform identity + partner-stub migration
  - v95 ack-ux Layer 1+2+3 (👀 reaction, streaming preview, ack-watchdog cron)
  - gbrain 0.28.1 (bun 1.3.13, empty PGLite, MCP wired in openclaw.json)
  - All per-VM state scrubbed; validated via _postbake-validation.ts.
- **Size**: <SIZE> MB.
- **Verification**: §7 of snapshot-bake-runbook.md passed all gates, including
  cloud-init SSH-key regeneration + 1h soak with zero SIGTERM events.
```

### 8.4 — Delete the bake VM + the test VM

```bash
curl -sS -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/$BAKE_VM_ID
curl -sS -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/$TEST_VM_ID

# Remove the synthetic DB row for the bake VM
npx tsx -e 'const sb=require("@supabase/supabase-js").createClient(...); await sb.from("instaclaw_vms").delete().eq("name","instaclaw-bake-v95");'
```

### 8.5 — Release the cron lock

```bash
npx tsx -e '
import { releaseCronLock } from "./lib/cron-lock";
import { readFileSync } from "fs";
for (const f of [".env.local"]) for (const l of readFileSync(f,"utf-8").split("\n")) {const m=l.match(/^([^#=]+)=(.*)$/);if(m&&!process.env[m[1].trim()])process.env[m[1].trim()]=m[2].trim().replace(/^["\047]|["\047]$/g,"")}
await releaseCronLock("reconcile-fleet");
console.log("released");
'
```

### 8.6 — Verify pool replenishment picks up the new snapshot

Wait one cron tick (Vercel cron is every 5 min). The `replenish-pool` cron should provision a new VM from the bumped `LINODE_SNAPSHOT_ID`. Spot-check the new pool VM with the same §7.4 validation. If it passes, the bake is fully live.

## §9 — Rollback plan (must be ready BEFORE you start)

If §7 (test-VM verification) fails or §8.6 reveals broken pool VMs:

1. **Revert env vars** to point at the previous snapshot.
   ```bash
   printf "private/38575292" | npx vercel env rm LINODE_SNAPSHOT_ID production
   printf "private/38575292" | npx vercel env add LINODE_SNAPSHOT_ID production
   npx vercel --prod
   ```
2. **Revert repo edits** — `git revert` the changelog + CLAUDE.md commits.
3. **Pause the replenish-pool cron** in `vercel.json` so it doesn't keep provisioning from the broken snapshot during recovery. (Or: temporarily set `LINODE_SNAPSHOT_ID` to the rollback value via Vercel dashboard.)
4. **Quarantine VMs already provisioned from the bad snapshot.** Anything assigned within the post-promotion window before rollback. They may have broken state.
5. **Delete the broken image** to prevent accidental re-use:
   ```bash
   curl -sS -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
     https://api.linode.com/v4/images/$NEW_IMAGE_ID
   ```
6. **Postmortem** before retrying — what specifically failed §7? Most likely candidates: cloud-init `ssh_deletekeys` not working, disk size > cap, gbrain MCP not responding, watchdog kill-loop.

**Keep the previous snapshot (`private/38575292`)** until at least 1 week after promotion — typically 2026-05-19 for a v95 bake. Don't delete until the new snapshot has soaked through one full fleet cycle.

## §10 — Disk-overage recovery (if §6.1 fails)

If `df` reports > 5900 MB after `_prebake-cleanup.sh`, the most likely culprits in descending probability:

1. **Journal accumulated during reconcile** (most common): `sudo journalctl --vacuum-time=1s` again.
2. **Playwright cache** (622 MB): re-run cleanup with `--no-playwright`. Trade-off: agents will re-download chromium on first use of `web-search-browser` skill, adding ~30s to that first request.
3. **Skill node_modules** (motion-graphics is 301 MB): `rm -rf ~/.openclaw/skills/motion-graphics/assets/template-basic/node_modules`.
4. **edge-esmeralda 114 MB** still present: the cleanup should have caught this. Re-run the partner-cleanup section.
5. **bun cache** (~150 MB after install): `rm -rf ~/.bun/install/cache`.
6. **Some unexpected file** — manually inspect with `du -BM -d 2 / 2>/dev/null | sort -rn | head -20`.

After clearing, re-run `_postbake-validation.ts` from §5.

## §11 — Known risks specific to v95 (read before bake)

| Risk | Mitigation |
|---|---|
| **Bun shebang `#!/usr/bin/env bun`** — needs `bun` in PATH | Gateway's systemd PATH includes `~/.bun/bin` (verified on vm-050 audit). Verified by `prctl-subreaper.conf` not modifying PATH negatively. Validate via §7.6 gbrain MCP probe. |
| **`messages.*` keys don't hot-reload** (Rule 32) | We restart the gateway during cleanup, then snapshot in stopped state. First boot from snapshot reads correct values at init. |
| **cloud-init `ssh_deletekeys` not explicitly set** | Verified empirically on v79 fleet (host keys differ across fleet VMs). Validated in §7.4 with `--bake-vm-fingerprint`. |
| **`OPENCLAW_PINNED_VERSION` change** | If you're also bumping OpenClaw, you must follow the OpenClaw Upgrade Playbook in `CLAUDE.md` (canary + 1h soak) BEFORE this runbook. |
| **Lying-DB on the bake VM after reconcile** (P1-1) | `_postbake-validation.ts` checks disk state directly, not DB. If validation passes, the on-disk state is correct regardless of what the DB says. |
| **v95 manifest currently has bootstrapMaxChars=40000 but workspace > 40K total** | The CLAUDE.md Rule 12 issue. The fix should land before bake (trim SOUL.md). If it hasn't landed, the bake will ship with the truncation bug. Verify in §2.3 that `wc -c` totals are < 40K. |

## §12 — Checklist (tear-off, fill in as you go)

```
[ ] §0.5  Pre-flight: Linode API, Supabase, scripts present, OpenClaw version pin OK
[ ] §1.1  Bake VM provisioned   id=______   ip=__________
[ ] §1.2  SSH ready + openclaw 2026.4.26 verified
[ ] §1.3  Bake VM SSH fp recorded: SHA256:_______________________________
[ ] §2.1  reconcile-fleet cron lock acquired (4h TTL)
[ ] §2.2  Reconcile to v95 complete (catch-up exit=0)
[ ] §2.3  Manifest markers verified (TasksMax=120, gcc, prctl, 9 keys, bootstrapMaxChars=40000)
[ ] §3.2  gbrain install: INSTALL_COMPLETE (no FATAL_*)
[ ] §3.3  gbrain end-to-end verified (symlink, MCP entry, env vars, PGLite)
[ ] §4.1  ~/.snapshot-bake-mode marker created
[ ] §4.2  _prebake-cleanup.sh --dry-run reviewed (saved to /tmp/bake-v95-dryrun.log)
[ ] §4.3  _prebake-cleanup.sh --confirm OK; disk usage <5900MB
[ ] §4.4  Spot checks: secrets gone, sessions empty, gbrain pglite empty, identity reset, partner gone
[ ] §5    _postbake-validation.ts --mode=bake: ALL P0 PASS
[ ] §6.1  Final disk-size check < 5900 MB
[ ] §6.2  Linode shutdown OK (status=offline)
[ ] §6.4  Image creation OK   id=__________
[ ] §6.5  Image available, size < 6144 MB
[ ] §7.1  Test VM provisioned   id=______   ip=__________
[ ] §7.2  cloud-init status=done
[ ] §7.3  configureOpenClaw run (gateway_token populated in DB)
[ ] §7.4  _postbake-validation.ts --mode=test: ALL P0 PASS (incl. SSH-key regen)
[ ] §7.5  Chat completion < 30s with non-empty response
[ ] §7.6  gbrain MCP responded
[ ] §7.7  1 hour soak — zero SIGTERM/OOM/watchdog kills in journal
[ ] §8.1  CLAUDE.md + .env.local updated
[ ] §8.2  Vercel LINODE_SNAPSHOT_ID updated + redeployed
[ ] §8.3  Changelog entry added
[ ] §8.4  Bake VM + Test VM deleted; DB row deleted
[ ] §8.5  reconcile-fleet cron lock released
[ ] §8.6  Pool replenishment fired and produced healthy new VM
[ ] §rollback plan reviewed and ready (keep v79 snapshot for 1 week)
```
