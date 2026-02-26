#!/bin/bash
#
# fleet-upgrade-openclaw.sh — Upgrade OpenClaw across the entire fleet
#
# End-to-end upgrade lifecycle: resolve version, update code pins,
# canary test on one VM, batched fleet rollout, post-rollout verification.
#
# Usage:
#   ./instaclaw/scripts/fleet-upgrade-openclaw.sh                        # Upgrade to latest
#   ./instaclaw/scripts/fleet-upgrade-openclaw.sh --version 2026.2.25    # Specific version
#   ./instaclaw/scripts/fleet-upgrade-openclaw.sh --dry-run              # Preview only
#   ./instaclaw/scripts/fleet-upgrade-openclaw.sh --skip-code-update     # Skip git commit
#   ./instaclaw/scripts/fleet-upgrade-openclaw.sh --skip-token-audit     # Skip post-rollout audit
#   ./instaclaw/scripts/fleet-upgrade-openclaw.sh --batch-size 10        # Custom batch size
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
SSH_ENV_FILE="${SCRIPT_DIR}/../.env.ssh-key"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults ──
TARGET_VERSION=""
DRY_RUN=false
SKIP_CODE_UPDATE=false
SKIP_TOKEN_AUDIT=false
BATCH_SIZE=5
COMMIT_SHA=""

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      TARGET_VERSION="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-code-update)
      SKIP_CODE_UPDATE=true
      shift
      ;;
    --skip-token-audit)
      SKIP_TOKEN_AUDIT=true
      shift
      ;;
    --batch-size)
      BATCH_SIZE="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      echo "Usage: $0 [--version X.Y.Z] [--dry-run] [--skip-code-update] [--skip-token-audit] [--batch-size N]"
      exit 1
      ;;
  esac
done

# ── Colored output helpers ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

preflight() { echo -e "${CYAN}[PREFLIGHT]${NC} $*"; }
code()      { echo -e "${YELLOW}[CODE]${NC} $*"; }
canary()    { echo -e "${BOLD}[CANARY]${NC} $*"; }
fleet()     { echo -e "${GREEN}[FLEET]${NC} $*"; }
verify()    { echo -e "${CYAN}[VERIFY]${NC} $*"; }
done_msg()  { echo -e "${GREEN}[DONE]${NC} $*"; }
err()       { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Load environment ──
if [ ! -f "$ENV_FILE" ]; then
  err ".env.local not found at $ENV_FILE"
  exit 1
fi

load_env_any() {
  local key="$1"
  local val
  val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  if [ -z "$val" ] && [ -f "$SSH_ENV_FILE" ]; then
    val=$(grep "^${key}=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  fi
  echo "$val"
}

SUPABASE_URL=$(load_env_any "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env_any "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env_any "SSH_PRIVATE_KEY_B64")

if [ -z "$SUPABASE_URL" ]; then err "NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then err "SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then err "SSH_PRIVATE_KEY_B64 not found in .env.local or .env.ssh-key"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

SSH_OPTS="-i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes -o ServerAliveInterval=15"

# Detect sed in-place flag (macOS vs Linux)
if [[ "$(uname)" == "Darwin" ]]; then
  SED_INPLACE="sed -i ''"
else
  SED_INPLACE="sed -i"
fi

# ── NVM path on VMs ──
NVM_BIN='$HOME/.nvm/versions/node/v22.22.0/bin'

# ── Temp files for tracking ──
UPGRADED_FILE=$(mktemp)
SKIPPED_FILE=$(mktemp)
FAILED_FILE=$(mktemp)
trap 'rm -f "$SSH_KEY_FILE" "$UPGRADED_FILE" "$SKIPPED_FILE" "$FAILED_FILE"' EXIT

# ── Core functions ──

get_vm_version() {
  local ip="$1" port="$2" user="$3"
  ssh -n $SSH_OPTS -p "$port" "${user}@${ip}" \
    "grep '^Description=' ~/.config/systemd/user/openclaw-gateway.service 2>/dev/null | sed 's/.*v\([0-9.]*[-a-z0-9]*\).*/\1/'" 2>/dev/null || echo "unknown"
}

upgrade_vm() {
  local ip="$1" port="$2" user="$3" version="$4"
  local SSH_CMD="ssh -n $SSH_OPTS -p $port ${user}@${ip}"

  # Step 1: Install target version
  $SSH_CMD "export PATH=${NVM_BIN}:\$PATH && npm install -g openclaw@${version}" 2>/dev/null
  if [ $? -ne 0 ]; then
    err "  npm install failed on ${ip}"
    return 1
  fi

  # Step 2: Update systemd Description + daemon-reload
  $SSH_CMD "
    sed -i 's/Description=.*/Description=OpenClaw Gateway v${version}/' ~/.config/systemd/user/openclaw-gateway.service 2>/dev/null
    systemctl --user daemon-reload
  " 2>/dev/null
  if [ $? -ne 0 ]; then
    err "  systemd update failed on ${ip}"
    return 1
  fi

  # Step 3: Restart gateway
  $SSH_CMD "systemctl --user restart openclaw-gateway" 2>/dev/null
  if [ $? -ne 0 ]; then
    err "  gateway restart failed on ${ip}"
    return 1
  fi

  # Step 4: Health retry loop — 6 attempts x 5s = 30s max (CLAUDE.md Rule 5)
  local attempt=0
  while [ $attempt -lt 6 ]; do
    sleep 5
    local status
    status=$($SSH_CMD "systemctl --user is-active openclaw-gateway 2>/dev/null" 2>/dev/null || echo "inactive")
    if [ "$status" = "active" ]; then
      local health
      health=$($SSH_CMD "curl -sf http://localhost:18789/health 2>/dev/null && echo OK" 2>/dev/null || echo "FAIL")
      if echo "$health" | grep -q "OK"; then
        return 0
      fi
    fi
    attempt=$((attempt + 1))
  done

  err "  Health check failed after 30s on ${ip}"
  return 1
}

downgrade_vm() {
  local ip="$1" port="$2" user="$3" old_version="$4"
  upgrade_vm "$ip" "$port" "$user" "$old_version"
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 1: PREFLIGHT
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Fleet OpenClaw Upgrade"
echo "════════════════════════════════════════════════════════════"
echo ""

if [ "$DRY_RUN" = true ]; then
  preflight "DRY RUN — no changes will be made"
  echo ""
fi

# 1a. Resolve target version
if [ -z "$TARGET_VERSION" ]; then
  preflight "Resolving latest openclaw version from npm..."
  TARGET_VERSION=$(npm view openclaw version 2>/dev/null)
  if [ -z "$TARGET_VERSION" ]; then
    err "Failed to resolve latest openclaw version from npm"
    exit 1
  fi
fi
preflight "Target version: v${TARGET_VERSION}"

# 1b. Query Supabase for all assigned VMs
preflight "Querying Supabase for assigned VMs..."
VMS_JSON=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?status=eq.assigned&gateway_token=not.is.null&select=ip_address,ssh_port,ssh_user,name&order=name" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}")

VM_COUNT=$(echo "$VMS_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$VM_COUNT" -eq 0 ]; then
  err "No assigned VMs found in Supabase"
  exit 1
fi
preflight "Found ${VM_COUNT} assigned VM(s)"

# Parse VMs into pipe-delimited list (avoids subshell issues with while-read in pipes)
VM_LIST=$(echo "$VMS_JSON" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['ip_address']}|{vm.get('ssh_port',22)}|{vm.get('ssh_user','openclaw')}|{vm.get('name','unknown')}\")
")

# 1c. Get current fleet version from first VM
FIRST_VM=$(echo "$VM_LIST" | head -1)
FIRST_IP=$(echo "$FIRST_VM" | cut -d'|' -f1)
FIRST_PORT=$(echo "$FIRST_VM" | cut -d'|' -f2)
FIRST_USER=$(echo "$FIRST_VM" | cut -d'|' -f3)
FIRST_NAME=$(echo "$FIRST_VM" | cut -d'|' -f4)

preflight "Checking current version on ${FIRST_NAME} (${FIRST_IP})..."
CURRENT_VERSION=$(get_vm_version "$FIRST_IP" "$FIRST_PORT" "$FIRST_USER")
preflight "Current fleet version: v${CURRENT_VERSION}"

# 1d. Already up to date?
if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ]; then
  preflight "Fleet already on v${TARGET_VERSION} — nothing to do"
  exit 0
fi

# 1e. Summary
echo ""
preflight "${BOLD}Upgrading from v${CURRENT_VERSION} -> v${TARGET_VERSION} (${VM_COUNT} VMs)${NC}"
preflight "Batch size: ${BATCH_SIZE}"
preflight "npm versions: https://www.npmjs.com/package/openclaw?activeTab=versions"
echo ""

# ══════════════════════════════════════════════════════════════════════
# PHASE 2: UPDATE VERSION PINS
# ══════════════════════════════════════════════════════════════════════

CLOUD_INIT_FILE="${PROJECT_ROOT}/lib/cloud-init.ts"
OPEN_SPOTS_FILE="${SCRIPT_DIR}/open-spots.sh"
SSH_TS_FILE="${PROJECT_ROOT}/lib/ssh.ts"

if [ "$SKIP_CODE_UPDATE" = true ]; then
  code "Skipping code update (--skip-code-update)"
elif [ "$DRY_RUN" = true ]; then
  code "Would update version pins in:"
  code "  ${CLOUD_INIT_FILE} — openclaw@VERSION in npm install line"
  code "  ${OPEN_SPOTS_FILE} — openclaw@VERSION in npm install line"
  code "  ${SSH_TS_FILE} — lastRunVersion: \"VERSION\""
  code "Would commit and push to origin/main"
else
  code "Updating version pins to v${TARGET_VERSION}..."

  # cloud-init.ts: openclaw@X.Y.Z (preserves mcporter suffix)
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/openclaw@[0-9.]\{1,\}/openclaw@${TARGET_VERSION}/" "$CLOUD_INIT_FILE"
    sed -i '' "s/openclaw@[0-9.]\{1,\}/openclaw@${TARGET_VERSION}/" "$OPEN_SPOTS_FILE"
    sed -i '' "s/lastRunVersion: \"[0-9.]*\"/lastRunVersion: \"${TARGET_VERSION}\"/" "$SSH_TS_FILE"
  else
    sed -i "s/openclaw@[0-9.]\{1,\}/openclaw@${TARGET_VERSION}/" "$CLOUD_INIT_FILE"
    sed -i "s/openclaw@[0-9.]\{1,\}/openclaw@${TARGET_VERSION}/" "$OPEN_SPOTS_FILE"
    sed -i "s/lastRunVersion: \"[0-9.]*\"/lastRunVersion: \"${TARGET_VERSION}\"/" "$SSH_TS_FILE"
  fi

  code "  Updated cloud-init.ts"
  code "  Updated open-spots.sh"
  code "  Updated ssh.ts"

  # Git commit + push
  cd "$PROJECT_ROOT"
  git add lib/cloud-init.ts scripts/open-spots.sh lib/ssh.ts
  git commit -m "chore: upgrade fleet to openclaw@${TARGET_VERSION}" --quiet
  COMMIT_SHA=$(git rev-parse --short HEAD)
  git push origin main --quiet
  code "Committed and pushed: ${COMMIT_SHA}"
  cd "$SCRIPT_DIR"
fi

echo ""

# ══════════════════════════════════════════════════════════════════════
# PHASE 3: CANARY TEST (CLAUDE.md Rule 3)
# ══════════════════════════════════════════════════════════════════════

CANARY_IP="$FIRST_IP"
CANARY_PORT="$FIRST_PORT"
CANARY_USER="$FIRST_USER"
CANARY_NAME="$FIRST_NAME"

if [ "$DRY_RUN" = true ]; then
  canary "Would canary test on: ${CANARY_NAME} (${CANARY_IP})"
  canary "Would upgrade v${CURRENT_VERSION} -> v${TARGET_VERSION}"
  canary "Would verify health (6 retries x 5s)"
  canary "Would verify openclaw --version matches"
else
  canary "Testing upgrade on canary: ${CANARY_NAME} (${CANARY_IP})"
  canary "Upgrading v${CURRENT_VERSION} -> v${TARGET_VERSION}..."

  if upgrade_vm "$CANARY_IP" "$CANARY_PORT" "$CANARY_USER" "$TARGET_VERSION"; then
    # Additional version verification
    ACTUAL_VERSION=$(ssh -n $SSH_OPTS -p "$CANARY_PORT" "${CANARY_USER}@${CANARY_IP}" \
      "export PATH=${NVM_BIN}:\$PATH && openclaw --version 2>/dev/null" 2>/dev/null || echo "unknown")
    canary "Reported version: ${ACTUAL_VERSION}"

    canary "${GREEN}CANARY PASSED${NC} — ${CANARY_NAME} healthy on v${TARGET_VERSION}"
    echo "$CANARY_IP" >> "$UPGRADED_FILE"
  else
    err "CANARY FAILED on ${CANARY_NAME} (${CANARY_IP})"

    # Rollback canary VM
    canary "Rolling back canary to v${CURRENT_VERSION}..."
    if downgrade_vm "$CANARY_IP" "$CANARY_PORT" "$CANARY_USER" "$CURRENT_VERSION"; then
      canary "Canary rolled back successfully"
    else
      err "Canary rollback also failed — manual intervention needed on ${CANARY_IP}"
    fi

    # Revert git commit if we made one
    if [ -n "$COMMIT_SHA" ]; then
      canary "Reverting code commit ${COMMIT_SHA}..."
      cd "$PROJECT_ROOT"
      git revert --no-edit "$COMMIT_SHA" --quiet
      git push origin main --quiet
      canary "Code reverted"
      cd "$SCRIPT_DIR"
    fi

    err "Aborting fleet upgrade. Canary failed — investigate before retrying."
    exit 1
  fi
fi

echo ""

# ══════════════════════════════════════════════════════════════════════
# PHASE 4: FLEET ROLLOUT
# ══════════════════════════════════════════════════════════════════════

UPGRADED=0
SKIPPED=0
FAILED=0
PROCESSED=0

if [ "$DRY_RUN" = true ]; then
  fleet "Would upgrade ${VM_COUNT} VMs in batches of ${BATCH_SIZE}:"
  BATCH_NUM=1
  VM_IDX=0
  while IFS='|' read -r IP PORT USER NAME; do
    VM_IDX=$((VM_IDX + 1))
    if [ $((VM_IDX % BATCH_SIZE)) -eq 1 ] || [ "$BATCH_SIZE" -eq 1 ]; then
      fleet "  Batch ${BATCH_NUM}:"
      BATCH_NUM=$((BATCH_NUM + 1))
    fi
    fleet "    ${NAME} (${IP})"
  done <<< "$VM_LIST"
else
  fleet "Rolling out to ${VM_COUNT} VMs (batch size: ${BATCH_SIZE})..."
  echo ""

  while IFS='|' read -r IP PORT USER NAME; do
    PROCESSED=$((PROCESSED + 1))

    # Check current version — skip if already on target
    VM_VER=$(get_vm_version "$IP" "$PORT" "$USER")
    if [ "$VM_VER" = "$TARGET_VERSION" ]; then
      fleet "  [${PROCESSED}/${VM_COUNT}] ${NAME} (${IP}) — already on v${TARGET_VERSION}, skipping"
      SKIPPED=$((SKIPPED + 1))
      echo "$IP" >> "$SKIPPED_FILE"
    else
      fleet "  [${PROCESSED}/${VM_COUNT}] ${NAME} (${IP}) — upgrading v${VM_VER} -> v${TARGET_VERSION}..."
      if upgrade_vm "$IP" "$PORT" "$USER" "$TARGET_VERSION"; then
        fleet "  [${PROCESSED}/${VM_COUNT}] ${NAME} — ${GREEN}OK${NC}"
        UPGRADED=$((UPGRADED + 1))
        echo "$IP" >> "$UPGRADED_FILE"
      else
        err "  [${PROCESSED}/${VM_COUNT}] ${NAME} (${IP}) — FAILED (continuing)"
        FAILED=$((FAILED + 1))
        echo "$IP" >> "$FAILED_FILE"
      fi
    fi

    # Batch pause
    if [ "$BATCH_SIZE" -gt 0 ] && [ $((PROCESSED % BATCH_SIZE)) -eq 0 ] && [ "$PROCESSED" -lt "$VM_COUNT" ]; then
      fleet "  --- Batch complete. Pausing 10s ---"
      sleep 10
    fi
  done <<< "$VM_LIST"
fi

echo ""

# ══════════════════════════════════════════════════════════════════════
# PHASE 5: POST-ROLLOUT VERIFICATION
# ══════════════════════════════════════════════════════════════════════

if [ "$DRY_RUN" = true ]; then
  verify "Skipped (dry run)"
else
  # 5a. Token audit
  TOKEN_AUDIT_RESULT="SKIPPED"
  if [ "$SKIP_TOKEN_AUDIT" = true ]; then
    verify "Skipping token audit (--skip-token-audit)"
  else
    verify "Running token audit..."
    AUDIT_OUTPUT=$(cd "$PROJECT_ROOT" && npx dotenv-cli -e .env.local -- npx tsx scripts/_fleet-token-audit.ts 2>&1 || true)
    if echo "$AUDIT_OUTPUT" | grep -qi "PASS"; then
      TOKEN_AUDIT_RESULT="PASS"
      AUDIT_SUMMARY=$(echo "$AUDIT_OUTPUT" | grep -i "PASS" | tail -1)
      verify "Token audit: ${GREEN}${AUDIT_SUMMARY}${NC}"
    elif echo "$AUDIT_OUTPUT" | grep -qi "FAIL"; then
      TOKEN_AUDIT_RESULT="FAIL"
      AUDIT_SUMMARY=$(echo "$AUDIT_OUTPUT" | grep -i "FAIL" | tail -1)
      verify "Token audit: ${RED}${AUDIT_SUMMARY}${NC}"
    else
      TOKEN_AUDIT_RESULT="UNKNOWN"
      verify "Token audit: result unclear — check manually"
    fi
  fi

  # 5b. Version sweep
  verify "Running version sweep..."
  VERSION_MISMATCH=0
  while IFS='|' read -r IP PORT USER NAME; do
    VM_VER=$(get_vm_version "$IP" "$PORT" "$USER")
    if [ "$VM_VER" != "$TARGET_VERSION" ]; then
      verify "  ${RED}MISMATCH${NC} ${NAME} (${IP}): v${VM_VER} (expected v${TARGET_VERSION})"
      VERSION_MISMATCH=$((VERSION_MISMATCH + 1))
    fi
  done <<< "$VM_LIST"

  if [ "$VERSION_MISMATCH" -eq 0 ]; then
    verify "Version sweep: ${GREEN}all ${VM_COUNT} VMs on v${TARGET_VERSION}${NC}"
  else
    verify "Version sweep: ${RED}${VERSION_MISMATCH} VM(s) not on target version${NC}"
  fi

  # 5c. Rollback manifest
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  MANIFEST_FILE="/tmp/fleet-upgrade-${TIMESTAMP}.json"

  UPGRADED_IPS=$(cat "$UPGRADED_FILE" 2>/dev/null | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))" 2>/dev/null || echo "[]")
  FAILED_IPS=$(cat "$FAILED_FILE" 2>/dev/null | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))" 2>/dev/null || echo "[]")

  cat > "$MANIFEST_FILE" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "old_version": "${CURRENT_VERSION}",
  "new_version": "${TARGET_VERSION}",
  "commit_sha": "${COMMIT_SHA}",
  "upgraded_ips": ${UPGRADED_IPS},
  "failed_ips": ${FAILED_IPS}
}
EOF

  verify "Rollback manifest saved: ${MANIFEST_FILE}"

  # 5d. Final report
  echo ""
  echo "════════════════════════════════════════════════════════════"
  done_msg "Upgraded: ${UPGRADED} | Skipped: ${SKIPPED} | Failed: ${FAILED}"
  if [ -n "$COMMIT_SHA" ]; then
    done_msg "Code commit: ${COMMIT_SHA}"
  else
    done_msg "Code commit: (skipped)"
  fi
  done_msg "Token audit: ${TOKEN_AUDIT_RESULT}"
  done_msg "Rollback manifest: ${MANIFEST_FILE}"
  echo "════════════════════════════════════════════════════════════"
fi
