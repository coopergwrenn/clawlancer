#!/bin/bash
#
# fleet-push-voice-skill.sh — Push Voice & Audio Production skill to all assigned VMs
#
# Deploys the complete voice-audio-production skill package:
#   - SKILL.md (complete documentation)
#   - Helper scripts (tts-openai.sh, tts-elevenlabs.sh, audio-toolkit.sh)
#   - Usage tracker (audio-usage-tracker.py)
#   - Voice reference guide
#   - Audio config (tier-based limits)
#
# Does NOT restart gateways — skill files don't require it.
#
# Usage:
#   ./instaclaw/scripts/fleet-push-voice-skill.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-push-voice-skill.sh --canary 1.2.3.4   # Single VM by IP
#   ./instaclaw/scripts/fleet-push-voice-skill.sh --dry-run           # Show what would happen
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="${SCRIPT_DIR}/../skills/voice-audio-production"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
SSH_ENV_FILE="${SCRIPT_DIR}/../.env.ssh-key"

# Defaults
CANARY_IP=""
DRY_RUN=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary)
      CANARY_IP="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown arg: $1"
      echo "Usage: $0 [--canary <ip>] [--dry-run]"
      exit 1
      ;;
  esac
done

# Verify skill directory exists
if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
  echo "Error: Skill directory not found at $SKILL_DIR"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

# Load env vars
load_env() {
  local key="$1"
  local val=""
  val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  if [ -z "$val" ] && [ -f "$SSH_ENV_FILE" ]; then
    val=$(grep "^${key}=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  fi
  echo "$val"
}

SUPABASE_URL=$(load_env "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env "SSH_PRIVATE_KEY_B64")

if [ -z "$SUPABASE_URL" ]; then echo "Error: NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then echo "Error: SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# Base64 encode all skill files
SKILL_MD_B64=$(base64 < "$SKILL_DIR/SKILL.md")
TTS_OPENAI_B64=$(base64 < "$SKILL_DIR/assets/tts-openai.sh")
TTS_ELEVENLABS_B64=$(base64 < "$SKILL_DIR/assets/tts-elevenlabs.sh")
AUDIO_TOOLKIT_B64=$(base64 < "$SKILL_DIR/assets/audio-toolkit.sh")
USAGE_TRACKER_B64=$(base64 < "$SKILL_DIR/assets/audio-usage-tracker.py")
VOICE_GUIDE_B64=$(base64 < "$SKILL_DIR/references/voice-guide.md")

# Fetch VMs
echo "=== Fleet Push: Voice & Audio Production Skill ==="
echo ""

if [ -n "$CANARY_IP" ]; then
  echo "Mode: CANARY ($CANARY_IP)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?ip_address=eq.${CANARY_IP}&select=id,ip_address,ssh_port,ssh_user,name" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}")
else
  echo "Mode: FLEET (all assigned VMs)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=id,ip_address,ssh_port,ssh_user,name" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}")
fi

VM_COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "Found $VM_COUNT VM(s)"
if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — no changes will be made"
fi
echo ""

SUCCESS=0
FAILED=0

echo "$VMS" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['id']}|{vm['ip_address']}|{vm.get('ssh_port',22)}|{vm.get('ssh_user','openclaw')}|{vm.get('name','unknown')}\")
" | while IFS='|' read -r VM_ID VM_IP VM_PORT VM_USER VM_NAME; do
  if [ "$DRY_RUN" = true ]; then
    echo "[$VM_NAME] $VM_IP — [DRY RUN] would push voice skill (SKILL.md + 4 scripts + reference)"
    continue
  fi

  echo -n "[$VM_NAME] $VM_IP — "

  RESULT=$(ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
    -i "$SSH_KEY_FILE" -p "$VM_PORT" "${VM_USER}@${VM_IP}" \
    "set -e && \
     SKILL=\$HOME/.openclaw/skills/voice-audio-production && \
     SCRIPTS=\$HOME/scripts && \
     mkdir -p \$SKILL/references \$SKILL/assets \$SCRIPTS && \
     echo '${SKILL_MD_B64}' | base64 -d > \$SKILL/SKILL.md && \
     echo '${VOICE_GUIDE_B64}' | base64 -d > \$SKILL/references/voice-guide.md && \
     echo '${TTS_OPENAI_B64}' | base64 -d > \$SCRIPTS/tts-openai.sh && \
     echo '${TTS_ELEVENLABS_B64}' | base64 -d > \$SCRIPTS/tts-elevenlabs.sh && \
     echo '${AUDIO_TOOLKIT_B64}' | base64 -d > \$SCRIPTS/audio-toolkit.sh && \
     echo '${USAGE_TRACKER_B64}' | base64 -d > \$SCRIPTS/audio-usage-tracker.py && \
     chmod +x \$SCRIPTS/tts-openai.sh \$SCRIPTS/tts-elevenlabs.sh \$SCRIPTS/audio-toolkit.sh \$SCRIPTS/audio-usage-tracker.py && \
     echo VOICE_SKILL_PUSHED" 2>/dev/null || true)

  if echo "$RESULT" | grep -q "VOICE_SKILL_PUSHED"; then
    echo "OK"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "FAILED"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "=== Done ==="
echo "  Updated: $SUCCESS"
echo "  Failed:  $FAILED"
echo ""
echo "Files deployed per VM:"
echo "  ~/.openclaw/skills/voice-audio-production/SKILL.md"
echo "  ~/.openclaw/skills/voice-audio-production/references/voice-guide.md"
echo "  ~/scripts/tts-openai.sh"
echo "  ~/scripts/tts-elevenlabs.sh"
echo "  ~/scripts/audio-toolkit.sh"
echo "  ~/scripts/audio-usage-tracker.py"
