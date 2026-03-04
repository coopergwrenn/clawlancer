#!/bin/bash
#
# fleet-push-prediction-markets-skill.sh — Deploy prediction markets skill (Polymarket + Kalshi) to fleet
#
# Pushes: SKILL.md, references (gamma-api, analysis, trading, monitoring, kalshi-api, kalshi-trading),
# all Polymarket scripts, all Kalshi scripts. Creates backward compat symlink from polymarket → prediction-markets.
#
# Usage:
#   fleet-push-prediction-markets-skill.sh --dry-run    — Preview deployment
#   fleet-push-prediction-markets-skill.sh --canary     — Deploy to 1 VM, pause for approval
#   fleet-push-prediction-markets-skill.sh --all        — Deploy to all active VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -uo pipefail
# Note: -e intentionally omitted — SSH failures on individual VMs should not abort the fleet deploy

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/prediction-markets"

# Load env
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  set -a
  source "$PROJECT_ROOT/.env.local"
  set +a
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
CLOB_PROXY_URL="${CLOB_PROXY_URL:-}"

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
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&select=id,ip_address,ssh_user,name,region" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3" region="${4:-}"

  echo "  Deploying to $vm_id ($user@$ip, region=$region)..."

  # Polymarket files
  local skill_md_b64 gamma_api_b64 analysis_b64 trading_b64 monitoring_b64 wallet_script_b64
  local setup_creds_b64 trade_b64 positions_b64 verify_b64 portfolio_b64 wallet_py_b64
  # Kalshi files
  local kalshi_api_b64 kalshi_trading_b64
  local kalshi_setup_b64 kalshi_trade_b64 kalshi_positions_b64 kalshi_portfolio_b64 kalshi_browse_b64

  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  gamma_api_b64=$(base64 < "$SKILL_DIR/references/gamma-api.md")
  analysis_b64=$(base64 < "$SKILL_DIR/references/analysis.md")
  trading_b64=$(base64 < "$SKILL_DIR/references/trading.md")
  monitoring_b64=$(base64 < "$SKILL_DIR/references/monitoring.md")
  kalshi_api_b64=$(base64 < "$SKILL_DIR/references/kalshi-api.md")
  kalshi_trading_b64=$(base64 < "$SKILL_DIR/references/kalshi-trading.md")
  wallet_script_b64=$(base64 < "$SKILL_DIR/scripts/setup-polymarket-wallet.sh")
  setup_creds_b64=$(base64 < "$SKILL_DIR/scripts/polymarket-setup-creds.py")
  trade_b64=$(base64 < "$SKILL_DIR/scripts/polymarket-trade.py")
  positions_b64=$(base64 < "$SKILL_DIR/scripts/polymarket-positions.py")
  verify_b64=$(base64 < "$SKILL_DIR/scripts/polymarket-verify.py")
  portfolio_b64=$(base64 < "$SKILL_DIR/scripts/polymarket-portfolio.py")
  wallet_py_b64=$(base64 < "$SKILL_DIR/scripts/polymarket-wallet.py")
  kalshi_setup_b64=$(base64 < "$SKILL_DIR/scripts/kalshi-setup.py")
  kalshi_trade_b64=$(base64 < "$SKILL_DIR/scripts/kalshi-trade.py")
  kalshi_positions_b64=$(base64 < "$SKILL_DIR/scripts/kalshi-positions.py")
  kalshi_portfolio_b64=$(base64 < "$SKILL_DIR/scripts/kalshi-portfolio.py")
  kalshi_browse_b64=$(base64 < "$SKILL_DIR/scripts/kalshi-browse.py")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_FILE" "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/prediction-markets"
mkdir -p "\$SKILL_DIR/references" "\$SKILL_DIR/scripts" "\$HOME/scripts" "\$HOME/.openclaw/polymarket" "\$HOME/.openclaw/prediction-markets" "\$HOME/memory"

# SKILL.md + Polymarket references
echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$gamma_api_b64' | base64 -d > "\$SKILL_DIR/references/gamma-api.md"
echo '$analysis_b64' | base64 -d > "\$SKILL_DIR/references/analysis.md"
echo '$trading_b64' | base64 -d > "\$SKILL_DIR/references/trading.md"
echo '$monitoring_b64' | base64 -d > "\$SKILL_DIR/references/monitoring.md"

# Kalshi references
echo '$kalshi_api_b64' | base64 -d > "\$SKILL_DIR/references/kalshi-api.md"
echo '$kalshi_trading_b64' | base64 -d > "\$SKILL_DIR/references/kalshi-trading.md"

# Polymarket scripts
echo '$wallet_script_b64' | base64 -d > "\$HOME/scripts/setup-polymarket-wallet.sh"
chmod +x "\$HOME/scripts/setup-polymarket-wallet.sh"
echo '$setup_creds_b64' | base64 -d > "\$HOME/scripts/polymarket-setup-creds.py"
echo '$trade_b64' | base64 -d > "\$HOME/scripts/polymarket-trade.py"
echo '$positions_b64' | base64 -d > "\$HOME/scripts/polymarket-positions.py"
echo '$verify_b64' | base64 -d > "\$HOME/scripts/polymarket-verify.py"
echo '$portfolio_b64' | base64 -d > "\$HOME/scripts/polymarket-portfolio.py"
echo '$wallet_py_b64' | base64 -d > "\$HOME/scripts/polymarket-wallet.py"
chmod +x "\$HOME/scripts/polymarket-wallet.py"
chmod +x "\$HOME/scripts/polymarket-setup-creds.py"
chmod +x "\$HOME/scripts/polymarket-trade.py"
chmod +x "\$HOME/scripts/polymarket-positions.py"
chmod +x "\$HOME/scripts/polymarket-verify.py"
chmod +x "\$HOME/scripts/polymarket-portfolio.py"

# Kalshi scripts
echo '$kalshi_setup_b64' | base64 -d > "\$HOME/scripts/kalshi-setup.py"
echo '$kalshi_trade_b64' | base64 -d > "\$HOME/scripts/kalshi-trade.py"
echo '$kalshi_positions_b64' | base64 -d > "\$HOME/scripts/kalshi-positions.py"
echo '$kalshi_portfolio_b64' | base64 -d > "\$HOME/scripts/kalshi-portfolio.py"
echo '$kalshi_browse_b64' | base64 -d > "\$HOME/scripts/kalshi-browse.py"
chmod +x "\$HOME/scripts/kalshi-setup.py"
chmod +x "\$HOME/scripts/kalshi-trade.py"
chmod +x "\$HOME/scripts/kalshi-positions.py"
chmod +x "\$HOME/scripts/kalshi-portfolio.py"
chmod +x "\$HOME/scripts/kalshi-browse.py"

# Backward compat: remove old polymarket dir before symlinking
rm -rf "\$HOME/.openclaw/skills/polymarket" 2>/dev/null
ln -sfn "\$SKILL_DIR" "\$HOME/.openclaw/skills/polymarket"

# Bootstrap pip if missing
python3 -m pip --version >/dev/null 2>&1 || curl -sS https://bootstrap.pypa.io/get-pip.py | python3 - --break-system-packages --quiet 2>/dev/null || true
python3 -m pip install --quiet --break-system-packages py-clob-client eth-account websockets web3 cryptography 2>/dev/null || true

echo "  Prediction markets skill deployed (Polymarket + Kalshi)"
REMOTE_SCRIPT

  # Set CLOB_PROXY_URL on US VMs (region starts with "us-" or "nyc")
  if [ -n "$CLOB_PROXY_URL" ]; then
    case "$region" in
      us-*|nyc*)
        echo "  Setting CLOB_PROXY_URL on US VM $vm_id..."
        ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_FILE" "${user}@${ip}" \
          "grep -q CLOB_PROXY_URL ~/.openclaw/.env 2>/dev/null || echo 'CLOB_PROXY_URL=${CLOB_PROXY_URL}' >> ~/.openclaw/.env"
        ;;
      *)
        echo "  Non-US region ($region) — skipping CLOB_PROXY_URL"
        ;;
    esac
  fi

  echo "  done: $vm_id"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Prediction Markets Skill Deployment (Polymarket + Kalshi) ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md                            -> ~/.openclaw/skills/prediction-markets/SKILL.md"
    echo "  references/gamma-api.md             -> ~/.openclaw/skills/prediction-markets/references/gamma-api.md"
    echo "  references/analysis.md              -> ~/.openclaw/skills/prediction-markets/references/analysis.md"
    echo "  references/trading.md               -> ~/.openclaw/skills/prediction-markets/references/trading.md"
    echo "  references/monitoring.md            -> ~/.openclaw/skills/prediction-markets/references/monitoring.md"
    echo "  references/kalshi-api.md            -> ~/.openclaw/skills/prediction-markets/references/kalshi-api.md"
    echo "  references/kalshi-trading.md        -> ~/.openclaw/skills/prediction-markets/references/kalshi-trading.md"
    echo "  scripts/setup-polymarket-wallet.sh  -> ~/scripts/setup-polymarket-wallet.sh"
    echo "  scripts/polymarket-setup-creds.py   -> ~/scripts/polymarket-setup-creds.py"
    echo "  scripts/polymarket-trade.py         -> ~/scripts/polymarket-trade.py"
    echo "  scripts/polymarket-positions.py     -> ~/scripts/polymarket-positions.py"
    echo "  scripts/polymarket-verify.py        -> ~/scripts/polymarket-verify.py"
    echo "  scripts/polymarket-portfolio.py     -> ~/scripts/polymarket-portfolio.py"
    echo "  scripts/polymarket-wallet.py        -> ~/scripts/polymarket-wallet.py"
    echo "  scripts/kalshi-setup.py             -> ~/scripts/kalshi-setup.py"
    echo "  scripts/kalshi-trade.py             -> ~/scripts/kalshi-trade.py"
    echo "  scripts/kalshi-positions.py         -> ~/scripts/kalshi-positions.py"
    echo "  scripts/kalshi-portfolio.py         -> ~/scripts/kalshi-portfolio.py"
    echo "  scripts/kalshi-browse.py           -> ~/scripts/kalshi-browse.py"
    echo ""
    echo "Symlink: ~/.openclaw/skills/polymarket -> ~/.openclaw/skills/prediction-markets"
    echo ""
    echo "Directories created:"
    echo "  ~/.openclaw/skills/prediction-markets/references"
    echo "  ~/.openclaw/prediction-markets (Kalshi state)"
    echo "  ~/.openclaw/polymarket (Polymarket state)"
    echo "  ~/scripts"
    echo "  ~/memory"
    echo ""
    echo "pip dependencies: py-clob-client, eth-account, websockets, web3, cryptography"
    echo ""
    echo "No API keys required — Gamma API is public, Kalshi is BYOK."
    echo ""

    VMS=$(fetch_vms)
    COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "Active VMs: $COUNT"
    echo ""
    echo "Run with --canary to deploy to 1 VM first, then --all for the rest."
    ;;

  --canary)
    echo "=== CANARY: Deploying prediction markets skill to first VM only ==="
    VMS=$(fetch_vms)

    if [ -n "${CANARY_IP:-}" ]; then
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    if v['ip_address'] == '${CANARY_IP}':
        print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']} {v.get('region','')}\")
        break
" 2>/dev/null)
    else
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
if vms:
    v = vms[0]
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']} {v.get('region','')}\")
" 2>/dev/null)
    fi

    if [ -z "$FIRST" ]; then
      echo "No active VMs found" >&2
      exit 1
    fi

    read -r IP USER VM_ID REGION <<< "$FIRST"
    deploy_to_vm "$IP" "$USER" "$VM_ID" "$REGION"

    echo ""
    echo "=== CANARY COMPLETE ==="
    echo "Verify: ssh ${USER}@${IP} 'ls ~/.openclaw/skills/prediction-markets/ && ls ~/scripts/kalshi-*.py'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Prediction Markets Skill (Polymarket + Kalshi) ==="
    VMS=$(fetch_vms)

    # Write VM list to temp file to avoid heredoc-stdin conflicts in the loop
    VM_LIST_FILE=$(mktemp)
    echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']} {v.get('region','')}\")
" 2>/dev/null > "$VM_LIST_FILE"

    DEPLOY_OK=0
    DEPLOY_FAIL=0
    while IFS=' ' read -r IP USER VM_ID REGION <&3; do
      deploy_to_vm "$IP" "$USER" "$VM_ID" "$REGION" && DEPLOY_OK=$((DEPLOY_OK + 1)) || { echo "  FAILED: $VM_ID ($IP)" >&2; DEPLOY_FAIL=$((DEPLOY_FAIL + 1)); }
    done 3< "$VM_LIST_FILE"
    rm -f "$VM_LIST_FILE"

    echo ""
    echo "=== FLEET DEPLOY COMPLETE ==="
    echo "  Succeeded: $DEPLOY_OK  Failed: $DEPLOY_FAIL  Total: $((DEPLOY_OK + DEPLOY_FAIL))"
    ;;

  --help|*)
    echo "fleet-push-prediction-markets-skill.sh — Deploy prediction markets skill (Polymarket + Kalshi) to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
