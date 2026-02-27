#!/bin/bash
#
# fleet-fix-ffmpeg.sh — Install ffmpeg + openai python on all active VMs
#
# Fixes fleet-wide missing dependencies for voice/audio processing:
#   - ffmpeg (OGG/Opus decode for Telegram voice messages, audio conversion)
#   - openai python package (Whisper API for speech-to-text)
#
# Usage:
#   ./instaclaw/scripts/fleet-fix-ffmpeg.sh --dry-run     # Preview targets
#   ./instaclaw/scripts/fleet-fix-ffmpeg.sh --canary IP    # Single VM test
#   ./instaclaw/scripts/fleet-fix-ffmpeg.sh --all          # Fix entire fleet
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load env
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  set -a
  source "$PROJECT_ROOT/.env.local"
  set +a
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" >&2
  exit 1
fi

# Load SSH key
SSH_PRIVATE_KEY_B64=""
if [ -f "$PROJECT_ROOT/.env.ssh-key" ]; then
  SSH_PRIVATE_KEY_B64=$(grep "^SSH_PRIVATE_KEY_B64=" "$PROJECT_ROOT/.env.ssh-key" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then
  echo "ERROR: SSH_PRIVATE_KEY_B64 not found" >&2
  exit 1
fi
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

MODE="${1:---help}"
CANARY_IP="${2:-}"

fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&select=id,ip_address,ssh_user,name" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY" \
    -H "Content-Type: application/json"
}

fix_vm() {
  local ip="$1" user="$2" name="$3"

  echo "  [$name] $ip — installing ffmpeg + openai..."

  local RESULT
  RESULT=$(ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes \
    -i "$SSH_KEY_FILE" "${user}@${ip}" 'export PATH="$HOME/.local/bin:/usr/bin:/usr/local/bin:$PATH"; if ! which ffmpeg >/dev/null 2>&1; then if sudo -n true 2>/dev/null; then sudo apt-get update -qq 2>/dev/null; sudo apt-get install -y -qq ffmpeg 2>/dev/null; echo "ffmpeg: INSTALLED"; else echo "ffmpeg: SKIP (no sudo)"; fi; else echo "ffmpeg: already present"; fi; which ffmpeg >/dev/null 2>&1 && echo "ffmpeg: OK" || echo "ffmpeg: MISSING"; python3 -c "import openai" 2>/dev/null || { pip3 install --break-system-packages --quiet openai 2>/dev/null || pip3 install --user --quiet openai 2>/dev/null; echo "openai: INSTALLED"; }; python3 -c "import openai" 2>/dev/null && echo "openai: OK" || echo "openai: FAIL"; which ffmpeg >/dev/null 2>&1 && python3 -c "import openai" 2>/dev/null && echo "FIX_DONE" || echo "FIX_PARTIAL"' 2>&1) || RESULT="SSH_FAILED"

  if echo "$RESULT" | grep -q "FIX_DONE"; then
    local status_details
    status_details=$(echo "$RESULT" | grep -E "ffmpeg:|openai:" | tr '\n' ', ')
    echo "    OK ($status_details)"
    return 0
  else
    echo "    FAILED: $RESULT"
    return 1
  fi
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Fleet ffmpeg + openai fix ==="
    echo ""
    echo "Will install (if missing):"
    echo "  - ffmpeg (apt-get) — audio/video conversion, OGG/Opus decode"
    echo "  - openai python (pip3) — Whisper API for speech-to-text"
    echo ""
    VMS=$(fetch_vms)
    COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "Active VMs: $COUNT"
    echo ""
    echo "Run with --canary <IP> to test on one VM, then --all for the fleet."
    ;;

  --canary)
    if [ -z "$CANARY_IP" ]; then
      echo "Usage: $0 --canary <IP>" >&2
      exit 1
    fi
    echo "=== CANARY: Fixing $CANARY_IP ==="
    fix_vm "$CANARY_IP" "openclaw" "canary"
    echo ""
    echo "If OK, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET FIX: ffmpeg + openai ==="
    echo ""
    VMS=$(fetch_vms)
    SUCCESS=0
    FAILED=0

    echo "$VMS" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['ip_address']} {vm.get('ssh_user','openclaw')} {vm.get('name','unknown')}\")
" 2>/dev/null | while read -r IP USER NAME; do
      fix_vm "$IP" "$USER" "$NAME" || true
    done

    echo ""
    echo "=== Fleet fix complete ==="
    ;;

  --help|*)
    echo "fleet-fix-ffmpeg.sh — Install ffmpeg + openai on all active VMs"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run          — Preview targets"
    echo "  $0 --canary <IP>      — Test on one VM"
    echo "  $0 --all              — Fix entire fleet"
    ;;
esac
