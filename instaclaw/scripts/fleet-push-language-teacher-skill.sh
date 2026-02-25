#!/bin/bash
#
# fleet-push-language-teacher-skill.sh — Deploy Language Teacher skill (Skill 14) to existing VMs
#
# Pushes: SKILL.md, 4 reference docs, 3 language-specific error guides, setup script
# No external API keys needed — all teaching logic is in the agent.
#
# Usage:
#   fleet-push-language-teacher-skill.sh --dry-run    — Preview deployment
#   fleet-push-language-teacher-skill.sh --canary     — Deploy to 1 VM, pause for approval
#   fleet-push-language-teacher-skill.sh --all        — Deploy to all active VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/language-teacher"

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
SSH_ENV_FILE="$PROJECT_ROOT/.env.ssh-key"
SSH_PRIVATE_KEY_B64=""
if [ -f "$SSH_ENV_FILE" ]; then
  SSH_PRIVATE_KEY_B64=$(grep "^SSH_PRIVATE_KEY_B64=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then
  echo "ERROR: SSH_PRIVATE_KEY_B64 not found in .env.ssh-key" >&2
  exit 1
fi
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

MODE="${1:---help}"

fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=id,ip_address,ssh_user,name" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3"

  echo "  Deploying to $vm_id ($user@$ip)..."

  local skill_md_b64 pedagogy_b64 spaced_rep_b64 gamification_b64 lesson_templates_b64
  local mistakes_pt_en_b64 mistakes_es_en_b64 mistakes_en_pt_b64 setup_script_b64

  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  pedagogy_b64=$(base64 < "$SKILL_DIR/references/pedagogy.md")
  spaced_rep_b64=$(base64 < "$SKILL_DIR/references/spaced-repetition.md")
  gamification_b64=$(base64 < "$SKILL_DIR/references/gamification.md")
  lesson_templates_b64=$(base64 < "$SKILL_DIR/references/lesson-templates.md")
  mistakes_pt_en_b64=$(base64 < "$SKILL_DIR/references/languages/common-mistakes-pt-en.md")
  mistakes_es_en_b64=$(base64 < "$SKILL_DIR/references/languages/common-mistakes-es-en.md")
  mistakes_en_pt_b64=$(base64 < "$SKILL_DIR/references/languages/common-mistakes-en-pt.md")
  setup_script_b64=$(base64 < "$SKILL_DIR/scripts/setup-language-learning.sh")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_FILE" "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/language-teacher"
mkdir -p "\$SKILL_DIR/references/languages" "\$SKILL_DIR/scripts" "\$HOME/scripts" "\$HOME/memory"

echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$pedagogy_b64' | base64 -d > "\$SKILL_DIR/references/pedagogy.md"
echo '$spaced_rep_b64' | base64 -d > "\$SKILL_DIR/references/spaced-repetition.md"
echo '$gamification_b64' | base64 -d > "\$SKILL_DIR/references/gamification.md"
echo '$lesson_templates_b64' | base64 -d > "\$SKILL_DIR/references/lesson-templates.md"
echo '$mistakes_pt_en_b64' | base64 -d > "\$SKILL_DIR/references/languages/common-mistakes-pt-en.md"
echo '$mistakes_es_en_b64' | base64 -d > "\$SKILL_DIR/references/languages/common-mistakes-es-en.md"
echo '$mistakes_en_pt_b64' | base64 -d > "\$SKILL_DIR/references/languages/common-mistakes-en-pt.md"
echo '$setup_script_b64' | base64 -d > "\$HOME/scripts/setup-language-learning.sh"
chmod +x "\$HOME/scripts/setup-language-learning.sh"

echo "  Language Teacher skill deployed successfully"
REMOTE_SCRIPT

  echo "  done: $vm_id"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Language Teacher Skill Deployment ==="
    echo ""
    echo "Files to deploy (9 files):"
    echo "  SKILL.md                                        -> ~/.openclaw/skills/language-teacher/SKILL.md"
    echo "  references/pedagogy.md                          -> ~/.openclaw/skills/language-teacher/references/pedagogy.md"
    echo "  references/spaced-repetition.md                 -> ~/.openclaw/skills/language-teacher/references/spaced-repetition.md"
    echo "  references/gamification.md                      -> ~/.openclaw/skills/language-teacher/references/gamification.md"
    echo "  references/lesson-templates.md                  -> ~/.openclaw/skills/language-teacher/references/lesson-templates.md"
    echo "  references/languages/common-mistakes-pt-en.md   -> ~/.openclaw/skills/language-teacher/references/languages/common-mistakes-pt-en.md"
    echo "  references/languages/common-mistakes-es-en.md   -> ~/.openclaw/skills/language-teacher/references/languages/common-mistakes-es-en.md"
    echo "  references/languages/common-mistakes-en-pt.md   -> ~/.openclaw/skills/language-teacher/references/languages/common-mistakes-en-pt.md"
    echo "  scripts/setup-language-learning.sh              -> ~/scripts/setup-language-learning.sh"
    echo ""
    echo "Directories created:"
    echo "  ~/.openclaw/skills/language-teacher/references/languages"
    echo "  ~/.openclaw/skills/language-teacher/scripts"
    echo "  ~/scripts"
    echo "  ~/memory"
    echo ""
    echo "No API keys or pip dependencies required."
    echo ""

    VMS=$(fetch_vms)
    COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "Active VMs: $COUNT"
    echo ""
    echo "Run with --canary to deploy to 1 VM first, then --all for the rest."
    ;;

  --canary)
    echo "=== CANARY: Deploying to first VM only ==="
    VMS=$(fetch_vms)

    if [ -n "${CANARY_IP:-}" ]; then
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    if v['ip_address'] == '${CANARY_IP}':
        print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
        break
" 2>/dev/null)
    else
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
if vms:
    v = vms[0]
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null)
    fi

    if [ -z "$FIRST" ]; then
      echo "No active VMs found" >&2
      exit 1
    fi

    read -r IP USER VM_ID <<< "$FIRST"
    deploy_to_vm "$IP" "$USER" "$VM_ID"

    echo ""
    echo "=== CANARY COMPLETE ==="
    echo "Verify: ssh ${USER}@${IP} 'ls ~/.openclaw/skills/language-teacher/'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Language Teacher Skill ==="
    VMS=$(fetch_vms)

    echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null | while read -r IP USER VM_ID; do
      deploy_to_vm "$IP" "$USER" "$VM_ID" || echo "  FAILED: $VM_ID ($IP)" >&2
    done

    echo ""
    echo "=== FLEET DEPLOY COMPLETE ==="
    ;;

  --help|*)
    echo "fleet-push-language-teacher-skill.sh — Deploy Language Teacher skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
