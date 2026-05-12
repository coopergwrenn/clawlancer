#!/usr/bin/env bash
# Per-VM readiness probe for Phase 4b gbrain installs (PRD §10 known-unknowns).
# Read-only. Outputs a single VM_READY structured line.
set +e
source ~/.nvm/nvm.sh 2>/dev/null
export PATH="$HOME/.bun/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# Disk free at / in GB (1 = 1GB)
DISK_FREE_GB=$(df --output=avail / 2>/dev/null | tail -1 | awk '{print int($1/1024/1024)}')
DISK_USE_PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -d ' %')

# Bun version (if installed). gbrain Phase B can skip if version >=1.0
BUN_VERSION=$(bun --version 2>/dev/null || echo MISSING)

# OpenClaw version
OPENCLAW_VERSION=$(openclaw --version 2>&1 | head -1 | grep -oE 'OpenClaw [0-9]+\.[0-9]+\.[0-9]+' | head -c 30)

# Build-essential / gcc check (gbrain's prctl-subreaper compiles native; gbrain itself doesn't, but build essentials matter for the manifest)
GCC_PATH=$(command -v gcc 2>/dev/null || echo MISSING)
UNZIP_PATH=$(command -v unzip 2>/dev/null || echo MISSING)

# Anthropic key already landed via stepEnvVarPush?
ANTHROPIC_KEY_LEN=$(grep "^GBRAIN_ANTHROPIC_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | wc -c)
OPENAI_KEY_LEN=$(grep "^OPENAI_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | wc -c)

# Already-installed gbrain check (idempotency signal)
GBRAIN_VERSION=$(gbrain --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo MISSING)
GBRAIN_MCP_REGISTERED=$(openclaw mcp show gbrain 2>/dev/null | grep -c '/home/openclaw/.bun/bin/gbrain' || echo 0)

# Gateway health (default to non-empty sentinels so the parser regex always matches)
GW_ACTIVE=$(systemctl --user is-active openclaw-gateway 2>/dev/null)
GW_ACTIVE="${GW_ACTIVE:-unknown}"
GW_HEALTH=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:18789/health 2>/dev/null || echo 000)
GW_HEALTH="${GW_HEALTH:-000}"

# SOUL.md size (informational, not blocking for gbrain)
SOUL_SIZE=$(wc -c < "$HOME/.openclaw/workspace/SOUL.md" 2>/dev/null || echo 0)

# Existing gbrain repo on disk (saves Phase C clone time)
GBRAIN_REPO=$(test -d "$HOME/gbrain/.git" && echo PRESENT || echo MISSING)

# Existing PGLite DB on disk (saves Phase E init time)
PGLITE_DB=$(test -d "$HOME/.gbrain/brain.pglite" && echo PRESENT || echo MISSING)

# Done — single-line summary
echo "VM_READY hostname=$(hostname) disk_free_gb=$DISK_FREE_GB disk_use_pct=$DISK_USE_PCT bun=$BUN_VERSION openclaw=\"$OPENCLAW_VERSION\" gcc=$GCC_PATH unzip=$UNZIP_PATH anthropic_key_len=$ANTHROPIC_KEY_LEN openai_key_len=$OPENAI_KEY_LEN gbrain_version=$GBRAIN_VERSION gbrain_mcp=$GBRAIN_MCP_REGISTERED gateway_active=$GW_ACTIVE gateway_health=$GW_HEALTH soul_size=$SOUL_SIZE gbrain_repo=$GBRAIN_REPO pglite_db=$PGLITE_DB"
